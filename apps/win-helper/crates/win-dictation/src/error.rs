//! Capability failures, mirroring the mac helper's `CapabilityError`: `code` is a protocol
//! `ErrorCode`, `reason` the finer machine reason carried in `details.reason`.

use serde_json::{Map, Value, json};
use std::fmt;

/// Protocol `ErrorCode` values the dictation and speech capabilities use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidParams,
    Forbidden,
    PolicyDenied,
    Unavailable,
    Conflict,
    RateLimited,
    NotFound,
    Cancelled,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidParams => "invalid_params",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::PolicyDenied => "policy_denied",
            ErrorCode::Unavailable => "unavailable",
            ErrorCode::Conflict => "conflict",
            ErrorCode::RateLimited => "rate_limited",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Internal => "internal",
        }
    }
}

/// Windows privacy permissions a capability may need (the TCC analogues).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    /// Settings › Privacy & security › Microphone (incl. "Let desktop apps access your microphone").
    Microphone,
    /// Settings › Privacy & security › Speech › Online speech recognition (the WinRT dictation topic).
    SpeechRecognition,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::Microphone => "microphone",
            Permission::SpeechRecognition => "speechRecognition",
        }
    }

    /// The `ms-settings:` page where the owner turns it on.
    pub fn settings_uri(self) -> &'static str {
        match self {
            Permission::Microphone => "ms-settings:privacy-microphone",
            Permission::SpeechRecognition => "ms-settings:privacy-speech",
        }
    }

    fn instructions(self) -> &'static str {
        match self {
            Permission::Microphone => {
                "Turn on Settings › Privacy & security › Microphone, including \"Let desktop apps access your microphone\"."
            }
            Permission::SpeechRecognition => {
                "Turn on Settings › Privacy & security › Speech › Online speech recognition."
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapError {
    pub code: ErrorCode,
    pub reason: String,
    pub message: String,
    pub details: Map<String, Value>,
    pub retryable: bool,
}

impl CapError {
    pub fn new(code: ErrorCode, reason: &str, message: impl Into<String>) -> Self {
        CapError { code, reason: reason.to_string(), message: message.into(), details: Map::new(), retryable: false }
    }

    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_string(), value.into());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn invalid_params(message: impl Into<String>, field: Option<&str>) -> Self {
        let e = CapError::new(ErrorCode::InvalidParams, "invalid_params", message);
        match field {
            Some(f) => e.with_detail("field", f),
            None => e,
        }
    }

    pub fn permission_missing(p: Permission) -> Self {
        CapError::new(
            ErrorCode::Forbidden,
            "permission_missing",
            format!("Psyche (Helper) does not have the {} permission. {}", p.as_str(), p.instructions()),
        )
        .with_detail("permission", p.as_str())
        .with_detail("settingsUri", p.settings_uri())
    }

    pub fn unavailable(reason: &str, message: impl Into<String>) -> Self {
        CapError::new(ErrorCode::Unavailable, reason, message)
    }

    pub fn cancelled() -> Self {
        CapError::new(ErrorCode::Cancelled, "cancelled", "The invocation was cancelled")
    }

    pub fn internal(message: impl Into<String>) -> Self {
        CapError::new(ErrorCode::Internal, "internal", message)
    }

    /// Wire form (`WireError`): `{code, message, details: {..., reason}, retryable?}`.
    pub fn wire(&self) -> Value {
        let mut details = self.details.clone();
        details.insert("reason".into(), Value::String(self.reason.clone()));
        let mut o = json!({ "code": self.code.as_str(), "message": self.message, "details": details });
        if self.retryable {
            o["retryable"] = Value::Bool(true);
        }
        o
    }
}

impl fmt::Display for CapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}: {}", self.code.as_str(), self.reason, self.message)
    }
}

impl std::error::Error for CapError {}

/// Windows API failure → `unavailable` with the HRESULT in details.
pub(crate) fn win_err(reason: &str, message: &str, e: &windows_core::Error) -> CapError {
    CapError::unavailable(reason, message).with_detail("hresult", format!("0x{:08X}", e.code().0 as u32))
}
