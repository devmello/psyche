//! `mail.*`, `calendar.*`, `contacts.*`, `reminders.*` on classic Outlook: the Windows
//! counterpart of the mac helper's Mail / Calendar / Contacts / Reminders adapters, under the same
//! capability names, input schemas, side effects, target kinds, receipt kinds and result shapes
//! (`AppleAppsCapabilities`, `CalendarWatch`, `ContactsCapabilities`).
//!
//! ## Availability
//!
//! Registered only when classic Outlook's COM server is installed (`availability`): otherwise
//! nothing is advertised and the Gateway hides the connector; `health.providers.outlook` and
//! `permissions.status.outlook` say why (`outlook_not_installed`, or `new_outlook_only`: the new
//! Outlook for Windows has no COM object model and cannot be automated).
//!
//! ## How Outlook is driven
//!
//! Late-bound `IDispatch` on `Outlook.Application`, on one dedicated STA thread with a message
//! pump (`com::sta`): Outlook's object model is apartment-threaded and its events arrive as
//! window messages. Every capability is one job on that thread with a deadline; every COM call
//! checks it, and a call still blocked when it passes is cancelled with `CoCancelCall` (a
//! security prompt or another modal dialog in Outlook otherwise blocks forever). A job that has
//! not started by its deadline is dropped, so a write never happens after its caller gave up.
//!
//! Outlook's object model guard shows "A program is trying to access e-mail address information"
//! for external programs when Windows reports no up-to-date antivirus (or a policy says to warn).
//! The helper checks `Application.IsTrusted` first and never triggers the prompt: guarded
//! operations (message bodies and recipients, sending, saving attachments, contact emails) fail
//! with `forbidden` / `outlook_object_model_guard`, and reads degrade where the mac shape allows
//! (`from` empty, `notes` null, no attendees).
//!
//! ## Mapping (and where it differs from the Mac)
//!
//! - **Ids** (`ids`): `ol1.<StoreID>.<EntryID>[.<occurrence start>]`, base64url; folders
//!   `olf1.…`. Opaque strings, longer than Mail's numeric ids; they survive restarts (a draft id
//!   stays valid after Outlook restarts, unlike Mail's).
//! - **Dates** (`dates`): appointments use `StartUTC` / `EndUTC`; local fields (`ReceivedTime`,
//!   task dates, reminders, birthdays) convert through Windows' dynamic time zone (DST per year).
//!   `Restrict` filters use the locale's date format, local for Jet (`[Start]`) and UTC for DASL.
//! - **Mail**: accounts are stores (`Store.DisplayName`), mailboxes folder paths `Parent/Child`;
//!   no unified inbox row. `mail.search` restricts the folder with DASL (subject / sender name /
//!   address `LIKE`, read flag, received window), `source` is `"outlook"`. No `link` (Outlook
//!   has no `message://` URLs). `mail.selected` reads `ActiveExplorer().Selection` and never starts
//!   Outlook. Drafts are saved in Drafts; `mail.send` goes through the Outbox (Outlook sends it
//!   on its next send / receive). Flag colors are best effort (`FlagIcon`; Outlook shows one
//!   flag). `archive` is the store's top-level "Archive" folder, `junk` its Junk Email folder.
//! - **Calendar**: every store's calendar folders. Occurrences expanded with
//!   `IncludeRecurrences` over a sorted, restricted date window. One reminder per appointment
//!   (the first alarm). `url` is kept in a custom item property (`PsycheURL`). `span: future`
//!   on an occurrence ends the series there for delete; for update it applies to the whole
//!   series only from its first occurrence (`span_future_unsupported` otherwise). `free_busy`
//!   is computed from the owner's own events (as EventKit does), not `Recipient.FreeBusy`.
//!   `calendar.watch` subscribes to `Items.ItemAdd / ItemChange / ItemRemove` of each calendar
//!   folder and emits the same debounced `calendar.changed` events; it ends if Outlook quits.
//! - **Reminders** are Outlook tasks; lists are task folders. Due dates are dates (Outlook keeps
//!   no due time). Priority ↔ importance (high 1, normal 0, low 9). `flagged` on a task is the
//!   "Flagged" category; `reminders.list {flagged: true}` also returns mail flagged for follow-up
//!   (Outlook's To-Do List), whose ids `reminders.complete` / `set_flagged` accept (completing
//!   or clearing the flag) and `update` / `delete` refuse. `url` is a custom property.
//! - **Contacts**: every store's contact folders. Outlook holds 3 email addresses and fixed
//!   phone fields (mobile, work ×2, home ×2, main, company, faxes, pager, car, other): adds that
//!   do not fit fail with `invalid_params`. `groups` are the contact's categories.
//!
//! Logs are content-free (capability, phase, counts, HRESULTs).

pub mod availability;
pub mod backend;
pub mod caps;
pub mod caps_mail;
pub mod caps_pim;
pub mod com;
pub mod dates;
pub mod errors;
pub mod ids;
pub mod mail;
pub mod model;
pub mod pim;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

use crate::node::{CapabilityRegistry, Runtime};
use availability::Availability;
use caps::Ctx;

/// Process-wide Outlook state: what the registry says, and what the live session last learned.
pub struct OutlookState {
    pub availability: Availability,
    /// `Application.IsTrusted` from the last session (None until Outlook was used).
    pub trusted: Mutex<Option<bool>>,
}

pub fn state(rt: &Runtime) -> Arc<OutlookState> {
    rt.service(|| OutlookState {
        availability: availability::detect(&rt.env),
        trusted: Mutex::new(None),
    })
}

/// `health.providers.outlook` / `permissions.status.outlook`.
pub fn status_json(rt: &Runtime) -> Value {
    let s = state(rt);
    let mut v = s.availability.to_json();
    v["trusted"] = json!(*s.trusted.lock().unwrap_or_else(|p| p.into_inner()));
    v
}

pub fn register(reg: &mut CapabilityRegistry) {
    let rt = reg.runtime().clone();
    let st = state(&rt);
    if let Some(reason) = st.availability.reason() {
        rt.log
            .info(format!("outlook capabilities not offered reason={reason}"));
        return;
    }
    let backend = Arc::new(com::LiveOutlook::new(rt.log.clone(), st));
    register_with(
        reg,
        &Ctx {
            backend,
            zone: Arc::new(dates::WindowsZone),
            env: rt.env.clone(),
            home: rt.home.clone(),
            debounce: Duration::from_secs(30),
            now: caps::now_ms,
        },
    );
}

/// Registers every Outlook capability over `ctx.backend` (the fake in tests).
pub fn register_with(reg: &mut CapabilityRegistry, ctx: &Ctx) {
    caps_pim::register_calendar(reg, ctx);
    caps_pim::register_reminders(reg, ctx);
    caps_mail::register(reg, ctx);
    caps_pim::register_contacts(reg, ctx);
}
