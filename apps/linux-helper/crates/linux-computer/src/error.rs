//! Capability errors, mirroring the mac helper's `CapabilityError` (apps/mac-helper
//! `PsycheHelperCore/Node/Capability.swift`): `code` is a protocol `ErrorCode` string, `reason` the
//! finer machine reason carried in `details.reason` on the wire. Messages never quote screen
//! content (labels, values, typed text); where the Gateway needs a label (risky-label approval
//! cards) it rides in `details`, exactly as on the Mac.

use serde_json::{Map, Value};
use std::fmt;

/// Protocol `ErrorCode`s used by computer use (packages/protocol `ErrorCode`).
pub mod code {
    pub const APPROVAL_REQUIRED: &str = "approval_required";
    pub const CANCELLED: &str = "cancelled";
    pub const CONFLICT: &str = "conflict";
    pub const FORBIDDEN: &str = "forbidden";
    pub const INTERNAL: &str = "internal";
    pub const INVALID_PARAMS: &str = "invalid_params";
    pub const NOT_FOUND: &str = "not_found";
    pub const NOT_IMPLEMENTED: &str = "not_implemented";
    pub const POLICY_DENIED: &str = "policy_denied";
    pub const PRESENCE_REQUIRED: &str = "presence_required";
    pub const TIMEOUT: &str = "timeout";
    pub const UNAVAILABLE: &str = "unavailable";
}

#[derive(Debug, Clone, PartialEq)]
pub struct CapError {
    /// Protocol `ErrorCode` (`policy_denied`, `not_found`, …).
    pub code: &'static str,
    /// Machine reason (`stale_ref`, `secure_field`, `tier_read`, …); `details.reason` on the wire.
    pub reason: String,
    /// Human text without screen content.
    pub message: String,
    pub details: Map<String, Value>,
    pub retryable: bool,
}

impl CapError {
    pub fn new(code: &'static str, reason: impl Into<String>, message: impl Into<String>) -> Self {
        CapError {
            code,
            reason: reason.into(),
            message: message.into(),
            details: Map::new(),
            retryable: false,
        }
    }

    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_string(), value.into());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// `invalid_params/invalid_params` with `details.field`.
    pub fn invalid_params(message: impl Into<String>, field: Option<&str>) -> Self {
        let e = CapError::new(code::INVALID_PARAMS, "invalid_params", message);
        match field {
            Some(f) => e.detail("field", f),
            None => e,
        }
    }

    pub fn unavailable(reason: &str, message: impl Into<String>) -> Self {
        CapError::new(code::UNAVAILABLE, reason, message)
    }

    /// Esc pressed by the user during this invocation (`cancelled/user_stopped`).
    pub fn stopped() -> Self {
        CapError::new(
            code::CANCELLED,
            "user_stopped",
            "The user pressed Esc to stop computer use",
        )
    }

    pub fn cancelled() -> Self {
        CapError::new(code::CANCELLED, "cancelled", "The invocation was cancelled")
    }

    /// `policy_denied/secure_field`: never read or type into password fields.
    pub fn secure_refusal() -> Self {
        CapError::new(
            code::POLICY_DENIED,
            "secure_field",
            "Psyche never reads or types into password fields. Use a {{cred:…}} fill through the vault instead.",
        )
    }

    pub fn internal(message: impl Into<String>) -> Self {
        CapError::new(code::INTERNAL, "internal", message)
    }

    /// Wire `ErrorPayload`: `{code, message, details: {..., reason}, retryable?}`.
    pub fn to_wire(&self) -> Value {
        let mut d = self.details.clone();
        d.insert("reason".into(), Value::String(self.reason.clone()));
        let mut o = Map::new();
        o.insert("code".into(), Value::String(self.code.to_string()));
        o.insert("message".into(), Value::String(self.message.clone()));
        o.insert("details".into(), Value::Object(d));
        if self.retryable {
            o.insert("retryable".into(), Value::Bool(true));
        }
        Value::Object(o)
    }
}

impl fmt::Display for CapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}: {}", self.code, self.reason, self.message)
    }
}

impl std::error::Error for CapError {}

pub type CapResult<T> = Result<T, CapError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_carries_reason_in_details() {
        let e = CapError::new(code::NOT_FOUND, "stale_ref", "e3 no longer exists")
            .detail("ref", "e3")
            .retryable();
        let w = e.to_wire();
        assert_eq!(w["code"], "not_found");
        assert_eq!(w["details"]["reason"], "stale_ref");
        assert_eq!(w["details"]["ref"], "e3");
        assert_eq!(w["retryable"], true);
        let plain = CapError::invalid_params("x", Some("keys")).to_wire();
        assert!(plain.get("retryable").is_none());
        assert_eq!(plain["details"]["field"], "keys");
    }
}
