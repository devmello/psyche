//! Capability model, a port of `Core/Node/Capability.swift`: spec metadata (name, side effect,
//! target kind, input schema, streaming, permissions, receipt kind), the error type with the
//! protocol `ErrorCode` plus a finer machine `reason`, receipts, and the per-invocation context.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::cancel::CancelToken;
use super::encoding::{b64url, random_bytes};
use super::frames::WireError;
use super::time::iso8601_millis;

/// Protocol `ErrorCode` values the helper uses (`packages/protocol/src/errors.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    NotImplemented,
    InvalidParams,
    UnknownMethod,
    Forbidden,
    NotFound,
    Conflict,
    Timeout,
    Cancelled,
    Unavailable,
    ApprovalRequired,
    PolicyDenied,
    Internal,
    PresenceRequired,
    RateLimited,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotImplemented => "not_implemented",
            ErrorCode::InvalidParams => "invalid_params",
            ErrorCode::UnknownMethod => "unknown_method",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Conflict => "conflict",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Unavailable => "unavailable",
            ErrorCode::ApprovalRequired => "approval_required",
            ErrorCode::PolicyDenied => "policy_denied",
            ErrorCode::Internal => "internal",
            ErrorCode::PresenceRequired => "presence_required",
            ErrorCode::RateLimited => "rate_limited",
        }
    }

    /// The code for a wire string (capability crates report codes as strings); unknown → `Internal`.
    pub fn parse(s: &str) -> ErrorCode {
        [
            ErrorCode::NotImplemented,
            ErrorCode::InvalidParams,
            ErrorCode::UnknownMethod,
            ErrorCode::Forbidden,
            ErrorCode::NotFound,
            ErrorCode::Conflict,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
            ErrorCode::Unavailable,
            ErrorCode::ApprovalRequired,
            ErrorCode::PolicyDenied,
            ErrorCode::PresenceRequired,
            ErrorCode::RateLimited,
        ]
        .into_iter()
        .find(|c| c.as_str() == s)
        .unwrap_or(ErrorCode::Internal)
    }
}

/// `SideEffect` (`packages/protocol/src/common.ts`): what the Permission Broker gates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideEffect {
    None,
    Read,
    Write,
    Destructive,
    Financial,
}

impl SideEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            SideEffect::None => "none",
            SideEffect::Read => "read",
            SideEffect::Write => "write",
            SideEffect::Destructive => "destructive",
            SideEffect::Financial => "financial",
        }
    }

    pub fn parse(s: &str) -> Option<SideEffect> {
        [
            SideEffect::None,
            SideEffect::Read,
            SideEffect::Write,
            SideEffect::Destructive,
            SideEffect::Financial,
        ]
        .into_iter()
        .find(|e| e.as_str() == s)
    }
}

/// `TargetKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Origin,
    Path,
    Account,
    Command,
    Recipient,
    App,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Origin => "origin",
            TargetKind::Path => "path",
            TargetKind::Account => "account",
            TargetKind::Command => "command",
            TargetKind::Recipient => "recipient",
            TargetKind::App => "app",
        }
    }

    pub fn parse(s: &str) -> Option<TargetKind> {
        [
            TargetKind::Origin,
            TargetKind::Path,
            TargetKind::Account,
            TargetKind::Command,
            TargetKind::Recipient,
            TargetKind::App,
        ]
        .into_iter()
        .find(|k| k.as_str() == s)
    }
}

impl ReceiptOutcome {
    /// `ok` | `failed` | `uncertain` (anything else is `uncertain`).
    pub fn parse(s: &str) -> ReceiptOutcome {
        match s {
            "ok" => ReceiptOutcome::Ok,
            "failed" => ReceiptOutcome::Failed,
            _ => ReceiptOutcome::Uncertain,
        }
    }
}

impl CapabilityError {
    /// From a capability crate's wire `ErrorPayload` (`{code, message, details: {reason, …},
    /// retryable?}`), so crates need not depend on the core's types.
    pub fn from_wire(w: &Value) -> CapabilityError {
        let code = ErrorCode::parse(w["code"].as_str().unwrap_or("internal"));
        let mut details = w["details"].as_object().cloned().unwrap_or_default();
        let reason = match details.remove("reason") {
            Some(Value::String(r)) => r,
            _ => code.as_str().to_owned(),
        };
        let mut e = CapabilityError::new(code, reason, w["message"].as_str().unwrap_or_default());
        e.details = details;
        e.retryable = w["retryable"].as_bool() == Some(true);
        e
    }
}

/// OS permission a capability needs. The names are the mac helper's TCC vocabulary (so
/// `permissions.*` and the Gateway code paths stay unchanged), plus `camera`; each maps to its
/// Windows equivalent in `permissions` (privacy consent store, toast setting, UIPI).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OsPermission {
    Accessibility,
    ScreenRecording,
    Automation,
    FullDiskAccess,
    Calendars,
    Reminders,
    Contacts,
    Microphone,
    SpeechRecognition,
    Notifications,
    InputMonitoring,
    Camera,
}

impl OsPermission {
    pub const ALL: [OsPermission; 12] = [
        OsPermission::Accessibility,
        OsPermission::ScreenRecording,
        OsPermission::Automation,
        OsPermission::FullDiskAccess,
        OsPermission::Calendars,
        OsPermission::Reminders,
        OsPermission::Contacts,
        OsPermission::Microphone,
        OsPermission::SpeechRecognition,
        OsPermission::Notifications,
        OsPermission::InputMonitoring,
        OsPermission::Camera,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            OsPermission::Accessibility => "accessibility",
            OsPermission::ScreenRecording => "screenRecording",
            OsPermission::Automation => "automation",
            OsPermission::FullDiskAccess => "fullDiskAccess",
            OsPermission::Calendars => "calendars",
            OsPermission::Reminders => "reminders",
            OsPermission::Contacts => "contacts",
            OsPermission::Microphone => "microphone",
            OsPermission::SpeechRecognition => "speechRecognition",
            OsPermission::Notifications => "notifications",
            OsPermission::InputMonitoring => "inputMonitoring",
            OsPermission::Camera => "camera",
        }
    }

    pub fn names() -> Vec<&'static str> {
        Self::ALL.iter().map(|p| p.as_str()).collect()
    }
}

/// A capability failure: `code` is a protocol `ErrorCode`, `reason` the helper's finer machine
/// reason, carried in `details.reason`. Boxed so `Result<_, CapabilityError>` stays small; the
/// fields are reached through `Deref`.
#[derive(Debug, Clone, PartialEq)]
pub struct CapabilityError(Box<ErrorFields>);

#[derive(Debug, Clone, PartialEq)]
pub struct ErrorFields {
    pub code: ErrorCode,
    pub reason: String,
    pub message: String,
    pub details: Map<String, Value>,
    pub retryable: bool,
}

impl std::ops::Deref for CapabilityError {
    type Target = ErrorFields;
    fn deref(&self) -> &ErrorFields {
        &self.0
    }
}

impl std::ops::DerefMut for CapabilityError {
    fn deref_mut(&mut self) -> &mut ErrorFields {
        &mut self.0
    }
}

impl std::fmt::Display for CapabilityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}/{}: {}",
            self.code.as_str(),
            self.reason,
            self.message
        )
    }
}

impl std::error::Error for CapabilityError {}

impl CapabilityError {
    pub fn new(code: ErrorCode, reason: impl Into<String>, message: impl Into<String>) -> Self {
        CapabilityError(Box::new(ErrorFields {
            code,
            reason: reason.into(),
            message: message.into(),
            details: Map::new(),
            retryable: false,
        }))
    }

    pub fn with_detail(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.details.insert(key.to_owned(), value.into());
        self
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn invalid_params(message: impl Into<String>, field: Option<&str>) -> Self {
        let e = CapabilityError::new(ErrorCode::InvalidParams, "invalid_params", message);
        match field {
            Some(f) => e.with_detail("field", f),
            None => e,
        }
    }

    pub fn permission_missing(p: OsPermission) -> Self {
        CapabilityError::new(
            ErrorCode::Forbidden,
            "permission_missing",
            format!(
                "Psyche Helper does not have the {} permission. Grant it in Settings › Privacy & security.",
                p.as_str()
            ),
        )
        .with_detail("permission", p.as_str())
    }

    pub fn unavailable(reason: &str, message: impl Into<String>) -> Self {
        CapabilityError::new(ErrorCode::Unavailable, reason, message)
    }

    pub fn internal(reason: &str, message: impl Into<String>) -> Self {
        CapabilityError::new(ErrorCode::Internal, reason, message)
    }

    pub fn not_found(reason: &str, message: impl Into<String>) -> Self {
        CapabilityError::new(ErrorCode::NotFound, reason, message)
    }

    pub fn policy_denied(reason: &str, message: impl Into<String>) -> Self {
        CapabilityError::new(ErrorCode::PolicyDenied, reason, message)
    }

    pub fn cancelled() -> Self {
        CapabilityError::new(
            ErrorCode::Cancelled,
            "cancelled",
            "The invocation was cancelled",
        )
    }

    pub fn user_cancelled() -> Self {
        CapabilityError::new(
            ErrorCode::Cancelled,
            "user_cancelled",
            "The user cancelled authentication",
        )
    }

    pub fn timed_out(after: Duration) -> Self {
        CapabilityError::new(
            ErrorCode::Timeout,
            "timeout",
            format!("The capability did not finish within {} s", after.as_secs()),
        )
        .retryable()
    }

    /// A Windows API failure, content-free (the HRESULT only).
    pub fn os(reason: &str, message: impl Into<String>, err: &windows::core::Error) -> Self {
        CapabilityError::new(ErrorCode::Unavailable, reason, message)
            .with_detail("hresult", format!("0x{:08X}", err.code().0 as u32))
    }

    /// Wire `ErrorPayload` with `details.reason`.
    pub fn wire(&self) -> WireError {
        let mut d = self.details.clone();
        d.insert("reason".into(), self.reason.clone().into());
        WireError {
            code: self.code.as_str().to_owned(),
            message: self.message.clone(),
            details: Some(Value::Object(d)),
            retryable: self.retryable.then_some(true),
        }
    }
}

/// `ReceiptOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptOutcome {
    Ok,
    Failed,
    Uncertain,
}

impl ReceiptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            ReceiptOutcome::Ok => "ok",
            ReceiptOutcome::Failed => "failed",
            ReceiptOutcome::Uncertain => "uncertain",
        }
    }
}

/// The node-side half of a `Receipt` (the Gateway adds task / tool-call ids when it records it).
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptDraft {
    pub outcome: ReceiptOutcome,
    pub summary: String,
    pub external_refs: Map<String, Value>,
}

impl ReceiptDraft {
    pub fn ok(summary: impl Into<String>) -> Self {
        ReceiptDraft {
            outcome: ReceiptOutcome::Ok,
            summary: summary.into(),
            external_refs: Map::new(),
        }
    }

    pub fn failed(summary: impl Into<String>) -> Self {
        ReceiptDraft {
            outcome: ReceiptOutcome::Failed,
            summary: summary.into(),
            external_refs: Map::new(),
        }
    }

    pub fn with_ref(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.external_refs.insert(key.to_owned(), value.into());
        self
    }

    /// Full `Receipt` wire object.
    pub fn wire(&self, kind: &str, approval_id: Option<&str>, now: SystemTime) -> Value {
        json!({
            "id": format!("rcpt_{}", b64url(&random_bytes::<12>())),
            "kind": kind,
            "taskId": Value::Null,
            "toolCallId": Value::Null,
            "approvalId": approval_id.map_or(Value::Null, |a| a.into()),
            "outcome": self.outcome.as_str(),
            "summary": self.summary,
            "externalRefs": Value::Object(self.external_refs.clone()),
            "payload": Value::Null,
            "createdAt": iso8601_millis(now),
        })
    }
}

/// What a handler returns. `receipt` is filled for side-effecting calls.
#[derive(Debug, Clone, PartialEq)]
pub struct CapabilityOutput {
    pub result: Value,
    pub receipt: Option<ReceiptDraft>,
}

impl CapabilityOutput {
    pub fn new(result: Value) -> Self {
        CapabilityOutput {
            result,
            receipt: None,
        }
    }

    pub fn with_receipt(result: Value, receipt: ReceiptDraft) -> Self {
        CapabilityOutput {
            result,
            receipt: Some(receipt),
        }
    }
}

pub type CapResult = Result<CapabilityOutput, CapabilityError>;

/// Static description of one capability (architecture §7).
#[derive(Debug, Clone)]
pub struct CapabilitySpec {
    pub name: String,
    pub description: String,
    pub side_effect: SideEffect,
    pub target_kind: Option<TargetKind>,
    pub input_schema: Value,
    pub streaming: bool,
    /// Checked locally before dispatch, reported on refusal.
    pub permissions: Vec<OsPermission>,
    /// Receipt kind (`receipts.kind` vocabulary) for side-effecting calls.
    pub receipt_kind: Option<String>,
    /// Helper-side ceiling for one invocation (never in the manifest; the Gateway has its own).
    pub timeout: Option<Duration>,
}

impl CapabilitySpec {
    pub fn new(name: &str, description: &str, side_effect: SideEffect) -> Self {
        CapabilitySpec {
            name: name.to_owned(),
            description: description.to_owned(),
            side_effect,
            target_kind: None,
            input_schema: super::schema::empty(),
            streaming: false,
            permissions: Vec::new(),
            receipt_kind: None,
            timeout: None,
        }
    }

    pub fn target(mut self, kind: TargetKind) -> Self {
        self.target_kind = Some(kind);
        self
    }

    pub fn input(mut self, schema: Value) -> Self {
        self.input_schema = schema;
        self
    }

    pub fn streaming(mut self) -> Self {
        self.streaming = true;
        self
    }

    pub fn permissions(mut self, p: &[OsPermission]) -> Self {
        self.permissions = p.to_vec();
        self
    }

    pub fn receipt(mut self, kind: &str) -> Self {
        self.receipt_kind = Some(kind.to_owned());
        self
    }

    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }

    /// Wire form (`NodeCapability`): exactly the keys the Swift helper declares.
    pub fn manifest_entry(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), self.name.clone().into());
        o.insert("description".into(), self.description.clone().into());
        o.insert("sideEffect".into(), self.side_effect.as_str().into());
        o.insert("inputSchema".into(), self.input_schema.clone());
        o.insert("streaming".into(), self.streaming.into());
        if let Some(t) = self.target_kind {
            o.insert("targetKind".into(), t.as_str().into());
        }
        Value::Object(o)
    }
}

pub type EmitFn = Arc<dyn Fn(Value) + Send + Sync>;

/// Per-invocation context handed to a handler.
#[derive(Clone)]
pub struct InvocationContext {
    pub invocation_id: String,
    pub capability: String,
    pub params: Value,
    pub approval_id: Option<String>,
    emit: EmitFn,
    cancel: CancelToken,
}

impl std::fmt::Debug for InvocationContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InvocationContext")
            .field("capability", &self.capability)
            .finish_non_exhaustive()
    }
}

impl InvocationContext {
    pub fn new(
        invocation_id: &str,
        capability: &str,
        params: Value,
        approval_id: Option<String>,
        emit: EmitFn,
    ) -> Self {
        Self::with_cancel(
            invocation_id,
            capability,
            params,
            approval_id,
            emit,
            CancelToken::new(),
        )
    }

    pub fn with_cancel(
        invocation_id: &str,
        capability: &str,
        params: Value,
        approval_id: Option<String>,
        emit: EmitFn,
        cancel: CancelToken,
    ) -> Self {
        InvocationContext {
            invocation_id: invocation_id.to_owned(),
            capability: capability.to_owned(),
            params,
            approval_id,
            emit,
            cancel,
        }
    }

    /// Set when the Gateway cancelled the invocation or the connection dropped. Blocking handlers
    /// poll it between steps; async handlers are simply dropped.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    pub fn cancel_token(&self) -> CancelToken {
        self.cancel.clone()
    }

    /// A context for tests and direct calls (events are dropped).
    pub fn detached(capability: &str, params: Value) -> Self {
        Self::new("test", capability, params, None, Arc::new(|_| {}))
    }

    /// Streams one `node.event` for this invocation (dropped once the invocation finished).
    pub fn emit(&self, data: Value) {
        (self.emit)(data)
    }

    /// Typed view of `params` (missing params decode as `{}`); decode errors become
    /// `invalid_params` naming the field.
    pub fn decode<T: DeserializeOwned>(&self) -> Result<T, CapabilityError> {
        decode_params(&self.params)
    }
}

pub fn decode_params<T: DeserializeOwned>(params: &Value) -> Result<T, CapabilityError> {
    let value = if params.is_null() {
        Value::Object(Map::new())
    } else {
        params.clone()
    };
    serde_path_to_error::deserialize::<_, T>(value).map_err(|e| {
        let path = e.path().to_string();
        let inner = e.into_inner().to_string();
        if let Some(rest) = inner.strip_prefix("missing field `") {
            let key = rest.split('`').next().unwrap_or_default();
            let field = if path == "." {
                key.to_owned()
            } else {
                format!("{path}.{key}")
            };
            CapabilityError::invalid_params(format!("missing parameter {field}"), Some(&field))
        } else if inner.starts_with("unknown variant") {
            CapabilityError::invalid_params(format!("parameter {path} is invalid"), Some(&path))
        } else {
            CapabilityError::invalid_params(
                format!("parameter {path} has the wrong type"),
                Some(&path),
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, Debug)]
    struct P {
        #[allow(dead_code)]
        name: String,
        #[allow(dead_code)]
        inner: Option<Inner>,
    }
    #[derive(serde::Deserialize, Debug)]
    struct Inner {
        #[allow(dead_code)]
        n: u32,
    }

    #[test]
    fn decode_reports_the_field() {
        let e = decode_params::<P>(&json!({})).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidParams);
        assert_eq!(e.details["field"], "name");
        let e = decode_params::<P>(&json!({"name": 3})).unwrap_err();
        assert_eq!(e.details["field"], "name");
        let e = decode_params::<P>(&json!({"name": "x", "inner": {"n": "bad"}})).unwrap_err();
        assert_eq!(e.details["field"], "inner.n");
        assert!(decode_params::<P>(&json!({"name": "x", "extra": 1})).is_ok());
        assert!(decode_params::<Option<u8>>(&Value::Null).is_err());
    }

    #[test]
    fn wire_error_carries_reason_and_retryable() {
        let e = CapabilityError::unavailable("x_reason", "msg")
            .with_detail("k", 1)
            .retryable();
        let w = e.wire();
        assert_eq!(w.code, "unavailable");
        assert_eq!(w.details.unwrap(), json!({"k": 1, "reason": "x_reason"}));
        assert_eq!(w.retryable, Some(true));
        assert_eq!(CapabilityError::cancelled().wire().retryable, None);
    }

    #[test]
    fn manifest_entry_shape() {
        let s = CapabilitySpec::new("apps.open", "d", SideEffect::Write)
            .target(TargetKind::App)
            .receipt("app_open");
        let m = s.manifest_entry();
        assert_eq!(m["name"], "apps.open");
        assert_eq!(m["sideEffect"], "write");
        assert_eq!(m["targetKind"], "app");
        assert_eq!(m["streaming"], false);
        assert!(m.get("receiptKind").is_none() && m.get("permissions").is_none());
        let s = CapabilitySpec::new("notify.subscribe", "d", SideEffect::Read).streaming();
        assert!(s.manifest_entry().get("targetKind").is_none());
    }

    #[test]
    fn receipt_wire_shape() {
        let r = ReceiptDraft::ok("Did it").with_ref("name", "x");
        let w = r.wire("keychain_item", Some("apr_1"), SystemTime::UNIX_EPOCH);
        assert!(w["id"].as_str().unwrap().starts_with("rcpt_"));
        assert_eq!(w["kind"], "keychain_item");
        assert_eq!(w["approvalId"], "apr_1");
        assert_eq!(w["taskId"], Value::Null);
        assert_eq!(w["outcome"], "ok");
        assert_eq!(w["externalRefs"], json!({"name": "x"}));
        assert_eq!(w["createdAt"], "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn permission_names_round_trip() {
        for p in OsPermission::ALL {
            let v: OsPermission = serde_json::from_value(json!(p.as_str())).unwrap();
            assert_eq!(v, p);
        }
    }
}
