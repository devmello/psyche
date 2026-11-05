//! An in-memory Outlook for the capability tests: records in wire shape, every call logged by
//! name, an optional injected failure.

use std::path::Path;
use std::sync::{Arc, Mutex};

use super::backend::{BResult, OutlookBackend, WatchHandle};
use super::ids::{FolderId, ItemId};
use super::model::*;
use crate::node::capability::CapabilityError;
use crate::node::time::parse_iso8601_millis;

pub fn id(n: u32) -> String {
    ItemId::new("AA01", &format!("{n:08X}")).encode()
}

pub fn folder(n: u32) -> String {
    FolderId::new("AA01", &format!("F{n:07X}")).encode()
}

#[derive(Default)]
pub struct State {
    pub calls: Vec<String>,
    pub fail: Option<CapabilityError>,
    pub mailboxes: Vec<MailboxRecord>,
    pub messages: Vec<MailMessage>,
    pub attachments: Vec<AttachmentInfo>,
    pub selected: Vec<MailSummaryRecord>,
    pub drafts: Vec<MailDraftRecord>,
    pub sent: Vec<MailDraft>,
    pub sent_drafts: Vec<String>,
    pub last_search: Option<(MailFilter, MailScope, usize)>,
    pub last_flags: Option<FlagChange>,
    pub last_move: Option<Destination>,
    pub calendars: Vec<CalendarRecord>,
    pub events: Vec<CalendarEventRecord>,
    pub last_event_write: Option<(EventWrite, bool)>,
    pub last_events_query: Option<(i64, i64, Option<Vec<FolderId>>)>,
    pub contacts: Vec<ContactRecord>,
    pub lists: Vec<CalendarRecord>,
    pub tasks: Vec<ReminderRecord>,
    pub flagged_mail: Vec<ReminderRecord>,
    pub last_tasks_query: Option<(Option<Vec<FolderId>>, Option<bool>)>,
    pub last_task_write: Option<TaskWrite>,
    pub watch: Option<Arc<dyn Fn() + Send + Sync>>,
    pub next: u32,
}

#[derive(Default)]
pub struct Fake {
    pub s: Mutex<State>,
}

struct FakeWatch;
impl WatchHandle for FakeWatch {}

fn summary(n: u32, subject: &str, date: &str) -> MailSummaryRecord {
    MailSummaryRecord {
        id: id(n),
        mailbox: "Inbox".into(),
        account: "ann@x.com".into(),
        subject: subject.into(),
        from: "Bob <bob@y.com>".into(),
        date: date.into(),
        read: false,
        flagged: Some(false),
        link: None,
    }
}

pub fn event(
    n: u32,
    title: &str,
    start: &str,
    end: &str,
    availability: &str,
) -> CalendarEventRecord {
    CalendarEventRecord {
        id: id(n),
        calendar_id: folder(1),
        title: title.into(),
        start: start.into(),
        end: end.into(),
        all_day: false,
        location: None,
        notes: None,
        url: None,
        recurring: false,
        attendees: Some(Vec::new()),
        conference_url: None,
        alarms: Some(Vec::new()),
        recurrence: None,
        availability: Some(availability.into()),
    }
}

pub fn task(n: u32, title: &str, due: Option<&str>, completed: bool) -> ReminderRecord {
    ReminderRecord {
        id: id(n),
        list_id: folder(2),
        title: title.into(),
        notes: None,
        due: due.map(String::from),
        completed,
        priority: 0,
        url: None,
        flagged: Some(false),
        alarms: Some(Vec::new()),
        recurrence: None,
    }
}

impl Fake {
    /// A small mailbox, calendar, task list and address book.
    pub fn seeded() -> Arc<Fake> {
        let f = Fake::default();
        {
            let mut s = f.s.lock().unwrap();
            s.next = 100;
            s.mailboxes = vec![MailboxRecord {
                account: "ann@x.com".into(),
                name: "Inbox".into(),
                unread_count: 2,
                special: Some("inbox".into()),
            }];
            s.messages = vec![
                MailMessage {
                    summary: summary(1, "Invoice", "2026-11-04T10:00:00Z"),
                    to: vec!["ann@x.com".into()],
                    cc: vec![],
                    body: "Please pay".into(),
                },
                MailMessage {
                    summary: summary(2, "Lunch?", "2026-11-05T09:00:00Z"),
                    to: vec!["ann@x.com".into()],
                    cc: vec!["cat@z.com".into()],
                    body: "x".repeat(300),
                },
            ];
            s.attachments = vec![
                AttachmentInfo {
                    name: "bill.pdf".into(),
                    mime_type: Some("application/pdf".into()),
                    size: 3,
                },
                AttachmentInfo {
                    name: "logo.png".into(),
                    mime_type: None,
                    size: 4,
                },
            ];
            s.calendars = vec![CalendarRecord {
                id: folder(1),
                title: "Calendar".into(),
                source: "ann@x.com".into(),
                writable: true,
                color: None,
            }];
            s.events = vec![
                event(
                    10,
                    "Standup",
                    "2026-11-05T09:00:00Z",
                    "2026-11-05T09:15:00Z",
                    "busy",
                ),
                event(
                    11,
                    "Lunch",
                    "2026-11-05T12:00:00Z",
                    "2026-11-05T13:00:00Z",
                    "free",
                ),
                event(
                    12,
                    "Review",
                    "2026-11-05T15:00:00Z",
                    "2026-11-05T16:00:00Z",
                    "tentative",
                ),
                event(
                    13,
                    "Next month",
                    "2026-12-05T15:00:00Z",
                    "2026-12-05T16:00:00Z",
                    "busy",
                ),
            ];
            s.lists = vec![CalendarRecord {
                id: folder(2),
                title: "Tasks".into(),
                source: "ann@x.com".into(),
                writable: true,
                color: None,
            }];
            s.tasks = vec![
                task(20, "Pay rent", Some("2026-11-01T04:00:00Z"), false),
                task(21, "Call mom", Some("2026-11-05T05:00:00Z"), false),
                task(22, "Call mom", None, false),
                task(23, "Filed taxes", Some("2026-04-15T04:00:00Z"), true),
            ];
            let mut fm = task(30, "Reply to Bob", None, false);
            fm.flagged = Some(true);
            s.flagged_mail = vec![fm];
            s.contacts = vec![ContactRecord {
                id: id(40),
                given_name: "Ann".into(),
                family_name: "Lee".into(),
                nickname: String::new(),
                organization: "Acme".into(),
                job_title: String::new(),
                emails: vec![LabeledValue {
                    label: String::new(),
                    value: "ann@x.com".into(),
                }],
                phones: vec![LabeledValue {
                    label: "mobile".into(),
                    value: "+1 555 0100".into(),
                }],
                addresses: vec![],
                urls: vec![],
                birthday: Some("--07-04".into()),
                groups: vec![],
            }];
        }
        Arc::new(f)
    }

    fn enter(&self, name: &str) -> BResult<std::sync::MutexGuard<'_, State>> {
        let mut s = self.s.lock().unwrap();
        s.calls.push(name.into());
        match s.fail.clone() {
            Some(e) => Err(e),
            None => Ok(s),
        }
    }

    pub fn calls(&self) -> Vec<String> {
        self.s.lock().unwrap().calls.clone()
    }

    fn not_found(reason: &str) -> CapabilityError {
        CapabilityError::not_found(reason, "not found")
    }
}

fn mk_draft(
    s: &mut State,
    to: Vec<String>,
    cc: Vec<String>,
    subject: &str,
    body: &str,
) -> MailDraftRecord {
    s.next += 1;
    let d = MailDraftRecord::new(id(s.next), subject.into(), to, cc, body.into());
    s.drafts.push(d.clone());
    d
}

impl OutlookBackend for Fake {
    fn mailboxes(&self, account: Option<&str>) -> BResult<Vec<MailboxRecord>> {
        let s = self.enter("mailboxes")?;
        Ok(s.mailboxes
            .iter()
            .filter(|m| account.is_none_or(|a| a == m.account))
            .cloned()
            .collect())
    }

    fn search_mail(
        &self,
        filter: &MailFilter,
        scope: &MailScope,
        limit: usize,
    ) -> BResult<MailSearchResult> {
        let mut s = self.enter("search_mail")?;
        s.last_search = Some((filter.clone(), scope.clone(), limit));
        let q = filter.query.to_lowercase();
        let mut messages: Vec<MailSummaryRecord> = s
            .messages
            .iter()
            .map(|m| m.summary.clone())
            .filter(|m| q.is_empty() || m.subject.to_lowercase().contains(&q))
            .collect();
        super::mail::newest_first(&mut messages);
        messages.truncate(limit);
        Ok(MailSearchResult {
            messages,
            truncated: false,
            note: None,
        })
    }

    fn read_mail(&self, id: &ItemId, max_len: usize) -> BResult<MailMessage> {
        let s = self.enter("read_mail")?;
        let mut m = s
            .messages
            .iter()
            .find(|m| m.summary.id == id.encode())
            .cloned()
            .ok_or_else(|| Self::not_found("message_not_found"))?;
        m.body = m.body.chars().take(max_len).collect();
        Ok(m)
    }

    fn attachments(&self, _id: &ItemId) -> BResult<Vec<AttachmentInfo>> {
        Ok(self.enter("attachments")?.attachments.clone())
    }

    fn save_attachment(&self, _id: &ItemId, index: usize, path: &Path) -> BResult<()> {
        let s = self.enter("save_attachment")?;
        let a = &s.attachments[index];
        std::fs::write(path, vec![b'x'; a.size as usize])
            .map_err(|_| CapabilityError::internal("x", "write"))
    }

    fn selected_mail(&self, _limit: usize) -> BResult<Vec<MailSummaryRecord>> {
        Ok(self.enter("selected_mail")?.selected.clone())
    }

    fn save_draft(&self, d: &MailDraft) -> BResult<MailDraftRecord> {
        let mut s = self.enter("save_draft")?;
        Ok(mk_draft(
            &mut s,
            d.to.clone(),
            d.cc.clone().unwrap_or_default(),
            &d.subject,
            &d.body,
        ))
    }

    fn send_mail(&self, d: &MailDraft) -> BResult<()> {
        self.enter("send_mail")?.sent.push(d.clone());
        Ok(())
    }

    fn reply_draft(
        &self,
        id: &ItemId,
        body: &str,
        reply_all: bool,
        cc: &[String],
    ) -> BResult<MailDraftRecord> {
        let mut s = self.enter("reply_draft")?;
        let m = s
            .messages
            .iter()
            .find(|m| m.summary.id == id.encode())
            .cloned()
            .ok_or_else(|| Self::not_found("message_not_found"))?;
        let mut to = vec!["bob@y.com".to_string()];
        if reply_all {
            to.extend(m.cc.clone());
        }
        Ok(mk_draft(
            &mut s,
            to,
            cc.to_vec(),
            &format!("RE: {}", m.summary.subject),
            &format!("{body}\r\n\r\n{}", m.body),
        ))
    }

    fn forward_draft(
        &self,
        id: &ItemId,
        to: &[String],
        cc: &[String],
        body: &str,
    ) -> BResult<MailDraftRecord> {
        let mut s = self.enter("forward_draft")?;
        let m = s
            .messages
            .iter()
            .find(|m| m.summary.id == id.encode())
            .cloned()
            .ok_or_else(|| Self::not_found("message_not_found"))?;
        Ok(mk_draft(
            &mut s,
            to.to_vec(),
            cc.to_vec(),
            &format!("FW: {}", m.summary.subject),
            body,
        ))
    }

    fn draft(&self, id: &ItemId) -> BResult<Option<MailDraftRecord>> {
        let s = self.enter("draft")?;
        Ok(s.drafts.iter().find(|d| d.draft_id == id.encode()).cloned())
    }

    fn send_draft(&self, id: &ItemId) -> BResult<()> {
        let mut s = self.enter("send_draft")?;
        s.drafts.retain(|d| d.draft_id != id.encode());
        s.sent_drafts.push(id.encode());
        Ok(())
    }

    fn set_flags(&self, ids: &[ItemId], change: &FlagChange) -> BResult<usize> {
        let mut s = self.enter("set_flags")?;
        s.last_flags = Some(*change);
        Ok(ids.len())
    }

    fn move_mail(&self, ids: &[ItemId], to: &Destination) -> BResult<usize> {
        let mut s = self.enter("move_mail")?;
        s.last_move = Some(to.clone());
        Ok(ids.len())
    }

    fn calendars(&self) -> BResult<Vec<CalendarRecord>> {
        Ok(self.enter("calendars")?.calendars.clone())
    }

    fn events(
        &self,
        from: i64,
        to: i64,
        calendars: Option<&[FolderId]>,
    ) -> BResult<Vec<CalendarEventRecord>> {
        let mut s = self.enter("events")?;
        s.last_events_query = Some((from, to, calendars.map(<[FolderId]>::to_vec)));
        // Deliberately loose (the capability applies the exact window).
        Ok(s.events.clone())
    }

    fn create_event(&self, e: &EventWrite) -> BResult<CalendarEventRecord> {
        let mut s = self.enter("create_event")?;
        s.last_event_write = Some((e.clone(), false));
        s.next += 1;
        let r = event(
            s.next,
            e.title.as_deref().unwrap_or_default(),
            &iso(e.start.unwrap_or(0)),
            &iso(e.end.unwrap_or(0)),
            if e.busy == Some(false) {
                "free"
            } else {
                "busy"
            },
        );
        s.events.push(r.clone());
        Ok(r)
    }

    fn update_event(
        &self,
        id: &ItemId,
        e: &EventWrite,
        future: bool,
    ) -> BResult<CalendarEventRecord> {
        let mut s = self.enter("update_event")?;
        s.last_event_write = Some((e.clone(), future));
        let ev = s
            .events
            .iter_mut()
            .find(|x| x.id == id.encode())
            .ok_or_else(|| Self::not_found("event_not_found"))?;
        if let Some(t) = &e.title {
            ev.title = t.clone();
        }
        Ok(ev.clone())
    }

    fn delete_event(&self, id: &ItemId, future: bool) -> BResult<()> {
        let mut s = self.enter(if future {
            "delete_event_future"
        } else {
            "delete_event"
        })?;
        let before = s.events.len();
        s.events.retain(|x| x.id != id.encode());
        if s.events.len() == before {
            return Err(Self::not_found("event_not_found"));
        }
        Ok(())
    }

    fn watch_calendars(
        &self,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> BResult<Box<dyn WatchHandle>> {
        self.enter("watch")?.watch = Some(on_change);
        Ok(Box::new(FakeWatch))
    }

    fn contact_summaries(&self) -> BResult<Vec<ContactSummaryRecord>> {
        let s = self.enter("contact_summaries")?;
        Ok(s.contacts
            .iter()
            .map(|c| ContactSummaryRecord {
                id: c.id.clone(),
                name: format!("{} {}", c.given_name, c.family_name).trim().into(),
                organization: c.organization.clone(),
                emails: c.emails.iter().map(|e| e.value.clone()).collect(),
                phones: c.phones.iter().map(|p| p.value.clone()).collect(),
            })
            .collect())
    }

    fn contact_names(&self) -> BResult<Vec<ContactName>> {
        let s = self.enter("contact_names")?;
        Ok(s.contacts
            .iter()
            .map(|c| ContactName {
                id: c.id.clone(),
                name: format!("{} {}", c.given_name, c.family_name).trim().into(),
                given_name: c.given_name.clone(),
                family_name: c.family_name.clone(),
                nickname: c.nickname.clone(),
                organization: c.organization.clone(),
            })
            .collect())
    }

    fn read_contact(&self, id: &ItemId) -> BResult<ContactRecord> {
        let s = self.enter("read_contact")?;
        s.contacts
            .iter()
            .find(|c| c.id == id.encode())
            .cloned()
            .ok_or_else(|| Self::not_found("contact_not_found"))
    }

    fn create_contact(&self, c: &ContactWrite) -> BResult<ContactRecord> {
        let mut s = self.enter("create_contact")?;
        s.next += 1;
        let r = ContactRecord {
            id: id(s.next),
            given_name: c.given_name.clone().unwrap_or_default(),
            family_name: c.family_name.clone().unwrap_or_default(),
            nickname: String::new(),
            organization: c.organization.clone().unwrap_or_default(),
            job_title: c.job_title.clone().unwrap_or_default(),
            emails: c.emails.clone(),
            phones: c.phones.clone(),
            addresses: vec![],
            urls: vec![],
            birthday: c
                .birthday
                .map(|(y, m, d)| super::pim::birthday_string(y, m, d)),
            groups: vec![],
        };
        s.contacts.push(r.clone());
        Ok(r)
    }

    fn update_contact(&self, id: &ItemId, c: &ContactWrite) -> BResult<ContactRecord> {
        let mut s = self.enter("update_contact")?;
        let r = s
            .contacts
            .iter_mut()
            .find(|x| x.id == id.encode())
            .ok_or_else(|| Self::not_found("contact_not_found"))?;
        if let Some(v) = &c.job_title {
            r.job_title = v.clone();
        }
        r.emails.extend(c.emails.clone());
        Ok(r.clone())
    }

    fn task_lists(&self) -> BResult<Vec<CalendarRecord>> {
        Ok(self.enter("task_lists")?.lists.clone())
    }

    fn tasks(
        &self,
        lists: Option<&[FolderId]>,
        completed: Option<bool>,
    ) -> BResult<Vec<ReminderRecord>> {
        let mut s = self.enter("tasks")?;
        s.last_tasks_query = Some((lists.map(<[FolderId]>::to_vec), completed));
        Ok(s.tasks
            .iter()
            .filter(|t| completed.is_none_or(|c| t.completed == c))
            .cloned()
            .collect())
    }

    fn flagged_mail(&self) -> BResult<Vec<ReminderRecord>> {
        Ok(self.enter("flagged_mail")?.flagged_mail.clone())
    }

    fn create_task(&self, t: &TaskWrite) -> BResult<ReminderRecord> {
        let mut s = self.enter("create_task")?;
        s.last_task_write = Some(t.clone());
        s.next += 1;
        let r = task(
            s.next,
            t.title.as_deref().unwrap_or_default(),
            t.due.flatten().map(iso).as_deref(),
            false,
        );
        s.tasks.push(r.clone());
        Ok(r)
    }

    fn update_task(&self, id: &ItemId, t: &TaskWrite) -> BResult<ReminderRecord> {
        let mut s = self.enter("update_task")?;
        s.last_task_write = Some(t.clone());
        let r = s
            .tasks
            .iter_mut()
            .find(|x| x.id == id.encode())
            .ok_or_else(|| Self::not_found("reminder_not_found"))?;
        if let Some(d) = t.due {
            r.due = d.map(iso);
        }
        Ok(r.clone())
    }

    fn set_task_completed(&self, id: &ItemId, completed: bool) -> BResult<ReminderRecord> {
        let mut s = self.enter("set_task_completed")?;
        let r = s
            .tasks
            .iter_mut()
            .find(|x| x.id == id.encode())
            .ok_or_else(|| Self::not_found("reminder_not_found"))?;
        r.completed = completed;
        Ok(r.clone())
    }

    fn delete_task(&self, id: &ItemId) -> BResult<()> {
        let mut s = self.enter("delete_task")?;
        s.tasks.retain(|t| t.id != id.encode());
        Ok(())
    }

    fn set_task_flagged(&self, id: &ItemId, flagged: bool) -> BResult<()> {
        let mut s = self.enter("set_task_flagged")?;
        if let Some(r) = s.tasks.iter_mut().find(|x| x.id == id.encode()) {
            r.flagged = Some(flagged);
        }
        Ok(())
    }
}

/// Parses an ISO string the fake produced (tests).
pub fn ms(s: &str) -> i64 {
    parse_iso8601_millis(s).unwrap()
}
