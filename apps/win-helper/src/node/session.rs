//! Serves the node protocol on a paired connection (port of `NodeSession`):
//!
//! - Gateway → node `req node.invoke {invocationId, capability, params, approvalId?}` → the node
//!   answers `res {accepted: true}` once the work is queued (or an error `res`).
//! - Node → Gateway `req node.event {invocationId, data}` (zero or more), then exactly one
//!   `req node.result {invocationId, ok, result?, error?, receipt?}`.
//! - `node.cancel {invocationId}` cancels a running invocation (honoured when the Gateway sends it).
//!
//! Logs carry capability names, ids, sizes and outcomes only, never params or results.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::AsyncRead;

use super::cancel::CancelToken;
use super::capability::{CapResult, CapabilityError, ErrorCode, InvocationContext, ReceiptDraft, SideEffect};
use super::channel::{FrameReader, FrameWriter, SendError};
use super::frames::{Frame, ReqFrame, WireError};
use super::log::HelperLog;
use super::registry::{Capability, CapabilityRegistry};

#[derive(Default)]
struct State {
    in_flight: HashMap<String, CancelToken>,
    reserved: HashSet<String>,
    next_request: u64,
}

pub struct NodeSession {
    registry: Arc<CapabilityRegistry>,
    writer: FrameWriter,
    log: HelperLog,
    state: Mutex<State>,
}

#[derive(Deserialize)]
struct InvokeParams {
    #[serde(rename = "invocationId")]
    invocation_id: String,
    capability: String,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default, rename = "approvalId")]
    approval_id: Option<String>,
}

fn wire_error(code: ErrorCode, message: impl Into<String>) -> WireError {
    WireError { code: code.as_str().into(), message: message.into(), details: None, retryable: None }
}

impl NodeSession {
    pub fn new(registry: Arc<CapabilityRegistry>, writer: FrameWriter, log: HelperLog) -> Arc<NodeSession> {
        Arc::new(NodeSession { registry, writer, log, state: Mutex::new(State::default()) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Reads frames until the Gateway closes the connection; in-flight invocations are cancelled
    /// when it returns.
    pub async fn serve<R: AsyncRead + Unpin>(self: &Arc<Self>, reader: &mut FrameReader<R>) -> std::io::Result<()> {
        let result = async {
            while let Some(frame) = reader.next().await? {
                match frame {
                    Frame::Req(req) => self.handle(req),
                    Frame::Res(res) => {
                        if !res.ok {
                            let code = res.error.as_ref().map(|e| e.code.as_str()).unwrap_or("unknown");
                            self.log.error(format!("gateway rejected {}: {code}", res.id));
                        }
                    }
                    Frame::Event(_) => {}
                }
            }
            Ok(())
        }
        .await;
        self.cancel_all();
        result
    }

    /// Invocations currently running (tests, diagnostics).
    pub fn in_flight_count(&self) -> usize {
        self.lock().in_flight.len()
    }

    pub fn cancel_all(&self) {
        let tokens: Vec<CancelToken> = {
            let mut s = self.lock();
            s.reserved.clear();
            s.in_flight.drain().map(|(_, t)| t).collect()
        };
        for t in tokens {
            t.cancel();
        }
    }

    // MARK: Gateway → node

    fn handle(self: &Arc<Self>, req: ReqFrame) {
        match req.method.as_str() {
            "node.invoke" => self.handle_invoke(req),
            "node.cancel" => {
                let id = req.params.as_ref().and_then(|p| p.get("invocationId")).and_then(Value::as_str);
                match id {
                    Some(id) => {
                        let token = self.lock().in_flight.get(id).cloned();
                        if let Some(t) = token {
                            t.cancel();
                        }
                        self.respond(&req.id, json!({ "ok": true }));
                    }
                    None => self.respond_error(&req.id, wire_error(ErrorCode::InvalidParams, "invocationId is required")),
                }
            }
            other => self.respond_error(&req.id, wire_error(ErrorCode::UnknownMethod, format!("Unknown method {other}"))),
        }
    }

    fn handle_invoke(self: &Arc<Self>, req: ReqFrame) {
        let parsed = serde_json::from_value::<InvokeParams>(req.params.clone().unwrap_or(Value::Null))
            .ok()
            .filter(|p| !p.invocation_id.is_empty() && p.invocation_id.chars().count() <= 128);
        let Some(p) = parsed else {
            self.respond_error(&req.id, wire_error(ErrorCode::InvalidParams, "node.invoke needs invocationId and capability"));
            return;
        };
        let Some(cap) = self.registry.get(&p.capability) else {
            self.log.info(format!("invoke capability={} outcome=not_found", p.capability));
            self.respond_error(&req.id, wire_error(ErrorCode::NotFound, format!("Unknown capability {}", p.capability)));
            return;
        };
        {
            let mut s = self.lock();
            if s.in_flight.contains_key(&p.invocation_id) || s.reserved.contains(&p.invocation_id) {
                drop(s);
                self.respond_error(
                    &req.id,
                    wire_error(ErrorCode::Conflict, format!("Invocation {} is already running", p.invocation_id)),
                );
                return;
            }
            s.reserved.insert(p.invocation_id.clone());
        }
        // `accepted` goes out before the work starts, so it always precedes node.event / node.result.
        self.respond(&req.id, json!({ "accepted": true }));
        self.log.info(format!("invoke capability={} approval={}", p.capability, if p.approval_id.is_some() { "yes" } else { "no" }));

        let cancel = CancelToken::new();
        let weak = Arc::downgrade(self);
        let event_id = p.invocation_id.clone();
        let emit = Arc::new(move |data: Value| {
            if let Some(s) = weak.upgrade() {
                s.send_event(&event_id, data);
            }
        });
        let ctx = InvocationContext::with_cancel(
            &p.invocation_id,
            &p.capability,
            p.params.unwrap_or(Value::Null),
            p.approval_id,
            emit,
            cancel.clone(),
        );
        {
            let mut s = self.lock();
            s.reserved.remove(&p.invocation_id);
            s.in_flight.insert(p.invocation_id.clone(), cancel.clone());
        }
        let session = self.clone();
        tokio::spawn(async move {
            let outcome = run(&session.registry, &cap, ctx.clone(), cancel).await;
            session.finish(&cap, &ctx, outcome);
        });
    }

    fn finish(&self, cap: &Capability, ctx: &InvocationContext, outcome: CapResult) {
        self.lock().in_flight.remove(&ctx.invocation_id);
        let spec = &cap.spec;
        let kind = spec.receipt_kind.clone().unwrap_or_else(|| ctx.capability.clone());
        let mut params = Map::new();
        params.insert("invocationId".into(), ctx.invocation_id.clone().into());
        match outcome {
            Ok(output) => {
                params.insert("ok".into(), true.into());
                params.insert("result".into(), output.result);
                if let Some(r) = &output.receipt {
                    params.insert("receipt".into(), r.wire(&kind, ctx.approval_id.as_deref(), SystemTime::now()));
                }
                self.log.info(format!(
                    "result capability={} ok=true receipt={}",
                    ctx.capability,
                    output.receipt.as_ref().map_or("none", |r| r.outcome.as_str())
                ));
            }
            Err(error) => {
                params.insert("ok".into(), false.into());
                params.insert("error".into(), serde_json::to_value(error.wire()).unwrap_or(Value::Null));
                // A refused side effect still gets a failed receipt so the audit trail is complete.
                if spec.side_effect != SideEffect::None && spec.side_effect != SideEffect::Read && error.code != ErrorCode::InvalidParams {
                    let r = ReceiptDraft::failed(format!("{} failed: {}", ctx.capability, error.reason));
                    params.insert("receipt".into(), r.wire(&kind, ctx.approval_id.as_deref(), SystemTime::now()));
                }
                self.log.info(format!(
                    "result capability={} ok=false code={} reason={}",
                    ctx.capability,
                    error.code.as_str(),
                    error.reason
                ));
            }
        }
        self.send_request("node.result", Value::Object(params));
    }

    // MARK: Node → Gateway

    fn send_event(&self, invocation_id: &str, data: Value) {
        // Never after node.result: a leaked emitter must not reopen a finished call.
        let live = {
            let s = self.lock();
            s.in_flight.contains_key(invocation_id) || s.reserved.contains(invocation_id)
        };
        if live {
            self.send_request("node.event", json!({ "invocationId": invocation_id, "data": data }));
        }
    }

    fn send_request(&self, method: &str, params: Value) {
        let id = {
            let mut s = self.lock();
            s.next_request += 1;
            format!("h{}", s.next_request)
        };
        match self.writer.send(&Frame::req(id.clone(), method, Some(params.clone()))) {
            Ok(()) => {}
            Err(SendError::TooLarge) => {
                self.log.error(format!("{method} frame over 1 MiB dropped"));
                if method == "node.result"
                    && let Some(invocation_id) = params.get("invocationId")
                {
                    let error = CapabilityError::internal("result_too_large", "The result exceeded the 1 MiB frame limit");
                    let mut fallback = Map::new();
                    fallback.insert("invocationId".into(), invocation_id.clone());
                    fallback.insert("ok".into(), false.into());
                    fallback.insert("error".into(), serde_json::to_value(error.wire()).unwrap_or(Value::Null));
                    // The side effect (if any) already happened: keep its receipt, marked uncertain.
                    if let Some(Value::Object(mut receipt)) = params.get("receipt").cloned() {
                        receipt.insert("outcome".into(), "uncertain".into());
                        fallback.insert("receipt".into(), Value::Object(receipt));
                    }
                    let _ = self.writer.send(&Frame::req(id, method, Some(Value::Object(fallback))));
                }
            }
            Err(_) => self.log.error(format!("{method} send failed")),
        }
    }

    fn respond(&self, id: &str, payload: Value) {
        let _ = self.writer.send(&Frame::res_ok(id, payload));
    }

    fn respond_error(&self, id: &str, error: WireError) {
        let _ = self.writer.send(&Frame::res_err(id, error));
    }
}

/// Preflight, then the handler, raced against cancellation and the spec's timeout. The handler
/// runs in its own task, so a panic becomes `internal` instead of killing the session.
async fn run(registry: &CapabilityRegistry, cap: &Arc<Capability>, ctx: InvocationContext, cancel: CancelToken) -> CapResult {
    for p in &cap.spec.permissions {
        if !registry.runtime().preflight.is_granted(*p) {
            return Err(CapabilityError::permission_missing(*p));
        }
    }
    let handler = cap.handler.clone();
    let mut task = tokio::spawn(async move { handler(ctx).await });
    let timeout = cap.spec.timeout;
    let sleeper = async {
        match timeout {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        joined = &mut task => match joined {
            Ok(r) => r,
            Err(e) if e.is_cancelled() => Err(CapabilityError::cancelled()),
            Err(_) => Err(CapabilityError::internal("internal", format!("Internal error in {}", cap.spec.name))),
        },
        _ = cancel.cancelled() => {
            task.abort();
            Err(CapabilityError::cancelled())
        }
        _ = sleeper => {
            task.abort();
            Err(CapabilityError::timed_out(timeout.unwrap_or_default()))
        }
    }
}
