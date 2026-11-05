//! The Outlook backend behind the capabilities. Live: classic Outlook over COM on a dedicated STA
//! thread (`com::LiveOutlook`); tests: an in-memory fake. Inputs arrive validated (the capability
//! layer owns every check the mac helper makes); records come back in wire shape with UTC ISO
//! dates.

use std::path::Path;
use std::sync::Arc;

use super::ids::{FolderId, ItemId};
use super::model::{
    AttachmentInfo, CalendarEventRecord, CalendarRecord, ContactName, ContactRecord,
    ContactSummaryRecord, ContactWrite, Destination, EventWrite, FlagChange, MailDraft,
    MailDraftRecord, MailFilter, MailMessage, MailScope, MailSearchResult, MailSummaryRecord,
    MailboxRecord, ReminderRecord, TaskWrite,
};
use crate::node::capability::CapabilityError;

pub type BResult<T> = Result<T, CapabilityError>;

/// Keeps a `calendar.watch` subscription alive; dropping it unsubscribes.
pub trait WatchHandle: Send {}

pub trait OutlookBackend: Send + Sync {
    // Mail
    /// Every mail folder of `account` (every store when None) with its unread count.
    fn mailboxes(&self, account: Option<&str>) -> BResult<Vec<MailboxRecord>>;
    /// Newest first, at most `limit`, in `scope` (the default inbox when empty).
    fn search_mail(
        &self,
        filter: &MailFilter,
        scope: &MailScope,
        limit: usize,
    ) -> BResult<MailSearchResult>;
    /// One message; the body cut to `max_len` characters.
    fn read_mail(&self, id: &ItemId, max_len: usize) -> BResult<MailMessage>;
    fn attachments(&self, id: &ItemId) -> BResult<Vec<AttachmentInfo>>;
    /// Saves attachment `index` (0-based, in `attachments` order) to `path`.
    fn save_attachment(&self, id: &ItemId, index: usize, path: &Path) -> BResult<()>;
    /// The messages selected in Outlook's active window; empty when Outlook is not running
    /// (never starts it).
    fn selected_mail(&self, limit: usize) -> BResult<Vec<MailSummaryRecord>>;
    /// Saves a new draft in the default Drafts folder.
    fn save_draft(&self, draft: &MailDraft) -> BResult<MailDraftRecord>;
    /// Sends a new message (only ever called with an approval).
    fn send_mail(&self, draft: &MailDraft) -> BResult<()>;
    fn reply_draft(
        &self,
        id: &ItemId,
        body: &str,
        reply_all: bool,
        cc: &[String],
    ) -> BResult<MailDraftRecord>;
    fn forward_draft(
        &self,
        id: &ItemId,
        to: &[String],
        cc: &[String],
        body: &str,
    ) -> BResult<MailDraftRecord>;
    /// The unsent draft as it is now (None when it no longer exists or was sent).
    fn draft(&self, id: &ItemId) -> BResult<Option<MailDraftRecord>>;
    fn send_draft(&self, id: &ItemId) -> BResult<()>;
    fn set_flags(&self, ids: &[ItemId], change: &FlagChange) -> BResult<usize>;
    fn move_mail(&self, ids: &[ItemId], to: &Destination) -> BResult<usize>;

    // Calendar
    fn calendars(&self) -> BResult<Vec<CalendarRecord>>;
    /// Events overlapping `[from, to)` (UTC ms), recurring series expanded into occurrences.
    fn events(
        &self,
        from: i64,
        to: i64,
        calendars: Option<&[FolderId]>,
    ) -> BResult<Vec<CalendarEventRecord>>;
    fn create_event(&self, e: &EventWrite) -> BResult<CalendarEventRecord>;
    /// `future`: the rest of a recurring series from this occurrence on.
    fn update_event(
        &self,
        id: &ItemId,
        e: &EventWrite,
        future: bool,
    ) -> BResult<CalendarEventRecord>;
    fn delete_event(&self, id: &ItemId, future: bool) -> BResult<()>;
    /// Calls `on_change` for every change Outlook reports in any calendar folder.
    fn watch_calendars(
        &self,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> BResult<Box<dyn WatchHandle>>;

    // Contacts
    fn contact_summaries(&self) -> BResult<Vec<ContactSummaryRecord>>;
    fn contact_names(&self) -> BResult<Vec<ContactName>>;
    fn read_contact(&self, id: &ItemId) -> BResult<ContactRecord>;
    fn create_contact(&self, c: &ContactWrite) -> BResult<ContactRecord>;
    /// Sets the given fields and adds `emails` / `phones` (never removes).
    fn update_contact(&self, id: &ItemId, c: &ContactWrite) -> BResult<ContactRecord>;

    // Reminders (Outlook tasks; flagged mail where noted)
    fn task_lists(&self) -> BResult<Vec<CalendarRecord>>;
    /// Tasks in `lists` (every task folder when None), by completion.
    fn tasks(
        &self,
        lists: Option<&[FolderId]>,
        completed: Option<bool>,
    ) -> BResult<Vec<ReminderRecord>>;
    /// Open follow-up-flagged mail (Outlook's To-Do List), as flagged reminders.
    fn flagged_mail(&self) -> BResult<Vec<ReminderRecord>>;
    fn create_task(&self, t: &TaskWrite) -> BResult<ReminderRecord>;
    fn update_task(&self, id: &ItemId, t: &TaskWrite) -> BResult<ReminderRecord>;
    /// A task, or a flagged message (completes / reopens its flag).
    fn set_task_completed(&self, id: &ItemId, completed: bool) -> BResult<ReminderRecord>;
    fn delete_task(&self, id: &ItemId) -> BResult<()>;
    /// A task (the "Flagged" category), or a flagged message (its follow-up flag).
    fn set_task_flagged(&self, id: &ItemId, flagged: bool) -> BResult<()>;
}
