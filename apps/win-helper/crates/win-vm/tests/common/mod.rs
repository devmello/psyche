#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use psyche_win_vm::backend::fake::FakeBackend;
use psyche_win_vm::conn::{Conn, MemConn};
use psyche_win_vm::error::VmResult;
use psyche_win_vm::manager::{AsSelf, GatewayConnector, Manager, ManagerConfig};
use psyche_win_vm::model::HostResources;
use psyche_win_vm::shares::SensitiveRoots;
use psyche_win_vm::vhd::FakeDisks;
use serde_json::{Value, json};

/// A Gateway whose guest pipe ends are kept for the test to read and write.
#[derive(Default)]
pub struct FakeGateway {
    pub ends: Mutex<Vec<MemConn>>,
}

impl GatewayConnector for FakeGateway {
    fn connect(&self, _home: &Path) -> VmResult<Box<dyn Conn>> {
        let (relay_end, gateway_end) = MemConn::pair();
        self.ends.lock().unwrap().push(gateway_end);
        Ok(Box::new(relay_end))
    }
}

pub struct Env {
    pub root: PathBuf,
    pub home: PathBuf,
    pub images: PathBuf,
    pub manager: Arc<Manager>,
    pub fake: Arc<FakeBackend>,
    pub gateway: Arc<FakeGateway>,
}

pub fn sha256_hex(b: &[u8]) -> String {
    psyche_win_vm::paths::sha256_hex(b)
}

/// A small image (`vmlinuz`, `initrd`, a fake `rootfs.vhdx` "disk") with a valid manifest.
pub fn write_image(root: &Path, version: &str, created: &str) -> PathBuf {
    let dir = root.join(version);
    std::fs::create_dir_all(&dir).unwrap();
    let mut files = Vec::new();
    let rootfs = json!({"kind": "dynamic", "size": 1}).to_string();
    for (name, body) in [("vmlinuz", b"kernel".to_vec()), ("initrd", b"initrd".to_vec()), ("rootfs.vhdx", rootfs.into_bytes())] {
        std::fs::write(dir.join(name), &body).unwrap();
        files.push(psyche_win_vm::image::ImageFile { name: name.into(), bytes: body.len() as u64, sha256: sha256_hex(&body) });
    }
    let m = psyche_win_vm::image::build_manifest(version, created, Some("0.1.0"), Some("console=ttyS0 quiet"), &files);
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
    dir
}

pub fn env(tag: &str) -> Env {
    let root = std::env::temp_dir().join(format!("psyche-vm-it-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let images = root.join("images");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&images).unwrap();
    write_image(&images, "linux-1", "2026-11-01T00:00:00Z");
    let fake = Arc::new(FakeBackend::default());
    let gateway = Arc::new(FakeGateway::default());
    // The test tree lives under the real profile's AppData; a stand-in profile keeps it shareable.
    let roots = SensitiveRoots::new(
        r"C:\Users\psyche-test-nobody",
        &home.to_string_lossy(),
        r"C:\Windows",
        &[r"C:\Program Files".into(), r"C:\Program Files (x86)".into()],
        r"C:\ProgramData",
    );
    let manager = Manager::new(
        ManagerConfig {
            home: home.clone(),
            images_root: images.clone(),
            owner_sid: psyche_win_vm::security::current_user_sid().unwrap(),
            roots,
            version: "0.0.0-test".into(),
        },
        fake.clone(),
        Arc::new(FakeDisks),
        gateway.clone(),
        Arc::new(AsSelf),
        Box::new(|| HostResources { cpu_count: 16, memory_gb: 32, free_disk_gb: 500 }),
    );
    Env { root, home, images, manager, fake, gateway }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// An `emit` that records events.
pub fn recorder() -> (Arc<Mutex<Vec<Value>>>, impl Fn(Value) + Sync) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let l = log.clone();
    (log, move |v: Value| l.lock().unwrap().push(v))
}

pub fn read_some(c: &dyn Conn, n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 256];
    while out.len() < n {
        match c.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(k) => out.extend_from_slice(&buf[..k]),
        }
    }
    out
}

pub fn wait_until(mut f: impl FnMut() -> bool) -> bool {
    for _ in 0..200 {
        if f() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}
