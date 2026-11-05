//! Errors in the mac helper's vocabulary (`CapabilityError`): a wire `code` from the protocol's
//! `ErrorCode` set plus a machine `reason` (`details.reason`), so the Windows helper can forward a
//! service error as the capability error the mac helper would have thrown.

use serde_json::{Map, Value, json};

/// Wire codes the service uses (a subset of `packages/protocol` `ErrorCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    InvalidParams,
    UnknownMethod,
    Forbidden,
    NotFound,
    Conflict,
    Timeout,
    Unavailable,
    ApprovalRequired,
    PolicyDenied,
    Internal,
}

impl Code {
    pub fn as_str(self) -> &'static str {
        match self {
            Code::InvalidParams => "invalid_params",
            Code::UnknownMethod => "unknown_method",
            Code::Forbidden => "forbidden",
            Code::NotFound => "not_found",
            Code::Conflict => "conflict",
            Code::Timeout => "timeout",
            Code::Unavailable => "unavailable",
            Code::ApprovalRequired => "approval_required",
            Code::PolicyDenied => "policy_denied",
            Code::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VmError {
    pub code: Code,
    pub reason: String,
    pub message: String,
    pub details: Map<String, Value>,
    pub retryable: bool,
}

pub type VmResult<T> = Result<T, VmError>;

impl VmError {
    pub fn new(code: Code, reason: impl Into<String>, message: impl Into<String>) -> VmError {
        VmError { code, reason: reason.into(), message: message.into(), details: Map::new(), retryable: false }
    }

    /// `CapabilityError.invalidParams(message, field:)`: reason `invalid_params`, `details.field`.
    pub fn invalid_params(message: impl Into<String>, field: &str) -> VmError {
        VmError::new(Code::InvalidParams, "invalid_params", message).detail("field", field)
    }

    pub fn not_found(reason: &str, message: impl Into<String>) -> VmError {
        VmError::new(Code::NotFound, reason, message)
    }

    pub fn conflict(reason: &str, message: impl Into<String>) -> VmError {
        VmError::new(Code::Conflict, reason, message)
    }

    pub fn unavailable(reason: &str, message: impl Into<String>) -> VmError {
        VmError::new(Code::Unavailable, reason, message)
    }

    pub fn policy_denied(reason: &str, message: impl Into<String>) -> VmError {
        VmError::new(Code::PolicyDenied, reason, message)
    }

    pub fn internal(message: impl Into<String>) -> VmError {
        VmError::new(Code::Internal, "internal", message)
    }

    /// A mac-only feature with no Windows equivalent: `unavailable` / `unsupported`, never retryable.
    pub fn unsupported(what: &str, why: impl Into<String>) -> VmError {
        VmError::new(Code::Unavailable, "unsupported", why).detail("feature", what)
    }

    pub fn detail(mut self, key: &str, value: impl Into<Value>) -> VmError {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    pub fn retryable(mut self) -> VmError {
        self.retryable = true;
        self
    }

    /// From an I/O error while touching `what` (a file the service manages).
    pub fn io(what: &str, e: &std::io::Error) -> VmError {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => Code::NotFound,
            std::io::ErrorKind::PermissionDenied => Code::Forbidden,
            _ => Code::Unavailable,
        };
        let reason = match e.raw_os_error() {
            Some(112) => "disk_full", // ERROR_DISK_FULL
            _ if code == Code::NotFound => "not_found",
            _ if code == Code::Forbidden => "access_denied",
            _ => "io_error",
        };
        VmError::new(code, reason, format!("{what}: {e}"))
    }

    /// The wire `ErrorPayload`: `{code, message, details: {reason, …}, retryable?}`.
    pub fn to_wire(&self) -> Value {
        let mut details = self.details.clone();
        details.insert("reason".into(), Value::String(self.reason.clone()));
        let mut o = json!({ "code": self.code.as_str(), "message": self.message, "details": details });
        if self.retryable {
            o["retryable"] = Value::Bool(true);
        }
        o
    }
}

impl std::fmt::Display for VmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}: {}", self.code.as_str(), self.reason, self.message)
    }
}

impl std::error::Error for VmError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shape_carries_reason_in_details() {
        let e = VmError::conflict("vm_busy", "sandbox is busy").retryable();
        assert_eq!(
            e.to_wire(),
            json!({"code": "conflict", "message": "sandbox is busy", "details": {"reason": "vm_busy"}, "retryable": true})
        );
        let p = VmError::invalid_params("bad", "name").to_wire();
        assert_eq!(p["details"], json!({"field": "name", "reason": "invalid_params"}));
        assert!(p.get("retryable").is_none());
        let u = VmError::unsupported("ipsw", "no IPSW on Windows").to_wire();
        assert_eq!(u["code"], "unavailable");
        assert_eq!(u["details"]["reason"], "unsupported");
        assert_eq!(u["details"]["feature"], "ipsw");
    }

    #[test]
    fn io_errors_map_to_codes() {
        let nf = std::io::Error::from(std::io::ErrorKind::NotFound);
        assert_eq!(VmError::io("x", &nf).code, Code::NotFound);
        let full = std::io::Error::from_raw_os_error(112);
        assert_eq!(VmError::io("x", &full).reason, "disk_full");
    }
}
