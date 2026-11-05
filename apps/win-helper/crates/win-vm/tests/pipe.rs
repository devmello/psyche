//! The control pipe end to end (fake backend): DACL, impersonation-level check, NDJSON shapes,
//! progress events, watch, and the binary's console mode.

mod common;

use std::os::windows::io::AsRawHandle;
use std::sync::Arc;
use std::time::Duration;

use psyche_win_vm::server::{Activity, CachedOwner, Server};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
use windows::core::PWSTR;

/// `SECURITY_IMPERSONATION` QoS (`SecurityImpersonation << 16`).
const SECURITY_IMPERSONATION: u32 = 2 << 16;

struct Client {
    lines: tokio::io::Lines<BufReader<tokio::io::ReadHalf<NamedPipeClient>>>,
    write: tokio::io::WriteHalf<NamedPipeClient>,
    handle: HANDLE,
}

impl Client {
    async fn open(name: &str, impersonation: bool) -> Client {
        let mut opts = ClientOptions::new();
        if impersonation {
            opts.security_qos_flags(SECURITY_IMPERSONATION);
        }
        let pipe = loop {
            match opts.open(name) {
                Ok(p) => break p,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        let handle = HANDLE(pipe.as_raw_handle());
        let (r, w) = tokio::io::split(pipe);
        Client { lines: BufReader::new(r).lines(), write: w, handle }
    }

    async fn send(&mut self, v: Value) {
        let mut line = serde_json::to_vec(&v).unwrap();
        line.push(b'\n');
        self.write.write_all(&line).await.unwrap();
    }

    async fn next(&mut self) -> Value {
        let line =
            tokio::time::timeout(Duration::from_secs(10), self.lines.next_line()).await.expect("timed out").unwrap().expect("closed");
        serde_json::from_str(&line).unwrap()
    }

    /// Sends a request and returns (events seen before the response, response).
    async fn call(&mut self, id: &str, method: &str, params: Value, progress: bool) -> (Vec<Value>, Value) {
        self.send(json!({"id": id, "method": method, "params": params, "progress": progress})).await;
        let mut events = Vec::new();
        loop {
            let v = self.next().await;
            if v.get("id").and_then(Value::as_str) == Some(id) {
                return (events, v);
            }
            events.push(v);
        }
    }
}

fn dacl_sddl(h: HANDLE) -> String {
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: reads the DACL of our own pipe handle; the descriptor and string are freed.
    unsafe {
        let e = GetSecurityInfo(h, SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION, None, None, None, None, Some(&mut sd));
        assert_eq!(e.0, 0);
        let mut s = PWSTR::null();
        ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1, DACL_SECURITY_INFORMATION, &mut s, None).unwrap();
        let out = s.to_string().unwrap();
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        out
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn control_pipe_end_to_end() {
    let e = common::env("pipe");
    let me = psyche_win_vm::security::current_user_sid().unwrap();
    let name = format!(r"\\.\pipe\psyche-vm-test-{}", std::process::id());
    let server = Arc::new(Server {
        pipe_name: name.clone(),
        owner_sid: me.clone(),
        manager: e.manager.clone(),
        owner: Arc::new(CachedOwner::default()),
        activity: Arc::new(Activity::default()),
        require_impersonation: true,
    });
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    let srv = tokio::spawn(server.clone().run(stop_rx));

    // A client that forbids impersonation is refused (the service acts with the owner's rights).
    let mut ident = Client::open(&name, false).await;
    let refused = ident.next().await;
    assert_eq!(refused["id"], Value::Null);
    assert_eq!(refused["error"]["details"]["reason"], "impersonation_required");

    let mut c = Client::open(&name, true).await;
    // DACL: the owner and LocalSystem only, network logons denied.
    let sddl = dacl_sddl(c.handle);
    assert!(sddl.contains(&format!(";;;{me})")) && sddl.contains(";;;SY)") && sddl.contains("(D;;") && sddl.contains(";;;NU)"), "{sddl}");
    assert!(!sddl.contains(";;;WD)") && !sddl.contains(";;;AU)") && !sddl.contains(";;;BU)"), "{sddl}");

    let (_, r) = c.call("1", "status", Value::Null, false).await;
    assert_eq!(r, json!({"id": "1", "result": {"guests": [], "active": 0, "supportsGuestProvisioning": true, "maxActive": 1}}));
    let (_, r) = c.call("2", "service_info", json!({}), false).await;
    assert_eq!(r["result"]["hcs"]["available"], true);
    assert_eq!(r["result"]["images"][0]["version"], "linux-1");

    // watch: an ack, the current status, then updates.
    let (_, r) = c.call("w", "watch", json!({}), false).await;
    assert_eq!(r["result"], json!({"watching": true}));
    let first = c.next().await;
    assert_eq!(first["event"], "vm.status");
    assert_eq!(first["data"]["type"], "vm.status");
    assert!(first["data"]["status"]["guests"].is_array());

    // create with progress: vm.import events arrive tagged with the request id.
    let (events, r) = c.call("3", "create", json!({"cpus": 2}), true).await;
    assert_eq!(r["result"]["phase"], "installed");
    let progress: Vec<&Value> = events.iter().filter(|v| v["event"] == "progress").collect();
    assert!(progress.iter().all(|v| v["data"]["id"] == "3" && v["data"]["event"]["type"] == "vm.import"));
    assert_eq!(progress.first().unwrap()["data"]["event"]["phase"], "started");
    assert!(events.iter().any(|v| v["event"] == "vm.updated" && v["data"]["guest"]["name"] == "sandbox"));

    // Without progress no progress events; errors carry the mac reasons.
    let (events, r) = c.call("4", "start", json!({"name": "sandbox"}), false).await;
    assert_eq!(r["result"]["phase"], "running");
    assert!(events.iter().all(|v| v["event"] != "progress"));
    let (_, r) = c.call("5", "delete", json!({}), false).await;
    assert_eq!(r["error"]["code"], "conflict");
    assert_eq!(r["error"]["details"]["reason"], "vm_running");
    let (_, r) = c.call("6", "share_add", json!({"share": "x"}), false).await;
    assert_eq!(r["error"]["details"]["field"], "path");
    let (_, r) = c.call("7", "frobnicate", json!({}), false).await;
    assert_eq!(r["error"]["code"], "unknown_method");
    let (_, r) = c.call("8", "stop", json!({"force": "yes"}), false).await;
    assert_eq!(r["error"]["code"], "invalid_params");
    c.send(json!({"id": 9, "method": "status"})).await;
    let bad = c.next().await;
    assert_eq!(bad["error"]["details"]["field"], "id");

    // Concurrent requests on one connection both answer.
    c.send(json!({"id": "a", "method": "status"})).await;
    c.send(json!({"id": "b", "method": "agent_status"})).await;
    let mut ids = Vec::new();
    while ids.len() < 2 {
        let v = c.next().await;
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            ids.push(id.to_owned());
        }
    }
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);

    let (_, r) = c.call("10", "stop", json!({}), false).await;
    assert_eq!(r["result"]["graceful"], true);
    let (_, r) = c.call("11", "unwatch", json!({}), false).await;
    assert_eq!(r["result"], json!({"closed": true}));
    assert_eq!(server.activity.connections.load(std::sync::atomic::Ordering::SeqCst), 1);
    drop(c);
    drop(ident);
    let _ = stop_tx.send(true);
    srv.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_service_cannot_take_the_pipe_name() {
    let e = common::env("squat");
    let me = psyche_win_vm::security::current_user_sid().unwrap();
    let name = format!(r"\\.\pipe\psyche-vm-squat-{}", std::process::id());
    let _squatter = tokio::net::windows::named_pipe::ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
    let server = Arc::new(Server {
        pipe_name: name,
        owner_sid: me,
        manager: e.manager.clone(),
        owner: Arc::new(CachedOwner::default()),
        activity: Arc::new(Activity::default()),
        require_impersonation: true,
    });
    let (_tx, rx) = tokio::sync::watch::channel(false);
    assert!(server.run(rx).await.is_err(), "first_pipe_instance refuses an existing name");
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_watch_waits_for_quiet() {
    let e = common::env("idle");
    let activity = Arc::new(Activity::default());
    activity.connections.store(1, std::sync::atomic::Ordering::SeqCst);
    let a2 = activity.clone();
    let m = e.manager.clone();
    let idle = tokio::spawn(psyche_win_vm::server::idle_watch(m, a2, Duration::from_millis(100), Duration::from_millis(20)));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!idle.is_finished(), "a connected client keeps the service up");
    activity.connections.store(0, std::sync::atomic::Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(5), idle).await.unwrap().unwrap();
}

/// The binary in console mode with the fake backend (what the Windows helper's tests can use).
#[tokio::test(flavor = "multi_thread")]
async fn binary_console_mode_serves_the_protocol() {
    let e = common::env("bin");
    let name = format!(r"\\.\pipe\psyche-vm-bin-{}", std::process::id());
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_psyche-vm-svc"))
        .args(["run", "--backend", "fake", "--pipe", &name, "--idle-secs", "60"])
        .arg("--home")
        .arg(&e.home)
        .arg("--images")
        .arg(&e.images)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut c = Client::open(&name, true).await;
    let (_, r) = c.call("1", "service_info", json!({}), false).await;
    assert_eq!(r["result"]["hcs"]["backend"], "fake");
    assert_eq!(r["result"]["version"], env!("CARGO_PKG_VERSION"));
    let (_, r) = c.call("2", "create", json!({}), false).await;
    assert_eq!(r["result"]["phase"], "installed", "{r}");
    let (_, r) = c.call("3", "start", json!({}), false).await;
    assert_eq!(r["result"]["phase"], "running");
    let _ = child.kill();
    let _ = child.wait();
    let v = std::process::Command::new(env!("CARGO_BIN_EXE_psyche-vm-svc")).arg("version").output().unwrap();
    let out: Value = serde_json::from_slice(&v.stdout).unwrap();
    assert_eq!(out["version"], env!("CARGO_PKG_VERSION"));
    let bad = std::process::Command::new(env!("CARGO_BIN_EXE_psyche-vm-svc")).arg("frob").output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
}
