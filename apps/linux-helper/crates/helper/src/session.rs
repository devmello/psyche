//! Serves the node protocol on a paired connection (architecture §7, wire spec v1), as
//! `NodeSession` does in the Mac helper:
//!
//! - Gateway -> node `req node.invoke {invocationId, capability, params, approvalId?}`: the node
//!   answers `res {accepted: true}` once the work is queued (or an error `res`).
//! - Node -> Gateway `req node.event {invocationId, data}` (zero or more), then exactly one
//!   `req node.result {invocationId, ok, result?, error?}`.
//!
//! Logs carry capability names, ids and outcomes only, never params or results.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use psyche_protocol::frame::{error_payload, req_line, res_err_line, res_ok_line, Incoming};
use psyche_protocol::{ErrorCode, NodeEventParams, NodeInvokeParams, NodeResultParams, ReqFrame};
use serde_json::{json, Value};

use crate::capability::{needs_approval, CapabilityError, InvocationContext, Output, Registry};
use crate::channel::{FrameReader, HelperError, Read1};
use crate::idle::IdleTimer;

/// Invocations running at once (each has its own thread). The Gateway never sends this many.
pub const MAX_IN_FLIGHT: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum ServeEnd {
    /// The Gateway closed the connection.
    Closed,
    /// The quiet period ran out with nothing in flight: the helper should exit.
    Idle,
}

struct Shared<W: Write + Send> {
    writer: Mutex<W>,
    registry: Registry,
    idle: Arc<IdleTimer>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Invocations running or about to run, with their cancel flags.
    in_flight: HashMap<String, Arc<AtomicBool>>,
    next_request: u64,
}

impl<W: Write + Send> Shared<W> {
    fn send(&self, line: Vec<u8>) {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if writer
            .write_all(&line)
            .and_then(|()| writer.flush())
            .is_err()
        {
            crate::log("write to the Gateway failed");
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn in_flight(&self) -> usize {
        self.state().in_flight.len()
    }

    fn next_request_id(&self) -> String {
        let mut state = self.state();
        state.next_request += 1;
        format!("h{}", state.next_request)
    }

    fn send_request(&self, method: &str, params: &Value) {
        let id = self.next_request_id();
        match req_line(&id, method, params) {
            Ok(line) => self.send(line),
            Err(e) => crate::log(&format!("{method} not sent: {e}")),
        }
    }

    fn respond_ok(&self, id: &str, payload: Value) {
        if let Ok(line) = res_ok_line(id, &payload) {
            self.send(line);
        }
    }

    fn respond_err(&self, id: &str, code: ErrorCode, message: &str) {
        if let Ok(line) = res_err_line(id, &error_payload(code, message)) {
            self.send(line);
        }
    }
}

/// Serves one paired connection until the Gateway closes it or the helper goes idle. `reader`
/// must have a short read timeout so the idle check runs. In-flight invocations are cancelled
/// when this returns.
pub fn serve<R: Read, W: Write + Send + 'static>(
    reader: &mut FrameReader<R>,
    writer: W,
    registry: Registry,
    idle: Arc<IdleTimer>,
) -> Result<ServeEnd, HelperError> {
    let shared = Arc::new(Shared {
        writer: Mutex::new(writer),
        registry,
        idle,
        state: Mutex::new(State::default()),
    });
    let outcome = loop {
        match reader.read_frame() {
            Ok(Read1::Closed) => break Ok(ServeEnd::Closed),
            Ok(Read1::Tick) => {
                if shared.idle.expired(shared.in_flight()) {
                    break Ok(ServeEnd::Idle);
                }
            }
            Ok(Read1::Frame(Incoming::Req(req))) => {
                shared.idle.touch();
                handle_request(&shared, req);
            }
            Ok(Read1::Frame(Incoming::ResErr(res))) => {
                // Answer to one of our node.event / node.result requests.
                crate::log(&format!(
                    "gateway rejected {}: {:?}",
                    res.id.as_str(),
                    res.error.code
                ));
            }
            Ok(Read1::Frame(_)) => {}
            Err(e) => break Err(e),
        }
    };
    for flag in shared.state().in_flight.values() {
        flag.store(true, Ordering::SeqCst);
    }
    outcome
}

fn handle_request<W: Write + Send + 'static>(shared: &Arc<Shared<W>>, req: ReqFrame) {
    let id = req.id.to_string();
    match req.method.to_string().as_str() {
        "node.invoke" => handle_invoke(shared, &id, req.params),
        "node.cancel" => {
            let invocation = req
                .params
                .as_ref()
                .and_then(|p| p.get("invocationId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            match invocation {
                Some(invocation) => {
                    if let Some(flag) = shared.state().in_flight.get(&invocation) {
                        flag.store(true, Ordering::SeqCst);
                    }
                    shared.respond_ok(&id, json!({ "ok": true }));
                }
                None => {
                    shared.respond_err(&id, ErrorCode::InvalidParams, "invocationId is required")
                }
            }
        }
        other => shared.respond_err(
            &id,
            ErrorCode::UnknownMethod,
            &format!("Unknown method {other}"),
        ),
    }
}

fn handle_invoke<W: Write + Send + 'static>(
    shared: &Arc<Shared<W>>,
    request_id: &str,
    params: Option<Value>,
) {
    let Some(invoke) = params.and_then(|p| serde_json::from_value::<NodeInvokeParams>(p).ok())
    else {
        shared.respond_err(
            request_id,
            ErrorCode::InvalidParams,
            "node.invoke needs invocationId and capability",
        );
        return;
    };
    let invocation_id = invoke.invocation_id.to_string();
    let capability_name = invoke.capability.to_string();
    let Some(capability) = shared.registry.get(&capability_name).cloned() else {
        crate::log(&format!(
            "invoke capability={capability_name} outcome=not_found"
        ));
        shared.respond_err(
            request_id,
            ErrorCode::NotFound,
            &format!("Unknown capability {capability_name}"),
        );
        return;
    };
    let spec = capability.spec();
    let approval_id = invoke.approval_id.map(|a| a.to_string());
    if needs_approval(spec.side_effect) && approval_id.is_none() {
        crate::log(&format!(
            "invoke capability={capability_name} outcome=approval_required"
        ));
        shared.respond_err(
            request_id,
            ErrorCode::ApprovalRequired,
            "This capability needs an approval",
        );
        return;
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut state = shared.state();
        // One thread per invocation: beyond the cap the Gateway is told to come back later.
        if state.in_flight.len() >= MAX_IN_FLIGHT {
            drop(state);
            crate::log(&format!("invoke capability={capability_name} outcome=busy"));
            shared.respond_err(
                request_id,
                ErrorCode::Unavailable,
                "The helper is busy with other invocations; try again shortly",
            );
            return;
        }
        if state.in_flight.contains_key(&invocation_id) {
            drop(state);
            shared.respond_err(
                request_id,
                ErrorCode::Conflict,
                &format!("Invocation {invocation_id} is already running"),
            );
            return;
        }
        state
            .in_flight
            .insert(invocation_id.clone(), Arc::clone(&cancelled));
    }
    // `accepted` goes out before the work starts, so it always precedes node.event/node.result.
    shared.respond_ok(request_id, json!({ "accepted": true }));
    crate::log(&format!(
        "invoke capability={capability_name} approval={}",
        if approval_id.is_some() { "yes" } else { "no" }
    ));

    let shared = Arc::clone(shared);
    std::thread::spawn(move || {
        let emit = {
            let shared = Arc::clone(&shared);
            let id = invocation_id.clone();
            Arc::new(move |data: Value| {
                // Never after node.result: a leaked emitter must not reopen a finished call.
                if !shared.state().in_flight.contains_key(&id) {
                    return;
                }
                let Ok(params) = serde_json::to_value(NodeEventParams {
                    data,
                    invocation_id: match id.as_str().try_into() {
                        Ok(v) => v,
                        Err(_) => return,
                    },
                }) else {
                    return;
                };
                shared.send_request("node.event", &params);
            }) as Arc<dyn Fn(Value) + Send + Sync>
        };
        let ctx = InvocationContext {
            invocation_id: invocation_id.clone(),
            capability: capability_name.clone(),
            params: invoke.params,
            approval_id,
            emit,
            cancelled: Arc::clone(&cancelled),
        };
        let outcome = if cancelled.load(Ordering::SeqCst) {
            Err(CapabilityError::new(
                ErrorCode::Cancelled,
                "cancelled",
                "Cancelled",
            ))
        } else {
            capability.invoke_full(&ctx)
        };
        let receipt = ReceiptPlan {
            kind: capability.receipt_kind(),
            approval_id: ctx.approval_id.clone(),
            side_effect: spec.side_effect,
        };
        finish(&shared, &invocation_id, &capability_name, outcome, &receipt);
    });
}

/// What `finish` needs to attach a receipt.
struct ReceiptPlan {
    kind: Option<&'static str>,
    approval_id: Option<String>,
    side_effect: psyche_protocol::SideEffect,
}

fn finish<W: Write + Send>(
    shared: &Shared<W>,
    invocation_id: &str,
    capability: &str,
    outcome: Result<Output, CapabilityError>,
    plan: &ReceiptPlan,
) {
    let Ok(id) = invocation_id.try_into() else {
        return;
    };
    let params = match &outcome {
        Ok(output) => {
            let receipt = plan
                .kind
                .zip(output.receipt.as_ref())
                .and_then(|(kind, draft)| {
                    draft.wire(
                        kind,
                        plan.approval_id.as_deref(),
                        std::time::SystemTime::now(),
                    )
                });
            crate::log(&format!(
                "result capability={capability} ok=true receipt={}",
                output.receipt.as_ref().map_or("none", |r| r.outcome)
            ));
            NodeResultParams {
                error: None,
                invocation_id: id,
                ok: true,
                receipt,
                result: Some(output.result.clone()),
            }
        }
        Err(error) => {
            crate::log(&format!(
                "result capability={capability} ok=false code={:?} reason={}",
                error.code, error.reason
            ));
            // A refused side effect still gets a failed receipt, so the audit trail is complete.
            let receipt = plan
                .kind
                .filter(|_| {
                    !matches!(
                        plan.side_effect,
                        psyche_protocol::SideEffect::None | psyche_protocol::SideEffect::Read
                    ) && error.code != ErrorCode::InvalidParams
                })
                .and_then(|kind| {
                    crate::receipt::ReceiptDraft::failed(format!(
                        "{capability} failed: {}",
                        error.reason
                    ))
                    .wire(
                        kind,
                        plan.approval_id.as_deref(),
                        std::time::SystemTime::now(),
                    )
                });
            NodeResultParams {
                error: Some(error.payload()),
                invocation_id: id,
                ok: false,
                receipt,
                result: None,
            }
        }
    };
    // Leave the in-flight set only now, so a duplicate id is refused until the result is sent.
    if let Ok(value) = serde_json::to_value(&params) {
        shared.send_request("node.result", &value);
    }
    shared.state().in_flight.remove(invocation_id);
    shared.idle.touch();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;
    use crate::capability::{Capability, CapabilitySpec};
    use psyche_protocol::SideEffect;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    struct Echo;
    impl Capability for Echo {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: "test.echo",
                description: "echo",
                side_effect: SideEffect::None,
                target_kind: None,
                streaming: true,
            }
        }
        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            (ctx.emit)(json!({ "progress": 1 }));
            Ok(ctx.params.clone())
        }
    }

    struct Danger;
    impl Capability for Danger {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: "test.danger",
                description: "destructive",
                side_effect: SideEffect::Destructive,
                target_kind: None,
                streaming: false,
            }
        }
        fn invoke(&self, _: &InvocationContext) -> Result<Value, CapabilityError> {
            Ok(json!("ran"))
        }
    }

    struct Acts;
    impl Capability for Acts {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: "test.acts",
                description: "writes",
                side_effect: SideEffect::Write,
                target_kind: None,
                streaming: false,
            }
        }
        fn receipt_kind(&self) -> Option<&'static str> {
            Some("computer_action")
        }
        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            if ctx.params["fail"] == true {
                return Err(CapabilityError::new(
                    ErrorCode::Conflict,
                    "focus_moved",
                    "moved",
                ));
            }
            Ok(json!({"status": "unverified"}))
        }
        fn invoke_full(&self, ctx: &InvocationContext) -> Result<Output, CapabilityError> {
            let result = self.invoke(ctx)?;
            Ok(Output {
                result,
                receipt: Some(crate::receipt::ReceiptDraft {
                    outcome: "uncertain",
                    summary: "click in Text Editor: unverified".into(),
                    external_refs: serde_json::Map::new(),
                }),
            })
        }
    }

    struct Wait;
    impl Capability for Wait {
        fn spec(&self) -> CapabilitySpec {
            CapabilitySpec {
                name: "test.wait",
                description: "waits for cancel",
                side_effect: SideEffect::None,
                target_kind: None,
                streaming: false,
            }
        }
        fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
            while !ctx.cancelled.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(CapabilityError::new(
                ErrorCode::Cancelled,
                "cancelled",
                "Cancelled",
            ))
        }
    }

    struct Harness {
        gateway: BufReader<UnixStream>,
        gateway_w: UnixStream,
        helper: Option<std::thread::JoinHandle<ServeEnd>>,
    }

    fn start(idle: Option<Duration>) -> Harness {
        let (a, b) = UnixStream::pair().unwrap();
        a.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        b.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut registry = Registry::standard(BuildInfo::current());
        registry.register(Arc::new(Echo));
        registry.register(Arc::new(Danger));
        registry.register(Arc::new(Acts));
        registry.register(Arc::new(Wait));
        let helper = std::thread::spawn(move || {
            let mut reader = FrameReader::new(a.try_clone().unwrap());
            serve(&mut reader, a, registry, Arc::new(IdleTimer::new(idle))).unwrap()
        });
        Harness {
            gateway: BufReader::new(b.try_clone().unwrap()),
            gateway_w: b,
            helper: Some(helper),
        }
    }

    impl Harness {
        fn send(&mut self, v: Value) {
            writeln!(self.gateway_w, "{v}").unwrap();
        }
        fn read(&mut self) -> Value {
            let mut line = String::new();
            self.gateway.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        }
        fn invoke(&mut self, req: &str, invocation: &str, capability: &str, params: Value) {
            self.send(json!({
                "type": "req", "id": req, "method": "node.invoke",
                "params": { "invocationId": invocation, "capability": capability, "params": params }
            }));
        }
        fn finish(mut self) -> ServeEnd {
            let _ = self.gateway_w.shutdown(std::net::Shutdown::Both);
            self.helper.take().unwrap().join().unwrap()
        }
    }

    #[test]
    fn accepts_then_streams_events_then_one_result() {
        let mut h = start(None);
        h.invoke("r1", "inv1", "test.echo", json!({ "a": 1 }));
        let accepted = h.read();
        assert_eq!(accepted["id"], "r1");
        assert_eq!(accepted["payload"]["accepted"], true);
        let event = h.read();
        assert_eq!(event["method"], "node.event");
        assert_eq!(event["params"]["invocationId"], "inv1");
        assert_eq!(event["params"]["data"]["progress"], 1);
        let result = h.read();
        assert_eq!(result["method"], "node.result");
        assert_eq!(result["params"]["ok"], true);
        assert_eq!(result["params"]["result"], json!({ "a": 1 }));
        assert_eq!(h.finish(), ServeEnd::Closed);
    }

    #[test]
    fn side_effects_carry_a_receipt_with_the_kind_outcome_and_approval() {
        let mut h = start(None);
        h.send(json!({
            "type": "req", "id": "r1", "method": "node.invoke",
            "params": { "invocationId": "inv1", "capability": "test.acts", "params": {}, "approvalId": "ap9" }
        }));
        assert_eq!(h.read()["payload"]["accepted"], true);
        let result = h.read();
        let receipt = &result["params"]["receipt"];
        assert!(receipt["id"].as_str().unwrap().starts_with("rcpt_"));
        assert_eq!(receipt["kind"], "computer_action");
        assert_eq!(receipt["outcome"], "uncertain");
        assert_eq!(receipt["approvalId"], "ap9");
        // A refused side effect still leaves a failed receipt; a read does not.
        h.invoke("r2", "inv2", "test.acts", json!({"fail": true}));
        assert_eq!(h.read()["payload"]["accepted"], true);
        let failed = h.read();
        assert_eq!(failed["params"]["ok"], false);
        assert_eq!(failed["params"]["receipt"]["outcome"], "failed");
        h.invoke("r3", "inv3", "health", json!({}));
        h.read();
        assert!(h.read()["params"].get("receipt").is_none());
        h.finish();
    }

    #[test]
    fn health_answers() {
        let mut h = start(None);
        h.invoke("r1", "inv1", "health", json!({}));
        assert_eq!(h.read()["payload"]["accepted"], true);
        let result = h.read();
        assert_eq!(result["params"]["result"]["ok"], true);
        h.finish();
    }

    #[test]
    fn unknown_capability_is_not_found_and_bad_params_are_invalid() {
        let mut h = start(None);
        h.invoke("r1", "inv1", "nope", json!({}));
        let r = h.read();
        assert_eq!(r["ok"], false);
        assert_eq!(r["error"]["code"], "not_found");
        h.send(json!({ "type": "req", "id": "r2", "method": "node.invoke", "params": { "x": 1 } }));
        assert_eq!(h.read()["error"]["code"], "invalid_params");
        h.send(json!({ "type": "req", "id": "r3", "method": "bogus" }));
        assert_eq!(h.read()["error"]["code"], "unknown_method");
        h.finish();
    }

    #[test]
    fn destructive_capabilities_refuse_without_an_approval() {
        let mut h = start(None);
        h.invoke("r1", "inv1", "test.danger", json!({}));
        let r = h.read();
        assert_eq!(r["error"]["code"], "approval_required");
        h.send(json!({
            "type": "req", "id": "r2", "method": "node.invoke",
            "params": { "invocationId": "inv2", "capability": "test.danger", "params": {}, "approvalId": "ap1" }
        }));
        assert_eq!(h.read()["payload"]["accepted"], true);
        assert_eq!(h.read()["params"]["result"], "ran");
        h.finish();
    }

    #[test]
    fn a_running_invocation_id_cannot_be_reused_and_can_be_cancelled() {
        let mut h = start(None);
        h.invoke("r1", "inv1", "test.wait", json!({}));
        assert_eq!(h.read()["payload"]["accepted"], true);
        h.invoke("r2", "inv1", "test.wait", json!({}));
        assert_eq!(h.read()["error"]["code"], "conflict");
        h.send(json!({ "type": "req", "id": "r3", "method": "node.cancel", "params": { "invocationId": "inv1" } }));
        assert_eq!(h.read()["payload"]["ok"], true);
        let result = h.read();
        assert_eq!(result["method"], "node.result");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "cancelled");
        h.finish();
    }

    #[test]
    fn goes_idle_when_nothing_is_running_and_not_while_work_is() {
        let h = start(Some(Duration::from_millis(100)));
        let end = h.helper.as_ref().map(|j| j.is_finished());
        assert_eq!(end, Some(false));
        let mut h = h;
        let join = h.helper.take().unwrap();
        assert_eq!(join.join().unwrap(), ServeEnd::Idle);

        let mut busy = start(Some(Duration::from_millis(100)));
        busy.invoke("r1", "inv1", "test.wait", json!({}));
        assert_eq!(busy.read()["payload"]["accepted"], true);
        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !busy.helper.as_ref().unwrap().is_finished(),
            "in-flight work keeps the helper up"
        );
        busy.send(json!({ "type": "req", "id": "c", "method": "node.cancel", "params": { "invocationId": "inv1" } }));
        busy.read();
        busy.read();
        assert_eq!(busy.helper.take().unwrap().join().unwrap(), ServeEnd::Idle);
    }
}
