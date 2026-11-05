//! `calendar.*`, `reminders.*` and `contacts.*` on Outlook: the mac helper's names, schemas,
//! side effects, receipt kinds and result shapes (`AppleAppsCapabilities`, `CalendarWatch`,
//! `ContactsCapabilities`), backed by Outlook calendars, tasks and contacts.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::caps::{
    CAP_TIMEOUT, Ctx, alarm_schema, guard_cancel, ids_array, iso_schema, limit_schema,
    offset_schema, props, recurrence_schema, str_desc_max, str_max, to_json, untrusted,
    untrusted_list,
};
use super::dates::overlaps;
use super::ids::{FolderId, ItemId, folder_ids};
use super::model::{
    Alarm, ContactWrite, EventWrite, LabeledValue, RawContactInput, RawEventInput,
    RawReminderInput, TaskWrite, iso_param, limit, offset, text,
};
use super::pim::{self, ReminderQuery};
use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, OsPermission, ReceiptDraft, SideEffect,
    TargetKind,
};
use crate::node::time::parse_iso8601_millis;
use crate::node::{CapabilityRegistry, schema};

fn event_fields() -> Vec<(&'static str, Value)> {
    vec![
        ("calendarId", schema::string(None)),
        ("title", str_max(500)),
        ("start", iso_schema()),
        ("end", iso_schema()),
        ("allDay", schema::boolean(None)),
        ("location", str_max(500)),
        ("notes", str_max(10_000)),
        ("url", str_max(2_000)),
        (
            "alarms",
            schema::array(alarm_schema(), Some("Replaces the alarms"), Some(5)),
        ),
        ("recurrence", recurrence_schema()),
        (
            "availability",
            schema::string_enum(Some("Show as busy or free"), &["busy", "free"]),
        ),
    ]
}

fn span_schema() -> Value {
    schema::string_enum(None, &["this", "future"])
}

fn check_span(span: Option<&str>) -> Result<bool, CapabilityError> {
    match span {
        None | Some("this") => Ok(false),
        Some("future") => Ok(true),
        _ => Err(CapabilityError::invalid_params(
            "span is this or future",
            Some("span"),
        )),
    }
}

/// Validates an event write (create when `create`): the mac checks plus Outlook's one
/// reminder per appointment.
fn event_write(p: &RawEventInput, create: bool) -> Result<EventWrite, CapabilityError> {
    text(p.title.as_deref(), 500, "title", create)?;
    text(p.location.as_deref(), 500, "location", false)?;
    text(p.notes.as_deref(), 10_000, "notes", false)?;
    text(p.url.as_deref(), 2_000, "url", false)?;
    if let Some(Some(r)) = &p.recurrence {
        r.validate()?;
    }
    let start = p
        .start
        .as_deref()
        .map(|s| iso_param(s, "start"))
        .transpose()?;
    let end = p.end.as_deref().map(|s| iso_param(s, "end")).transpose()?;
    if create && (start.is_none() || end.is_none()) {
        let f = if start.is_none() { "start" } else { "end" };
        return Err(CapabilityError::invalid_params(
            format!("missing parameter {f}"),
            Some(f),
        ));
    }
    if let (Some(s), Some(e)) = (start, end)
        && e < s
    {
        return Err(CapabilityError::invalid_params(
            "end is before start",
            Some("end"),
        ));
    }
    let alarms = match &p.alarms {
        Some(xs) if xs.len() > 5 => {
            return Err(CapabilityError::invalid_params(
                "at most 5 alarms",
                Some("alarms"),
            ));
        }
        Some(xs) => Some(xs.iter().map(Alarm::parse).collect::<Result<Vec<_>, _>>()?),
        None => None,
    };
    let busy = match p.availability.as_deref() {
        None => None,
        Some("busy") => Some(true),
        Some("free") => Some(false),
        Some(_) => {
            return Err(CapabilityError::invalid_params(
                "availability is busy or free",
                Some("availability"),
            ));
        }
    };
    let calendar = match (&p.calendar_id, create) {
        (Some(c), true) => Some(FolderId::decode(c, "calendarId")?),
        _ => None,
    };
    Ok(EventWrite {
        calendar,
        title: p.title.clone(),
        start,
        end,
        all_day: p.all_day,
        location: p.location.clone(),
        notes: p.notes.clone(),
        url: p.url.clone(),
        alarms,
        recurrence: p.recurrence.clone(),
        busy,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListEvents {
    from: String,
    to: String,
    calendar_ids: Option<Vec<String>>,
    query: Option<String>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreeBusy {
    from: String,
    to: String,
    calendar_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct DeleteEvent {
    id: String,
    span: Option<String>,
}

fn window(from: &str, to: &str, max_days: i64) -> Result<(i64, i64), CapabilityError> {
    let (f, t) = (iso_param(from, "from")?, iso_param(to, "to")?);
    if t <= f || t - f > max_days * 86_400_000 {
        return Err(CapabilityError::invalid_params(
            format!("to must be after from, within {max_days} days"),
            Some("to"),
        ));
    }
    Ok((f, t))
}

pub fn register_calendar(reg: &mut CapabilityRegistry, c: &Ctx) {
    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.list_calendars",
            "Calendars in Outlook (every store's calendar folders): id, title, account, writable.",
            SideEffect::Read,
        )
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            guard_cancel(&ctx)?;
            untrusted_list("calendars", &x.backend.calendars()?)
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.list_events",
            "Events between from and to (at most 366 days) in Outlook, recurring series expanded, optionally in some calendars or matching text in the title, location or notes. Each event has its attendees (read-only), a conferenceUrl (Zoom / Meet / Teams / Webex) found in its URL, location or notes, alarms, recurrence and availability.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("from", iso_schema()),
                ("to", iso_schema()),
                ("calendarIds", ids_array(50)),
                ("query", str_desc_max("Text in the title, location or notes", 200)),
                ("limit", limit_schema()),
            ],
            &["from", "to"],
        ))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ListEvents = ctx.decode()?;
            let (from, to) = window(&p.from, &p.to, 366)?;
            text(p.query.as_deref(), 200, "query", false)?;
            let lim = limit(p.limit, 50)?;
            let cals = folder_ids(&p.calendar_ids, "calendarIds")?;
            guard_cancel(&ctx)?;
            let mut events = x.backend.events(from, to, cals.as_deref())?;
            events.retain(|e| match (parse_iso8601_millis(&e.start), parse_iso8601_millis(&e.end)) {
                (Some(s), Some(en)) => overlaps(s, en, from, to),
                _ => false,
            });
            untrusted_list("events", &pim::select_events(events, p.query.as_deref(), lim))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.create_event",
            "Create an event in Outlook (the default calendar unless calendarId), with an optional reminder (Outlook keeps one: the first alarm), a recurrence and busy / free. Attendees are not invited: to invite people, send an invitation email instead.",
            SideEffect::Write,
        )
        .input(schema::object(event_fields(), &["title", "start", "end"]))
        .receipt("calendar_write")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawEventInput = ctx.decode()?;
            let w = event_write(&p, true)?;
            guard_cancel(&ctx)?;
            let e = x.backend.create_event(&w)?;
            let summary = format!("Created event {}", e.title);
            let id = e.id.clone();
            Ok(CapabilityOutput::with_receipt(
                json!({"event": to_json(&e)?}),
                ReceiptDraft::ok(summary).with_ref("eventId", id),
            ))
        },
    );

    let x = c.clone();
    let update_fields = props(
        &event_fields(),
        vec![("id", schema::string(None)), ("span", span_schema())],
    )
    .into_iter()
    .filter(|(k, _)| *k != "calendarId")
    .collect();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.update_event",
            "Change an event's fields; span: future for the rest of a recurring series.",
            SideEffect::Write,
        )
        .input(schema::object(update_fields, &["id"]))
        .receipt("calendar_write")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawEventInput = ctx.decode()?;
            let id = ItemId::decode(p.id.as_deref().unwrap_or_default(), "id")?;
            let future = check_span(p.span.as_deref())?;
            let w = event_write(&p, false)?;
            guard_cancel(&ctx)?;
            let e = x.backend.update_event(&id, &w, future)?;
            let summary = format!("Updated event {}", e.title);
            let eid = e.id.clone();
            Ok(CapabilityOutput::with_receipt(
                json!({"event": to_json(&e)?}),
                ReceiptDraft::ok(summary).with_ref("eventId", eid),
            ))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.free_busy",
            "Busy blocks (busy, tentative, unavailable; free events left out) between from and to (at most 62 days), in start order. Finding free slots is the caller's job.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![("from", iso_schema()), ("to", iso_schema()), ("calendarIds", ids_array(50))],
            &["from", "to"],
        ))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: FreeBusy = ctx.decode()?;
            let (from, to) = window(&p.from, &p.to, 62)?;
            let cals = folder_ids(&p.calendar_ids, "calendarIds")?;
            guard_cancel(&ctx)?;
            let mut events = x.backend.events(from, to, cals.as_deref())?;
            events.retain(|e| match (parse_iso8601_millis(&e.start), parse_iso8601_millis(&e.end)) {
                (Some(s), Some(en)) => overlaps(s, en, from, to),
                _ => false,
            });
            // Busy blocks carry no titles or notes: not untrusted content.
            Ok(CapabilityOutput::new(json!({"blocks": to_json(&pim::busy_blocks(&events))?})))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "calendar.delete_event",
            "Delete an event; span: future deletes this and the later events of a recurring series. Always asks.",
            SideEffect::Destructive,
        )
        .input(schema::object(
            vec![("id", schema::string(None)), ("span", span_schema())],
            &["id"],
        ))
        .receipt("calendar_write")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: DeleteEvent = ctx.decode()?;
            let future = check_span(p.span.as_deref())?;
            let id = ItemId::decode(&p.id, "id")?;
            guard_cancel(&ctx)?;
            x.backend.delete_event(&id, future)?;
            Ok(CapabilityOutput::with_receipt(
                json!({"deleted": true}),
                ReceiptDraft::ok("Deleted an event").with_ref("eventId", p.id),
            ))
        },
    );

    let x = c.clone();
    reg.add(
        CapabilitySpec::new(
            "calendar.watch",
            "Streams calendar.changed events when an Outlook calendar changes (this PC, a sync or another app), at most one per 30 s, until cancelled. Says that something changed, not what: re-read the window you need with calendar.list_events. Ends (with the count sent) if Outlook quits.",
            SideEffect::Read,
        )
        .input(schema::empty())
        .streaming()
        .permissions(&[OsPermission::Calendars]),
        move |ctx| {
            let x = x.clone();
            async move {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
                let b = x.backend.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    b.watch_calendars(Arc::new(move || {
                        let _ = tx.send(());
                    }))
                })
                .await
                .map_err(|_| CapabilityError::internal("internal", "calendar.watch failed to start"))??;
                let sent = run_watch(rx, x.debounce, x.now, &|v| ctx.emit(v)).await;
                drop(handle);
                if ctx.is_cancelled() {
                    return Err(CapabilityError::cancelled());
                }
                Ok(CapabilityOutput::new(json!({"events": sent})))
            }
        },
    );
}

/// `CalendarWatchCore.run`: a change opens a window of `debounce`, changes inside it are folded
/// in, one event goes out when it closes. Returns how many events went out when `changes` ends.
pub async fn run_watch(
    mut changes: tokio::sync::mpsc::UnboundedReceiver<()>,
    debounce: std::time::Duration,
    now: fn() -> i64,
    emit: &(dyn Fn(Value) + Sync),
) -> u32 {
    let mut fold = pim::Fold::default();
    let mut closes: Option<tokio::time::Instant> = None;
    let mut sent = 0u32;
    loop {
        let sleep = async {
            match closes {
                Some(t) => tokio::time::sleep_until(t).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            m = changes.recv() => match m {
                Some(()) => {
                    if fold.note() {
                        closes = Some(tokio::time::Instant::now() + debounce);
                    }
                }
                None => break,
            },
            _ = sleep => {
                closes = None;
                let n = fold.take();
                if n > 0 {
                    sent += 1;
                    emit(pim::changed_event(now(), n));
                }
            }
        }
    }
    sent
}

// MARK: - Reminders

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListReminders {
    list_ids: Option<Vec<String>>,
    completed: Option<bool>,
    due_before: Option<String>,
    overdue: Option<bool>,
    due_today: Option<bool>,
    flagged: Option<bool>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteReminder {
    id: Option<String>,
    title: Option<String>,
    list_id: Option<String>,
    completed: Option<bool>,
}

#[derive(Deserialize)]
struct ReminderRef {
    id: String,
}

#[derive(Deserialize)]
struct SetFlagged {
    id: String,
    flagged: bool,
}

fn check_priority(p: Option<i64>) -> Result<(), CapabilityError> {
    match p {
        Some(p) if !(0..=9).contains(&p) => Err(CapabilityError::invalid_params(
            "priority is 0–9",
            Some("priority"),
        )),
        _ => Ok(()),
    }
}

fn reminder_receipt(r: &super::model::ReminderRecord, summary: String) -> ReceiptDraft {
    ReceiptDraft::ok(summary).with_ref("reminderId", r.id.clone())
}

pub fn register_reminders(reg: &mut CapabilityRegistry, c: &Ctx) {
    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.list_lists",
            "Reminders lists: Outlook task folders (every store).",
            SideEffect::Read,
        )
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            guard_cancel(&ctx)?;
            untrusted_list("lists", &x.backend.task_lists()?)
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.list",
            "Reminders (Outlook tasks), soonest due first: optionally by list, completion, due before, overdue (open and past due), due today, flagged (tasks in the \"Flagged\" category, plus mail flagged for follow-up) and text in the title or notes.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("listIds", ids_array(50)),
                ("completed", schema::boolean(None)),
                ("dueBefore", iso_schema()),
                ("overdue", schema::boolean(Some("Only open reminders past their due time"))),
                ("dueToday", schema::boolean(Some("Only reminders due today"))),
                ("flagged", schema::boolean(Some("Only flagged reminders"))),
                ("query", str_desc_max("Text in the title or notes", 200)),
                ("limit", limit_schema()),
                ("offset", offset_schema()),
            ],
            &[],
        ))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ListReminders = ctx.decode()?;
            let due_before = p.due_before.as_deref().map(|d| iso_param(d, "dueBefore")).transpose()?;
            text(p.query.as_deref(), 200, "query", false)?;
            let lists = folder_ids(&p.list_ids, "listIds")?;
            let filter = ReminderQuery {
                overdue: p.overdue == Some(true),
                due_today: p.due_today == Some(true),
                query: p.query.clone().unwrap_or_default(),
                flagged_only: p.flagged == Some(true),
                offset: offset(p.offset)?,
            };
            let lim = limit(p.limit, 50)?;
            // Overdue reminders are open ones.
            let completed = if p.overdue == Some(true) { Some(false) } else { p.completed };
            guard_cancel(&ctx)?;
            let mut rows = x.backend.tasks(lists.as_deref(), completed)?;
            if p.flagged == Some(true) && lists.is_none() && completed != Some(true) {
                rows.extend(x.backend.flagged_mail()?);
            }
            if let Some(db) = due_before {
                rows.retain(|r| r.due.as_deref().and_then(parse_iso8601_millis).is_some_and(|d| d <= db));
            }
            untrusted_list("reminders", &filter.apply(rows, (x.now)(), x.zone.as_ref(), lim))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.create",
            "Create a reminder as an Outlook task (the default Tasks folder unless listId), with an optional url (e.g. the mail it came from), alarm and recurrence (needs a due date). Outlook tasks are due on a date: the time of day is not kept.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("listId", schema::string(None)),
                ("title", str_max(500)),
                ("notes", str_max(10_000)),
                ("due", iso_schema()),
                ("priority", schema::integer(None, Some(0), Some(9))),
                ("url", str_desc_max("A link to keep with it, e.g. message://… from mail.read", 2_000)),
                ("alarm", alarm_schema()),
                ("recurrence", recurrence_schema()),
            ],
            &["title"],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawReminderInput = ctx.decode()?;
            text(p.title.as_deref(), 500, "title", true)?;
            text(p.notes.as_deref(), 10_000, "notes", false)?;
            text(p.url.as_deref(), 2_000, "url", false)?;
            if let Some(r) = &p.recurrence {
                r.validate()?;
            }
            check_priority(p.priority)?;
            let due = match &p.due {
                Some(Some(d)) => Some(iso_param(d, "due")?),
                _ => None,
            };
            if p.recurrence.is_some() && due.is_none() {
                return Err(CapabilityError::invalid_params("a repeating reminder needs a due date", Some("recurrence")));
            }
            let w = TaskWrite {
                list: p.list_id.as_deref().map(|l| FolderId::decode(l, "listId")).transpose()?,
                title: p.title.clone(),
                notes: p.notes.clone(),
                due: due.map(Some),
                completed: None,
                priority: p.priority,
                url: p.url.clone(),
                alarm: p.alarm.as_ref().map(Alarm::parse).transpose()?,
                recurrence: p.recurrence.clone(),
            };
            guard_cancel(&ctx)?;
            let r = x.backend.create_task(&w)?;
            let rc = reminder_receipt(&r, format!("Created reminder {}", r.title));
            Ok(CapabilityOutput::with_receipt(json!({"reminder": to_json(&r)?}), rc))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.update",
            "Change a reminder: title, notes, due (null clears), completed, priority.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("id", schema::string(None)),
                ("title", str_max(500)),
                ("notes", str_max(10_000)),
                ("due", iso_schema()),
                ("completed", schema::boolean(None)),
                ("priority", schema::integer(None, Some(0), Some(9))),
            ],
            &["id"],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawReminderInput = ctx.decode()?;
            let id = ItemId::decode(p.id.as_deref().unwrap_or_default(), "id")?;
            text(p.title.as_deref(), 500, "title", false)?;
            text(p.notes.as_deref(), 10_000, "notes", false)?;
            check_priority(p.priority)?;
            let due = match &p.due {
                Some(Some(d)) => Some(Some(iso_param(d, "due")?)),
                Some(None) => Some(None),
                None => None,
            };
            let w = TaskWrite {
                title: p.title.clone(),
                notes: p.notes.clone(),
                due,
                completed: p.completed,
                priority: p.priority,
                ..Default::default()
            };
            guard_cancel(&ctx)?;
            let r = x.backend.update_task(&id, &w)?;
            let rc = reminder_receipt(&r, format!("Updated reminder {}", r.title));
            Ok(CapabilityOutput::with_receipt(
                json!({"reminder": to_json(&r)?}),
                rc,
            ))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.complete",
            "Complete a reminder (completed: false reopens it), by id or by the exact title of one open reminder (in listId when given). A flagged message's id marks its follow-up flag complete.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("id", schema::string(None)),
                ("title", str_desc_max("Exact title (when no id)", 500)),
                ("listId", schema::string(Some("The list to look in with title"))),
                ("completed", schema::boolean(Some("Default true"))),
            ],
            &[],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: CompleteReminder = ctx.decode()?;
            if p.id.is_none() && p.title.as_deref().unwrap_or("").trim().is_empty() {
                return Err(CapabilityError::invalid_params("give id or title", Some("id")));
            }
            text(p.title.as_deref(), 500, "title", false)?;
            let completed = p.completed.unwrap_or(true);
            let id = match &p.id {
                Some(id) => ItemId::decode(id, "id")?,
                None => {
                    let lists = p.list_id.as_deref().map(|l| FolderId::decode(l, "listId")).transpose()?;
                    guard_cancel(&ctx)?;
                    let rows = x.backend.tasks(lists.as_ref().map(std::slice::from_ref), Some(!completed))?;
                    let found = pim::one_by_title(&rows, p.title.as_deref().unwrap_or_default(), completed)?;
                    ItemId::decode(&found, "id")?
                }
            };
            guard_cancel(&ctx)?;
            let r = x.backend.set_task_completed(&id, completed)?;
            let verb = if r.completed { "Completed" } else { "Reopened" };
            let rc = reminder_receipt(&r, format!("{verb} reminder {}", r.title));
            Ok(CapabilityOutput::with_receipt(json!({"reminder": to_json(&r)?}), rc))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.delete",
            "Delete a reminder (an Outlook task; flagged mail is never deleted here). Always asks.",
            SideEffect::Destructive,
        )
        .input(schema::object(vec![("id", schema::string(None))], &["id"]))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ReminderRef = ctx.decode()?;
            let id = ItemId::decode(&p.id, "id")?;
            guard_cancel(&ctx)?;
            x.backend.delete_task(&id)?;
            Ok(CapabilityOutput::with_receipt(
                json!({"deleted": true}),
                ReceiptDraft::ok("Deleted a reminder").with_ref("reminderId", p.id),
            ))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "reminders.set_flagged",
            "Flag or unflag a reminder (Outlook tasks: the \"Flagged\" category; a flagged message: its follow-up flag).",
            SideEffect::Write,
        )
        .target(TargetKind::App)
        .input(schema::object(
            vec![("id", schema::string(None)), ("flagged", schema::boolean(None))],
            &["id", "flagged"],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: SetFlagged = ctx.decode()?;
            let id = ItemId::decode(&p.id, "id")?;
            guard_cancel(&ctx)?;
            x.backend.set_task_flagged(&id, p.flagged)?;
            let summary = if p.flagged { "Flagged a reminder" } else { "Unflagged a reminder" };
            Ok(CapabilityOutput::with_receipt(
                json!({"flagged": p.flagged}),
                ReceiptDraft::ok(summary).with_ref("reminderId", p.id),
            ))
        },
    );
}

// MARK: - Contacts

fn labeled_schema() -> Value {
    schema::array(
        schema::object(
            vec![
                ("label", str_desc_max("home, work, mobile, … or empty", 100)),
                ("value", str_max(320)),
            ],
            &["label", "value"],
        ),
        None,
        Some(10),
    )
}

fn contact_fields() -> Vec<(&'static str, Value)> {
    vec![
        ("givenName", str_max(200)),
        ("familyName", str_max(200)),
        ("organization", str_max(200)),
        ("jobTitle", str_max(200)),
        (
            "birthday",
            str_desc_max("YYYY-MM-DD, or --MM-DD without a year", 10),
        ),
    ]
}

/// `checkContactFields` plus Outlook's three email addresses per contact.
fn contact_write(
    p: &RawContactInput,
    emails: &[LabeledValue],
    phones: &[LabeledValue],
    email_field: &str,
    phone_field: &str,
) -> Result<ContactWrite, CapabilityError> {
    for (v, f) in [
        (&p.given_name, "givenName"),
        (&p.family_name, "familyName"),
        (&p.organization, "organization"),
        (&p.job_title, "jobTitle"),
    ] {
        text(v.as_deref(), 200, f, false)?;
    }
    let birthday = p.birthday.as_deref().map(pim::birthday).transpose()?;
    if emails.len() > 10 || phones.len() > 10 {
        return Err(CapabilityError::invalid_params(
            "at most 10 emails and 10 phones",
            Some(email_field),
        ));
    }
    for e in emails {
        pim::check_email(&e.value, email_field)?;
        text(Some(&e.label), 100, email_field, false)?;
    }
    for ph in phones {
        pim::check_phone(&ph.value, phone_field)?;
        text(Some(&ph.label), 100, phone_field, false)?;
    }
    Ok(ContactWrite {
        given_name: p.given_name.clone(),
        family_name: p.family_name.clone(),
        organization: p.organization.clone(),
        job_title: p.job_title.clone(),
        birthday,
        emails: emails.to_vec(),
        phones: phones.to_vec(),
    })
}

#[derive(Deserialize)]
struct ContactsSearch {
    query: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct ContactsListParams {
    limit: Option<i64>,
    fields: Option<Vec<String>>,
    query: Option<String>,
    offset: Option<i64>,
}

pub fn register_contacts(reg: &mut CapabilityRegistry, c: &Ctx) {
    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "contacts.search",
            "Find people in Outlook Contacts by name, email, phone or company, best match first (id, name, organization, emails, phones). Read-only.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("query", str_desc_max("A name, email, phone or company", 200)),
                ("limit", limit_schema()),
            ],
            &["query"],
        ))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ContactsSearch = ctx.decode()?;
            text(Some(&p.query), 200, "query", true)?;
            let lim = limit(p.limit, 20)?;
            guard_cancel(&ctx)?;
            untrusted_list("contacts", &pim::search(x.backend.contact_summaries()?, &p.query, lim))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "contacts.read",
            "One contact: names, organization, job title, emails, phones, addresses, URLs, birthday and groups (Outlook categories; never the notes). Read-only.",
            SideEffect::Read,
        )
        .input(schema::object(vec![("id", schema::string(None))], &["id"]))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ReminderRef = ctx.decode()?;
            text(Some(&p.id), super::ids::MAX_ID_LENGTH, "id", true)?;
            let id = ItemId::decode(&p.id, "id")?;
            guard_cancel(&ctx)?;
            let mut o = Map::new();
            o.insert("contact".into(), to_json(&x.backend.read_contact(&id)?)?);
            Ok(untrusted(o))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "contacts.create",
            "Add a contact to Outlook (\"save this sender\"): names, organization, job title, birthday, emails (at most 3: Outlook's limit) and phones with labels.",
            SideEffect::Write,
        )
        .input(schema::object(
            props(&contact_fields(), vec![("emails", labeled_schema()), ("phones", labeled_schema())]),
            &[],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawContactInput = ctx.decode()?;
            let emails = p.emails.clone().unwrap_or_default();
            let phones = p.phones.clone().unwrap_or_default();
            let w = contact_write(&p, &emails, &phones, "emails", "phones")?;
            let named = [&p.given_name, &p.family_name, &p.organization]
                .iter()
                .any(|v| !v.as_deref().unwrap_or("").trim().is_empty());
            if !named {
                return Err(CapabilityError::invalid_params("give a name or an organization", Some("givenName")));
            }
            // Outlook's fields: three emails; phones by label (checked against free fields).
            pim::assign_emails(&[], &emails, "emails")?;
            pim::assign_phones(&[], &phones)?;
            guard_cancel(&ctx)?;
            let contact = x.backend.create_contact(&w)?;
            let id = contact.id.clone();
            Ok(CapabilityOutput::with_receipt(
                json!({"contact": to_json(&contact)?}),
                ReceiptDraft::ok("Added a contact").with_ref("contactId", id),
            ))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "contacts.update",
            "Change a contact's names, organization, job title or birthday, and add emails or phones (never removes or replaces them; Outlook holds 3 emails).",
            SideEffect::Write,
        )
        .input(schema::object(
            props(
                &contact_fields(),
                vec![("id", schema::string(None)), ("addEmails", labeled_schema()), ("addPhones", labeled_schema())],
            ),
            &["id"],
        ))
        .receipt("connector_action")
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: RawContactInput = ctx.decode()?;
            let id = ItemId::decode(p.id.as_deref().unwrap_or_default(), "id")?;
            let emails = p.add_emails.clone().unwrap_or_default();
            let phones = p.add_phones.clone().unwrap_or_default();
            let w = contact_write(&p, &emails, &phones, "addEmails", "addPhones")?;
            guard_cancel(&ctx)?;
            let contact = x.backend.update_contact(&id, &w)?;
            let cid = contact.id.clone();
            Ok(CapabilityOutput::with_receipt(
                json!({"contact": to_json(&contact)?}),
                ReceiptDraft::ok("Updated a contact").with_ref("contactId", cid),
            ))
        },
    );

    let x = c.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "contacts.list",
            "Contact names (with nickname and organization when set) for dictation vocabulary, ordered by family then given name. Names only: no phone numbers, emails or addresses. Reads Outlook Contacts; never prompts.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("limit", schema::integer(Some("Default 500"), Some(1), Some(pim::LIST_MAX_LIMIT))),
                ("fields", schema::array(schema::string_enum(None, &["name"]), Some("Only \"name\" for now"), None)),
                ("query", str_desc_max("Prefix match on given or family name", pim::LIST_MAX_QUERY as u64)),
                (
                    "offset",
                    schema::integer(Some("Skip this many contacts first, to page past the limit; default 0"), Some(0), Some(1_000_000)),
                ),
            ],
            &[],
        ))
        .timeout(CAP_TIMEOUT),
        move |ctx| {
            let p: ContactsListParams = ctx.decode()?;
            let (lim, off, q) = pim::list_params(p.limit, p.offset, p.fields.as_deref(), p.query.as_deref())?;
            guard_cancel(&ctx)?;
            let rows = x.backend.contact_names()?;
            Ok(CapabilityOutput::new(pim::list_result(&rows, lim, off, q.as_deref())))
        },
    );
}
