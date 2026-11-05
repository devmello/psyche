//! Wire records (packages/protocol `schemas/apple-apps.ts`, byte-compatible with the mac helper's
//! encoders: nullable keys are always present, optional ones only when known), the raw params the
//! capabilities decode, and the validated forms the backend receives.

use serde::{Deserialize, Deserializer, Serialize};

use super::ids::{FolderId, ItemId};
use crate::node::capability::CapabilityError;
use crate::node::time::parse_iso8601_millis;

// MARK: - Shared validation (AppleAppsCapabilities helpers)

/// `AppleDates.param`: an ISO 8601 date-time with a zone, or `invalid_params`.
pub fn iso_param(s: &str, field: &str) -> Result<i64, CapabilityError> {
    parse_iso8601_millis(s).ok_or_else(|| {
        CapabilityError::invalid_params(
            format!("{field} must be an ISO 8601 date-time"),
            Some(field),
        )
    })
}

/// `limit`: 1–500, default `d`.
pub fn limit(v: Option<i64>, d: i64) -> Result<usize, CapabilityError> {
    let l = v.unwrap_or(d);
    if !(1..=500).contains(&l) {
        return Err(CapabilityError::invalid_params(
            "limit must be 1–500",
            Some("limit"),
        ));
    }
    Ok(l as usize)
}

/// `offset`: 0–1 000 000.
pub fn offset(v: Option<i64>) -> Result<usize, CapabilityError> {
    let o = v.unwrap_or(0);
    if !(0..=1_000_000).contains(&o) {
        return Err(CapabilityError::invalid_params(
            "offset must be 0–1000000",
            Some("offset"),
        ));
    }
    Ok(o as usize)
}

/// `text`: at most `max` characters, non-blank when `required`.
pub fn text(
    s: Option<&str>,
    max: usize,
    field: &str,
    required: bool,
) -> Result<(), CapabilityError> {
    if required && s.unwrap_or("").trim().is_empty() {
        return Err(CapabilityError::invalid_params(
            format!("{field} is required"),
            Some(field),
        ));
    }
    if let Some(s) = s
        && s.chars().count() > max
    {
        return Err(CapabilityError::invalid_params(
            format!("{field} is at most {max} characters"),
            Some(field),
        ));
    }
    Ok(())
}

/// ISO 8601 without fractional seconds (`AppleDates.string`).
pub fn iso(ms: i64) -> String {
    crate::node::time::iso8601(
        std::time::UNIX_EPOCH
            .checked_add(std::time::Duration::from_millis(ms.max(0) as u64))
            .unwrap_or(std::time::UNIX_EPOCH),
    )
}

/// `Some(None)` for an explicit `null`, `None` when the key is absent (with `#[serde(default)]`).
pub fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

// MARK: - Alarms and recurrence

/// `AppleAlarm` as it arrives.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RawAlarm {
    pub relative_minutes: Option<i64>,
    pub at: Option<String>,
}

/// A validated alarm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Alarm {
    /// Minutes before (≤ 0).
    Relative(i64),
    /// An absolute time (UTC ms).
    Absolute(i64),
}

impl Alarm {
    pub fn parse(r: &RawAlarm) -> Result<Alarm, CapabilityError> {
        if let Some(m) = r.relative_minutes {
            if !(-40_320..=0).contains(&m) {
                return Err(CapabilityError::invalid_params(
                    "relativeMinutes is -40320…0 (minutes before)",
                    Some("alarm"),
                ));
            }
            return Ok(Alarm::Relative(m));
        }
        if let Some(at) = &r.at {
            return Ok(Alarm::Absolute(iso_param(at, "alarm.at")?));
        }
        Err(CapabilityError::invalid_params(
            "an alarm is {relativeMinutes} or {at}",
            Some("alarm"),
        ))
    }
}

/// `AppleAlarm` on the wire.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(untagged)]
pub enum AlarmRecord {
    Relative {
        #[serde(rename = "relativeMinutes")]
        relative_minutes: i64,
    },
    Absolute {
        at: String,
    },
}

/// `AppleRecurrence` (wire form both ways; optional keys omitted when absent).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceSpec {
    pub frequency: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_of_week: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

pub const FREQUENCIES: [&str; 4] = ["daily", "weekly", "monthly", "yearly"];
/// Sunday first (EventKit order).
pub const DAYS: [&str; 7] = ["su", "mo", "tu", "we", "th", "fr", "sa"];

impl RecurrenceSpec {
    /// `RecurrenceSpec.validate`.
    pub fn validate(&self) -> Result<(), CapabilityError> {
        let bad = |m: &str| CapabilityError::invalid_params(m, Some("recurrence"));
        if !FREQUENCIES.contains(&self.frequency.as_str()) {
            return Err(bad("frequency is daily, weekly, monthly or yearly"));
        }
        if let Some(i) = self.interval
            && !(1..=999).contains(&i)
        {
            return Err(bad("interval is 1–999"));
        }
        if let Some(c) = self.count
            && !(1..=999).contains(&c)
        {
            return Err(bad("count is 1–999"));
        }
        if self.until.is_some() && self.count.is_some() {
            return Err(bad("give until or count, not both"));
        }
        if let Some(u) = &self.until {
            iso_param(u, "recurrence.until")?;
        }
        if let Some(d) = &self.days_of_week {
            if self.frequency != "weekly" {
                return Err(bad("daysOfWeek is for weekly rules"));
            }
            let mut seen = std::collections::HashSet::new();
            if d.len() > 7
                || !d
                    .iter()
                    .all(|x| DAYS.contains(&x.as_str()) && seen.insert(x.clone()))
            {
                return Err(bad("daysOfWeek takes mo, tu, we, th, fr, sa, su once each"));
            }
        }
        Ok(())
    }

    /// The `until` instant (already validated).
    pub fn until_ms(&self) -> Option<i64> {
        self.until.as_deref().and_then(parse_iso8601_millis)
    }
}

// MARK: - Calendar

/// `AppleCalendar` (also a reminders list).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CalendarRecord {
    pub id: String,
    pub title: String,
    pub source: String,
    pub writable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AttendeeRecord {
    pub name: String,
    pub email: Option<String>,
    pub status: String,
    pub organizer: bool,
}

/// `AppleCalendarEvent`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventRecord {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub recurring: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attendees: Option<Vec<AttendeeRecord>>,
    pub conference_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alarms: Option<Vec<AlarmRecord>>,
    pub recurrence: Option<RecurrenceSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
}

/// `AppleBusyBlock`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BusyBlockRecord {
    pub start: String,
    pub end: String,
    pub calendar_id: String,
    pub availability: String,
}

/// `calendar.create_event` / `calendar.update_event` params as they arrive.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEventInput {
    pub id: Option<String>,
    pub calendar_id: Option<String>,
    pub title: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub all_day: Option<bool>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub span: Option<String>,
    pub alarms: Option<Vec<RawAlarm>>,
    #[serde(default, deserialize_with = "double_option")]
    pub recurrence: Option<Option<RecurrenceSpec>>,
    pub availability: Option<String>,
}

/// A validated event write: every field is "leave as is" when `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EventWrite {
    pub calendar: Option<FolderId>,
    pub title: Option<String>,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub all_day: Option<bool>,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub alarms: Option<Vec<Alarm>>,
    /// `Some(None)` removes the recurrence.
    pub recurrence: Option<Option<RecurrenceSpec>>,
    /// `Some(true)` busy, `Some(false)` free.
    pub busy: Option<bool>,
}

// MARK: - Reminders (Outlook tasks)

/// `AppleReminder`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRecord {
    pub id: String,
    pub list_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub due: Option<String>,
    pub completed: bool,
    pub priority: i64,
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flagged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alarms: Option<Vec<AlarmRecord>>,
    pub recurrence: Option<RecurrenceSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawReminderInput {
    pub id: Option<String>,
    pub list_id: Option<String>,
    pub title: Option<String>,
    pub notes: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub due: Option<Option<String>>,
    pub completed: Option<bool>,
    pub priority: Option<i64>,
    pub url: Option<String>,
    pub alarm: Option<RawAlarm>,
    pub recurrence: Option<RecurrenceSpec>,
}

/// A validated task write ("leave as is" when `None`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskWrite {
    pub list: Option<FolderId>,
    pub title: Option<String>,
    pub notes: Option<String>,
    /// `Some(None)` clears the due date.
    pub due: Option<Option<i64>>,
    pub completed: Option<bool>,
    pub priority: Option<i64>,
    pub url: Option<String>,
    pub alarm: Option<Alarm>,
    pub recurrence: Option<RecurrenceSpec>,
}

// MARK: - Mail

/// `AppleMailMessageSummary`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MailSummaryRecord {
    pub id: String,
    pub mailbox: String,
    pub account: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub read: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flagged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// `AppleMailMailbox`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailboxRecord {
    pub account: String,
    pub name: String,
    pub unread_count: i64,
    pub special: Option<String>,
}

/// `AppleMailDraftRef` plus the body.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailDraftRecord {
    pub draft_id: String,
    pub subject: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub body: String,
    pub body_sha256: String,
}

impl MailDraftRecord {
    pub fn new(
        draft_id: String,
        subject: String,
        to: Vec<String>,
        cc: Vec<String>,
        body: String,
    ) -> Self {
        let body_sha256 = super::mail::body_hash(&body);
        MailDraftRecord {
            draft_id,
            subject,
            to,
            cc,
            body,
            body_sha256,
        }
    }
}

/// `AppleSavedFile`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedFileRecord {
    pub name: String,
    pub size: u64,
    pub path: Option<String>,
    pub library_item_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staged_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

/// `mail.draft` / `mail.send` params.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MailDraft {
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub subject: String,
    pub body: String,
}

/// A message, as `mail.read` returns it (before shaping).
#[derive(Debug, Clone, PartialEq)]
pub struct MailMessage {
    pub summary: MailSummaryRecord,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    /// At most the requested length.
    pub body: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AttachmentInfo {
    pub name: String,
    pub mime_type: Option<String>,
    pub size: i64,
}

/// `mail.search` filters (#626), validated.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MailFilter {
    pub query: String,
    pub unread: Option<bool>,
    pub since: Option<i64>,
    pub until: Option<i64>,
    pub from: String,
}

/// Where a message is (`mailbox` / `account` params): the default store's inbox when absent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MailScope {
    pub mailbox: Option<String>,
    pub account: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MailSearchResult {
    pub messages: Vec<MailSummaryRecord>,
    pub truncated: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FlagChange {
    pub read: Option<bool>,
    pub flagged: Option<bool>,
    /// Mail's flag index 0–6 (also flags the message).
    pub color: Option<u8>,
}

/// Where `mail.move` puts messages.
#[derive(Debug, Clone, PartialEq)]
pub enum Destination {
    Mailbox { name: String, account: String },
    Archive,
    Junk,
}

// MARK: - Contacts

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LabeledValue {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContactAddressRecord {
    pub label: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub postal_code: String,
    pub country: String,
}

/// `AppleContactSummary`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ContactSummaryRecord {
    pub id: String,
    pub name: String,
    pub organization: String,
    pub emails: Vec<String>,
    pub phones: Vec<String>,
}

/// `AppleContact` (never the note / body).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContactRecord {
    pub id: String,
    pub given_name: String,
    pub family_name: String,
    pub nickname: String,
    pub organization: String,
    pub job_title: String,
    pub emails: Vec<LabeledValue>,
    pub phones: Vec<LabeledValue>,
    pub addresses: Vec<ContactAddressRecord>,
    pub urls: Vec<LabeledValue>,
    pub birthday: Option<String>,
    pub groups: Vec<String>,
}

/// `contacts.list` source rows (names only).
#[derive(Debug, Clone, PartialEq)]
pub struct ContactName {
    pub id: String,
    pub name: String,
    pub given_name: String,
    pub family_name: String,
    pub nickname: String,
    pub organization: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawContactInput {
    pub id: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub organization: Option<String>,
    pub job_title: Option<String>,
    pub birthday: Option<String>,
    pub emails: Option<Vec<LabeledValue>>,
    pub phones: Option<Vec<LabeledValue>>,
    pub add_emails: Option<Vec<LabeledValue>>,
    pub add_phones: Option<Vec<LabeledValue>>,
}

/// A validated contact write; `emails` / `phones` are added (create: the whole set).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ContactWrite {
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub organization: Option<String>,
    pub job_title: Option<String>,
    /// (year?, month, day)
    pub birthday: Option<(Option<i64>, u32, u32)>,
    pub emails: Vec<LabeledValue>,
    pub phones: Vec<LabeledValue>,
}

/// Item id parsing shared by the capabilities.
pub fn item_id(s: &str, field: &str) -> Result<ItemId, CapabilityError> {
    ItemId::decode(s, field)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nullable_keys_are_present_and_optional_ones_omitted() {
        let e = CalendarEventRecord {
            id: "i".into(),
            calendar_id: "c".into(),
            title: "t".into(),
            start: "s".into(),
            end: "e".into(),
            all_day: false,
            location: None,
            notes: None,
            url: None,
            recurring: false,
            attendees: None,
            conference_url: None,
            alarms: None,
            recurrence: None,
            availability: None,
        };
        let v = serde_json::to_value(&e).unwrap();
        for k in ["location", "notes", "url", "conferenceUrl", "recurrence"] {
            assert_eq!(v[k], serde_json::Value::Null, "{k}");
            assert!(v.as_object().unwrap().contains_key(k));
        }
        for k in ["attendees", "alarms", "availability"] {
            assert!(!v.as_object().unwrap().contains_key(k), "{k}");
        }
        let r = RecurrenceSpec {
            frequency: "weekly".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&r).unwrap(),
            json!({"frequency": "weekly"})
        );
        let a = AlarmRecord::Relative {
            relative_minutes: -15,
        };
        assert_eq!(
            serde_json::to_value(&a).unwrap(),
            json!({"relativeMinutes": -15})
        );
    }

    #[test]
    fn alarms_validate() {
        let raw = |m: Option<i64>, at: Option<&str>| RawAlarm {
            relative_minutes: m,
            at: at.map(String::from),
        };
        assert_eq!(
            Alarm::parse(&raw(Some(-15), None)).unwrap(),
            Alarm::Relative(-15)
        );
        assert!(Alarm::parse(&raw(Some(5), None)).is_err());
        assert!(Alarm::parse(&raw(Some(-40_321), None)).is_err());
        assert!(matches!(
            Alarm::parse(&raw(None, Some("2026-11-05T09:00:00Z"))).unwrap(),
            Alarm::Absolute(_)
        ));
        assert_eq!(
            Alarm::parse(&raw(None, Some("bad"))).unwrap_err().details["field"],
            "alarm.at"
        );
        assert_eq!(
            Alarm::parse(&raw(None, None)).unwrap_err().details["field"],
            "alarm"
        );
    }

    #[test]
    fn recurrence_validates_like_the_mac() {
        let r = |f: &str| RecurrenceSpec {
            frequency: f.into(),
            ..Default::default()
        };
        assert!(r("weekly").validate().is_ok());
        assert!(r("hourly").validate().is_err());
        let mut x = r("daily");
        x.days_of_week = Some(vec!["mo".into()]);
        assert!(x.validate().is_err(), "days only for weekly");
        let mut x = r("weekly");
        x.days_of_week = Some(vec!["mo".into(), "mo".into()]);
        assert!(x.validate().is_err(), "duplicate day");
        let mut x = r("weekly");
        x.until = Some("2027-01-01T00:00:00Z".into());
        x.count = Some(3);
        assert!(x.validate().is_err(), "until and count");
        let mut x = r("monthly");
        x.interval = Some(0);
        assert!(x.validate().is_err());
    }

    #[test]
    fn patch_tells_null_from_absent() {
        let p: RawEventInput =
            serde_json::from_value(json!({"id": "x", "recurrence": null})).unwrap();
        assert_eq!(p.recurrence, Some(None));
        let p: RawEventInput = serde_json::from_value(json!({"id": "x"})).unwrap();
        assert_eq!(p.recurrence, None);
        let p: RawReminderInput = serde_json::from_value(json!({"id": "x", "due": null})).unwrap();
        assert_eq!(p.due, Some(None));
    }

    #[test]
    fn helpers_validate() {
        assert_eq!(limit(None, 50).unwrap(), 50);
        assert!(limit(Some(0), 50).is_err());
        assert!(limit(Some(501), 50).is_err());
        assert!(offset(Some(-1)).is_err());
        assert!(text(Some("  "), 10, "title", true).is_err());
        assert!(
            text(Some("ééé"), 3, "t", false).is_ok(),
            "characters, not bytes"
        );
        assert!(text(Some("abcd"), 3, "t", false).is_err());
        assert_eq!(iso(1_792_843_200_123), "2026-10-24T12:00:00Z");
        assert!(iso_param("2026-10-24", "from").is_err());
    }
}
