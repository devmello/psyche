//! Shared pieces of the Outlook capability layer: the context every handler closes over and the
//! schema / result helpers that match the Swift helper's (`AppleAppsCapabilities`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};

use super::backend::OutlookBackend;
use super::dates::LocalZone;
use crate::node::capability::{CapabilityError, CapabilityOutput};
use crate::node::paths::Env;
use crate::node::schema;

/// What the handlers share.
#[derive(Clone)]
pub struct Ctx {
    pub backend: Arc<dyn OutlookBackend>,
    pub zone: Arc<dyn LocalZone>,
    pub env: Env,
    pub home: PathBuf,
    /// `calendar.watch` window (30 s live).
    pub debounce: Duration,
    /// Wall clock, UTC ms (fixed in tests).
    pub now: fn() -> i64,
}

pub fn now_ms() -> i64 {
    crate::node::time::unix_millis(std::time::SystemTime::now())
}

/// The helper's own ceiling per invocation; every Outlook call has a shorter deadline of its own.
pub const CAP_TIMEOUT: Duration = Duration::from_secs(58);

/// `untrusted(…)`: app content is marked so the Gateway taints it.
pub fn untrusted(mut o: Map<String, Value>) -> CapabilityOutput {
    o.insert("provenance".into(), "untrusted".into());
    CapabilityOutput::new(Value::Object(o))
}

pub fn untrusted_list<T: serde::Serialize>(
    key: &str,
    items: &T,
) -> Result<CapabilityOutput, CapabilityError> {
    let mut o = Map::new();
    o.insert(key.into(), to_json(items)?);
    Ok(untrusted(o))
}

pub fn to_json<T: serde::Serialize>(v: &T) -> Result<Value, CapabilityError> {
    serde_json::to_value(v)
        .map_err(|_| CapabilityError::internal("internal", "Could not encode the result"))
}

/// `Schema.string(maxLength:)`.
pub fn str_max(max: u64) -> Value {
    schema::string_max(None, max)
}

/// `Schema.string(description, maxLength:)`.
pub fn str_desc_max(d: &str, max: u64) -> Value {
    schema::string_with(Some(d), None, Some(max))
}

/// `isoSchema`.
pub fn iso_schema() -> Value {
    schema::string(Some("ISO 8601 date-time"))
}

/// `limitSchema`.
pub fn limit_schema() -> Value {
    schema::integer(Some("Default 50"), Some(1), Some(500))
}

/// `offsetSchema`.
pub fn offset_schema() -> Value {
    schema::integer(
        Some("Skip this many matches first, to page past the limit; default 0"),
        Some(0),
        Some(1_000_000),
    )
}

/// `alarmSchema` (shape checked in the handler).
pub fn alarm_schema() -> Value {
    json!({"type": "object", "description": "{relativeMinutes: -15} (minutes before) or {at: ISO date-time}"})
}

/// `recurrenceSchema` (shape checked in the handler).
pub fn recurrence_schema() -> Value {
    json!({"description": "{frequency: daily|weekly|monthly|yearly, interval?, daysOfWeek? (weekly: mo…su), until? | count?}; null removes it on update"})
}

pub fn ids_array(max: u64) -> Value {
    schema::array(schema::string(None), None, Some(max))
}

/// Merges property lists (later keys win, like Swift's `merging`).
pub fn props(
    base: &[(&'static str, Value)],
    extra: Vec<(&'static str, Value)>,
) -> Vec<(&'static str, Value)> {
    let mut out: Vec<(&'static str, Value)> = base.to_vec();
    for (k, v) in extra {
        out.retain(|(k2, _)| *k2 != k);
        out.push((k, v));
    }
    out
}

/// Runs a backend call on the blocking thread a handler already is on, checking cancellation
/// first (a cancelled invocation never starts Outlook work).
pub fn guard_cancel(ctx: &crate::node::InvocationContext) -> Result<(), CapabilityError> {
    if ctx.is_cancelled() {
        Err(CapabilityError::cancelled())
    } else {
        Ok(())
    }
}
