//! End-to-end: a fake Gateway on a real named pipe speaks the node handshake and the invoke
//! protocol with the helper's daemon (identity, pointer file, handshake secret, signature check,
//! invoke / event / result / receipts / cancel, reconnect with a new secret, denial).

#![cfg(windows)]

use std::sync::Arc;
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use psyche_win_helper::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, ReceiptDraft, SideEffect,
};
use psyche_win_helper::node::channel::{FrameReader, FrameWriter, spawn_writer};
use psyche_win_helper::node::daemon::{Backoff, NodeDaemon};
use psyche_win_helper::node::encoding::{b64url, b64url_decode, random_bytes};
use psyche_win_helper::node::frames::{Frame, ReqFrame, WireError};
use psyche_win_helper::node::identity::{DeviceIdentity, connect_signing_payload};
use psyche_win_helper::node::log::HelperLog;
use psyche_win_helper::node::paths::Env;
use psyche_win_helper::node::{CapabilityRegistry, Runtime};
use serde_json::{Value, json};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

const STEP: Duration = Duration::from_secs(10);

struct Gateway {
    reader: FrameReader<tokio::io::ReadHalf<NamedPipeServer>>,
    writer: FrameWriter,
    _task: tokio::task::JoinHandle<()>,
}

impl Gateway {
    async fn accept(server: NamedPipeServer) -> Gateway {
        tokio::time::timeout(STEP, server.connect())
            .await
            .expect("helper connects")
            .expect("connect");
        let (r, w) = tokio::io::split(server);
        let (writer, task) = spawn_writer(w);
        Gateway {
            reader: FrameReader::new(r),
            writer,
            _task: task,
        }
    }

    async fn next(&mut self) -> Frame {
        tokio::time::timeout(STEP, self.reader.next())
            .await
            .expect("frame in time")
            .expect("read")
            .expect("not EOF")
    }

    async fn req(&mut self) -> ReqFrame {
        match self.next().await {
            Frame::Req(r) => r,
            other => panic!("expected a request, got {other:?}"),
        }
    }

    async fn res(&mut self, id: &str) -> (bool, Value) {
        loop {
            if let Frame::Res(r) = self.next().await
                && r.id == id
            {
                let body = if r.ok {
                    r.payload.unwrap_or(Value::Null)
                } else {
                    serde_json::to_value(r.error).unwrap()
                };
                return (r.ok, body);
            }
        }
    }

    fn send(&self, f: Frame) {
        self.writer.send(&f).unwrap();
    }

    /// Answers connect + connect.verify; returns the connect params and checks the signature.
    async fn handshake(&mut self, phase: Value) -> Value {
        let connect = self.req().await;
        assert_eq!(connect.method, "connect");
        let params = connect.params.clone().unwrap();
        let nonce = b64url(&random_bytes::<32>());
        self.send(Frame::res_ok(
            &connect.id,
            json!({ "phase": "challenge", "nonce": nonce, "serverOrigin": "psyche://node", "protocolVersion": 1, "expiresAt": "2030-01-01T00:00:00.000Z" }),
        ));
        let verify = self.req().await;
        assert_eq!(verify.method, "connect.verify");
        let vp = verify.params.clone().unwrap();
        assert_eq!(vp["nonce"], nonce);
        let key: [u8; 32] = b64url_decode(params["publicKey"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let sig = Signature::from_slice(&b64url_decode(vp["signature"].as_str().unwrap()).unwrap())
            .unwrap();
        let payload =
            connect_signing_payload(&nonce, "windows", "win-helper", 1, "psyche://node", None)
                .unwrap();
        VerifyingKey::from_bytes(&key)
            .unwrap()
            .verify(&payload, &sig)
            .expect("valid connect signature");
        self.send(Frame::res_ok(&verify.id, phase));
        params
    }

    fn invoke(&self, id: &str, capability: &str, params: Value) {
        self.send(Frame::req(
            format!("g-{id}"),
            "node.invoke",
            Some(json!({ "invocationId": id, "capability": capability, "params": params })),
        ));
    }

    /// Reads node.event / node.result requests for `id` (acknowledging each) until the result.
    async fn collect(&mut self, id: &str) -> (Vec<Value>, Value) {
        let mut events = Vec::new();
        loop {
            let r = self.req().await;
            self.send(Frame::res_ok(&r.id, json!({ "ok": true })));
            let p = r.params.unwrap();
            assert_eq!(p["invocationId"], id);
            match r.method.as_str() {
                "node.event" => events.push(p["data"].clone()),
                "node.result" => return (events, p),
                m => panic!("unexpected {m}"),
            }
        }
    }
}

fn server(pipe: &str, first: bool) -> NamedPipeServer {
    ServerOptions::new()
        .first_pipe_instance(first)
        .create(pipe)
        .expect("create pipe")
}

fn registry(env: Env) -> Arc<CapabilityRegistry> {
    let mut reg = CapabilityRegistry::new(Runtime::offline(env));
    reg.add(
        CapabilitySpec::new("test.echo", "echo", SideEffect::Read),
        |ctx| async move { Ok(CapabilityOutput::new(ctx.params.clone())) },
    );
    reg.add(
        CapabilitySpec::new("test.stream", "stream", SideEffect::Read).streaming(),
        |ctx| async move {
            ctx.emit(json!({ "n": 1 }));
            ctx.emit(json!({ "n": 2 }));
            Ok(CapabilityOutput::new(json!({ "done": true })))
        },
    );
    reg.add(
        CapabilitySpec::new("test.sleep", "sleep", SideEffect::Read),
        |_| async {
            tokio::time::sleep(Duration::from_secs(600)).await;
            Ok(CapabilityOutput::new(json!({})))
        },
    );
    reg.add(
        CapabilitySpec::new("test.write", "write", SideEffect::Write).receipt("test_kind"),
        |_| async {
            Ok(CapabilityOutput::with_receipt(
                json!({ "wrote": true }),
                ReceiptDraft::ok("Wrote").with_ref("k", "v"),
            ))
        },
    );
    reg.add(
        CapabilitySpec::new("test.fail", "fail", SideEffect::Destructive),
        |_| async { Err(CapabilityError::unavailable("nope", "It did not work")) },
    );
    reg.add(
        CapabilitySpec::new("test.slow", "timeout", SideEffect::Read)
            .timeout(Duration::from_millis(100)),
        |_| async {
            tokio::time::sleep(Duration::from_secs(60)).await;
            Ok(CapabilityOutput::new(json!({})))
        },
    );
    Arc::new(reg)
}

fn setup(tag: &str) -> (Env, String, std::path::PathBuf) {
    let home = std::env::temp_dir().join(format!("psyche-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join("run")).unwrap();
    let pipe = format!(r"\\.\pipe\psyche-node-test-{tag}-{}", std::process::id());
    std::fs::write(home.join("run").join("node-socket"), format!("{pipe}\n")).unwrap();
    std::fs::write(home.join("run").join("handshake.secret"), "secret-one\n").unwrap();
    let env = Env::current().with("PSYCHE_HOME", home.display().to_string());
    let env = Env(env
        .0
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("PSYCHE_NODE_SOCKET"))
        .collect());
    (env, pipe, home)
}

fn fast(daemon: &mut NodeDaemon) {
    daemon.backoff = Backoff {
        initial: Duration::from_millis(50),
        max: Duration::from_millis(200),
        pending_retry: Duration::from_millis(50),
        denied_retry: Duration::from_millis(50),
    };
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn handshake_invoke_events_receipts_cancel_and_reconnect() {
    let (env, pipe, home) = setup("flow");
    let first = server(&pipe, true);
    let identity = DeviceIdentity::generate();
    let device_id = identity.device_id();
    let mut daemon = NodeDaemon::new(
        identity,
        registry(env.clone()),
        env.clone(),
        HelperLog::quiet(),
    );
    fast(&mut daemon);
    let daemon = Arc::new(daemon);
    let stop = daemon.stop_token();
    let d = daemon.clone();
    let running = tokio::spawn(async move { d.run().await });

    // Handshake: the declared identity, family, platform, secret and manifest.
    let mut gw = Gateway::accept(first).await;
    let params = gw.handshake(json!({ "phase": "paired", "deviceId": device_id, "scopes": ["node"], "stateVersion": 0, "serverTime": "2030-01-01T00:00:00.000Z" })).await;
    assert_eq!(params["role"], "node");
    assert_eq!(params["platform"], "windows");
    assert_eq!(params["deviceFamily"], "win-helper");
    assert_eq!(params["deviceId"], device_id);
    assert_eq!(params["handshakeSecret"], "secret-one");
    let names: Vec<&str> = params["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"test.echo") && names.contains(&"test.stream"));

    // Plain invoke: accepted first, then the result.
    gw.invoke("i1", "test.echo", json!({ "hello": "world" }));
    let (ok, body) = gw.res("g-i1").await;
    assert!(ok && body == json!({ "accepted": true }));
    let (events, result) = gw.collect("i1").await;
    assert!(events.is_empty());
    assert_eq!(result["ok"], true);
    assert_eq!(result["result"], json!({ "hello": "world" }));
    assert!(result.get("receipt").is_none());

    // Streaming: events before the result.
    gw.invoke("i2", "test.stream", Value::Null);
    assert!(gw.res("g-i2").await.0);
    let (events, result) = gw.collect("i2").await;
    assert_eq!(events, vec![json!({ "n": 1 }), json!({ "n": 2 })]);
    assert_eq!(result["result"], json!({ "done": true }));

    // Unknown capability and malformed invoke.
    gw.invoke("i3", "test.nope", Value::Null);
    let (ok, err) = gw.res("g-i3").await;
    assert!(!ok);
    assert_eq!(err["code"], "not_found");
    gw.send(Frame::req(
        "g-bad",
        "node.invoke",
        Some(json!({ "capability": "test.echo" })),
    ));
    assert_eq!(gw.res("g-bad").await.1["code"], "invalid_params");
    gw.send(Frame::req("g-m", "node.frobnicate", None));
    assert_eq!(gw.res("g-m").await.1["code"], "unknown_method");

    // Receipts: kind from the spec; a refused side effect gets a failed receipt.
    gw.invoke("i4", "test.write", Value::Null);
    assert!(gw.res("g-i4").await.0);
    let (_, result) = gw.collect("i4").await;
    assert_eq!(result["receipt"]["kind"], "test_kind");
    assert_eq!(result["receipt"]["outcome"], "ok");
    assert_eq!(result["receipt"]["externalRefs"], json!({ "k": "v" }));
    gw.invoke("i5", "test.fail", Value::Null);
    assert!(gw.res("g-i5").await.0);
    let (_, result) = gw.collect("i5").await;
    assert_eq!(result["ok"], false);
    assert_eq!(result["error"]["code"], "unavailable");
    assert_eq!(result["error"]["details"]["reason"], "nope");
    assert_eq!(result["receipt"]["outcome"], "failed");
    assert_eq!(result["receipt"]["kind"], "test.fail");

    // Duplicate id while running → conflict; node.cancel → cancelled result.
    gw.invoke("i6", "test.sleep", Value::Null);
    assert!(gw.res("g-i6").await.0);
    gw.invoke("i6", "test.sleep", Value::Null);
    let (ok, err) = gw.res("g-i6").await;
    assert!(!ok && err["code"] == "conflict");
    gw.send(Frame::req(
        "g-c",
        "node.cancel",
        Some(json!({ "invocationId": "i6" })),
    ));
    assert!(gw.res("g-c").await.0);
    let (_, result) = gw.collect("i6").await;
    assert_eq!(result["error"]["code"], "cancelled");

    // Helper-side timeout.
    gw.invoke("i7", "test.slow", Value::Null);
    assert!(gw.res("g-i7").await.0);
    let (_, result) = gw.collect("i7").await;
    assert_eq!(result["error"]["code"], "timeout");

    // Gateway restart: the connection drops, the secret changes, the helper reconnects and
    // presents the new one.
    let second = server(&pipe, false);
    std::fs::write(home.join("run").join("handshake.secret"), "secret-two").unwrap();
    drop(gw);
    let mut gw = Gateway::accept(second).await;
    let params = gw.handshake(json!({ "phase": "paired", "deviceId": device_id, "scopes": ["node"], "stateVersion": 0, "serverTime": "2030-01-01T00:00:00.000Z" })).await;
    assert_eq!(params["handshakeSecret"], "secret-two");
    assert_eq!(
        params["deviceId"], device_id,
        "same identity across reconnects"
    );
    gw.invoke("j1", "test.echo", json!(7));
    assert!(gw.res("g-j1").await.0);
    assert_eq!(gw.collect("j1").await.1["result"], 7);

    stop.cancel();
    drop(gw);
    tokio::time::timeout(STEP, running)
        .await
        .expect("daemon stops")
        .unwrap();
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_and_pending_are_retried() {
    let (env, pipe, home) = setup("deny");
    let first = server(&pipe, true);
    let mut daemon = NodeDaemon::new(
        DeviceIdentity::generate(),
        registry(env.clone()),
        env.clone(),
        HelperLog::quiet(),
    );
    fast(&mut daemon);
    let daemon = Arc::new(daemon);
    let stop = daemon.stop_token();
    let d = daemon.clone();
    let running = tokio::spawn(async move { d.run().await });

    let mut gw = Gateway::accept(first).await;
    let second = server(&pipe, false);
    gw.handshake(json!({ "phase": "denied", "reason": "stale or missing handshake secret" }))
        .await;
    drop(gw);
    let mut gw = Gateway::accept(second).await;
    let third = server(&pipe, false);
    gw.handshake(json!({ "phase": "pending", "pairingRequestId": "pr_1", "code": "1234" }))
        .await;
    drop(gw);
    let mut gw = Gateway::accept(third).await;
    // A Gateway error on connect (e.g. a protocol mismatch) is also retried.
    let c = gw.req().await;
    gw.send(Frame::res_err(
        &c.id,
        WireError {
            code: "protocol_version_mismatch".into(),
            message: "no".into(),
            details: None,
            retryable: None,
        },
    ));

    stop.cancel();
    drop(gw);
    tokio::time::timeout(STEP, running)
        .await
        .expect("daemon stops")
        .unwrap();
    let _ = std::fs::remove_dir_all(home);
}

/// The real groups (computer, screen, speech, dictation) through the node protocol: specs in the
/// manifest, results, refusals with their reasons, and no receipts for reads or invalid params.
/// Reads the screen once (screenshot, region context); never injects input.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_groups_through_the_node_protocol() {
    let (env, pipe, home) = setup("groups");
    let first = server(&pipe, true);
    let identity = DeviceIdentity::generate();
    let device_id = identity.device_id();
    let registry = Arc::new(psyche_win_helper::groups::build(Runtime::offline(
        env.clone(),
    )));
    let mut daemon = NodeDaemon::new(identity, registry, env.clone(), HelperLog::quiet());
    fast(&mut daemon);
    let daemon = Arc::new(daemon);
    let stop = daemon.stop_token();
    let d = daemon.clone();
    let running = tokio::spawn(async move { d.run().await });

    let mut gw = Gateway::accept(first).await;
    let params = gw.handshake(json!({ "phase": "paired", "deviceId": device_id, "scopes": ["node"], "stateVersion": 0, "serverTime": "2030-01-01T00:00:00.000Z" })).await;
    let caps = params["capabilities"].as_array().unwrap();
    let cap = |n: &str| {
        caps.iter()
            .find(|c| c["name"] == n)
            .cloned()
            .unwrap_or_else(|| panic!("{n} missing"))
    };
    assert_eq!(cap("computer.click")["targetKind"], "app");
    assert_eq!(cap("computer.click")["sideEffect"], "write");
    assert_eq!(cap("screen.context")["sideEffect"], "read");
    assert_eq!(cap("speech.transcribe_stream")["streaming"], true);
    let engines = &cap("speech.transcribe_stream")["inputSchema"]["properties"]["engine"]["enum"];
    assert_eq!(*engines, json!(["sapi", "windowsSpeech"]));

    // computer.screenshot: an image of the foreground app, or a policy refusal / approval request
    // with its reason (which one depends on what is in front).
    gw.invoke(
        "s1",
        "computer.screenshot",
        json!({ "maxWidth": 320, "maxHeight": 240 }),
    );
    assert!(gw.res("g-s1").await.0);
    let (events, mut r) = gw.collect("s1").await;
    assert!(events.is_empty());
    if r["error"]["code"] == "approval_required" {
        // The Gateway's approval round: the same call with the approval id, bound to {app, tier}.
        let d = &r["error"]["details"];
        let approval = json!({ "app": d["app"], "tier": d["tierRequired"] });
        gw.send(Frame::req(
            "g-s1b",
            "node.invoke",
            Some(json!({ "invocationId": "s1b", "capability": "computer.screenshot", "approvalId": "apr_e2e",
                "params": { "maxWidth": 320, "maxHeight": 240, "approval": approval } })),
        ));
        assert!(gw.res("g-s1b").await.0);
        r = gw.collect("s1b").await.1;
    }
    assert!(r.get("receipt").is_none(), "reads have no receipt");
    eprintln!(
        "computer.screenshot ok={} code={}",
        r["ok"], r["error"]["code"]
    );
    if r["ok"] == true {
        let res = &r["result"];
        assert!(res["image"].as_str().unwrap().len() > 100);
        assert_eq!(res["mimeType"], "image/jpeg");
        assert!(res["width"].as_u64().unwrap() <= 320 && res["height"].as_u64().unwrap() <= 240);
        assert_eq!(res["provenance"], "untrusted");
        assert!(res["screen"]["width"].as_f64().unwrap() > 0.0);
    } else {
        let code = r["error"]["code"].as_str().unwrap();
        assert!(
            matches!(code, "policy_denied" | "approval_required"),
            "{}",
            r["error"]
        );
        assert!(r["error"]["details"]["reason"].is_string());
    }

    // screen.context over a region: the context, then an image or a refusal.
    gw.invoke(
        "s2",
        "screen.context",
        json!({ "mode": "region", "rect": { "x": 0, "y": 0, "width": 200, "height": 150 }, "maxWidth": 320, "maxHeight": 240 }),
    );
    assert!(gw.res("g-s2").await.0);
    let (_, r) = gw.collect("s2").await;
    assert_eq!(r["ok"], true, "{r}");
    let res = &r["result"];
    assert!(res["context"].get("appName").is_some());
    if res.get("refusal").is_none() {
        assert!(res["image"].as_str().unwrap().len() > 100);
        assert!(res["width"].as_u64().unwrap() > 0);
    }
    // screen.context without `mode`: invalid_params naming the field.
    gw.invoke("s3", "screen.context", json!({}));
    assert!(gw.res("g-s3").await.0);
    let (_, r) = gw.collect("s3").await;
    assert_eq!(r["error"]["code"], "invalid_params");
    assert_eq!(r["error"]["details"]["field"], "mode");

    // A computer action without a session is refused before anything happens; invalid params
    // carry no receipt.
    gw.invoke(
        "s4",
        "computer.click",
        json!({ "x": 1, "y": 1, "app": "notepad.exe" }),
    );
    assert!(gw.res("g-s4").await.0);
    let (_, r) = gw.collect("s4").await;
    assert_eq!(r["error"]["code"], "invalid_params");
    assert_eq!(r["error"]["details"]["field"], "session");
    assert!(r.get("receipt").is_none());

    // speech.status: the on-device engine is the default.
    gw.invoke("s5", "speech.status", Value::Null);
    assert!(gw.res("g-s5").await.0);
    let (_, r) = gw.collect("s5").await;
    assert_eq!(r["ok"], true, "{r}");
    let st = &r["result"];
    assert_eq!(st["engines"]["sapi"]["onDevice"], true);
    assert_eq!(st["engines"]["windowsSpeech"]["onDevice"], false);
    if st["engines"]["sapi"]["available"] == true {
        assert_eq!(st["defaultEngine"], "sapi");
    } else {
        assert_eq!(st["defaultEngine"], Value::Null);
    }

    // dictation.target: the focused element (or null), never its contents.
    gw.invoke("s6", "dictation.target", Value::Null);
    assert!(gw.res("g-s6").await.0);
    let (_, r) = gw.collect("s6").await;
    assert_eq!(r["ok"], true, "{r}");
    let t = &r["result"]["target"];
    assert!(
        t.is_null() || (t["pid"].is_u64() && t["insertable"].is_boolean()),
        "{t}"
    );
    assert!(t.get("value").is_none());
    // The helper-wide app id: a lowercase executable name, never a package family name.
    if let Some(b) = t["bundleId"].as_str() {
        assert!(b.ends_with(".exe") && b == b.to_lowercase(), "{t}");
    }

    stop.cancel();
    drop(gw);
    tokio::time::timeout(STEP, running)
        .await
        .expect("daemon stops")
        .unwrap();
    let _ = std::fs::remove_dir_all(home);
}

/// A daemon serving the real capability groups, paired with a fake Gateway.
struct RealHelper {
    gw: Gateway,
    stop: psyche_win_helper::node::cancel::CancelToken,
    running: tokio::task::JoinHandle<()>,
    home: std::path::PathBuf,
    next: u32,
}

impl RealHelper {
    async fn start(tag: &str) -> RealHelper {
        let (env, pipe, home) = setup(tag);
        let first = server(&pipe, true);
        let identity = DeviceIdentity::generate();
        let device_id = identity.device_id();
        let registry = Arc::new(psyche_win_helper::groups::build(Runtime::offline(
            env.clone(),
        )));
        let mut daemon = NodeDaemon::new(identity, registry, env, HelperLog::quiet());
        fast(&mut daemon);
        let daemon = Arc::new(daemon);
        let stop = daemon.stop_token();
        let d = daemon.clone();
        let running = tokio::spawn(async move { d.run().await });
        let mut gw = Gateway::accept(first).await;
        gw.handshake(json!({ "phase": "paired", "deviceId": device_id, "scopes": ["node"], "stateVersion": 0, "serverTime": "2030-01-01T00:00:00.000Z" })).await;
        RealHelper {
            gw,
            stop,
            running,
            home,
            next: 0,
        }
    }

    /// One invocation's `node.result` payload.
    async fn call(&mut self, capability: &str, params: Value, approval_id: Option<&str>) -> Value {
        self.next += 1;
        let id = format!("c{}", self.next);
        let mut inv = json!({ "invocationId": id, "capability": capability, "params": params });
        if let Some(a) = approval_id {
            inv["approvalId"] = json!(a);
        }
        self.gw
            .send(Frame::req(format!("g-{id}"), "node.invoke", Some(inv)));
        assert!(self.gw.res(&format!("g-{id}")).await.0);
        self.gw.collect(&id).await.1
    }

    /// Like [`Self::call`], answering an `approval_required` refusal once as the Gateway does:
    /// the same call with an approval bound to the app and tier the refusal named.
    async fn call_approved(&mut self, capability: &str, params: Value) -> Value {
        let r = self.call(capability, params.clone(), None).await;
        if r["error"]["code"] != "approval_required" {
            return r;
        }
        let d = &r["error"]["details"];
        let mut p = params;
        p["approval"] = json!({ "app": d["app"], "tier": d["tierRequired"] });
        self.call(capability, p, Some("apr_ids")).await
    }

    async fn stop(self) {
        self.stop.cancel();
        drop(self.gw);
        tokio::time::timeout(STEP, self.running)
            .await
            .expect("daemon stops")
            .unwrap();
        let _ = std::fs::remove_dir_all(self.home);
    }
}

/// The app id a computer-use result names: the snapshot header's `bundleId`, or (refused) the
/// error's `app`.
fn computer_app_id(r: &Value) -> Option<String> {
    let id = if r["ok"] == true {
        &r["result"]["header"]["bundleId"]
    } else {
        &r["error"]["details"]["app"]
    };
    id.as_str().map(str::to_owned)
}

/// Every capability names an app by the same id (the lowercase executable name): `apps.list`
/// agrees with the computer crate's window attribution for every running app, and for the
/// foreground app `apps.list`, `computer.ax_tree`, `screen.context` and `dictation.target` report
/// the same id whenever they reached the same process. Reads only; never changes the foreground.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn app_ids_agree_across_capabilities() {
    let mut h = RealHelper::start("ids").await;
    let list = h.call("apps.list", json!({}), None).await;
    assert_eq!(list["ok"], true, "{list}");
    let apps = list["result"]["apps"].as_array().unwrap().clone();
    let crate_view = psyche_win_computer::win::apps::windowed_apps();
    for a in &apps {
        let id = a["bundleId"].as_str().unwrap_or_default();
        assert_eq!(id, id.to_lowercase(), "{a}");
        assert!(
            !id.contains(['\\', '!']),
            "ids are executable names, not paths or AUMIDs: {a}"
        );
        let exe = a["exe"]
            .as_str()
            .map(|e| psyche_win_computer::app_id_from_exe(e).unwrap());
        assert_eq!(a["bundleId"].as_str().map(str::to_owned), exe, "{a}");
        // Windows that closed or opened between the two listings are skipped.
        if let Some(c) = crate_view
            .iter()
            .find(|c| c.pid == a["pid"].as_u64().unwrap() as u32)
        {
            assert_eq!(c.bundle_id.as_deref().unwrap_or_default(), id, "{a}");
        }
        // Packaged apps hosted in a frame are the hosted app, never the frame host.
        if a["aumid"].as_str().is_some_and(|m| m.contains('!')) {
            assert_ne!(id, "applicationframehost.exe", "{a}");
        }
    }

    let fg_before = psyche_win_helper::win::process::foreground_window();
    let active = apps.iter().find(|a| a["active"] == true).cloned();
    let tree = h
        .call_approved("computer.ax_tree", json!({ "maxEmit": 5 }))
        .await;
    let ctx = h
        .call(
            "screen.context",
            json!({ "mode": "window", "maxWidth": 320, "maxHeight": 240 }),
            None,
        )
        .await;
    let target = h.call("dictation.target", Value::Null, None).await;
    let fg_after = psyche_win_helper::win::process::foreground_window();
    let Some(active) = active.filter(|_| fg_before == fg_after) else {
        eprintln!("no stable foreground app; skipping the foreground comparison");
        return h.stop().await;
    };
    let id = active["bundleId"].as_str().map(str::to_owned);
    let pid = active["pid"].clone();
    eprintln!("foreground app {id:?}");
    if r_pid(&tree) == Some(pid.clone())
        || (tree["ok"] != true && tree["error"]["details"]["app"].is_string())
    {
        assert_eq!(computer_app_id(&tree), id, "computer.ax_tree {tree}");
    }
    assert_eq!(ctx["ok"], true, "{ctx}");
    if ctx["result"]["win"]["exePath"].is_string()
        && ctx["result"]["win"]["exePath"] == active["exe"]
    {
        assert_eq!(
            ctx["result"]["context"]["bundleId"]
                .as_str()
                .map(str::to_owned),
            id,
            "screen.context {ctx}"
        );
    }
    assert_eq!(target["ok"], true, "{target}");
    let t = &target["result"]["target"];
    if t["pid"] == pid {
        assert_eq!(
            t["bundleId"].as_str().map(str::to_owned),
            id,
            "dictation.target {t}"
        );
    }
    h.stop().await;
}

fn r_pid(r: &Value) -> Option<Value> {
    (r["ok"] == true).then(|| r["result"]["header"]["pid"].clone())
}

/// Live: Calculator (a packaged app drawn in an `ApplicationFrameHost.exe` frame) opened by its
/// app id, focused by it, and named `calculatorapp.exe` by `apps.list`, `computer.ax_tree`,
/// `screen.context` and `dictation.target`. Skipped when Calculator is already running (it is the
/// user's then); the Calculator it opens is closed again. `cargo test -- --ignored live_app_ids`
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "opens and focuses Calculator on the desktop"]
async fn live_app_ids_on_calculator() {
    use psyche_win_helper::win::process::{all_processes, app_windows_by_pid};
    const ID: &str = "calculatorapp.exe";
    if all_processes()
        .iter()
        .any(|(_, exe)| exe.eq_ignore_ascii_case(ID))
    {
        eprintln!("Calculator is already running; skipping");
        return;
    }
    let mut h = RealHelper::start("calc").await;
    let opened = h.call("apps.open", json!({ "app": ID }), None).await;
    assert_eq!(opened["ok"], true, "{opened}");
    assert_eq!(opened["result"]["bundleId"], ID, "{opened}");
    assert!(
        opened["result"]["aumid"]
            .as_str()
            .unwrap()
            .ends_with("!App"),
        "{opened}"
    );
    assert_eq!(opened["receipt"]["externalRefs"]["app"], ID);

    let mut listed = None;
    for _ in 0..50 {
        let list = h.call("apps.list", json!({}), None).await;
        listed = list["result"]["apps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["bundleId"] == ID)
            .cloned();
        if listed.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let listed = listed.expect("apps.list shows Calculator");
    // Closes the Calculator this test opened, whatever happens below.
    struct Close(u32);
    impl Drop for Close {
        fn drop(&mut self) {
            for w in app_windows_by_pid().remove(&self.0).unwrap_or_default() {
                // SAFETY: posting WM_CLOSE to the Calculator frame this test opened.
                unsafe {
                    let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(
                        Some(w),
                        windows::Win32::UI::WindowsAndMessaging::WM_CLOSE,
                        windows::Win32::Foundation::WPARAM(0),
                        windows::Win32::Foundation::LPARAM(0),
                    );
                }
            }
        }
    }
    let close = Close(listed["pid"].as_u64().unwrap() as u32);
    assert!(
        listed["packageFamilyName"]
            .as_str()
            .unwrap()
            .starts_with("Microsoft.WindowsCalculator_"),
        "{listed}"
    );

    let focused = h.call_approved("apps.focus", json!({ "app": ID })).await;
    let mut ids: Vec<(&str, Option<String>)> = Vec::new();
    if focused["result"]["focused"] == true {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let list = h.call("apps.list", json!({}), None).await;
        let active = list["result"]["apps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["active"] == true)
            .cloned();
        ids.push((
            "apps.list active",
            active.and_then(|a| a["bundleId"].as_str().map(str::to_owned)),
        ));
        let tree = h
            .call_approved("computer.ax_tree", json!({ "maxEmit": 5 }))
            .await;
        ids.push(("computer.ax_tree (foreground)", computer_app_id(&tree)));
        let ctx = h
            .call(
                "screen.context",
                json!({ "mode": "window", "maxWidth": 320, "maxHeight": 240 }),
                None,
            )
            .await;
        ids.push((
            "screen.context",
            ctx["result"]["context"]["bundleId"]
                .as_str()
                .map(str::to_owned),
        ));
        let target = h.call("dictation.target", Value::Null, None).await;
        ids.push((
            "dictation.target",
            target["result"]["target"]["bundleId"]
                .as_str()
                .map(str::to_owned),
        ));
    } else {
        eprintln!(
            "Windows kept Calculator in the background ({focused}); checking the by-id reads only"
        );
    }
    assert_eq!(focused["result"]["app"], ID, "{focused}");
    let tree = h
        .call_approved("computer.ax_tree", json!({ "app": ID, "maxEmit": 5 }))
        .await;
    ids.push(("computer.ax_tree (by id)", computer_app_id(&tree)));
    drop(close);
    for (cap, id) in &ids {
        assert_eq!(id.as_deref(), Some(ID), "{cap}: {ids:?}");
    }
    h.stop().await;
}

#[tokio::test]
async fn refuses_a_missing_pipe_quietly() {
    let (env, _pipe, home) = setup("missing");
    let daemon = NodeDaemon::new(
        DeviceIdentity::generate(),
        registry(env.clone()),
        env,
        HelperLog::quiet(),
    );
    assert_eq!(
        daemon.run_once().await,
        psyche_win_helper::node::daemon::Outcome::Failed
    );
    let _ = std::fs::remove_dir_all(home);
}
