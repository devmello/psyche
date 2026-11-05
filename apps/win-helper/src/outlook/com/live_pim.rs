//! Calendar, contacts and tasks on the live session (see `live` for the connection and mail).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use windows::Win32::System::Com::{IConnectionPoint, IConnectionPointContainer};
use windows::core::Interface;

use super::super::dates::{
    MS_PER_DAY, NONE_DATE, all_day_bounds, filter_date_string, local_day, local_ole_to_utc_ms,
    midnight, naive_ms_to_ole, ole_to_naive_ms, restrict_window, utc_ms_to_local_ole,
    utc_ole_to_ms, ymd,
};
use super::super::ids::{FolderId, ItemId};
use super::super::model::{
    Alarm, AlarmRecord, AttendeeRecord, CalendarEventRecord, CalendarRecord, ContactAddressRecord,
    ContactName, ContactRecord, ContactSummaryRecord, ContactWrite, EventWrite, LabeledValue,
    RecurrenceSpec, ReminderRecord, TaskWrite, iso,
};
use super::super::pim::{self, OlPattern};
use super::dispatch::{CR, Disp, Var};
use super::live::{
    CLASS_APPOINTMENT, CLASS_CONTACT, CLASS_MAIL, CLASS_TASK, FOLDER_CALENDAR, FOLDER_CONTACTS,
    FOLDER_INBOX, FOLDER_TASKS, Session, WatchConn, each_item, flag_message, renamed,
};
use super::sink::{ItemsEvents, ItemsSink, Slot};
use crate::node::capability::{CapabilityError, ErrorCode};

const PR_ACCESS: &str = "http://schemas.microsoft.com/mapi/proptag/0x0FF40003";
const MAPI_ACCESS_CREATE_CONTENTS: i32 = 0x10;
const URL_PROPERTY: &str = "PsycheURL";
/// Calendar folders read per call, and events per folder.
const MAX_CALENDARS: usize = 50;
const MAX_EVENTS_PER_FOLDER: usize = 5_000;
const MAX_CONTACTS: usize = 5_000;
const MAX_TASKS: usize = 5_000;
const NOTES_IN_LISTS: usize = 2_000;

fn user_prop(it: &Disp, name: &str) -> CR<Option<String>> {
    let Some(ups) = it.obj_opt("UserProperties", "UserProperties")? else {
        return Ok(None);
    };
    match ups.call("Find", vec![Var::str(name)])?.dispatch() {
        Some(p) => {
            let v = Disp::new(p, "UserProperty").soft_string("Value")?;
            Ok((!v.is_empty()).then_some(v))
        }
        None => Ok(None),
    }
}

fn set_user_prop(it: &Disp, name: &str, value: &str) -> CR<()> {
    let ups = it.obj("UserProperties", "UserProperties")?;
    let p = match ups.call("Find", vec![Var::str(name)])?.dispatch() {
        Some(p) => Disp::new(p, "UserProperty"),
        // olText, not added to the folder's fields.
        None => ups.call_obj(
            "Add",
            vec![Var::str(name), Var::int(1), Var::flag(false)],
            "UserProperty",
        )?,
    };
    p.put("Value", Var::str(value))
}

fn folder_writable(f: &Disp) -> CR<bool> {
    let Some(pa) = f.obj_opt("PropertyAccessor", "PropertyAccessor")? else {
        return Ok(true);
    };
    match pa.call("GetProperty", vec![Var::str(PR_ACCESS)]) {
        Ok(v) => Ok(v.i32() & MAPI_ACCESS_CREATE_CONTENTS != 0),
        Err(e) if e.code == ErrorCode::Timeout => Err(e),
        Err(_) => Ok(true),
    }
}

fn folder_record(store: &Disp, f: &Disp) -> CR<CalendarRecord> {
    Ok(CalendarRecord {
        id: FolderId::new(&f.string("StoreID")?, &f.string("EntryID")?).encode(),
        title: f.soft_string("Name")?,
        source: store.soft_string("DisplayName")?,
        writable: folder_writable(f)?,
        color: None,
    })
}

/// The locale's list separator (Outlook joins categories with it).
fn list_separator() -> String {
    use windows::Win32::Globalization::{GetLocaleInfoEx, LOCALE_SLIST};
    use windows::core::PCWSTR;
    let mut buf = [0u16; 8];
    // SAFETY: fixed buffer, the user default locale.
    let n = unsafe { GetLocaleInfoEx(PCWSTR::null(), LOCALE_SLIST, Some(&mut buf)) };
    if n > 1 {
        String::from_utf16_lossy(&buf[..n as usize - 1])
    } else {
        ",".into()
    }
}

/// An Outlook `RecurrencePattern` read into `OlPattern` (end as UTC ms of the local end date).
fn read_pattern(
    p: &Disp,
    zone: &dyn super::super::dates::LocalZone,
) -> CR<(OlPattern, Option<String>)> {
    let no_end = p.soft("NoEndDate")?.bool();
    let end = if no_end {
        None
    } else {
        local_ole_to_utc_ms(p.soft("PatternEndDate")?.f64(), zone)
    };
    Ok((
        OlPattern {
            recurrence_type: p.i32("RecurrenceType")?,
            interval: p.soft("Interval")?.i32().max(1),
            day_of_week_mask: p.soft("DayOfWeekMask")?.i32(),
            occurrences: None,
            end,
        },
        end.map(iso),
    ))
}

fn write_pattern(
    p: &Disp,
    r: &RecurrenceSpec,
    start_local_naive: i64,
    zone: &dyn super::super::dates::LocalZone,
) -> CR<()> {
    let pat = pim::to_pattern(r, pim::weekday(start_local_naive));
    p.put("RecurrenceType", Var::int(pat.recurrence_type))?;
    if pat.recurrence_type == 1 {
        p.put("DayOfWeekMask", Var::int(pat.day_of_week_mask))?;
    }
    p.put("Interval", Var::int(pat.interval))?;
    match (pat.occurrences, pat.end) {
        (Some(n), _) => p.put("Occurrences", Var::int(n))?,
        (None, Some(end)) => p.put(
            "PatternEndDate",
            Var::date(naive_ms_to_ole(local_day(end, zone))),
        )?,
        (None, None) => p.put("NoEndDate", Var::flag(true))?,
    }
    Ok(())
}

fn alarm_records(
    it: &Disp,
    relative: bool,
    zone: &dyn super::super::dates::LocalZone,
) -> CR<Vec<AlarmRecord>> {
    if !it.soft("ReminderSet")?.bool() {
        return Ok(Vec::new());
    }
    if relative {
        let m = it.soft("ReminderMinutesBeforeStart")?.i32() as i64;
        return Ok(vec![AlarmRecord::Relative {
            relative_minutes: -m.max(0),
        }]);
    }
    Ok(local_ole_to_utc_ms(it.soft("ReminderTime")?.f64(), zone)
        .map(|at| vec![AlarmRecord::Absolute { at: iso(at) }])
        .unwrap_or_default())
}

impl Session {
    // MARK: Calendar

    pub fn calendar_folders(&mut self, ids: Option<&[FolderId]>) -> CR<Vec<(Disp, Disp)>> {
        match ids {
            Some(ids) => ids
                .iter()
                .map(|id| {
                    let f = self
                        .folder(id)
                        .map_err(|e| renamed(e, "calendar_not_found", "No such calendar"))?;
                    let store = f.obj("Store", "Store")?;
                    Ok((store, f))
                })
                .collect(),
            None => self.typed_folders(1, MAX_CALENDARS),
        }
    }

    pub fn calendar_records(&mut self) -> CR<Vec<CalendarRecord>> {
        self.calendar_folders(None)?
            .iter()
            .map(|(s, f)| folder_record(s, f))
            .collect()
    }

    /// `AppleCalendarEvent` of an appointment (an occurrence gets an occurrence id).
    fn event_record(
        &self,
        a: &Disp,
        calendar_id: &str,
        store_id: &str,
        trusted: bool,
        patterns: &mut HashMap<String, Option<RecurrenceSpec>>,
    ) -> CR<CalendarEventRecord> {
        let entry = a.string("EntryID")?;
        let start = utc_ole_to_ms(a.f64("StartUTC")?).unwrap_or(0);
        let end = utc_ole_to_ms(a.f64("EndUTC")?).unwrap_or(start);
        let recurring = a.soft("IsRecurring")?.bool();
        // olApptOccurrence 2, olApptException 3.
        let occurrence = matches!(a.soft("RecurrenceState")?.i32(), 2 | 3).then_some(start / 1000);
        let location = Some(a.soft_string("Location")?).filter(|s| !s.is_empty());
        let notes = if trusted {
            Some(
                a.soft_string("Body")?
                    .chars()
                    .take(NOTES_IN_LISTS)
                    .collect::<String>(),
            )
            .filter(|s| !s.is_empty())
        } else {
            None
        };
        let url = user_prop(a, URL_PROPERTY)?;
        let recurrence = if recurring {
            match patterns.get(&entry) {
                Some(r) => r.clone(),
                None => {
                    let r = match a.call_obj("GetRecurrencePattern", vec![], "RecurrencePattern") {
                        Ok(p) => {
                            let (pat, end_iso) = read_pattern(&p, &self.zone)?;
                            Some(pim::from_pattern(&pat, end_iso))
                        }
                        Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                        Err(_) => None,
                    };
                    patterns.insert(entry.clone(), r.clone());
                    r
                }
            }
        } else {
            None
        };
        let attendees = if trusted && a.soft("MeetingStatus")?.i32() != 0 {
            let rs = a.obj("Recipients", "Recipients")?;
            let mut v = Vec::new();
            for i in 1..=rs.count()?.min(200) {
                let Some(r) = rs.item(i, "Recipient")? else {
                    continue;
                };
                let email = Session::smtp(&r)?;
                let name = r.soft_string("Name")?;
                v.push(AttendeeRecord {
                    name: if name.is_empty() { email.clone() } else { name },
                    email: email.contains('@').then_some(email),
                    status: pim::attendee_status(r.soft("MeetingResponseStatus")?.i32()).into(),
                    organizer: r.soft("Type")?.i32() == 0,
                });
            }
            Some(v)
        } else {
            Some(Vec::new())
        };
        let conference_url =
            pim::conference_link(&[url.as_deref(), location.as_deref(), notes.as_deref()]);
        Ok(CalendarEventRecord {
            id: ItemId::new(store_id, &entry)
                .with_occurrence(occurrence)
                .encode(),
            calendar_id: calendar_id.to_owned(),
            title: a.soft_string("Subject")?,
            start: iso(start),
            end: iso(end),
            all_day: a.soft("AllDayEvent")?.bool(),
            location,
            notes,
            url,
            recurring,
            attendees,
            conference_url,
            alarms: Some(alarm_records(a, true, &self.zone)?),
            recurrence,
            availability: Some(pim::availability(a.soft("BusyStatus")?.i32()).into()),
        })
    }

    pub fn events(
        &mut self,
        from: i64,
        to: i64,
        ids: Option<&[FolderId]>,
    ) -> CR<Vec<CalendarEventRecord>> {
        let trusted = self.is_trusted()?;
        let (from_l, to_l) = restrict_window(from, to, &self.zone);
        // Jet dates are local, in the user's date format.
        let filter = format!(
            "[Start] < '{}' AND [End] > '{}'",
            filter_date_string(to_l),
            filter_date_string(from_l)
        );
        let mut out = Vec::new();
        for (_, f) in self.calendar_folders(ids)? {
            let cal_id = FolderId::new(&f.string("StoreID")?, &f.string("EntryID")?).encode();
            let store_id = f.string("StoreID")?;
            let items = f.obj("Items", "Items")?;
            // Recurrences are expanded only on a collection sorted by start, then restricted.
            items.call("Sort", vec![Var::str("[Start]")])?;
            items.put("IncludeRecurrences", Var::flag(true))?;
            let restricted = items.call_obj("Restrict", vec![Var::str(&filter)], "Items")?;
            let mut patterns = HashMap::new();
            each_item(&restricted, MAX_EVENTS_PER_FOLDER, |a| {
                if a.i32("Class")? != CLASS_APPOINTMENT {
                    return Ok(true);
                }
                let start = utc_ole_to_ms(a.f64("StartUTC")?).unwrap_or(0);
                if start >= to {
                    return Ok(false); // sorted by start: nothing later overlaps
                }
                out.push(self.event_record(a, &cal_id, &store_id, trusted, &mut patterns)?);
                Ok(true)
            })?;
        }
        Ok(out)
    }

    fn apply_event(
        &mut self,
        a: &Disp,
        w: &EventWrite,
        create: bool,
        is_occurrence: bool,
    ) -> CR<()> {
        if let Some(t) = &w.title {
            a.put("Subject", Var::str(t))?;
        }
        if let Some(l) = &w.location {
            a.put("Location", Var::str(l))?;
        }
        if let Some(n) = &w.notes {
            self.guard()?;
            a.put("Body", Var::str(n))?;
        }
        if let Some(u) = &w.url {
            set_user_prop(a, URL_PROPERTY, u)?;
        }
        let old_start = utc_ole_to_ms(a.f64("StartUTC")?).unwrap_or(0);
        let old_end = utc_ole_to_ms(a.f64("EndUTC")?).unwrap_or(old_start);
        let start = w.start.unwrap_or(old_start);
        let end = w.end.unwrap_or(old_end);
        if end < start {
            return Err(CapabilityError::invalid_params(
                "end is before start",
                Some("end"),
            ));
        }
        let all_day = w
            .all_day
            .unwrap_or(!create && a.soft("AllDayEvent")?.bool());
        if all_day {
            let (s, e) = all_day_bounds(start, end, &self.zone);
            a.put("AllDayEvent", Var::flag(true))?;
            a.put("Start", Var::date(naive_ms_to_ole(s)))?;
            a.put("End", Var::date(naive_ms_to_ole(e)))?;
        } else {
            if w.all_day == Some(false) {
                a.put("AllDayEvent", Var::flag(false))?;
            }
            if create || w.start.is_some() || w.end.is_some() || w.all_day.is_some() {
                // Outlook keeps the duration when Start moves: set End after Start.
                a.put("Start", Var::date(utc_ms_to_local_ole(start, &self.zone)))?;
                a.put("End", Var::date(utc_ms_to_local_ole(end, &self.zone)))?;
            }
        }
        if let Some(alarms) = &w.alarms {
            match pim::reminder_minutes(alarms, start) {
                Some(m) => {
                    a.put("ReminderSet", Var::flag(true))?;
                    a.put("ReminderMinutesBeforeStart", Var::int(m as i32))?;
                }
                None => a.put("ReminderSet", Var::flag(false))?,
            }
        }
        if let Some(b) = w.busy {
            a.put("BusyStatus", Var::int(pim::busy_status(b)))?;
        }
        match &w.recurrence {
            Some(_) if is_occurrence => {
                return Err(CapabilityError::invalid_params(
                    "change the recurrence on the series (span future from its first event), not on one occurrence",
                    Some("recurrence"),
                ));
            }
            Some(Some(r)) => {
                let p = a.call_obj("GetRecurrencePattern", vec![], "RecurrencePattern")?;
                let local_start = self.zone_local(start);
                write_pattern(&p, r, local_start, &self.zone)?;
            }
            Some(None) if a.soft("IsRecurring")?.bool() => {
                a.call("ClearRecurrencePattern", vec![])?;
            }
            Some(None) | None => {}
        }
        Ok(())
    }

    fn zone_local(&self, utc: i64) -> i64 {
        use super::super::dates::LocalZone;
        self.zone.to_local(utc)
    }

    fn saved_event(&mut self, a: &Disp) -> CR<CalendarEventRecord> {
        // The parent of an occurrence is its series (olAppointment 26); walk up to the folder.
        let p = a.obj("Parent", "")?;
        let folder = if p.i32("Class")? == CLASS_APPOINTMENT {
            p.obj("Parent", "")?
        } else {
            p
        };
        let folder = Disp::new(folder.d, "Folder");
        let cal_id = FolderId::new(&folder.string("StoreID")?, &folder.string("EntryID")?).encode();
        let store_id = folder.string("StoreID")?;
        let trusted = self.is_trusted()?;
        self.event_record(a, &cal_id, &store_id, trusted, &mut HashMap::new())
    }

    pub fn create_event(&mut self, w: &EventWrite) -> CR<CalendarEventRecord> {
        let folder = match &w.calendar {
            Some(id) => self
                .folder(id)
                .map_err(|e| renamed(e, "calendar_not_found", "No such calendar"))?,
            None => self.default_folder(FOLDER_CALENDAR)?,
        };
        if !folder_writable(&folder)? {
            return Err(CapabilityError::new(
                ErrorCode::Forbidden,
                "calendar_read_only",
                "That calendar is read-only",
            ));
        }
        let a = folder
            .obj("Items", "Items")?
            .call_obj("Add", vec![Var::int(1)], "Item")?;
        self.apply_event(&a, w, true, false)?;
        a.call("Save", vec![])?;
        self.saved_event(&a)
    }

    fn appointment(&mut self, id: &ItemId) -> CR<Disp> {
        let a = self
            .item(&id.series())
            .map_err(|e| renamed(e, "event_not_found", "No such event"))?;
        if a.i32("Class")? != CLASS_APPOINTMENT {
            return Err(CapabilityError::not_found(
                "event_not_found",
                "That Outlook item is not an event",
            ));
        }
        Ok(a)
    }

    /// One occurrence of `master` starting at `secs` (UTC): `GetOccurrence` on its local start,
    /// else the exception that now starts there.
    fn occurrence(&mut self, master: &Disp, secs: i64) -> CR<(Disp, Disp)> {
        let p = master.call_obj("GetRecurrencePattern", vec![], "RecurrencePattern")?;
        let local = utc_ms_to_local_ole(secs * 1000, &self.zone);
        match p.call("GetOccurrence", vec![Var::date(local)]) {
            Ok(v) => {
                if let Some(d) = v.dispatch() {
                    return Ok((p, Disp::new(d, "Item")));
                }
            }
            Err(e) if e.code == ErrorCode::Timeout => return Err(e),
            Err(_) => {}
        }
        let exs = p.obj("Exceptions", "Exceptions")?;
        for i in 1..=exs.count()? {
            let Some(ex) = exs.item(i, "Exception")? else {
                continue;
            };
            if ex.soft("Deleted")?.bool() {
                continue;
            }
            let a = ex.obj("AppointmentItem", "Item")?;
            if utc_ole_to_ms(a.f64("StartUTC")?).map(|ms| ms / 1000) == Some(secs) {
                return Ok((p, a));
            }
        }
        Err(CapabilityError::not_found(
            "event_not_found",
            "That occurrence is not in the series any more",
        ))
    }

    pub fn update_event(
        &mut self,
        id: &ItemId,
        w: &EventWrite,
        future: bool,
    ) -> CR<CalendarEventRecord> {
        let master = self.appointment(id)?;
        let target = match id.occurrence {
            Some(secs) => {
                let (_, occ) = self.occurrence(&master, secs)?;
                if future {
                    let first = utc_ole_to_ms(master.f64("StartUTC")?).map(|ms| ms / 1000);
                    if first != Some(secs) {
                        return Err(CapabilityError::new(
                            ErrorCode::Unavailable,
                            "span_future_unsupported",
                            "Outlook cannot change only the later events of a series from here. Change this event (span this), or the whole series from its first event.",
                        ));
                    }
                    master.clone()
                } else {
                    occ
                }
            }
            None => master.clone(),
        };
        let is_occurrence = id.occurrence.is_some() && !future;
        self.apply_event(&target, w, false, is_occurrence)?;
        target.call("Save", vec![])?;
        self.saved_event(&target)
    }

    pub fn delete_event(&mut self, id: &ItemId, future: bool) -> CR<()> {
        let master = self.appointment(id)?;
        let Some(secs) = id.occurrence else {
            master.call("Delete", vec![])?;
            return Ok(());
        };
        let (pattern, occ) = self.occurrence(&master, secs)?;
        let first = utc_ole_to_ms(master.f64("StartUTC")?).map(|ms| ms / 1000);
        if future && first == Some(secs) {
            master.call("Delete", vec![])?;
        } else if future {
            // End the series on the day before this occurrence.
            let day_before = local_day(secs * 1000, &self.zone) - MS_PER_DAY;
            pattern.put("PatternEndDate", Var::date(naive_ms_to_ole(day_before)))?;
            master.call("Save", vec![])?;
        } else {
            occ.call("Delete", vec![])?;
        }
        Ok(())
    }

    // MARK: calendar.watch

    pub fn watch(&mut self, on_change: Arc<dyn Fn() + Send + Sync>) -> CR<u64> {
        let slot: Slot = Arc::new(Mutex::new(Some(on_change)));
        let sink: ItemsEvents = ItemsSink { slot: slot.clone() }.into();
        let sink: windows::core::IUnknown = sink.cast().map_err(|e| {
            CapabilityError::os(
                "outlook_object_model",
                "Could not create the change listener",
                &e,
            )
        })?;
        let mut conns = Vec::new();
        for (_, f) in self.calendar_folders(None)?.into_iter().take(20) {
            let items = f.obj("Items", "Items")?;
            let cpc: IConnectionPointContainer = items.d.cast().map_err(|e| {
                CapabilityError::os(
                    "outlook_object_model",
                    "Outlook's calendar does not report changes",
                    &e,
                )
            })?;
            // SAFETY: the sink implements ItemsEvents; the cookie is kept for Unadvise.
            let (cp, cookie): (IConnectionPoint, u32) = unsafe {
                let cp = cpc.FindConnectionPoint(&ItemsEvents::IID).map_err(|e| {
                    CapabilityError::os(
                        "outlook_object_model",
                        "Outlook's calendar does not report changes",
                        &e,
                    )
                })?;
                let cookie = cp.Advise(&sink).map_err(|e| {
                    CapabilityError::os(
                        "outlook_object_model",
                        "Outlook's calendar does not report changes",
                        &e,
                    )
                })?;
                (cp, cookie)
            };
            conns.push(WatchConn {
                cp,
                cookie,
                _items: items,
            });
        }
        let id = self.next_watch;
        self.next_watch += 1;
        self.watches.insert(id, (slot, conns));
        self.log.info(format!(
            "outlook watch started folders={}",
            self.watches[&id].1.len()
        ));
        Ok(id)
    }

    pub fn unwatch(&mut self, id: u64) {
        if let Some((slot, conns)) = self.watches.remove(&id) {
            *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
            for c in conns {
                // SAFETY: the cookie came from this connection point's Advise.
                unsafe {
                    let _ = c.cp.Unadvise(c.cookie);
                }
            }
        }
    }

    // MARK: Contacts

    fn contact_folders(&mut self) -> CR<Vec<(Disp, Disp)>> {
        self.typed_folders(2, 50)
    }

    fn each_contact(&mut self, mut f: impl FnMut(&Disp, &str) -> CR<()>) -> CR<()> {
        let mut n = 0;
        for (_, folder) in self.contact_folders()? {
            let store = folder.string("StoreID")?;
            let items = folder.obj("Items", "Items")?;
            each_item(&items, MAX_CONTACTS, |c| {
                if c.i32("Class")? == CLASS_CONTACT {
                    f(c, &store)?;
                    n += 1;
                }
                Ok(n < MAX_CONTACTS)
            })?;
            if n >= MAX_CONTACTS {
                break;
            }
        }
        Ok(())
    }

    fn emails(c: &Disp) -> CR<Vec<(&'static str, String)>> {
        let mut out = Vec::new();
        for (i, slot) in pim::EMAIL_SLOTS.iter().enumerate() {
            let v = c.soft_string(slot)?;
            let kind = c.soft_string(&format!("Email{}AddressType", i + 1))?;
            // Exchange entries hold an X.500 address; Outlook shows "Name (address)".
            if v.contains('@') || (!v.is_empty() && !kind.eq_ignore_ascii_case("EX")) {
                out.push((*slot, v));
            }
        }
        Ok(out)
    }

    fn phones(c: &Disp) -> CR<Vec<(&'static str, String, &'static str)>> {
        let mut out = Vec::new();
        for (field, label) in pim::PHONE_SLOTS {
            let v = c.soft_string(field)?;
            if !v.trim().is_empty() {
                out.push((field, v, label));
            }
        }
        Ok(out)
    }

    pub fn contact_summaries(&mut self) -> CR<Vec<ContactSummaryRecord>> {
        let trusted = self.is_trusted()?;
        let mut out = Vec::new();
        self.each_contact(|c, store| {
            let full = c.soft_string("FullName")?;
            let org = c.soft_string("CompanyName")?;
            out.push(ContactSummaryRecord {
                id: ItemId::new(store, &c.string("EntryID")?).encode(),
                name: if full.trim().is_empty() {
                    org.clone()
                } else {
                    full
                },
                organization: org,
                emails: if trusted {
                    Self::emails(c)?.into_iter().map(|(_, v)| v).collect()
                } else {
                    Vec::new()
                },
                phones: Self::phones(c)?.into_iter().map(|(_, v, _)| v).collect(),
            });
            Ok(())
        })?;
        Ok(out)
    }

    pub fn contact_names(&mut self) -> CR<Vec<ContactName>> {
        let mut out = Vec::new();
        self.each_contact(|c, store| {
            let (full, org, nick) = (
                c.soft_string("FullName")?,
                c.soft_string("CompanyName")?,
                c.soft_string("NickName")?,
            );
            let name = [&full, &org, &nick]
                .iter()
                .map(|s| s.trim())
                .find(|s| !s.is_empty())
                .unwrap_or("")
                .to_owned();
            out.push(ContactName {
                id: ItemId::new(store, &c.string("EntryID")?).encode(),
                name,
                given_name: c.soft_string("FirstName")?,
                family_name: c.soft_string("LastName")?,
                nickname: nick,
                organization: org,
            });
            Ok(())
        })?;
        Ok(out)
    }

    fn contact(&mut self, id: &ItemId) -> CR<Disp> {
        let c = self
            .item(id)
            .map_err(|e| renamed(e, "contact_not_found", "No such contact"))?;
        if c.i32("Class")? != CLASS_CONTACT {
            return Err(CapabilityError::not_found(
                "contact_not_found",
                "That Outlook item is not a contact",
            ));
        }
        Ok(c)
    }

    fn contact_record(c: &Disp, store: &str) -> CR<ContactRecord> {
        let lv = |label: &str, value: String| LabeledValue {
            label: label.into(),
            value,
        };
        let mut addresses = Vec::new();
        for (prefix, label) in [("Business", "work"), ("Home", "home"), ("Other", "other")] {
            let get = |k: &str| c.soft_string(&format!("{prefix}Address{k}"));
            let a = ContactAddressRecord {
                label: label.into(),
                street: get("Street")?,
                city: get("City")?,
                state: get("State")?,
                postal_code: get("PostalCode")?,
                country: get("Country")?,
            };
            if [&a.street, &a.city, &a.state, &a.postal_code, &a.country]
                .iter()
                .any(|s| !s.trim().is_empty())
            {
                addresses.push(a);
            }
        }
        let mut urls = Vec::new();
        for (field, label) in [
            ("WebPage", "homepage"),
            ("BusinessHomePage", "work"),
            ("PersonalHomePage", "home"),
        ] {
            let v = c.soft_string(field)?;
            if !v.trim().is_empty() && !urls.iter().any(|u: &LabeledValue| u.value == v) {
                urls.push(lv(label, v));
            }
        }
        let bday = c.soft("Birthday")?.f64();
        let birthday = if super::super::dates::is_none_date(bday) {
            None
        } else {
            ole_to_naive_ms(bday).map(|ms| {
                let (y, m, d) = ymd(ms);
                pim::birthday_string((y != pim::NO_YEAR).then_some(y), m, d)
            })
        };
        let mut groups = pim::categories(&c.soft_string("Categories")?);
        groups.sort();
        Ok(ContactRecord {
            id: ItemId::new(store, &c.string("EntryID")?).encode(),
            given_name: c.soft_string("FirstName")?,
            family_name: c.soft_string("LastName")?,
            nickname: c.soft_string("NickName")?,
            organization: c.soft_string("CompanyName")?,
            job_title: c.soft_string("JobTitle")?,
            emails: Self::emails(c)?
                .into_iter()
                .map(|(_, v)| lv("", v))
                .collect(),
            phones: Self::phones(c)?
                .into_iter()
                .map(|(_, v, l)| lv(l, v))
                .collect(),
            addresses,
            urls,
            birthday,
            groups,
        })
    }

    fn store_of(it: &Disp) -> CR<String> {
        it.obj("Parent", "Folder")?.string("StoreID")
    }

    pub fn read_contact(&mut self, id: &ItemId) -> CR<ContactRecord> {
        self.guard()?;
        let c = self.contact(id)?;
        Self::contact_record(&c, &id.store)
    }

    fn apply_contact(
        c: &Disp,
        w: &ContactWrite,
        emails: &[(&'static str, String)],
        phones: &[(&'static str, String)],
    ) -> CR<()> {
        for (field, v) in [
            ("FirstName", &w.given_name),
            ("LastName", &w.family_name),
            ("CompanyName", &w.organization),
            ("JobTitle", &w.job_title),
        ] {
            if let Some(v) = v {
                c.put(field, Var::str(v))?;
            }
        }
        if let Some((y, m, d)) = w.birthday {
            c.put(
                "Birthday",
                Var::date(naive_ms_to_ole(midnight(y.unwrap_or(pim::NO_YEAR), m, d))),
            )?;
        }
        for (field, v) in emails.iter().chain(phones) {
            c.put(field, Var::str(v))?;
        }
        Ok(())
    }

    pub fn create_contact(&mut self, w: &ContactWrite) -> CR<ContactRecord> {
        self.guard()?;
        let emails = pim::assign_emails(&[], &w.emails, "emails")?;
        let phones = pim::assign_phones(&[], &w.phones)?;
        let c = self
            .default_folder(FOLDER_CONTACTS)?
            .obj("Items", "Items")?
            .call_obj("Add", vec![Var::int(2)], "Item")?;
        Self::apply_contact(&c, w, &emails, &phones)?;
        c.call("Save", vec![])?;
        Self::contact_record(&c, &Self::store_of(&c)?)
    }

    pub fn update_contact(&mut self, id: &ItemId, w: &ContactWrite) -> CR<ContactRecord> {
        self.guard()?;
        let c = self.contact(id)?;
        let have_emails: Vec<(&str, String)> = pim::EMAIL_SLOTS
            .iter()
            .map(|s| Ok((*s, c.soft_string(s)?)))
            .collect::<CR<_>>()?;
        let have_phones: Vec<(&str, String)> = Self::phones(&c)?
            .into_iter()
            .map(|(f, v, _)| (f, v))
            .collect();
        let emails = pim::assign_emails(&have_emails, &w.emails, "addEmails")?;
        let phones = pim::assign_phones(&have_phones, &w.phones)
            .map_err(|e| e.with_detail("field", "addPhones"))?;
        Self::apply_contact(&c, w, &emails, &phones)?;
        c.call("Save", vec![])?;
        Self::contact_record(&c, &id.store)
    }

    // MARK: Tasks

    pub fn task_lists(&mut self) -> CR<Vec<CalendarRecord>> {
        self.typed_folders(3, 100)?
            .iter()
            .map(|(s, f)| folder_record(s, f))
            .collect()
    }

    fn task_record(
        &self,
        t: &Disp,
        list_id: &str,
        store: &str,
        trusted: bool,
    ) -> CR<ReminderRecord> {
        let due = local_ole_to_utc_ms(t.soft("DueDate")?.f64(), &self.zone).map(iso);
        let recurrence = if t.soft("IsRecurring")?.bool() {
            match t.call_obj("GetRecurrencePattern", vec![], "RecurrencePattern") {
                Ok(p) => {
                    let (pat, end_iso) = read_pattern(&p, &self.zone)?;
                    Some(pim::from_pattern(&pat, end_iso))
                }
                Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                Err(_) => None,
            }
        } else {
            None
        };
        Ok(ReminderRecord {
            id: ItemId::new(store, &t.string("EntryID")?).encode(),
            list_id: list_id.to_owned(),
            title: t.soft_string("Subject")?,
            notes: if trusted {
                Some(t.soft_string("Body")?).filter(|s| !s.is_empty())
            } else {
                None
            },
            due,
            completed: t.soft("Complete")?.bool(),
            priority: pim::priority(t.soft("Importance")?.i32()),
            url: user_prop(t, URL_PROPERTY)?,
            flagged: Some(pim::is_flagged(&t.soft_string("Categories")?)),
            alarms: Some(alarm_records(t, false, &self.zone)?),
            recurrence,
        })
    }

    /// A follow-up-flagged message as a reminder.
    fn flagged_record(&self, it: &Disp, list_id: &str, store: &str) -> CR<ReminderRecord> {
        let mut title = it.soft_string("TaskSubject")?;
        if title.is_empty() {
            title = it.soft_string("Subject")?;
        }
        Ok(ReminderRecord {
            id: ItemId::new(store, &it.string("EntryID")?).encode(),
            list_id: list_id.to_owned(),
            title,
            notes: None,
            due: local_ole_to_utc_ms(it.soft("TaskDueDate")?.f64(), &self.zone).map(iso),
            completed: it.soft("FlagStatus")?.i32() == 1,
            priority: pim::priority(it.soft("Importance")?.i32()),
            url: None,
            flagged: Some(it.soft("FlagStatus")?.i32() == 2),
            alarms: Some(alarm_records(it, false, &self.zone)?),
            recurrence: None,
        })
    }

    pub fn tasks(
        &mut self,
        lists: Option<&[FolderId]>,
        completed: Option<bool>,
    ) -> CR<Vec<ReminderRecord>> {
        let trusted = self.is_trusted()?;
        let folders: Vec<Disp> = match lists {
            Some(ids) => ids
                .iter()
                .map(|id| {
                    self.folder(id)
                        .map_err(|e| renamed(e, "list_not_found", "No such reminders list"))
                })
                .collect::<CR<_>>()?,
            None => self
                .typed_folders(3, 100)?
                .into_iter()
                .map(|(_, f)| f)
                .collect(),
        };
        let mut out = Vec::new();
        for f in folders {
            let store = f.string("StoreID")?;
            let list_id = FolderId::new(&store, &f.string("EntryID")?).encode();
            let mut items = f.obj("Items", "Items")?;
            if let Some(c) = completed {
                items = items.call_obj(
                    "Restrict",
                    vec![Var::str(if c {
                        "[Complete] = True"
                    } else {
                        "[Complete] = False"
                    })],
                    "Items",
                )?;
            }
            each_item(&items, MAX_TASKS, |t| {
                if t.i32("Class")? == CLASS_TASK {
                    out.push(self.task_record(t, &list_id, &store, trusted)?);
                }
                Ok(out.len() < MAX_TASKS)
            })?;
        }
        Ok(out)
    }

    pub fn flagged_mail(&mut self) -> CR<Vec<ReminderRecord>> {
        // Outlook's To-Do List (tasks and flagged items), else the inbox's flagged mail.
        let store = self.default_store()?;
        let (folder, restrict) =
            match store.call_obj("GetSpecialFolder", vec![Var::int(0)], "Folder") {
                Ok(f) => (f, None),
                Err(e) if e.code == ErrorCode::Timeout => return Err(e),
                Err(_) => (self.default_folder(FOLDER_INBOX)?, Some("[FlagStatus] = 2")),
            };
        let list_id =
            FolderId::new(&folder.string("StoreID")?, &folder.string("EntryID")?).encode();
        let mut items = folder.obj("Items", "Items")?;
        if let Some(r) = restrict {
            items = items.call_obj("Restrict", vec![Var::str(r)], "Items")?;
        }
        let mut out = Vec::new();
        each_item(&items, MAX_TASKS, |it| {
            if it.i32("Class")? == CLASS_MAIL && it.soft("FlagStatus")?.i32() == 2 {
                let store = Self::store_of(it)?;
                out.push(self.flagged_record(it, &list_id, &store)?);
            }
            Ok(true)
        })?;
        Ok(out)
    }

    /// A task or a flagged message, with its class.
    fn todo(&mut self, id: &ItemId) -> CR<(Disp, i32)> {
        let it = self
            .item(id)
            .map_err(|e| renamed(e, "reminder_not_found", "No such reminder"))?;
        let class = it.i32("Class")?;
        if class != CLASS_TASK && class != CLASS_MAIL {
            return Err(CapabilityError::not_found(
                "reminder_not_found",
                "That Outlook item is not a task",
            ));
        }
        Ok((it, class))
    }

    fn reminder_of(&mut self, it: &Disp, class: i32) -> CR<ReminderRecord> {
        let folder = it.obj("Parent", "Folder")?;
        let store = folder.string("StoreID")?;
        let list_id = FolderId::new(&store, &folder.string("EntryID")?).encode();
        if class == CLASS_MAIL {
            self.flagged_record(it, &list_id, &store)
        } else {
            let trusted = self.is_trusted()?;
            self.task_record(it, &list_id, &store, trusted)
        }
    }

    fn apply_task(&mut self, t: &Disp, w: &TaskWrite) -> CR<()> {
        if let Some(v) = &w.title {
            t.put("Subject", Var::str(v))?;
        }
        if let Some(v) = &w.notes {
            self.guard()?;
            t.put("Body", Var::str(v))?;
        }
        match w.due {
            Some(Some(due)) => t.put(
                "DueDate",
                Var::date(naive_ms_to_ole(local_day(due, &self.zone))),
            )?,
            Some(None) => t.put("DueDate", Var::date(NONE_DATE))?,
            None => {}
        }
        if let Some(p) = w.priority {
            t.put("Importance", Var::int(pim::importance(p)))?;
        }
        if let Some(u) = &w.url {
            set_user_prop(t, URL_PROPERTY, u)?;
        }
        if let Some(a) = w.alarm {
            let at = match a {
                Alarm::Absolute(at) => at,
                Alarm::Relative(m) => {
                    let due = w.due.flatten().ok_or_else(|| {
                        CapabilityError::invalid_params(
                            "a relative alarm needs a due date",
                            Some("alarm"),
                        )
                    })?;
                    due + m * 60_000
                }
            };
            t.put("ReminderSet", Var::flag(true))?;
            t.put(
                "ReminderTime",
                Var::date(utc_ms_to_local_ole(at, &self.zone)),
            )?;
        }
        if let Some(r) = &w.recurrence {
            let start = w.due.flatten().map(|d| self.zone_local(d)).unwrap_or(0);
            let p = t.call_obj("GetRecurrencePattern", vec![], "RecurrencePattern")?;
            write_pattern(&p, r, start, &self.zone)?;
        }
        match w.completed {
            Some(true) => {
                t.call("MarkComplete", vec![])?;
            }
            Some(false) => {
                t.put("Complete", Var::flag(false))?;
                t.put("Status", Var::int(0))?;
            }
            None => {}
        }
        Ok(())
    }

    pub fn create_task(&mut self, w: &TaskWrite) -> CR<ReminderRecord> {
        let folder = match &w.list {
            Some(id) => self
                .folder(id)
                .map_err(|e| renamed(e, "list_not_found", "No such reminders list"))?,
            None => self.default_folder(FOLDER_TASKS)?,
        };
        let t = folder
            .obj("Items", "Items")?
            .call_obj("Add", vec![Var::int(3)], "Item")?;
        self.apply_task(&t, w)?;
        t.call("Save", vec![])?;
        self.reminder_of(&t, CLASS_TASK)
    }

    pub fn update_task(&mut self, id: &ItemId, w: &TaskWrite) -> CR<ReminderRecord> {
        let (t, class) = self.todo(id)?;
        if class == CLASS_MAIL {
            return Err(CapabilityError::invalid_params(
                "that reminder is a flagged message: complete or unflag it, or change the message with mail tools",
                Some("id"),
            ));
        }
        self.apply_task(&t, w)?;
        t.call("Save", vec![])?;
        self.reminder_of(&t, class)
    }

    pub fn set_task_completed(&mut self, id: &ItemId, completed: bool) -> CR<ReminderRecord> {
        let (t, class) = self.todo(id)?;
        if class == CLASS_MAIL {
            if completed {
                t.put("FlagStatus", Var::int(1))?;
            } else {
                flag_message(&t, true)?;
            }
        } else {
            self.apply_task(
                &t,
                &TaskWrite {
                    completed: Some(completed),
                    ..Default::default()
                },
            )?;
        }
        t.call("Save", vec![])?;
        self.reminder_of(&t, class)
    }

    pub fn delete_task(&mut self, id: &ItemId) -> CR<()> {
        let (t, class) = self.todo(id)?;
        if class == CLASS_MAIL {
            return Err(CapabilityError::invalid_params(
                "that reminder is a flagged message: unflag it with reminders.set_flagged (messages are never deleted here)",
                Some("id"),
            ));
        }
        t.call("Delete", vec![]).map(|_| ())
    }

    pub fn set_task_flagged(&mut self, id: &ItemId, flagged: bool) -> CR<()> {
        let (t, class) = self.todo(id)?;
        if class == CLASS_MAIL {
            flag_message(&t, flagged)?;
        } else {
            let cats = pim::with_flag(&t.soft_string("Categories")?, flagged, &list_separator());
            t.put("Categories", Var::str(&cats))?;
        }
        t.call("Save", vec![]).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn list_separator_is_short_and_nonempty() {
        let s = super::list_separator();
        assert!(!s.is_empty() && s.chars().count() <= 3, "{s:?}");
    }
}
