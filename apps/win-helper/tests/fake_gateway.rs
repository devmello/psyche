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
