//! The real `psyche-helper.exe`: CLI flags, exit codes and a handshake against a fake Gateway.

#![cfg(windows)]

use std::process::Command;
use std::time::Duration;

use psyche_win_helper::node::channel::{FrameReader, spawn_writer};
use psyche_win_helper::node::encoding::{b64url, random_bytes};
use psyche_win_helper::node::frames::Frame;
use serde_json::{Value, json};
use tokio::net::windows::named_pipe::ServerOptions;

const EXE: &str = env!("CARGO_BIN_EXE_psyche-helper");

fn home(tag: &str) -> std::path::PathBuf {
    let h = std::env::temp_dir().join(format!("psyche-bin-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&h);
    std::fs::create_dir_all(h.join("run")).unwrap();
    h
}

fn helper(home: &std::path::Path) -> Command {
    let mut c = Command::new(EXE);
    c.env("PSYCHE_HOME", home)
        .env("PSYCHE_HELPER_NO_REGISTER", "1")
        .env_remove("PSYCHE_NODE_SOCKET");
    c
}

#[test]
fn manifest_lists_the_windows_capabilities() {
    let h = home("manifest");
    let out = helper(&h).arg("--manifest").output().unwrap();
    assert!(out.status.success());
    let m: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(m["platform"], "windows");
    let names: Vec<&str> = m["capabilities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    for want in [
        "notify.show",
        "notify.withdraw",
        "notify.subscribe",
        "notify.authorization_status",
        "notify.request_authorization",
        "presence.public_key",
        "presence.confirm",
        "vault.unlock",
        "keychain.status",
        "keychain.store",
        "keychain.retrieve",
        "keychain.set",
        "keychain.delete",
        "keychain.delete_item",
        "permissions.status",
        "permissions.request",
        "permissions.open_settings",
        "apps.list",
        "apps.focus",
        "apps.open",
        "files.trash",
        "files.move",
        "files.rename",
        "files.recent",
        "finder.reveal",
        "finder.list",
        "ocr.recognize",
        "health",
        "computer.ax_tree",
        "computer.ax_value",
        "computer.click",
        "computer.double_click",
        "computer.right_click",
        "computer.press",
        "computer.set_value",
        "computer.select",
        "computer.type",
        "computer.key",
        "computer.scroll",
        "computer.drag",
        "computer.menu",
        "computer.end_session",
        "computer.screenshot",
        "computer.screenshot_pick",
        "screen.context",
        "dictation.target",
        "dictation.insert",
        "dictation.watch",
        "speech.transcribe_stream",
        "speech.transcribe_file",
        "speech.audio_push",
        "speech.stop",
        "speech.status",
        "teach.start",
        "teach.stop",
        "teach.cancel",
        "teach.status",
        "chrome.tabs",
        "chrome.current_tab",
    ] {
        assert!(names.contains(&want), "missing {want}");
    }
    // No text-to-speech (owner decision).
    assert!(
        !names
            .iter()
            .any(|n| *n == "speech.synthesize" || *n == "speech.voices")
    );
    // Apple-only capabilities are not offered.
    assert!(
        !names
            .iter()
            .any(|n| n.starts_with("apps.applescript") || n.starts_with("notes."))
    );
    // `vm.*` (the sandbox PC) is advertised in full only once its service is installed; before
    // that only `vm.status` exists, and says so.
    let vm: Vec<&&str> = names.iter().filter(|n| n.starts_with("vm.")).collect();
    assert!(vm.len() == 1 && *vm[0] == "vm.status" || vm.len() > 20, "vm: {vm:?}");
    let _ = std::fs::remove_dir_all(h);
}

#[test]
fn build_info_and_print_identity() {
    let h = home("identity");
    let out = helper(&h).arg("--build-info").output().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap(),
        json!({ "presenceFileFallback": false })
    );
    let a: Value =
        serde_json::from_slice(&helper(&h).arg("--print-identity").output().unwrap().stdout)
            .unwrap();
    let b: Value =
        serde_json::from_slice(&helper(&h).arg("--print-identity").output().unwrap().stdout)
            .unwrap();
    assert!(a["deviceId"].as_str().unwrap().starts_with("dev_"));
    assert_eq!(a["deviceId"], b["deviceId"], "the identity persists");
    assert!(a.get("presenceKeyId").is_some() || a.get("presenceError").is_some());
    assert!(h.join("helper").join("device.key.dpapi").exists());
    assert_eq!(helper(&h).arg("--nope").status().unwrap().code(), Some(64));
    let _ = std::fs::remove_dir_all(h);
}

#[test]
fn handshake_only_exit_codes() {
    let h = home("handshake");
    // No Gateway: exit 2.
    std::fs::write(
        h.join("run").join("node-socket"),
        format!(r"\\.\pipe\psyche-node-absent-{}", std::process::id()),
    )
    .unwrap();
    assert_eq!(
        helper(&h)
            .args(["--handshake-only", "--timeout", "3"])
            .status()
            .unwrap()
            .code(),
        Some(2)
    );

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    for (phase, code) in [
        (
            json!({ "phase": "paired", "deviceId": "dev_x", "scopes": ["node"], "stateVersion": 0, "serverTime": "2030-01-01T00:00:00.000Z" }),
            0,
        ),
        (json!({ "phase": "denied", "reason": "no" }), 3),
    ] {
        let pipe = format!(r"\\.\pipe\psyche-node-bin-{}-{code}", std::process::id());
        std::fs::write(h.join("run").join("node-socket"), &pipe).unwrap();
        std::fs::write(h.join("run").join("handshake.secret"), "s3").unwrap();
        let server = {
            let _in_runtime = rt.enter();
            ServerOptions::new()
                .first_pipe_instance(true)
                .create(&pipe)
                .unwrap()
        };
        let gateway = rt.spawn(async move {
            server.connect().await.unwrap();
            let (r, w) = tokio::io::split(server);
            let mut reader = FrameReader::new(r);
            let (writer, _t) = spawn_writer(w);
            let Some(Frame::Req(c)) = reader.next().await.unwrap() else { panic!("connect") };
            assert_eq!(c.params.as_ref().unwrap()["handshakeSecret"], "s3");
            let nonce = b64url(&random_bytes::<32>());
            writer.send(&Frame::res_ok(&c.id, json!({"phase": "challenge", "nonce": nonce, "serverOrigin": "o", "protocolVersion": 1, "expiresAt": "2030-01-01T00:00:00Z"}))).unwrap();
            let Some(Frame::Req(v)) = reader.next().await.unwrap() else { panic!("verify") };
            writer.send(&Frame::res_ok(&v.id, phase)).unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
        });
        let status = helper(&h)
            .args(["--handshake-only", "--timeout", "5"])
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(code));
        rt.block_on(gateway).unwrap();
    }
    let _ = std::fs::remove_dir_all(h);
}
