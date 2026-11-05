//! The live backend: classic Outlook over late-bound COM, every operation one job on the STA
//! thread (`sta`). This file holds the session (connection, trust check, lookups) and mail;
//! `live_pim` holds calendar, contacts and tasks.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::Win32::System::Com::{
    CLSCTX_LOCAL_SERVER, CLSIDFromProgID, CoCreateInstance, IConnectionPoint, IDispatch,
};
use windows::Win32::System::Ole::GetActiveObject;
use windows::core::{IUnknown, Interface, w};

use super::super::OutlookState;
use super::super::backend::{BResult, OutlookBackend, WatchHandle};
use super::super::dates::{WindowsZone, filter_date_string, local_ole_to_utc_ms};
use super::super::errors;
use super::super::ids::{FolderId, ItemId};
use super::super::mail as m;
use super::super::model::{
    AttachmentInfo, CalendarEventRecord, CalendarRecord, ContactName, ContactRecord,
    ContactSummaryRecord, ContactWrite, Destination, EventWrite, FlagChange, MailDraft,
    MailDraftRecord, MailFilter, MailMessage, MailScope, MailSearchResult, MailSummaryRecord,
    MailboxRecord, ReminderRecord, TaskWrite, iso,
};
use super::dispatch::{CR, Disp, Var};
use super::sink::Slot;
use super::sta::{Sta, StaSession, remaining};
use crate::node::capability::{CapabilityError, ErrorCode};
use crate::node::log::HelperLog;

// OlDefaultFolders
pub const FOLDER_DELETED: i32 = 3;
pub const FOLDER_SENT: i32 = 5;
pub const FOLDER_INBOX: i32 = 6;
pub const FOLDER_CALENDAR: i32 = 9;
pub const FOLDER_CONTACTS: i32 = 10;
pub const FOLDER_TASKS: i32 = 13;
pub const FOLDER_DRAFTS: i32 = 16;
pub const FOLDER_JUNK: i32 = 23;
// OlObjectClass
pub const CLASS_APPOINTMENT: i32 = 26;
pub const CLASS_CONTACT: i32 = 40;
pub const CLASS_MAIL: i32 = 43;
pub const CLASS_POST: i32 = 45;
pub const CLASS_TASK: i32 = 48;

/// Mail, posts and meeting messages (what Mail lists as messages).
pub fn is_message_class(c: i32) -> bool {
    matches!(c, CLASS_MAIL | CLASS_POST | 53..=57)
}

const PR_SMTP_ADDRESS: &str = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F";
const PR_SENDER_SMTP_ADDRESS: &str = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F";
const PR_ATTACH_MIME_TAG: &str = "http://schemas.microsoft.com/mapi/proptag/0x370E001F";

/// How long one Outlook job may take (each below the capability's own 58 s ceiling).
pub const T_READ: Duration = Duration::from_secs(30);
pub const T_SCAN: Duration = Duration::from_secs(50);
pub const T_WRITE: Duration = Duration::from_secs(30);
/// A thread stuck this long in one job is abandoned (a fresh one reconnects to Outlook).
const WEDGED: Duration = Duration::from_secs(90);
/// The most folders walked per store, and the deepest.
pub const MAX_FOLDERS: usize = 500;
pub const MAX_DEPTH: usize = 6;

/// A not-found error with the capability's own reason.
pub fn renamed(e: CapabilityError, reason: &str, message: &str) -> CapabilityError {
    if e.code == ErrorCode::NotFound {
        CapabilityError::not_found(reason, message)
    } else {
        e
    }
}

pub(super) struct WatchConn {
    pub cp: IConnectionPoint,
    pub cookie: u32,
    pub _items: Disp,
}

/// Outlook state on the STA thread.
pub struct Session {
    pub log: HelperLog,
    pub state: Arc<OutlookState>,
    pub zone: WindowsZone,
    app: Option<Disp>,
    ns: Option<Disp>,
    trusted: Option<(Instant, bool)>,
    pub(super) watches: HashMap<u64, (Slot, Vec<WatchConn>)>,
    pub(super) next_watch: u64,
    last_ping: Instant,
}

impl StaSession for Session {
    fn tick(&mut self) {
        if self.watches.is_empty() || self.last_ping.elapsed() < Duration::from_secs(60) {
            return;
        }
        self.last_ping = Instant::now();
        let alive = self.app.as_ref().is_some_and(|a| a.get("Name").is_ok());
        if !alive {
            // Outlook quit: end every watch (their streams finish; the Gateway re-subscribes).
            self.log.info("outlook watch ended: outlook quit");
            self.drop_watches();
            self.reset();
        }
    }
}

impl Session {
    pub fn new(log: HelperLog, state: Arc<OutlookState>) -> Self {
        Session {
            log,
            state,
            zone: WindowsZone,
            app: None,
            ns: None,
            trusted: None,
            watches: HashMap::new(),
            next_watch: 1,
            last_ping: Instant::now(),
        }
    }

    pub fn reset(&mut self) {
        self.app = None;
        self.ns = None;
        self.trusted = None;
    }

    pub(super) fn drop_watches(&mut self) {
        for (_, (slot, conns)) in self.watches.drain() {
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
            for c in conns {
                // SAFETY: the cookie came from this connection point's Advise.
                unsafe {
                    let _ = c.cp.Unadvise(c.cookie);
                }
            }
        }
    }

    fn adopt(&mut self, d: IDispatch) -> CR<Disp> {
        let app = Disp::new(d, "Application");
        let ns = app.call_obj("GetNamespace", vec![Var::str("MAPI")], "Namespace")?;
        self.app = Some(app.clone());
        self.ns = Some(ns);
        Ok(app)
    }

    /// Drops a dead connection (Outlook quit since the last job).
    pub fn ensure_alive(&mut self) {
        if let Some(a) = &self.app
            && let Err(e) = a.get("Name")
            && matches!(e.reason.as_str(), "outlook_disconnected" | "outlook_error")
        {
            self.reset();
        }
    }

    /// `Outlook.Application`, started headless when it is not running.
    pub fn app(&mut self) -> CR<Disp> {
        if let Some(a) = &self.app {
            return Ok(a.clone());
        }
        if self.state.availability.profiles == 0 {
            return Err(CapabilityError::unavailable(
                "outlook_no_profile",
                "Classic Outlook has no mail profile yet. Open Outlook once and add your account.",
            ));
        }
        // SAFETY: ProgID lookup and out-of-process activation; the interface is owned.
        let d: IDispatch = unsafe {
            let clsid = CLSIDFromProgID(w!("Outlook.Application"))
                .map_err(|e| errors::map(e.code().0 as u32, None))?;
            CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER)
                .map_err(|e| errors::map(e.code().0 as u32, None))?
        };
        let app = self.adopt(d)?;
        // The default profile without a dialog (a no-op when Outlook already runs).
        if let Some(ns) = &self.ns {
            let _ = ns.call(
                "Logon",
                vec![
                    Var::missing(),
                    Var::missing(),
                    Var::flag(false),
                    Var::flag(false),
                ],
            );
        }
        self.log.info("outlook connected");
        Ok(app)
    }

    /// The running Outlook, or None (never starts it).
    pub fn running_app(&mut self) -> CR<Option<Disp>> {
        if let Some(a) = &self.app {
            return Ok(Some(a.clone()));
        }
        let mut unk: Option<IUnknown> = None;
        // SAFETY: ROT lookup into a local.
        let found = unsafe {
            let Ok(clsid) = CLSIDFromProgID(w!("Outlook.Application")) else {
                return Ok(None);
            };
            GetActiveObject(&clsid, None, &mut unk).is_ok()
        };
        match unk
            .filter(|_| found)
            .and_then(|u| u.cast::<IDispatch>().ok())
        {
            Some(d) => Ok(Some(self.adopt(d)?)),
            None => Ok(None),
        }
    }

    pub fn ns(&mut self) -> CR<Disp> {
        self.app()?;
        self.ns.clone().ok_or_else(|| {
            CapabilityError::unavailable("outlook_error", "Outlook has no MAPI namespace")
        })
    }

    /// `Application.IsTrusted` (cached a minute): whether guarded properties and methods work
    /// without the object model guard's prompt.
    pub fn is_trusted(&mut self) -> CR<bool> {
        if let Some((t, v)) = self.trusted
            && t.elapsed() < Duration::from_secs(60)
        {
            return Ok(v);
        }
        let app = self.app()?;
        let v = match app.get("IsTrusted") {
            Ok(v) => v.bool(),
            // Before Outlook 2007 there is no such property (and no such guard state to read).
            Err(e) if e.reason == "outlook_object_model" => true,
            Err(e) => return Err(e),
        };
        if !v {
            self.log
                .info("outlook object model guard active: guarded operations refused");
        }
        self.trusted = Some((Instant::now(), v));
        *self.state.trusted.lock().unwrap_or_else(|p| p.into_inner()) = Some(v);
        Ok(v)
    }

    /// Refuses a guarded operation instead of letting Outlook prompt.
    pub fn guard(&mut self) -> CR<()> {
        if self.is_trusted()? {
            Ok(())
        } else {
            Err(errors::object_model_guard())
        }
    }

    pub fn item(&mut self, id: &ItemId) -> CR<Disp> {
        let ns = self.ns()?;
        ns.call_obj(
            "GetItemFromID",
            vec![Var::str(&id.entry), Var::str(&id.store)],
            "Item",
        )
    }

    pub fn folder(&mut self, id: &FolderId) -> CR<Disp> {
        let ns = self.ns()?;
        ns.call_obj(
            "GetFolderFromID",
            vec![Var::str(&id.entry), Var::str(&id.store)],
            "Folder",
        )
    }

    pub fn default_folder(&mut self, n: i32) -> CR<Disp> {
        let ns = self.ns()?;
        ns.call_obj("GetDefaultFolder", vec![Var::int(n)], "Folder")
    }

    pub fn stores(&mut self) -> CR<Vec<Disp>> {
        let ns = self.ns()?;
        let stores = ns.obj("Stores", "Stores")?;
        let n = stores.count()?;
        let mut out = Vec::new();
        for i in 1..=n.min(50) {
            if let Some(s) = stores.item(i, "Store")? {
                // Exchange public folders (olExchangePublicFolder 2) can hold thousands of
                // folders and none of the owner's own items.
                if s.soft("ExchangeStoreType")?.i32() != 2 {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }

    pub fn store_named(&mut self, name: &str) -> CR<Disp> {
        for s in self.stores()? {
            if s.soft_string("DisplayName")?
                .eq_ignore_ascii_case(name.trim())
            {
                return Ok(s);
            }
        }
        Err(CapabilityError::not_found(
            "account_not_found",
            "No Outlook account (store) has that name",
        ))
    }

    pub fn default_store(&mut self) -> CR<Disp> {
        let ns = self.ns()?;
        ns.obj("DefaultStore", "Store")
    }

    /// Folders of an item type (olMailItem 0, olAppointmentItem 1, olContactItem 2,
    /// olTaskItem 3) in every store: the store's default folder of that kind and everything under
    /// it, plus such folders anywhere else in the tree.
    pub fn typed_folders(&mut self, item_type: i32, max: usize) -> CR<Vec<(Disp, Disp)>> {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for store in self.stores()? {
            let Ok(root) = store.call_obj("GetRootFolder", vec![], "Folder") else {
                continue;
            };
            let mut found = Vec::new();
            walk(&root, 0, MAX_DEPTH, MAX_FOLDERS, &mut found, &|f| {
                Ok(f.i32("DefaultItemType")? == item_type)
            })?;
            for f in found {
                if out.len() >= max {
                    return Ok(out);
                }
                let entry = f.string("EntryID")?;
                if seen.insert(entry) {
                    out.push((store.clone(), f));
                }
            }
        }
        Ok(out)
    }

    /// A mailbox by `Parent/Child` path in `account` (the default store when None); `inbox`,
    /// `sent`, `drafts`, `junk`, `trash` also name the store's default folders.
    pub fn mailbox(&mut self, account: Option<&str>, name: &str) -> CR<Disp> {
        let store = match account {
            Some(a) => self.store_named(a)?,
            None => self.default_store()?,
        };
        let root = store.call_obj("GetRootFolder", vec![], "Folder")?;
        let mut cur = Some(root);
        for seg in name.split('/').filter(|s| !s.is_empty()) {
            cur = match cur {
                Some(f) => {
                    let folders = f.obj("Folders", "Folders")?;
                    match folders.get_with("Item", vec![Var::str(seg)]) {
                        Ok(v) => v.dispatch().map(|d| Disp::new(d, "Folder")),
                        Err(e) if e.code == ErrorCode::NotFound || e.reason == "outlook_error" => {
                            None
                        }
                        Err(e) => return Err(e),
                    }
                }
                None => None,
            };
        }
        if let Some(f) = cur.filter(|_| !name.trim_matches('/').is_empty()) {
            return Ok(f);
        }
        let n = match m::special(name) {
            Some("inbox") => FOLDER_INBOX,
            Some("sent") => FOLDER_SENT,
            Some("drafts") => FOLDER_DRAFTS,
            Some("junk") => FOLDER_JUNK,
            Some("trash") => FOLDER_DELETED,
            _ => {
                return Err(CapabilityError::not_found(
                    "mailbox_not_found",
                    "No such mailbox in that account",
                ));
            }
        };
        store
            .call_obj("GetDefaultFolder", vec![Var::int(n)], "Folder")
            .map_err(|e| renamed(e, "mailbox_not_found", "No such mailbox in that account"))
    }

    // MARK: Mail records

    /// The SMTP address of a recipient / address entry (Exchange entries carry an X.500 one).
    pub fn smtp(r: &Disp) -> CR<String> {
        let addr = r.soft_string("Address")?;
        if addr.contains('@') {
            return Ok(addr);
        }
        if let Some(pa) = r.obj_opt("PropertyAccessor", "PropertyAccessor")? {
            let v = match pa.call("GetProperty", vec![Var::str(PR_SMTP_ADDRESS)]) {
                Ok(v) => v.string(),
                Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                Err(_) => String::new(),
            };
            if v.contains('@') {
                return Ok(v);
            }
        }
        Ok(addr)
    }

    pub fn sender(it: &Disp) -> CR<String> {
        let name = it.soft_string("SenderName")?;
        let mut addr = it.soft_string("SenderEmailAddress")?;
        if !addr.contains('@')
            && let Some(pa) = it.obj_opt("PropertyAccessor", "PropertyAccessor")?
        {
            match pa.call("GetProperty", vec![Var::str(PR_SENDER_SMTP_ADDRESS)]) {
                Ok(v) => addr = v.string(),
                Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                Err(_) => {}
            }
        }
        Ok(m::sender(&name, &addr))
    }

    fn received_ms(&self, it: &Disp) -> CR<i64> {
        for p in ["ReceivedTime", "SentOn", "CreationTime"] {
            if let Some(ms) = local_ole_to_utc_ms(it.soft(p)?.f64(), &self.zone) {
                return Ok(ms);
            }
        }
        Ok(0)
    }

    /// `AppleMailMessageSummary` of a message in a known folder.
    pub fn summary(
        &self,
        it: &Disp,
        mailbox: &str,
        account: &str,
        store_id: &str,
        trusted: bool,
    ) -> CR<MailSummaryRecord> {
        let entry = it.string("EntryID")?;
        Ok(MailSummaryRecord {
            id: ItemId::new(store_id, &entry).encode(),
            mailbox: mailbox.to_owned(),
            account: account.to_owned(),
            subject: it.soft_string("Subject")?,
            from: if trusted {
                Self::sender(it)?
            } else {
                String::new()
            },
            date: iso(self.received_ms(it)?),
            read: !it.soft("UnRead")?.bool(),
            flagged: Some(it.soft("FlagStatus")?.i32() == 2),
            link: None,
        })
    }

    /// (mailbox path, account, store id) of a folder.
    pub fn folder_place(f: &Disp) -> CR<(String, String, String)> {
        let path = m::mailbox_path(&f.soft_string("FolderPath")?);
        let store = f.obj("Store", "Store")?;
        Ok((
            path,
            store.soft_string("DisplayName")?,
            f.string("StoreID")?,
        ))
    }

    pub fn summary_of(&self, it: &Disp, trusted: bool) -> CR<MailSummaryRecord> {
        let parent = it.obj("Parent", "Folder")?;
        let (mb, acct, store) = Self::folder_place(&parent)?;
        self.summary(it, &mb, &acct, &store, trusted)
    }

    fn recipients(it: &Disp) -> CR<(Vec<String>, Vec<String>)> {
        let rs = it.obj("Recipients", "Recipients")?;
        let (mut to, mut cc) = (Vec::new(), Vec::new());
        for i in 1..=rs.count()?.min(500) {
            if let Some(r) = rs.item(i, "Recipient")? {
                let a = Self::smtp(&r)?;
                match r.i32("Type")? {
                    1 => to.push(a),
                    2 => cc.push(a),
                    _ => {}
                }
            }
        }
        Ok((to, cc))
    }

    /// `MailDraftRecord` of a saved draft.
    pub fn draft_record(it: &Disp) -> CR<MailDraftRecord> {
        let parent = it.obj("Parent", "Folder")?;
        let id = ItemId::new(&parent.string("StoreID")?, &it.string("EntryID")?);
        let (to, cc) = Self::recipients(it)?;
        Ok(MailDraftRecord::new(
            id.encode(),
            it.soft_string("Subject")?,
            to,
            cc,
            it.soft_string("Body")?,
        ))
    }

    fn add_recipients(it: &Disp, to: &[String], cc: &[String]) -> CR<()> {
        let rs = it.obj("Recipients", "Recipients")?;
        for (list, kind) in [(to, 1), (cc, 2)] {
            for a in list {
                let r = rs.call_obj("Add", vec![Var::str(a.trim())], "Recipient")?;
                r.put("Type", Var::int(kind))?;
            }
        }
        Ok(())
    }

    fn compose(&mut self, d: &MailDraft) -> CR<Disp> {
        self.guard()?;
        let app = self.app()?;
        let it = app.call_obj("CreateItem", vec![Var::int(0)], "Item")?;
        it.put("Subject", Var::str(&d.subject))?;
        it.put("Body", Var::str(&d.body))?;
        Self::add_recipients(&it, &d.to, d.cc.as_deref().unwrap_or_default())?;
        Ok(it)
    }

    fn message(&mut self, id: &ItemId) -> CR<Disp> {
        let it = self
            .item(id)
            .map_err(|e| renamed(e, "message_not_found", "No such message in Outlook"))?;
        if !is_message_class(it.i32("Class")?) {
            return Err(CapabilityError::not_found(
                "message_not_found",
                "That Outlook item is not a message",
            ));
        }
        Ok(it)
    }

    /// Attachments Mail would list (not links to cloud files), in order.
    fn attachment_list(it: &Disp) -> CR<Vec<(Disp, AttachmentInfo)>> {
        let atts = it.obj("Attachments", "Attachments")?;
        let mut out = Vec::new();
        for i in 1..=atts.count()?.min(500) {
            let Some(a) = atts.item(i, "Attachment")? else {
                continue;
            };
            if a.soft("Type")?.i32() == 4 {
                continue; // olByReference
            }
            let mut name = a.soft_string("FileName")?;
            if name.is_empty() {
                name = a.soft_string("DisplayName")?;
            }
            let mime = match a.obj_opt("PropertyAccessor", "PropertyAccessor")? {
                Some(pa) => pa
                    .call("GetProperty", vec![Var::str(PR_ATTACH_MIME_TAG)])
                    .map(|v| v.string())
                    .unwrap_or_default(),
                None => String::new(),
            };
            let size = a.soft("Size")?.i32() as i64;
            out.push((
                a,
                AttachmentInfo {
                    name,
                    mime_type: (!mime.is_empty()).then_some(mime),
                    size,
                },
            ));
        }
        Ok(out)
    }
}

/// Collects folders under `f` (not `f` itself) that `pred` accepts, depth-first.
pub fn walk(
    f: &Disp,
    depth: usize,
    max_depth: usize,
    max: usize,
    out: &mut Vec<Disp>,
    pred: &dyn Fn(&Disp) -> CR<bool>,
) -> CR<()> {
    if depth >= max_depth || out.len() >= max {
        return Ok(());
    }
    let folders = f.obj("Folders", "Folders")?;
    for i in 1..=folders.count()? {
        if out.len() >= max {
            break;
        }
        let Some(c) = folders.item(i, "Folder")? else {
            continue;
        };
        if pred(&c)? {
            out.push(c.clone());
        }
        walk(&c, depth + 1, max_depth, max, out, pred)?;
    }
    Ok(())
}

/// Iterates an `Items` collection with `GetFirst` / `GetNext` (fast on sorted and restricted
/// collections), stopping when `f` says so or after `max` items.
pub fn each_item(items: &Disp, max: usize, mut f: impl FnMut(&Disp) -> CR<bool>) -> CR<()> {
    let mut cur = items.call("GetFirst", vec![])?.dispatch();
    let mut n = 0;
    while let Some(d) = cur {
        n += 1;
        if n > max || !f(&Disp::new(d, "Item"))? {
            break;
        }
        cur = items.call("GetNext", vec![])?.dispatch();
    }
    Ok(())
}

/// The live backend.
pub struct LiveOutlook {
    pub(super) sta: Arc<Sta<Session>>,
    log: HelperLog,
}

impl LiveOutlook {
    pub fn new(log: HelperLog, state: Arc<OutlookState>) -> Self {
        let l2 = log.clone();
        LiveOutlook {
            sta: Arc::new(Sta::new(
                "outlook",
                move || Session::new(l2.clone(), state.clone()),
                WEDGED,
                log.clone(),
            )),
            log,
        }
    }

    /// One job: content-free log line (operation and outcome), session reset on disconnect.
    pub(super) fn job<R: Send + 'static>(
        &self,
        op: &'static str,
        timeout: Duration,
        f: impl FnOnce(&mut Session) -> CR<R> + Send + 'static,
    ) -> CR<R> {
        let started = Instant::now();
        let r = self.sta.run(timeout, move |s| {
            s.ensure_alive();
            let r = f(s);
            if let Err(e) = &r
                && e.reason == "outlook_disconnected"
            {
                s.reset();
            }
            r
        });
        let outcome = match &r {
            Ok(_) => "ok".to_owned(),
            Err(e) => e.reason.clone(),
        };
        self.log.info(format!(
            "outlook op={op} outcome={outcome} ms={}",
            started.elapsed().as_millis()
        ));
        r
    }
}

impl OutlookBackend for LiveOutlook {
    fn mailboxes(&self, account: Option<&str>) -> BResult<Vec<MailboxRecord>> {
        let account = account.map(str::to_owned);
        self.job("mail.mailboxes", T_SCAN, move |s| {
            let mut out = Vec::new();
            for store in s.stores()? {
                let acct = store.soft_string("DisplayName")?;
                if account
                    .as_deref()
                    .is_some_and(|a| !a.trim().eq_ignore_ascii_case(&acct))
                {
                    continue;
                }
                let mut defaults: HashMap<String, &'static str> = HashMap::new();
                for (n, role) in [
                    (FOLDER_INBOX, "inbox"),
                    (FOLDER_SENT, "sent"),
                    (FOLDER_DRAFTS, "drafts"),
                    (FOLDER_JUNK, "junk"),
                    (FOLDER_DELETED, "trash"),
                ] {
                    if let Ok(f) = store.call_obj("GetDefaultFolder", vec![Var::int(n)], "Folder") {
                        defaults.insert(f.string("EntryID")?, role);
                    }
                }
                let Ok(root) = store.call_obj("GetRootFolder", vec![], "Folder") else {
                    continue;
                };
                let mut found = Vec::new();
                walk(&root, 0, MAX_DEPTH, MAX_FOLDERS, &mut found, &|f| {
                    Ok(f.i32("DefaultItemType")? == 0)
                })?;
                for f in found {
                    let name = m::mailbox_path(&f.soft_string("FolderPath")?);
                    let special = defaults
                        .get(&f.string("EntryID")?)
                        .copied()
                        .or_else(|| m::special(&name));
                    out.push(MailboxRecord {
                        account: acct.clone(),
                        unread_count: f.soft("UnreadItemCount")?.i32().max(0) as i64,
                        special: special.map(String::from),
                        name,
                    });
                }
            }
            Ok(out)
        })
    }

    fn search_mail(
        &self,
        filter: &MailFilter,
        scope: &MailScope,
        limit: usize,
    ) -> BResult<MailSearchResult> {
        let (filter, scope) = (filter.clone(), scope.clone());
        self.job("mail.search", T_SCAN, move |s| {
            let folder = match &scope.mailbox {
                Some(mb) => s.mailbox(scope.account.as_deref(), mb)?,
                None => s.default_folder(FOLDER_INBOX)?,
            };
            let (mb, acct, store) = Session::folder_place(&folder)?;
            let trusted = s.is_trusted()?;
            let mut items = folder.obj("Items", "Items")?;
            // DASL dates are UTC in the user's date format.
            if let Some(q) = m::dasl_filter(&filter, &filter_date_string) {
                items = items.call_obj("Restrict", vec![Var::str(&q)], "Items")?;
            }
            items.call("Sort", vec![Var::str("[ReceivedTime]"), Var::flag(true)])?;
            let budget = Instant::now() + remaining().saturating_sub(Duration::from_secs(8)).min(Duration::from_secs(20));
            let mut out = MailSearchResult::default();
            each_item(&items, 5_000, |it| {
                if Instant::now() >= budget {
                    out.truncated = true;
                    return Ok(false);
                }
                if is_message_class(it.i32("Class")?) {
                    out.messages.push(s.summary(it, &mb, &acct, &store, trusted)?);
                }
                Ok(out.messages.len() < limit)
            })?;
            let mut notes = Vec::new();
            if out.truncated {
                notes.push(format!("Outlook was slow: only the newest {} matches could be read", out.messages.len()));
            }
            if !trusted {
                notes.push("Senders are hidden: Outlook's object model guard is on (no up-to-date antivirus reported)".to_owned());
            }
            out.note = (!notes.is_empty()).then(|| notes.join(". ") + ".");
            Ok(out)
        })
    }

    fn read_mail(&self, id: &ItemId, max_len: usize) -> BResult<MailMessage> {
        let id = id.clone();
        self.job("mail.read", T_READ, move |s| {
            s.guard()?;
            let it = s.message(&id)?;
            let summary = s.summary_of(&it, true)?;
            let (to, cc) = Session::recipients(&it)?;
            let body: String = it.soft_string("Body")?.chars().take(max_len).collect();
            Ok(MailMessage {
                summary,
                to,
                cc,
                body,
            })
        })
    }

    fn attachments(&self, id: &ItemId) -> BResult<Vec<AttachmentInfo>> {
        let id = id.clone();
        self.job("mail.attachments", T_READ, move |s| {
            let it = s.message(&id)?;
            Ok(Session::attachment_list(&it)?
                .into_iter()
                .map(|(_, a)| a)
                .collect())
        })
    }

    fn save_attachment(&self, id: &ItemId, index: usize, path: &Path) -> BResult<()> {
        let (id, path) = (id.clone(), path.display().to_string());
        self.job("mail.save_attachment", T_WRITE, move |s| {
            s.guard()?;
            let it = s.message(&id)?;
            let list = Session::attachment_list(&it)?;
            let (a, _) = list.get(index).ok_or_else(|| {
                CapabilityError::not_found("no_attachments", "The message has no such attachment")
            })?;
            a.call("SaveAsFile", vec![Var::str(&path)]).map(|_| ())
        })
    }

    fn selected_mail(&self, limit: usize) -> BResult<Vec<MailSummaryRecord>> {
        self.job("mail.selected", T_READ, move |s| {
            // "This email" means the one on screen: never start Outlook to find nothing selected.
            let Some(app) = s.running_app()? else {
                return Ok(Vec::new());
            };
            let Some(explorer) = app
                .call("ActiveExplorer", vec![])?
                .dispatch()
                .map(|d| Disp::new(d, "Explorer"))
            else {
                return Ok(Vec::new());
            };
            let sel = match explorer.obj("Selection", "Selection") {
                Ok(sel) => sel,
                Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                Err(_) => return Ok(Vec::new()),
            };
            let trusted = s.is_trusted()?;
            let mut out = Vec::new();
            for i in 1..=sel.count()?.min(500) {
                if out.len() >= limit {
                    break;
                }
                let Some(it) = sel.item(i, "Item")? else {
                    continue;
                };
                if is_message_class(it.i32("Class")?) {
                    out.push(s.summary_of(&it, trusted)?);
                }
            }
            Ok(out)
        })
    }

    fn save_draft(&self, draft: &MailDraft) -> BResult<MailDraftRecord> {
        let d = draft.clone();
        self.job("mail.draft", T_WRITE, move |s| {
            let it = s.compose(&d)?;
            it.call("Save", vec![])?;
            Session::draft_record(&it)
        })
    }

    fn send_mail(&self, draft: &MailDraft) -> BResult<()> {
        let d = draft.clone();
        self.job("mail.send", T_WRITE, move |s| {
            let it = s.compose(&d)?;
            it.call("Send", vec![]).map(|_| ())
        })
    }

    fn reply_draft(
        &self,
        id: &ItemId,
        body: &str,
        reply_all: bool,
        cc: &[String],
    ) -> BResult<MailDraftRecord> {
        let (id, body, cc) = (id.clone(), body.to_owned(), cc.to_vec());
        self.job("mail.reply_draft", T_WRITE, move |s| {
            s.guard()?;
            let it = s.message(&id)?;
            let r = it.call_obj(if reply_all { "ReplyAll" } else { "Reply" }, vec![], "Item")?;
            put_text_on_top(&r, &body)?;
            Session::add_recipients(&r, &[], &cc)?;
            r.call("Save", vec![])?;
            Session::draft_record(&r)
        })
    }

    fn forward_draft(
        &self,
        id: &ItemId,
        to: &[String],
        cc: &[String],
        body: &str,
    ) -> BResult<MailDraftRecord> {
        let (id, to, cc, body) = (id.clone(), to.to_vec(), cc.to_vec(), body.to_owned());
        self.job("mail.forward_draft", T_WRITE, move |s| {
            s.guard()?;
            let it = s.message(&id)?;
            let f = it.call_obj("Forward", vec![], "Item")?;
            put_text_on_top(&f, &body)?;
            Session::add_recipients(&f, &to, &cc)?;
            f.call("Save", vec![])?;
            Session::draft_record(&f)
        })
    }

    fn draft(&self, id: &ItemId) -> BResult<Option<MailDraftRecord>> {
        let id = id.clone();
        self.job("mail.draft_read", T_READ, move |s| {
            s.guard()?;
            let it = match s.item(&id) {
                Ok(it) => it,
                Err(e) if e.code == ErrorCode::NotFound => return Ok(None),
                Err(e) => return Err(e),
            };
            if it.i32("Class")? != CLASS_MAIL || it.soft("Sent")?.bool() {
                return Ok(None);
            }
            Session::draft_record(&it).map(Some)
        })
    }

    fn send_draft(&self, id: &ItemId) -> BResult<()> {
        let id = id.clone();
        self.job("mail.send_draft", T_WRITE, move |s| {
            s.guard()?;
            let it = s.message(&id)?;
            it.call("Send", vec![]).map(|_| ())
        })
    }

    fn set_flags(&self, ids: &[ItemId], change: &FlagChange) -> BResult<usize> {
        let (ids, change) = (ids.to_vec(), *change);
        self.job("mail.set_flags", T_WRITE, move |s| {
            let mut n = 0;
            for id in &ids {
                let it = match s.message(id) {
                    Ok(it) => it,
                    Err(e) if e.code == ErrorCode::NotFound => continue,
                    Err(e) => return Err(e),
                };
                if let Some(r) = change.read {
                    it.put("UnRead", Var::flag(!r))?;
                }
                if change.flagged == Some(true) || change.color.is_some() {
                    flag_message(&it, true)?;
                    if let Some(c) = change.color {
                        let _ = it.put("FlagIcon", Var::int(m::flag_icon(c)));
                    }
                } else if change.flagged == Some(false) {
                    flag_message(&it, false)?;
                }
                it.call("Save", vec![])?;
                n += 1;
            }
            Ok(n)
        })
    }

    fn move_mail(&self, ids: &[ItemId], to: &Destination) -> BResult<usize> {
        let (ids, to) = (ids.to_vec(), to.clone());
        self.job("mail.move", T_WRITE, move |s| {
            let named = match &to {
                Destination::Mailbox { name, account } => Some(s.mailbox(Some(account), name)?),
                _ => None,
            };
            let mut n = 0;
            for id in &ids {
                let it = match s.message(id) {
                    Ok(it) => it,
                    Err(e) if e.code == ErrorCode::NotFound => continue,
                    Err(e) => return Err(e),
                };
                let dest = match (&to, &named) {
                    (_, Some(f)) => f.clone(),
                    (Destination::Junk, _) => {
                        let store = it.obj("Parent", "Folder")?.obj("Store", "Store")?;
                        store
                            .call_obj("GetDefaultFolder", vec![Var::int(FOLDER_JUNK)], "Folder")
                            .map_err(|e| {
                                renamed(
                                    e,
                                    "junk_not_found",
                                    "That account has no Junk Email folder",
                                )
                            })?
                    }
                    _ => {
                        let store = it.obj("Parent", "Folder")?.obj("Store", "Store")?;
                        let root = store.call_obj("GetRootFolder", vec![], "Folder")?;
                        root.obj("Folders", "Folders")?
                            .get_with("Item", vec![Var::str("Archive")])
                            .ok()
                            .and_then(|v| v.dispatch())
                            .map(|d| Disp::new(d, "Folder"))
                            .ok_or_else(|| {
                                CapabilityError::not_found(
                                    "archive_not_found",
                                    "That account has no Archive folder",
                                )
                            })?
                    }
                };
                it.call("Move", vec![Var::disp(&dest)])?;
                n += 1;
            }
            Ok(n)
        })
    }

    fn calendars(&self) -> BResult<Vec<CalendarRecord>> {
        self.job("calendar.list_calendars", T_SCAN, |s| s.calendar_records())
    }

    fn events(
        &self,
        from: i64,
        to: i64,
        calendars: Option<&[FolderId]>,
    ) -> BResult<Vec<CalendarEventRecord>> {
        let cals = calendars.map(<[FolderId]>::to_vec);
        self.job("calendar.list_events", T_SCAN, move |s| {
            s.events(from, to, cals.as_deref())
        })
    }

    fn create_event(&self, e: &EventWrite) -> BResult<CalendarEventRecord> {
        let e = e.clone();
        self.job("calendar.create_event", T_WRITE, move |s| {
            s.create_event(&e)
        })
    }

    fn update_event(
        &self,
        id: &ItemId,
        e: &EventWrite,
        future: bool,
    ) -> BResult<CalendarEventRecord> {
        let (id, e) = (id.clone(), e.clone());
        self.job("calendar.update_event", T_WRITE, move |s| {
            s.update_event(&id, &e, future)
        })
    }

    fn delete_event(&self, id: &ItemId, future: bool) -> BResult<()> {
        let id = id.clone();
        self.job("calendar.delete_event", T_WRITE, move |s| {
            s.delete_event(&id, future)
        })
    }

    fn watch_calendars(
        &self,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> BResult<Box<dyn WatchHandle>> {
        let id = self.job("calendar.watch", T_SCAN, move |s| s.watch(on_change))?;
        Ok(Box::new(LiveWatch {
            sta: self.sta.clone(),
            id,
        }))
    }

    fn contact_summaries(&self) -> BResult<Vec<ContactSummaryRecord>> {
        self.job("contacts.search", T_SCAN, |s| s.contact_summaries())
    }

    fn contact_names(&self) -> BResult<Vec<ContactName>> {
        self.job("contacts.list", T_SCAN, |s| s.contact_names())
    }

    fn read_contact(&self, id: &ItemId) -> BResult<ContactRecord> {
        let id = id.clone();
        self.job("contacts.read", T_READ, move |s| s.read_contact(&id))
    }

    fn create_contact(&self, c: &ContactWrite) -> BResult<ContactRecord> {
        let c = c.clone();
        self.job("contacts.create", T_WRITE, move |s| s.create_contact(&c))
    }

    fn update_contact(&self, id: &ItemId, c: &ContactWrite) -> BResult<ContactRecord> {
        let (id, c) = (id.clone(), c.clone());
        self.job("contacts.update", T_WRITE, move |s| {
            s.update_contact(&id, &c)
        })
    }

    fn task_lists(&self) -> BResult<Vec<CalendarRecord>> {
        self.job("reminders.list_lists", T_SCAN, |s| s.task_lists())
    }

    fn tasks(
        &self,
        lists: Option<&[FolderId]>,
        completed: Option<bool>,
    ) -> BResult<Vec<ReminderRecord>> {
        let lists = lists.map(<[FolderId]>::to_vec);
        self.job("reminders.list", T_SCAN, move |s| {
            s.tasks(lists.as_deref(), completed)
        })
    }

    fn flagged_mail(&self) -> BResult<Vec<ReminderRecord>> {
        self.job("reminders.flagged_mail", T_SCAN, |s| s.flagged_mail())
    }

    fn create_task(&self, t: &TaskWrite) -> BResult<ReminderRecord> {
        let t = t.clone();
        self.job("reminders.create", T_WRITE, move |s| s.create_task(&t))
    }

    fn update_task(&self, id: &ItemId, t: &TaskWrite) -> BResult<ReminderRecord> {
        let (id, t) = (id.clone(), t.clone());
        self.job("reminders.update", T_WRITE, move |s| s.update_task(&id, &t))
    }

    fn set_task_completed(&self, id: &ItemId, completed: bool) -> BResult<ReminderRecord> {
        let id = id.clone();
        self.job("reminders.complete", T_WRITE, move |s| {
            s.set_task_completed(&id, completed)
        })
    }

    fn delete_task(&self, id: &ItemId) -> BResult<()> {
        let id = id.clone();
        self.job("reminders.delete", T_WRITE, move |s| s.delete_task(&id))
    }

    fn set_task_flagged(&self, id: &ItemId, flagged: bool) -> BResult<()> {
        let id = id.clone();
        self.job("reminders.set_flagged", T_WRITE, move |s| {
            s.set_task_flagged(&id, flagged)
        })
    }
}

/// Flags a message for follow-up (`MarkAsTask(olMarkNoDate)`) or clears the flag, falling back
/// to `FlagStatus` on stores without task flags.
pub fn flag_message(it: &Disp, on: bool) -> CR<()> {
    let r = if on {
        it.call("MarkAsTask", vec![Var::int(4)])
    } else {
        it.call("ClearTaskFlag", vec![])
    };
    match r {
        Ok(_) => Ok(()),
        Err(e) if e.code == ErrorCode::Timeout => Err(e),
        Err(_) => it.put("FlagStatus", Var::int(if on { 2 } else { 0 })),
    }
}

/// Puts the reply / forward text above the quoted message, keeping the body's format.
fn put_text_on_top(it: &Disp, text: &str) -> CR<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    if it.soft("BodyFormat")?.i32() == 2 {
        let html = it.soft_string("HTMLBody")?;
        it.put("HTMLBody", Var::str(&m::insert_on_top(&html, true, text)))
    } else {
        let body = it.soft_string("Body")?;
        it.put("Body", Var::str(&m::insert_on_top(&body, false, text)))
    }
}

/// A `calendar.watch` subscription: dropping it unsubscribes on the STA thread.
struct LiveWatch {
    sta: Arc<Sta<Session>>,
    id: u64,
}

impl WatchHandle for LiveWatch {}

impl Drop for LiveWatch {
    fn drop(&mut self) {
        let id = self.id;
        self.sta
            .post(Duration::from_secs(10), move |s| s.unwatch(id));
    }
}
