//! The capability registry (linux-desktop design §4.2). In L3 it holds exactly one capability,
//! `health`; later PRs add `computer.*`, `apps.*`, `vscreen.*` and the rest under the names the
//! Mac helper already uses.
//!
//! Each capability declares its side effect like a tool does, and the Gateway's broker gates on
//! it. The session adds one more guard of its own: a destructive or financial capability refuses
//! to run without an `approvalId`.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

use psyche_protocol::{ErrorCode, ErrorPayload, NodeCapability, SideEffect, TargetKind};
use serde_json::{json, Value};

use crate::buildinfo::BuildInfo;

#[derive(Debug, Clone)]
pub struct CapabilitySpec {
    pub name: &'static str,
    pub description: &'static str,
    pub side_effect: SideEffect,
    pub target_kind: Option<TargetKind>,
    pub streaming: bool,
}

impl CapabilitySpec {
    /// The wire form declared at `connect` (`NodeCapability`), with no parameters.
    pub fn manifest_entry(&self) -> NodeCapability {
        self.manifest_entry_with(None)
    }

    /// The wire form with the capability's own input schema (a JSON Schema object), as the Mac
    /// helper declares for `computer.*`.
    pub fn manifest_entry_with(&self, schema: Option<Value>) -> NodeCapability {
        let mut input_schema = serde_json::Map::new();
        if let Some(Value::Object(s)) = schema {
            input_schema = s;
        } else {
            input_schema.insert("type".into(), json!("object"));
            input_schema.insert("properties".into(), json!({}));
            input_schema.insert("additionalProperties".into(), json!(false));
        }
        NodeCapability {
            description: Some(self.description.to_string()),
            input_schema,
            name: self.name.to_string(),
            side_effect: self.side_effect,
            streaming: Some(self.streaming),
            target_kind: self.target_kind,
        }
    }
}

/// A capability failure. `code` is a protocol error code; `reason` is the helper's finer machine
/// reason, carried in `details.reason` so the Gateway and the model can react without parsing
/// messages.
#[derive(Debug, Clone)]
pub struct CapabilityError {
    pub code: ErrorCode,
    pub reason: String,
    pub message: String,
    pub retryable: bool,
    /// More `details` for the Gateway (the app a tier refusal names, the label an approval card
    /// shows). `reason` always wins over a `reason` key here.
    pub details: serde_json::Map<String, Value>,
}

impl CapabilityError {
    pub fn new(code: ErrorCode, reason: &str, message: &str) -> Self {
        Self {
            code,
            reason: reason.into(),
            message: message.into(),
            retryable: false,
            details: serde_json::Map::new(),
        }
    }

    pub fn payload(&self) -> ErrorPayload {
        let mut details = self.details.clone();
        details.insert("reason".into(), json!(self.reason));
        ErrorPayload {
            code: self.code,
            details: Some(Value::Object(details)),
            message: self.message.clone(),
            retryable: self.retryable.then_some(true),
        }
    }
}

/// What a capability sees of one `node.invoke`.
pub struct InvocationContext {
    pub invocation_id: String,
    pub capability: String,
    pub params: Value,
    pub approval_id: Option<String>,
    /// Streams one `node.event` (no-op once the invocation finished).
    pub emit: Arc<dyn Fn(Value) + Send + Sync>,
    /// Set when the Gateway sends `node.cancel` or the connection closes.
    pub cancelled: Arc<AtomicBool>,
}

/// What a capability returns: the result and, for side effects, a receipt draft.
#[derive(Debug, Clone)]
pub struct Output {
    pub result: Value,
    pub receipt: Option<crate::receipt::ReceiptDraft>,
}

impl Output {
    pub fn plain(result: Value) -> Self {
        Output {
            result,
            receipt: None,
        }
    }
}

pub trait Capability: Send + Sync {
    fn spec(&self) -> CapabilitySpec;
    /// The receipt kind for side-effecting calls (`computer_action`, `app_open`). `None`: the
    /// capability sends no receipt.
    fn receipt_kind(&self) -> Option<&'static str> {
        None
    }

    /// Like [`Capability::invoke`], with the receipt draft a side-effecting call attaches.
    fn invoke_full(&self, ctx: &InvocationContext) -> Result<Output, CapabilityError> {
        self.invoke(ctx).map(Output::plain)
    }

    /// The JSON Schema of the parameters, declared at `connect`. `None`: no parameters.
    fn input_schema(&self) -> Option<Value> {
        None
    }
    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError>;
}

/// `health`: the helper is alive and which build it is. Safe to call at any time; it touches
/// nothing outside the process.
pub struct Health {
    started: Instant,
    build: BuildInfo,
}

impl Health {
    pub fn new(build: BuildInfo) -> Self {
        Self {
            started: Instant::now(),
            build,
        }
    }
}

impl Capability for Health {
    fn spec(&self) -> CapabilitySpec {
        CapabilitySpec {
            name: "health",
            description: "Reports that the Linux helper is running, and which build it is.",
            side_effect: SideEffect::None,
            target_kind: None,
            streaming: false,
        }
    }

    fn invoke(&self, _ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        Ok(json!({
            "ok": true,
            "name": self.build.name,
            "version": self.build.version,
            "build": self.build.build,
            "platform": self.build.platform,
            "arch": self.build.arch,
            "protocolVersion": self.build.protocol_version,
            "uptimeMs": u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        }))
    }
}

#[derive(Default, Clone)]
pub struct Registry {
    ordered: Vec<Arc<dyn Capability>>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// The L3 registry: `health` only.
    pub fn standard(build: BuildInfo) -> Self {
        let mut registry = Self::new();
        registry.register(Arc::new(Health::new(build)));
        registry
    }

    /// Adds a capability. A second one with the same name is a programming error.
    pub fn register(&mut self, capability: Arc<dyn Capability>) {
        let name = capability.spec().name;
        assert!(
            self.get(name).is_none(),
            "capability {name} registered twice"
        );
        self.ordered.push(capability);
    }

    pub fn get(&self, name: &str) -> Option<&Arc<dyn Capability>> {
        self.ordered.iter().find(|c| c.spec().name == name)
    }

    pub fn len(&self) -> usize {
        self.ordered.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ordered.is_empty()
    }

    /// The manifest declared at `connect`, in registration order.
    pub fn manifest(&self) -> Vec<NodeCapability> {
        self.ordered
            .iter()
            .map(|c| c.spec().manifest_entry_with(c.input_schema()))
            .collect()
    }
}

/// Whether a side effect needs an `approvalId` before it may run.
pub fn needs_approval(effect: SideEffect) -> bool {
    matches!(effect, SideEffect::Destructive | SideEffect::Financial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_standard_registry_offers_only_health() {
        let registry = Registry::standard(BuildInfo::current());
        let manifest = registry.manifest();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].name, "health");
        assert_eq!(manifest[0].side_effect, SideEffect::None);
        assert!(registry.get("computer.click").is_none());
    }

    #[test]
    fn the_manifest_entry_serializes_to_the_wire_shape() {
        let v = serde_json::to_value(Registry::standard(BuildInfo::current()).manifest()).unwrap();
        assert_eq!(v[0]["name"], "health");
        assert_eq!(v[0]["sideEffect"], "none");
        assert_eq!(v[0]["streaming"], false);
        assert_eq!(v[0]["inputSchema"]["type"], "object");
    }

    #[test]
    fn health_reports_the_build() {
        let registry = Registry::standard(BuildInfo::current());
        let ctx = InvocationContext {
            invocation_id: "i".into(),
            capability: "health".into(),
            params: json!({}),
            approval_id: None,
            emit: Arc::new(|_| {}),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let out = registry.get("health").unwrap().invoke(&ctx).unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["platform"], "linux");
        assert_eq!(out["build"], BuildInfo::current().build);
    }

    #[test]
    fn destructive_and_financial_need_an_approval() {
        assert!(needs_approval(SideEffect::Destructive));
        assert!(needs_approval(SideEffect::Financial));
        assert!(!needs_approval(SideEffect::Write));
        assert!(!needs_approval(SideEffect::None));
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn duplicate_names_are_refused() {
        let mut registry = Registry::standard(BuildInfo::current());
        registry.register(Arc::new(Health::new(BuildInfo::current())));
    }

    #[test]
    fn capability_errors_carry_the_reason_in_details() {
        let e = CapabilityError::new(ErrorCode::Forbidden, "tier_read_only", "no");
        let v = serde_json::to_value(e.payload()).unwrap();
        assert_eq!(v["code"], "forbidden");
        assert_eq!(v["details"]["reason"], "tier_read_only");
    }
}
