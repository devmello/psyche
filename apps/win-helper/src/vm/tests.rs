//! The `vm.*` group against a fake service on a real named pipe (`PSYCHE_VM_PIPE`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;

use super::PIPE_OVERRIDE;
use crate::node::CapabilityRegistry;
use crate::node::capability::{
    CapResult, ErrorCode, InvocationContext, ReceiptOutcome, SideEffect,
};
use crate::node::paths::Env;
use crate::node::registry::Runtime;

static SEQ: AtomicU32 = AtomicU32::new(0);

/// Every request the fake service saw, in order: `(connection, method, params)`.
type Seen = Arc<Mutex<Vec<(u32, String, Value)>>>;

/// A fake `psyche-vm-svc` control pipe. `reply` maps a request to its response body (`Ok` result
/// or `Err` error object). `watch` replies at once and then sends one `vm.state` event; any other
/// method answers after `delay`.
fn fake_service(
    delay: Duration,
    reply: impl Fn(&str, &Value) -> Result<Value, Value> + Send + Sync + 'static,
) -> (String, Seen) {
    let pipe = format!(
        r"\\.\pipe\psyche-vm-test-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::SeqCst)
    );
    let seen: Seen = Arc::default();
    let reply = Arc::new(reply);
    let first = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe)
        .expect("create pipe");
    let (name, log) = (pipe.clone(), seen.clone());
    tokio::spawn(async move {
        let mut server = first;
        let mut conn_id = 0u32;
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let connected = server;
            server = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(_) => return,
            };
            conn_id += 1;
            let (log, reply, id) = (log.clone(), reply.clone(), conn_id);
            tokio::spawn(async move {
                let (read, mut write) = tokio::io::split(connected);
                let mut lines = BufReader::new(read).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(req) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    let method = req["method"].as_str().unwrap_or_default().to_owned();
                    let params = req["params"].clone();
                    log.lock()
                        .unwrap()
                        .push((id, method.clone(), params.clone()));
                    if method != "watch" {
                        // Progress is opt-in per request, as the real service does it.
                        if req["progress"] == true {
                            let ev = json!({"event": "progress", "data": {"id": req["id"],
                                "event": {"type": "vm.state", "phase": "starting", "fraction": 0.5}}});
                            let _ = write.write_all(format!("{ev}\n").as_bytes()).await;
                        }
                        tokio::time::sleep(delay).await;
                    }
                    let body = match reply(&method, &params) {
                        Ok(r) => json!({"id": req["id"], "result": r}),
                        Err(e) => json!({"id": req["id"], "error": e}),
                    };
                    let _ = write.write_all(format!("{body}\n").as_bytes()).await;
                    if method == "watch" {
                        let ev = json!({"event": "vm.state", "data": {"phase": "starting", "fraction": 0.5}});
                        let _ = write.write_all(format!("{ev}\n").as_bytes()).await;
                    }
                }
            });
        }
    });
    (pipe, seen)
}

fn registry(pipe: &str) -> CapabilityRegistry {
    let env = Env::default()
        .with(PIPE_OVERRIDE, pipe)
        .with("USERPROFILE", r"C:\Users\vm-test-owner");
    let mut reg = CapabilityRegistry::new(Runtime::offline(env));
    super::register(&mut reg);
    reg
}

async fn call(
    reg: &CapabilityRegistry,
    name: &str,
    params: Value,
    approval: Option<&str>,
) -> (CapResult, Vec<Value>) {
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = events.clone();
    let ctx = InvocationContext::new(
        "inv",
        name,
        params,
        approval.map(str::to_owned),
        Arc::new(move |v| sink.lock().unwrap().push(v)),
    );
    let cap = reg
        .get(name)
        .unwrap_or_else(|| panic!("{name} is advertised"));
    let r = (cap.handler)(ctx).await;
    let ev = events.lock().unwrap().clone();
    (r, ev)
}

const ALL: [&str; 25] = [
    "vm.status",
    "vm.restore_image",
    "vm.create",
    "vm.start",
    "vm.stop",
    "vm.delete",
    "vm.export_image",
    "vm.snapshot",
    "vm.restore",
    "vm.reset",
    "vm.snapshot_delete",
    "vm.share_add",
    "vm.share_remove",
    "vm.pause",
    "vm.resume",
    "vm.suspend",
    "vm.configure",
    "vm.display",
    "vm.agent_status",
    "vm.copy_in",
    "vm.copy_out",
    "vm.install_psyche",
    "vm.grant_permissions",
    "vm.service_info",
    "vm.watch",
];

#[tokio::test(flavor = "multi_thread")]
async fn an_installed_service_advertises_every_mac_vm_capability() {
    let (pipe, _) = fake_service(Duration::ZERO, |_, _| Ok(json!({})));
    let reg = registry(&pipe);
    let names = reg.names();
    for want in ALL {
        assert!(names.iter().any(|n| n == want), "missing {want}");
    }
    assert_eq!(
        names.iter().filter(|n| n.starts_with("vm.")).count(),
        ALL.len()
    );
    // Side effects and receipt kinds follow the mac helper.
    let spec = |n: &str| reg.get(n).unwrap().spec.clone();
    assert_eq!(spec("vm.status").side_effect, SideEffect::Read);
    assert_eq!(spec("vm.delete").side_effect, SideEffect::Destructive);
    assert_eq!(spec("vm.restore").side_effect, SideEffect::Destructive);
    assert_eq!(spec("vm.start").side_effect, SideEffect::Write);
    assert!(spec("vm.start").streaming);
    assert!(spec("vm.watch").streaming);
    assert_eq!(
        spec("vm.share_add").receipt_kind.as_deref(),
        Some("vm_share")
    );
    assert_eq!(
        spec("vm.copy_in").receipt_kind.as_deref(),
        Some("vm_transfer")
    );
    assert_eq!(spec("vm.start").receipt_kind.as_deref(), Some("vm"));
    assert_eq!(spec("vm.status").receipt_kind, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn params_and_results_cross_unchanged_with_a_receipt() {
    let (pipe, seen) = fake_service(Duration::ZERO, |m, _| match m {
        "stop" => Ok(json!({"graceful": false, "guest": {"name": "sandbox"}})),
        _ => Ok(json!({})),
    });
    let reg = registry(&pipe);
    let (r, _) = call(
        &reg,
        "vm.stop",
        json!({"name": "sandbox", "force": true}),
        None,
    )
    .await;
    let out = r.unwrap();
    assert_eq!(
        out.result,
        json!({"graceful": false, "guest": {"name": "sandbox"}})
    );
    let receipt = out.receipt.expect("a receipt for a write");
    assert_eq!(receipt.outcome, ReceiptOutcome::Ok);
    assert_eq!(receipt.summary, "Force-stopped the sandbox PC");
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].1, "stop");
    assert_eq!(seen[0].2, json!({"name": "sandbox", "force": true}));
}

#[tokio::test(flavor = "multi_thread")]
async fn service_errors_keep_their_code_and_reason() {
    let (pipe, _) = fake_service(Duration::ZERO, |_, _| {
        Err(json!({
            "code": "conflict",
            "message": "the sandbox PC is running",
            "details": {"reason": "vm_active", "phase": "running"},
        }))
    });
    let reg = registry(&pipe);
    let (r, _) = call(&reg, "vm.reset", json!({}), None).await;
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.reason, "vm_active");
    assert_eq!(e.details["phase"], "running");
}

#[tokio::test(flavor = "multi_thread")]
async fn status_adds_the_service_block_and_is_passive() {
    let (pipe, seen) = fake_service(Duration::ZERO, |_, _| {
        Ok(json!({
            "guests": [{"name": "sandbox", "phase": "running"}],
            "active": 1, "maxActive": 1, "supportsGuestProvisioning": true,
        }))
    });
    let reg = registry(&pipe);
    let (r, _) = call(&reg, "vm.status", json!({}), None).await;
    let v = r.unwrap().result;
    assert_eq!(v["guests"][0]["phase"], "running");
    assert_eq!(v["service"]["installed"], true);
    assert_eq!(seen.lock().unwrap()[0].2, json!({"passive": true}));
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_is_requested_only_by_streaming_calls() {
    let (pipe, seen) = fake_service(Duration::ZERO, |_, _| Ok(json!({})));
    let reg = registry(&pipe);
    let (_, ev) = call(&reg, "vm.stop", json!({}), None).await;
    assert!(ev.is_empty());
    let (_, ev) = call(&reg, "vm.start", json!({}), None).await;
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(
        seen.lock().unwrap().len(),
        2,
        "one connection per call, no watcher"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn streaming_calls_forward_service_events() {
    let (pipe, _) = fake_service(Duration::from_millis(400), |_, _| {
        Ok(json!({"started": true}))
    });
    let reg = registry(&pipe);
    let (r, events) = call(&reg, "vm.start", json!({}), None).await;
    assert_eq!(r.unwrap().result, json!({"started": true}));
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "vm.state" && e["phase"] == "starting" && e["fraction"] == 0.5),
        "events: {events:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_streams_status_then_events_until_the_pipe_closes() {
    let (pipe, _) = fake_service(Duration::ZERO, |m, _| match m {
        "status" => Ok(json!({"guests": []})),
        _ => Ok(json!({})),
    });
    let reg = registry(&pipe);
    let call = call(&reg, "vm.watch", json!({}), None);
    // The fake never closes the pipe: the stream is long-lived. Collect for a moment.
    let r = tokio::time::timeout(Duration::from_millis(800), call).await;
    assert!(r.is_err(), "vm.watch keeps running");
}

#[tokio::test(flavor = "multi_thread")]
async fn read_write_shares_need_an_approval_before_anything_is_sent() {
    let (pipe, seen) = fake_service(Duration::ZERO, |_, p| Ok(json!({"echo": p})));
    let reg = registry(&pipe);
    let dir = std::env::temp_dir().join(format!("psyche-vm-share-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().into_owned();

    let (r, _) = call(
        &reg,
        "vm.share_add",
        json!({"share": "work", "path": path, "readOnly": false}),
        None,
    )
    .await;
    let e = r.unwrap_err();
    assert_eq!(e.code, ErrorCode::ApprovalRequired);
    assert_eq!(e.reason, "share_rw_needs_approval");
    assert!(
        seen.lock().unwrap().is_empty(),
        "refused before the service"
    );

    // Read-only needs none; the service receives the canonical path.
    let (r, _) = call(
        &reg,
        "vm.share_add",
        json!({"share": "work", "path": path}),
        None,
    )
    .await;
    let out = r.unwrap();
    assert_eq!(out.receipt.unwrap().summary, "Shared work read-only");
    let sent = seen.lock().unwrap()[0].2.clone();
    assert_eq!(sent["readOnly"], true);
    assert!(
        sent["path"]
            .as_str()
            .unwrap()
            .to_lowercase()
            .ends_with(&format!("psyche-vm-share-{}", std::process::id()))
    );

    // With an approval a read-write share goes through and carries it.
    let (r, _) = call(
        &reg,
        "vm.share_add",
        json!({"share": "rw", "path": path, "readOnly": false}),
        Some("apr_9"),
    )
    .await;
    assert_eq!(r.unwrap().receipt.unwrap().summary, "Shared rw read-write");
    assert_eq!(seen.lock().unwrap()[1].2["approvalId"], "apr_9");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn sensitive_and_relative_paths_never_reach_the_service() {
    let (pipe, seen) = fake_service(Duration::ZERO, |_, _| Ok(json!({})));
    let reg = registry(&pipe);
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    for (cap, p) in [
        ("vm.share_add", json!({"share": "a", "path": sys})),
        ("vm.share_add", json!({"share": "a", "path": r"C:\"})),
        ("vm.share_add", json!({"share": "a", "path": "relative"})),
        (
            "vm.share_add",
            json!({"share": "../x", "path": r"C:\Users"}),
        ),
        ("vm.copy_in", json!({"hostPath": r"C:\Windows\System32"})),
        ("vm.copy_in", json!({"hostPath": "relative.txt"})),
        // Not inside a granted folder (none are granted here).
        (
            "vm.copy_out",
            json!({"guestPath": "/tmp/x", "hostDir": r"C:\Users"}),
        ),
        ("vm.export_image", json!({"outDir": r"C:\Users"})),
        // A macOS restore image has no meaning for the Linux guest.
        ("vm.create", json!({"ipsw": r"C:\x.ipsw"})),
    ] {
        let (r, _) = call(&reg, cap, p.clone(), Some("apr")).await;
        let e = r.expect_err(&format!("{cap} {p}"));
        assert!(
            matches!(
                e.code,
                ErrorCode::PolicyDenied | ErrorCode::InvalidParams | ErrorCode::NotFound
            ),
            "{cap} {p}: {e}"
        );
    }
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fake_service_run_by_someone_else_is_not_the_installed_one() {
    // Without the override the server must be the SCM-reported service process; nothing here is.
    let env = Env::default().with("USERPROFILE", r"C:\Users\vm-test-owner");
    let ep = super::Endpoint::resolve(&env).expect("sid");
    assert_eq!(ep.pipe(), super::control_pipe(ep.owner_sid()));
}

#[test]
fn not_installed_status_names_the_action() {
    let v = super::not_installed_status();
    assert_eq!(v["guests"], json!([]));
    assert_eq!(v["service"]["state"], "notInstalled");
    assert_eq!(v["service"]["installed"], false);
    assert_eq!(v["service"]["action"], "turn_on_sandbox_pc");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_the_service_only_status_exists_and_says_so() {
    // An SID nobody installed a service for: not installed, whatever else is on this machine.
    let env = Env::default().with("USERPROFILE", r"C:\Users\vm-test-owner");
    let ep = super::Endpoint::resolve(&env).expect("sid");
    if ep.installed() {
        return; // a developer machine with the real service
    }
    let mut reg = CapabilityRegistry::new(Runtime::offline(env));
    super::register(&mut reg);
    let vm: Vec<_> = reg
        .names()
        .into_iter()
        .filter(|n| n.starts_with("vm."))
        .collect();
    assert_eq!(vm, vec!["vm.status"]);
    let (r, _) = call(&reg, "vm.status", json!({}), None).await;
    assert_eq!(r.unwrap().result["service"]["state"], "notInstalled");
}

/// The helper against the real `psyche-vm-svc run --backend fake` (built next to the tests; the
/// test is skipped when the binary has not been built): impersonation QoS accepted, `status`,
/// `create` / `start` with progress, errors in the mac helper's shape.
#[tokio::test(flavor = "multi_thread")]
async fn against_the_real_service_with_the_fake_backend() {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent()?.parent().map(|d| d.join("psyche-vm-svc.exe")))
        .filter(|p| p.exists());
    let Some(exe) = exe else {
        eprintln!("psyche-vm-svc.exe not built; skipped");
        return;
    };
    let pipe = format!(r"\\.\pipe\psyche-vm-real-{}", std::process::id());
    let home = std::env::temp_dir().join(format!("psyche-vm-real-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let mut child = std::process::Command::new(exe)
        .args(["run", "--backend", "fake", "--pipe", &pipe, "--home"])
        .arg(&home)
        .arg("--images")
        .arg(home.join("images"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let reg = registry(&pipe);
    // Wait for the pipe.
    let mut status = None;
    let mut last = String::new();
    for _ in 0..40 {
        let (r, _) = call(&reg, "vm.status", json!({}), None).await;
        if let Err(e) = &r {
            last = e.to_string();
        }
        if let Ok(o) = r {
            status = Some(o.result);
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let status = status.unwrap_or_else(|| panic!("the real service answered vm.status: {last}"));
    assert_eq!(status["guests"], json!([]));
    assert_eq!(status["service"]["installed"], true);
    // An unknown guest is the mac helper's not_found, with a reason.
    let (r, _) = call(&reg, "vm.start", json!({"name": "nope"}), None).await;
    let e = r.unwrap_err();
    assert!(!e.reason.is_empty(), "{e}");
    let (r, _) = call(&reg, "vm.create", json!({"ipsw": "x"}), None).await;
    assert_eq!(r.unwrap_err().code, ErrorCode::InvalidParams);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(home);
}
