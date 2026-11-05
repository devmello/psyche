//! Pure pieces of the calendar, reminders (Outlook tasks) and contacts adapters: ports of
//! `ConferenceLinks`, `BusyBlockRecord.blocks`, `ReminderQuery`, `ContactsWave1`, `ContactsList`,
//! plus the Outlook mappings (busy status, importance, recurrence patterns, reminder minutes,
//! contact field slots, categories). No COM; every rule is unit-tested.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::dates::{LocalZone, same_local_day};
use super::model::{
    Alarm, BusyBlockRecord, CalendarEventRecord, ContactName, ContactSummaryRecord, DAYS,
    LabeledValue, RecurrenceSpec, ReminderRecord,
};
use crate::node::capability::CapabilityError;
use crate::node::time::parse_iso8601_millis;

// MARK: - Calendar

const CONFERENCE_HOSTS: [&str; 6] = [
    "zoom.us",
    "zoomgov.com",
    "meet.google.com",
    "teams.microsoft.com",
    "teams.live.com",
    "webex.com",
];

/// The first meeting link (Zoom, Meet, Teams, Webex) in the event's URL, location or notes.
pub fn conference_link(texts: &[Option<&str>]) -> Option<String> {
    for t in texts.iter().flatten() {
        let lower = t.to_lowercase();
        let mut from = 0;
        while let Some(i) = lower[from..].find("https://") {
            let start = from + i;
            let end = t[start..]
                .find(|c: char| c.is_whitespace() || "<>\"')]".contains(c))
                .map_or(t.len(), |j| start + j);
            let url = t[start..end].trim_end_matches(['.', ',', ';']);
            let rest = &url["https://".len()..];
            let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
            let host = authority
                .rsplit('@')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .to_lowercase();
            if !host.is_empty()
                && CONFERENCE_HOSTS
                    .iter()
                    .any(|h| host == *h || host.ends_with(&format!(".{h}")))
            {
                return Some(url.to_owned());
            }
            from = end.max(start + 8);
        }
    }
    None
}

/// Outlook `BusyStatus` → `availability` (olFree 0, olTentative 1, olBusy 2, olOutOfOffice 3,
/// olWorkingElsewhere 4: "working elsewhere" is available, so it reads as free).
pub fn availability(busy_status: i32) -> &'static str {
    match busy_status {
        0 | 4 => "free",
        1 => "tentative",
        3 => "unavailable",
        _ => "busy",
    }
}

/// `availability` busy / free → `BusyStatus`.
pub fn busy_status(busy: bool) -> i32 {
    if busy { 2 } else { 0 }
}

/// Attendee status from `MeetingResponseStatus` (olResponseNone 0, Organized 1, Tentative 2,
/// Accepted 3, Declined 4, NotResponded 5).
pub fn attendee_status(response: i32) -> &'static str {
    match response {
        1 | 3 => "accepted",
        2 => "tentative",
        4 => "declined",
        5 => "pending",
        _ => "unknown",
    }
}

/// `BusyBlockRecord.blocks`: free events left out, start order.
pub fn busy_blocks(events: &[CalendarEventRecord]) -> Vec<BusyBlockRecord> {
    let mut v: Vec<BusyBlockRecord> = events
        .iter()
        .map(|e| BusyBlockRecord {
            start: e.start.clone(),
            end: e.end.clone(),
            calendar_id: e.calendar_id.clone(),
            availability: e.availability.clone().unwrap_or_else(|| "busy".into()),
        })
        .filter(|b| b.availability != "free")
        .collect();
    v.sort_by(|a, b| (&a.start, &a.end).cmp(&(&b.start, &b.end)));
    v
}

/// `calendar.list_events`: text in the title, location or notes; start order; at most `limit`.
pub fn select_events(
    mut events: Vec<CalendarEventRecord>,
    query: Option<&str>,
    limit: usize,
) -> Vec<CalendarEventRecord> {
    let q = query.unwrap_or("").trim().to_lowercase();
    events.retain(|e| {
        q.is_empty()
            || [Some(&e.title), e.location.as_ref(), e.notes.as_ref()]
                .iter()
                .flatten()
                .any(|s| s.to_lowercase().contains(&q))
    });
    events.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.end.cmp(&b.end)));
    events.truncate(limit);
    events
}

/// Appointment reminder from `alarms` (Outlook has one reminder per appointment): the first
/// alarm wins; `Some(None)` turns the reminder off; absolute alarms count back from `start`.
pub fn reminder_minutes(alarms: &[Alarm], start_utc: i64) -> Option<i64> {
    alarms.first().map(|a| match *a {
        Alarm::Relative(m) => -m,
        Alarm::Absolute(at) => ((start_utc - at) / 60_000).max(0),
    })
}

/// An Outlook `RecurrencePattern` in the fields this adapter sets and reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OlPattern {
    /// olRecursDaily 0, Weekly 1, Monthly 2, MonthNth 3, Yearly 5, YearNth 6.
    pub recurrence_type: i32,
    /// For yearly rules Outlook counts months (12 = every year).
    pub interval: i32,
    /// olSunday 1, olMonday 2, … olSaturday 64.
    pub day_of_week_mask: i32,
    pub occurrences: Option<i32>,
    /// `PatternEndDate` (UTC ms of the end instant; set as a local date).
    pub end: Option<i64>,
}

pub fn day_mask(days: &[String]) -> i32 {
    days.iter()
        .filter_map(|d| DAYS.iter().position(|x| x == d))
        .fold(0, |m, i| m | (1 << i))
}

pub fn mask_days(mask: i32) -> Vec<String> {
    (0..7)
        .filter(|i| mask & (1 << i) != 0)
        .map(|i| DAYS[i].to_owned())
        .collect()
}

/// `AppleRecurrence` → Outlook pattern. `start_weekday` (0 = Sunday) fills a weekly rule that
/// names no days, as EventKit repeats on the start's weekday.
pub fn to_pattern(r: &RecurrenceSpec, start_weekday: u32) -> OlPattern {
    let interval = r.interval.unwrap_or(1) as i32;
    let (t, interval) = match r.frequency.as_str() {
        "weekly" => (1, interval),
        "monthly" => (2, interval),
        "yearly" => (5, interval * 12),
        _ => (0, interval),
    };
    let mask = match (&r.days_of_week, t) {
        (Some(d), 1) if !d.is_empty() => day_mask(d),
        (_, 1) => 1 << (start_weekday % 7),
        _ => 0,
    };
    OlPattern {
        recurrence_type: t,
        interval,
        day_of_week_mask: mask,
        occurrences: r.count.map(|c| c as i32),
        end: r.until_ms(),
    }
}

/// Outlook pattern → `AppleRecurrence` (nth-weekday rules read as their base frequency).
pub fn from_pattern(p: &OlPattern, end_iso: Option<String>) -> RecurrenceSpec {
    let (frequency, interval) = match p.recurrence_type {
        1 => ("weekly", p.interval),
        2 | 3 => ("monthly", p.interval),
        5 | 6 => ("yearly", (p.interval / 12).max(1)),
        _ => ("daily", p.interval),
    };
    RecurrenceSpec {
        frequency: frequency.into(),
        interval: (interval > 1).then_some(interval as i64),
        days_of_week: (p.recurrence_type == 1 && p.day_of_week_mask != 0)
            .then(|| mask_days(p.day_of_week_mask)),
        until: if p.occurrences.is_some() {
            None
        } else {
            end_iso
        },
        count: p.occurrences.map(|c| c as i64),
    }
}

/// Weekday (0 = Sunday) of a naive ms value.
pub fn weekday(naive_ms: i64) -> u32 {
    ((naive_ms.div_euclid(86_400_000) + 4).rem_euclid(7)) as u32
}

// MARK: - Reminders

/// Outlook `Importance` (olImportanceLow 0, Normal 1, High 2) → EventKit priority (0 none,
/// 1–4 high, 5 medium, 6–9 low).
pub fn priority(importance: i32) -> i64 {
    match importance {
        2 => 1,
        0 => 9,
        _ => 0,
    }
}

/// EventKit priority → `Importance`.
pub fn importance(priority: i64) -> i32 {
    match priority {
        1..=4 => 2,
        6..=9 => 0,
        _ => 1,
    }
}

/// The category that marks a task as flagged (Outlook tasks have no flag of their own).
pub const FLAG_CATEGORY: &str = "Flagged";

/// `Categories` as a list (Outlook joins them with the locale's list separator).
pub fn categories(s: &str) -> Vec<String> {
    s.split([',', ';'])
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `Categories` with the flag category added or removed (case-insensitive), joined with `sep`.
pub fn with_flag(s: &str, flagged: bool, sep: &str) -> String {
    let mut v: Vec<String> = categories(s)
        .into_iter()
        .filter(|c| !c.eq_ignore_ascii_case(FLAG_CATEGORY))
        .collect();
    if flagged {
        v.push(FLAG_CATEGORY.into());
    }
    v.join(&format!("{} ", sep.trim()))
}

pub fn is_flagged(s: &str) -> bool {
    categories(s)
        .iter()
        .any(|c| c.eq_ignore_ascii_case(FLAG_CATEGORY))
}

/// `reminders.list` filters (R1) applied after the backend's list / completion / due-before
/// selection, soonest due first (`ReminderQuery.apply`).
#[derive(Debug, Clone, Default)]
pub struct ReminderQuery {
    pub overdue: bool,
    pub due_today: bool,
    pub query: String,
    pub flagged_only: bool,
    pub offset: usize,
}

impl ReminderQuery {
    pub fn apply(
        &self,
        rs: Vec<ReminderRecord>,
        now: i64,
        zone: &dyn LocalZone,
        limit: usize,
    ) -> Vec<ReminderRecord> {
        let q = self.query.trim().to_lowercase();
        let mut out: Vec<ReminderRecord> = rs
            .into_iter()
            .filter(|r| {
                let due = r.due.as_deref().and_then(parse_iso8601_millis);
                if self.overdue && (r.completed || !due.is_some_and(|d| d < now)) {
                    return false;
                }
                if self.due_today && !due.is_some_and(|d| same_local_day(d, now, zone)) {
                    return false;
                }
                if self.flagged_only && r.flagged != Some(true) {
                    return false;
                }
                q.is_empty()
                    || r.title.to_lowercase().contains(&q)
                    || r.notes.as_deref().unwrap_or("").to_lowercase().contains(&q)
            })
            .collect();
        out.sort_by(|a, b| match (&a.due, &b.due) {
            (Some(x), Some(y)) if x == y => a.title.cmp(&b.title),
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.title.cmp(&b.title),
        });
        out.into_iter().skip(self.offset).take(limit).collect()
    }
}

/// `reminders.complete` by title: the one reminder with exactly `title`, else `not_found` /
/// `conflict` (`reminder_ambiguous`, with the ids).
pub fn one_by_title(
    rs: &[ReminderRecord],
    title: &str,
    completed_target: bool,
) -> Result<String, CapabilityError> {
    let t = title.trim();
    let matches: Vec<&ReminderRecord> = rs.iter().filter(|r| r.title == t).collect();
    match matches.as_slice() {
        [] => Err(CapabilityError::not_found(
            "reminder_not_found",
            format!(
                "No {} reminder titled {t}",
                if completed_target {
                    "open"
                } else {
                    "completed"
                }
            ),
        )),
        [one] => Ok(one.id.clone()),
        many => Err(CapabilityError::new(
            crate::node::capability::ErrorCode::Conflict,
            "reminder_ambiguous",
            format!(
                "{} reminders are titled {t}; give its id or a listId",
                many.len()
            ),
        )
        .with_detail(
            "ids",
            json!(many.iter().map(|r| r.id.clone()).collect::<Vec<_>>()),
        )),
    }
}

// MARK: - Contacts

/// `YYYY-MM-DD` or `--MM-DD` → (year?, month, day) (`ContactsWave1.birthday`).
pub fn birthday(s: &str) -> Result<(Option<i64>, u32, u32), CapabilityError> {
    let bad =
        || CapabilityError::invalid_params("birthday is YYYY-MM-DD or --MM-DD", Some("birthday"));
    let p: Vec<&str> = s.split('-').collect();
    let (y, m, d) = match p.as_slice() {
        ["", "", m, d] => (None, *m, *d),
        [y, m, d] if y.len() == 4 => (Some(*y), *m, *d),
        _ => return Err(bad()),
    };
    let num = |x: &str| {
        (x.len() == 2 && x.bytes().all(|b| b.is_ascii_digit()))
            .then(|| x.parse::<u32>().ok())
            .flatten()
    };
    let (month, day) = (num(m).ok_or_else(bad)?, num(d).ok_or_else(bad)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(bad());
    }
    let year = match y {
        Some(y) => {
            let v: i64 = y.parse().map_err(|_| bad())?;
            if !(1..=9999).contains(&v) {
                return Err(bad());
            }
            Some(v)
        }
        None => None,
    };
    Ok((year, month, day))
}

pub fn birthday_string(year: Option<i64>, month: u32, day: u32) -> String {
    match year {
        Some(y) => format!("{y:04}-{month:02}-{day:02}"),
        None => format!("--{month:02}-{day:02}"),
    }
}

/// Outlook stores a birthday without a year in year 1604 (as iCloud and Exchange write it).
pub const NO_YEAR: i64 = 1604;

pub fn check_email(v: &str, field: &str) -> Result<(), CapabilityError> {
    if v.chars().count() <= 320
        && v.contains('@')
        && !v.chars().any(|c| c.is_whitespace() || c == ',' || c == ';')
    {
        Ok(())
    } else {
        Err(CapabilityError::invalid_params(
            "each email is one address",
            Some(field),
        ))
    }
}

pub fn check_phone(v: &str, field: &str) -> Result<(), CapabilityError> {
    let n = v.chars().count();
    if (3..=40).contains(&n) && v.chars().all(|c| "+0123456789 ()-./ext".contains(c)) {
        Ok(())
    } else {
        Err(CapabilityError::invalid_params(
            "each phone is a phone number",
            Some(field),
        ))
    }
}

fn digits(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

/// `ContactsWave1.score`: 0 no match; exact name or email 100, name prefix 80, phone digits 70,
/// word prefix 60, contains 40, organization 30.
pub fn score(c: &ContactSummaryRecord, query: &str) -> u32 {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return 0;
    }
    let name = c.name.to_lowercase();
    let mut best = if name == q {
        100
    } else if name.starts_with(&q) {
        80
    } else if name.split(' ').any(|w| w.starts_with(&q)) {
        60
    } else if name.contains(&q) {
        40
    } else {
        0
    };
    for e in c.emails.iter().map(|e| e.to_lowercase()) {
        let s = if e == q {
            100
        } else if e.starts_with(&q) {
            75
        } else if e.contains(&q) {
            40
        } else {
            0
        };
        best = best.max(s);
    }
    let qd = digits(&q);
    if qd.len() >= 4 && c.phones.iter().any(|p| digits(p).contains(&qd)) {
        best = best.max(70);
    }
    if c.organization.to_lowercase().contains(&q) {
        best = best.max(30);
    }
    best
}

/// Best match first, then by name.
pub fn search(
    all: Vec<ContactSummaryRecord>,
    query: &str,
    limit: usize,
) -> Vec<ContactSummaryRecord> {
    let mut scored: Vec<(u32, ContactSummaryRecord)> = all
        .into_iter()
        .map(|c| (score(&c, query), c))
        .filter(|(s, _)| *s > 0)
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.into_iter().take(limit).map(|(_, c)| c).collect()
}

/// Case-, accent- and width-insensitive form for `contacts.list` (NFD, combining marks dropped,
/// lower-cased).
pub fn fold(s: &str) -> String {
    use windows::Win32::Globalization::{NormalizationKD, NormalizeString};
    let src: Vec<u16> = s.encode_utf16().collect();
    if src.is_empty() {
        return String::new();
    }
    // SAFETY: size query, then a buffer of that size (retried once if the estimate was short).
    let decomposed = unsafe {
        let n = NormalizeString(NormalizationKD, &src, None);
        if n <= 0 {
            None
        } else {
            let mut buf = vec![0u16; n as usize];
            let m = NormalizeString(NormalizationKD, &src, Some(&mut buf));
            (m > 0).then(|| String::from_utf16_lossy(&buf[..m as usize]))
        }
    };
    decomposed
        .unwrap_or_else(|| s.to_owned())
        .chars()
        .filter(|c| !matches!(*c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F))
        .flat_map(char::to_lowercase)
        .collect()
}

pub const LIST_DEFAULT_LIMIT: i64 = 500;
pub const LIST_MAX_LIMIT: i64 = 2000;
pub const LIST_MAX_QUERY: usize = 80;

/// `ContactsList.validate` → (limit, offset, query).
pub fn list_params(
    limit: Option<i64>,
    offset: Option<i64>,
    fields: Option<&[String]>,
    query: Option<&str>,
) -> Result<(usize, usize, Option<String>), CapabilityError> {
    let l = limit.unwrap_or(LIST_DEFAULT_LIMIT);
    if !(1..=LIST_MAX_LIMIT).contains(&l) {
        return Err(CapabilityError::invalid_params(
            format!("limit must be 1–{LIST_MAX_LIMIT}"),
            Some("limit"),
        ));
    }
    let o = offset.unwrap_or(0);
    if !(0..=1_000_000).contains(&o) {
        return Err(CapabilityError::invalid_params(
            "offset must be 0–1000000",
            Some("offset"),
        ));
    }
    if let Some(f) = fields
        && (f.is_empty() || !f.iter().all(|x| x == "name"))
    {
        return Err(CapabilityError::invalid_params(
            "fields supports only \"name\"",
            Some("fields"),
        ));
    }
    let q = match query.map(str::trim) {
        Some(q) if q.chars().count() > LIST_MAX_QUERY => {
            return Err(CapabilityError::invalid_params(
                format!("query is at most {LIST_MAX_QUERY} characters"),
                Some("query"),
            ));
        }
        Some("") | None => None,
        Some(q) => Some(q.to_owned()),
    };
    Ok((l as usize, o as usize, q))
}

/// `ContactsList.result`: nameless rows skipped, prefix query on given / family name, family then
/// given then id order, `offset` / `limit`, `total` (all rows) and `truncated`.
pub fn list_result(
    records: &[ContactName],
    limit: usize,
    offset: usize,
    query: Option<&str>,
) -> Value {
    let q = query.map(fold);
    let mut named: Vec<(&ContactName, String, String)> = records
        .iter()
        .filter(|r| !r.name.trim().is_empty())
        .map(|r| (r, fold(&r.family_name), fold(&r.given_name)))
        .filter(|(_, fam, giv)| {
            q.as_ref()
                .is_none_or(|q| fam.starts_with(q) || giv.starts_with(q))
        })
        .collect();
    named.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then_with(|| a.2.cmp(&b.2))
            .then_with(|| a.0.id.cmp(&b.0.id))
    });
    let total_named = named.len();
    let contacts: Vec<Value> = named
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(r, _, _)| {
            let mut o = json!({"id": r.id, "name": r.name});
            let nick = r.nickname.trim();
            let org = r.organization.trim();
            if !nick.is_empty() {
                o["nickname"] = nick.into();
            }
            if !org.is_empty() {
                o["organization"] = org.into();
            }
            o
        })
        .collect();
    json!({"contacts": contacts, "total": records.len(), "truncated": total_named > offset + limit})
}

/// The Outlook phone fields and the label each reads as.
pub const PHONE_SLOTS: [(&str, &str); 12] = [
    ("MobileTelephoneNumber", "mobile"),
    ("BusinessTelephoneNumber", "work"),
    ("Business2TelephoneNumber", "work"),
    ("HomeTelephoneNumber", "home"),
    ("Home2TelephoneNumber", "home"),
    ("PrimaryTelephoneNumber", "main"),
    ("CompanyMainTelephoneNumber", "main"),
    ("BusinessFaxNumber", "workfax"),
    ("HomeFaxNumber", "homefax"),
    ("PagerNumber", "pager"),
    ("OtherTelephoneNumber", "other"),
    ("CarTelephoneNumber", "car"),
];

/// Outlook contacts hold three email addresses.
pub const EMAIL_SLOTS: [&str; 3] = ["Email1Address", "Email2Address", "Email3Address"];

fn phone_slots_for(label: &str) -> Vec<&'static str> {
    let l = label.trim().to_lowercase();
    let wanted: &[&str] = match l.as_str() {
        "mobile" | "iphone" | "cell" => &["mobile", "other"],
        "work" => &["work", "other"],
        "home" => &["home", "other"],
        "main" => &["main", "other"],
        "workfax" => &["workfax"],
        "homefax" => &["homefax"],
        "pager" => &["pager"],
        "car" => &["car", "other"],
        _ => &["other", "car", "main"],
    };
    wanted
        .iter()
        .flat_map(|w| {
            PHONE_SLOTS
                .iter()
                .filter(move |(_, lab)| lab == w)
                .map(|(f, _)| *f)
        })
        .collect()
}

/// Puts new phones into free Outlook phone fields by label (existing numbers, compared by
/// digits, are skipped). `filled` are the fields that already hold a number.
pub fn assign_phones(
    filled: &[(&str, String)],
    new: &[LabeledValue],
) -> Result<Vec<(&'static str, String)>, CapabilityError> {
    let have: HashSet<String> = filled.iter().map(|(_, v)| digits(v)).collect();
    let mut taken: HashSet<&str> = filled
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(f, _)| *f)
        .collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in new {
        let d = digits(&p.value);
        if have.contains(&d) || !seen.insert(d) {
            continue;
        }
        let slot = phone_slots_for(&p.label)
            .into_iter()
            .find(|f| !taken.contains(f))
            .ok_or_else(|| {
                CapabilityError::invalid_params(
                    format!(
                        "the Outlook contact has no free phone field for label \"{}\"",
                        p.label
                    ),
                    Some("phones"),
                )
            })?;
        taken.insert(slot);
        out.push((slot, p.value.clone()));
    }
    Ok(out)
}

/// Puts new emails into the free `Email1–3Address` fields (existing ones, compared
/// case-insensitively, are skipped).
pub fn assign_emails(
    filled: &[(&str, String)],
    new: &[LabeledValue],
    field: &str,
) -> Result<Vec<(&'static str, String)>, CapabilityError> {
    let have: HashSet<String> = filled
        .iter()
        .map(|(_, v)| v.trim().to_lowercase())
        .collect();
    let taken: HashSet<&str> = filled
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(f, _)| *f)
        .collect();
    let mut free = EMAIL_SLOTS.iter().filter(|s| !taken.contains(*s));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for e in new {
        let v = e.value.trim().to_lowercase();
        if have.contains(&v) || !seen.insert(v) {
            continue;
        }
        let slot = free.next().ok_or_else(|| {
            CapabilityError::invalid_params(
                "Outlook contacts hold at most 3 email addresses",
                Some(field),
            )
        })?;
        out.push((*slot, e.value.trim().to_owned()));
    }
    Ok(out)
}

// MARK: - calendar.watch

/// The debounce fold of `CalendarWatchCore`: a change opens a window or joins the open one;
/// closing the window hands back how many changes it folded.
#[derive(Debug, Default)]
pub struct Fold {
    count: u32,
}

impl Fold {
    /// Records a change; true when it opened a new window.
    pub fn note(&mut self) -> bool {
        self.count += 1;
        self.count == 1
    }

    /// Closes the window: the changes it folded (0 when none was open).
    pub fn take(&mut self) -> u32 {
        std::mem::take(&mut self.count)
    }
}

/// What the watch emits for changes at `times` (ms) with a `window` (ms): the folded count of
/// each window, in order (`CalendarWatchCore.fold`).
pub fn fold_times(times: &[i64], window: i64) -> Vec<u32> {
    let mut sorted = times.to_vec();
    sorted.sort_unstable();
    let mut fold = Fold::default();
    let mut closes: Option<i64> = None;
    let mut out = Vec::new();
    for t in sorted {
        if let Some(end) = closes
            && t >= end
        {
            out.push(fold.take());
            closes = None;
        }
        if fold.note() {
            closes = Some(t + window);
        }
    }
    if closes.is_some() {
        out.push(fold.take());
    }
    out
}

/// `{type: "calendar.changed", at, coalesced}` (`AppleCalendarChangedEvent`).
pub fn changed_event(at_ms: i64, coalesced: u32) -> Value {
    json!({"type": "calendar.changed", "at": super::model::iso(at_ms), "coalesced": coalesced.max(1)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outlook::dates::tests::eastern;

    fn ev(start: &str, end: &str, avail: Option<&str>, title: &str) -> CalendarEventRecord {
        CalendarEventRecord {
            id: title.into(),
            calendar_id: "c".into(),
            title: title.into(),
            start: start.into(),
            end: end.into(),
            all_day: false,
            location: None,
            notes: Some("Agenda".into()),
            url: None,
            recurring: false,
            attendees: None,
            conference_url: None,
            alarms: None,
            recurrence: None,
            availability: avail.map(String::from),
        }
    }

    fn rem(
        id: &str,
        title: &str,
        due: Option<&str>,
        completed: bool,
        flagged: Option<bool>,
    ) -> ReminderRecord {
        ReminderRecord {
            id: id.into(),
            list_id: "l".into(),
            title: title.into(),
            notes: None,
            due: due.map(String::from),
            completed,
            priority: 0,
            url: None,
            flagged,
            alarms: None,
            recurrence: None,
        }
    }

    #[test]
    fn conference_links() {
        let teams = "Join: <https://teams.microsoft.com/l/meetup-join/19%3a>.";
        assert_eq!(
            conference_link(&[None, Some("Room 4"), Some(teams)]),
            Some("https://teams.microsoft.com/l/meetup-join/19%3a".into())
        );
        assert_eq!(
            conference_link(&[Some("HTTPS://us02web.zoom.us/j/123, then")]),
            Some("HTTPS://us02web.zoom.us/j/123".into())
        );
        assert_eq!(
            conference_link(&[Some("https://evilzoom.us/x https://example.com")]),
            None
        );
        assert_eq!(
            conference_link(&[Some("https://user@meet.google.com/abc")]),
            Some("https://user@meet.google.com/abc".into())
        );
        assert_eq!(conference_link(&[]), None);
    }

    #[test]
    fn busy_status_maps() {
        assert_eq!(availability(0), "free");
        assert_eq!(availability(1), "tentative");
        assert_eq!(availability(2), "busy");
        assert_eq!(availability(3), "unavailable");
        assert_eq!(availability(4), "free");
        assert_eq!(busy_status(true), 2);
        assert_eq!(attendee_status(3), "accepted");
        assert_eq!(attendee_status(5), "pending");
        assert_eq!(attendee_status(0), "unknown");
    }

    #[test]
    fn busy_blocks_drop_free_and_sort() {
        let es = vec![
            ev(
                "2026-11-05T12:00:00Z",
                "2026-11-05T13:00:00Z",
                Some("busy"),
                "b",
            ),
            ev(
                "2026-11-05T09:00:00Z",
                "2026-11-05T10:00:00Z",
                Some("tentative"),
                "a",
            ),
            ev(
                "2026-11-05T08:00:00Z",
                "2026-11-05T09:00:00Z",
                Some("free"),
                "f",
            ),
            ev("2026-11-05T07:00:00Z", "2026-11-05T08:00:00Z", None, "n"),
        ];
        let b = busy_blocks(&es);
        assert_eq!(b.len(), 3);
        assert_eq!(b[0].availability, "busy", "unknown reads as busy");
        assert_eq!(b[1].availability, "tentative");
        assert!(b.windows(2).all(|w| w[0].start <= w[1].start));
    }

    #[test]
    fn event_selection() {
        let es = vec![
            ev(
                "2026-11-05T12:00:00Z",
                "2026-11-05T13:00:00Z",
                None,
                "Lunch",
            ),
            ev(
                "2026-11-05T09:00:00Z",
                "2026-11-05T10:00:00Z",
                None,
                "Standup",
            ),
        ];
        let all = select_events(es.clone(), None, 10);
        assert_eq!(all[0].title, "Standup");
        assert_eq!(select_events(es.clone(), Some("lun"), 10).len(), 1);
        assert_eq!(
            select_events(es.clone(), Some("agenda"), 10).len(),
            2,
            "notes match"
        );
        assert_eq!(select_events(es, None, 1).len(), 1);
    }

    #[test]
    fn reminder_minutes_from_alarms() {
        assert_eq!(reminder_minutes(&[], 0), None);
        assert_eq!(
            reminder_minutes(&[Alarm::Relative(-15), Alarm::Relative(-5)], 0),
            Some(15)
        );
        assert_eq!(
            reminder_minutes(&[Alarm::Absolute(-30 * 60_000)], 0),
            Some(30)
        );
        assert_eq!(
            reminder_minutes(&[Alarm::Absolute(60_000)], 0),
            Some(0),
            "after the start"
        );
    }

    #[test]
    fn recurrence_patterns_round_trip() {
        let weekly = RecurrenceSpec {
            frequency: "weekly".into(),
            interval: Some(2),
            days_of_week: Some(vec!["mo".into(), "we".into()]),
            until: None,
            count: Some(10),
        };
        let p = to_pattern(&weekly, 3);
        assert_eq!(
            p,
            OlPattern {
                recurrence_type: 1,
                interval: 2,
                day_of_week_mask: 2 | 8,
                occurrences: Some(10),
                end: None
            }
        );
        assert_eq!(from_pattern(&p, None), weekly);
        // Weekly without days repeats on the start's weekday.
        let w = RecurrenceSpec {
            frequency: "weekly".into(),
            ..Default::default()
        };
        assert_eq!(to_pattern(&w, 5).day_of_week_mask, 32);
        // Yearly intervals are months in Outlook.
        let y = RecurrenceSpec {
            frequency: "yearly".into(),
            interval: Some(2),
            ..Default::default()
        };
        let yp = to_pattern(&y, 0);
        assert_eq!((yp.recurrence_type, yp.interval), (5, 24));
        assert_eq!(from_pattern(&yp, None).interval, Some(2));
        // until carries over; interval 1 reads as absent.
        let d = RecurrenceSpec {
            frequency: "daily".into(),
            until: Some("2027-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        let dp = to_pattern(&d, 0);
        assert!(dp.end.is_some());
        assert_eq!(from_pattern(&dp, Some("2027-01-01T00:00:00Z".into())), d);
        // Nth-weekday monthly rules read as monthly.
        assert_eq!(
            from_pattern(
                &OlPattern {
                    recurrence_type: 3,
                    interval: 1,
                    day_of_week_mask: 4,
                    occurrences: None,
                    end: None
                },
                None
            )
            .frequency,
            "monthly"
        );
        assert_eq!(weekday(0), 4, "1970-01-01 was a Thursday");
    }

    #[test]
    fn priorities_and_flags() {
        assert_eq!(priority(2), 1);
        assert_eq!(priority(1), 0);
        assert_eq!(priority(0), 9);
        assert_eq!(importance(1), 2);
        assert_eq!(importance(5), 1);
        assert_eq!(importance(0), 1);
        assert_eq!(importance(9), 0);
        assert_eq!(with_flag("Work; Home", true, ","), "Work, Home, Flagged");
        assert_eq!(with_flag("Work, flagged", false, ";"), "Work");
        assert!(is_flagged("a,FLAGGED"));
        assert!(!is_flagged(""));
    }

    #[test]
    fn reminder_query_filters_and_sorts() {
        let z = eastern();
        let now = parse_iso8601_millis("2026-11-05T15:00:00Z").unwrap();
        let rs = vec![
            rem(
                "1",
                "Pay rent",
                Some("2026-11-01T04:00:00Z"),
                false,
                Some(false),
            ),
            rem(
                "2",
                "Call mom",
                Some("2026-11-05T05:00:00Z"),
                false,
                Some(true),
            ),
            rem("3", "Done", Some("2026-11-02T05:00:00Z"), true, None),
            rem("4", "Someday", None, false, None),
            rem("5", "Tomorrow", Some("2026-11-06T05:00:00Z"), false, None),
        ];
        let q = |f: ReminderQuery| {
            f.apply(rs.clone(), now, &z, 50)
                .into_iter()
                .map(|r| r.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(q(ReminderQuery::default()), vec!["1", "3", "2", "5", "4"]);
        assert_eq!(
            q(ReminderQuery {
                overdue: true,
                ..Default::default()
            }),
            vec!["1", "2"]
        );
        assert_eq!(
            q(ReminderQuery {
                due_today: true,
                ..Default::default()
            }),
            vec!["2"]
        );
        assert_eq!(
            q(ReminderQuery {
                flagged_only: true,
                ..Default::default()
            }),
            vec!["2"]
        );
        assert_eq!(
            q(ReminderQuery {
                query: "MOM".into(),
                ..Default::default()
            }),
            vec!["2"]
        );
        assert_eq!(
            q(ReminderQuery {
                offset: 3,
                ..Default::default()
            }),
            vec!["5", "4"]
        );
    }

    #[test]
    fn complete_by_title() {
        let rs = vec![
            rem("1", "A", None, false, None),
            rem("2", "B", None, false, None),
            rem("3", "B", None, false, None),
        ];
        assert_eq!(one_by_title(&rs, " A ", true).unwrap(), "1");
        assert_eq!(
            one_by_title(&rs, "C", true).unwrap_err().reason,
            "reminder_not_found"
        );
        let e = one_by_title(&rs, "B", true).unwrap_err();
        assert_eq!(e.reason, "reminder_ambiguous");
        assert_eq!(e.details["ids"], json!(["2", "3"]));
    }

    #[test]
    fn birthdays() {
        assert_eq!(birthday("1990-07-04").unwrap(), (Some(1990), 7, 4));
        assert_eq!(birthday("--12-25").unwrap(), (None, 12, 25));
        for bad in [
            "1990-7-4",
            "--13-01",
            "90-07-04",
            "",
            "1990-07-04x",
            "0000-01-01",
        ] {
            assert!(birthday(bad).is_err(), "{bad}");
        }
        assert_eq!(birthday_string(None, 2, 9), "--02-09");
        assert_eq!(birthday_string(Some(5), 2, 9), "0005-02-09");
    }

    #[test]
    fn contact_scores_and_search() {
        let c = |name: &str, email: &str, phone: &str, org: &str| ContactSummaryRecord {
            id: name.into(),
            name: name.into(),
            organization: org.into(),
            emails: vec![email.into()],
            phones: vec![phone.into()],
        };
        let all = vec![
            c("Ann Lee", "ann@x.com", "+1 (555) 010-2000", "Acme"),
            c("Annabel Ray", "bel@y.com", "", ""),
            c("Bob Annan", "bob@z.com", "", ""),
            c("Zed", "z@acme.com", "", "Initech"),
        ];
        assert_eq!(score(&all[0], "ann lee"), 100);
        assert_eq!(score(&all[0], "5550102"), 70);
        assert_eq!(score(&all[3], "initech"), 30);
        let names: Vec<String> = search(all.clone(), "ann", 10)
            .into_iter()
            .map(|c| c.name)
            .collect();
        assert_eq!(names, vec!["Ann Lee", "Annabel Ray", "Bob Annan"]);
        assert!(search(all, " ", 10).is_empty());
        assert!(check_phone("+1 (555) 010-2000 ext 4", "phones").is_ok());
        assert!(check_phone("call me", "phones").is_err());
        assert!(check_email("a b@x.com", "emails").is_err());
    }

    #[test]
    fn contact_list_orders_folds_and_pages() {
        let n = |id: &str, given: &str, family: &str| ContactName {
            id: id.into(),
            name: format!("{given} {family}").trim().into(),
            given_name: given.into(),
            family_name: family.into(),
            nickname: String::new(),
            organization: String::new(),
        };
        let rows = vec![
            n("3", "Émile", "Zola"),
            n("1", "Ana", "Álvarez"),
            n("2", "Bo", "Álvarez"),
            n("4", "", ""),
        ];
        let v = list_result(&rows, 2, 0, None);
        assert_eq!(v["total"], 4);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["contacts"][0]["id"], "1");
        assert_eq!(v["contacts"][1]["id"], "2");
        let v = list_result(&rows, 10, 0, Some("emi"));
        assert_eq!(
            v["contacts"].as_array().unwrap().len(),
            1,
            "accent-insensitive prefix"
        );
        let v = list_result(&rows, 10, 2, None);
        assert_eq!(v["contacts"][0]["id"], "3");
        assert_eq!(v["truncated"], false);
        assert!(list_params(Some(0), None, None, None).is_err());
        assert!(list_params(None, None, Some(&["phone".into()]), None).is_err());
        assert_eq!(
            list_params(None, None, None, Some("  ")).unwrap(),
            (500, 0, None)
        );
        assert_eq!(fold("ÅNGSTRÖM"), "angstrom");
    }

    #[test]
    fn phone_and_email_slots() {
        let lv = |l: &str, v: &str| LabeledValue {
            label: l.into(),
            value: v.into(),
        };
        let filled = vec![("MobileTelephoneNumber", "555-0100".to_string())];
        let out = assign_phones(
            &filled,
            &[
                lv("mobile", "(555) 0100"),
                lv("mobile", "555-0199"),
                lv("work", "555-0200"),
                lv("", "555-0300"),
            ],
        )
        .unwrap();
        assert_eq!(
            out,
            vec![
                ("OtherTelephoneNumber", "555-0199".to_string()),
                ("BusinessTelephoneNumber", "555-0200".to_string()),
                ("CarTelephoneNumber", "555-0300".to_string()),
            ]
        );
        assert!(assign_phones(&[], &[lv("pager", "1234"), lv("pager", "5678")]).is_err());
        let emails = assign_emails(
            &[("Email1Address", "a@x.com".into())],
            &[lv("", "A@x.com"), lv("", "b@x.com"), lv("work", "c@x.com")],
            "emails",
        )
        .unwrap();
        assert_eq!(
            emails,
            vec![
                ("Email2Address", "b@x.com".to_string()),
                ("Email3Address", "c@x.com".to_string())
            ]
        );
        assert!(
            assign_emails(
                &[],
                &[lv("", "a@x"), lv("", "b@x"), lv("", "c@x"), lv("", "d@x")],
                "emails"
            )
            .is_err()
        );
    }

    #[test]
    fn watch_folds_like_the_mac() {
        assert_eq!(fold_times(&[], 30_000), Vec::<u32>::new());
        assert_eq!(fold_times(&[0, 1_000, 29_999], 30_000), vec![3]);
        assert_eq!(
            fold_times(&[0, 30_000, 30_001, 90_000], 30_000),
            vec![1, 2, 1]
        );
        let mut f = Fold::default();
        assert!(f.note());
        assert!(!f.note());
        assert_eq!(f.take(), 2);
        assert_eq!(f.take(), 0);
        let e = changed_event(1_792_843_200_000, 0);
        assert_eq!(
            e,
            json!({"type": "calendar.changed", "at": "2026-10-24T12:00:00Z", "coalesced": 1})
        );
    }
}
