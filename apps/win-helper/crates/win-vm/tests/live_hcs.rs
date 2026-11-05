//! Live: boots the real guest image on HCS. Needs an elevated prompt (HCS serves
//! administrators and LocalSystem) and an image built by `deploy/windows/guest-image`
//! (`PSYCHE_VM_TEST_IMAGE` = its folder, default `deploy/windows/guest-image/out`).
//!
//! ```text
//! cargo test -p psyche-win-vm --test live_hcs -- --ignored --nocapture
//! ```

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use psyche_win_vm::hcs::HcsBackend;
use psyche_win_vm::manager::{AsSelf, CreateParams, Manager, ManagerConfig};
use psyche_win_vm::shares::SensitiveRoots;
use psyche_win_vm::vhd::VirtDisk;
use serde_json::json;

fn image_dir() -> PathBuf {
    std::env::var_os("PSYCHE_VM_TEST_IMAGE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(r"..\..\..\..\deploy\windows\guest-image\out"))
}

/// No elevation needed: the built image verifies, and virtdisk accepts its `rootfs.vhdx` as the
/// parent of a per-guest differencing layer.
#[test]
#[ignore]
fn live_image_verifies_and_takes_a_differencing_child() {
    use psyche_win_vm::vhd::DiskOps;
    let dir = std::fs::canonicalize(image_dir()).expect("no guest image; set PSYCHE_VM_TEST_IMAGE");
    let dir = PathBuf::from(dir.to_string_lossy().trim_start_matches(r"\\?\"));
    let t = Instant::now();
    let img = psyche_win_vm::image::verify(&dir, None, &Default::default(), |_| {}).unwrap();
    eprintln!("verified {} ({} bytes) in {:?}", img.manifest.id, img.bytes(), t.elapsed());
    let tmp = std::env::temp_dir().join(format!("psyche-vm-live-vhd-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let child = tmp.join("system.vhdx");
    VirtDisk.create_differencing(&child, &img.rootfs()).unwrap();
    let parent = VirtDisk.parent_of(&child).unwrap().unwrap();
    assert!(parent.to_string_lossy().eq_ignore_ascii_case(&img.rootfs().to_string_lossy()), "{parent:?}");
    VirtDisk.create_dynamic(&tmp.join("sessiondata.vhdx"), 8 << 30).unwrap();
    let _ = std::fs::remove_dir_all(tmp);
}

#[test]
#[ignore]
fn live_boot_relay_share_and_stop() {
    if !psyche_win_vm::security::is_elevated() {
        eprintln!("skipped: run elevated (HCS needs administrator or LocalSystem)");
        return;
    }
    let dir = std::fs::canonicalize(image_dir()).expect("no guest image; build deploy/windows/guest-image or set PSYCHE_VM_TEST_IMAGE");
    let dir = PathBuf::from(dir.to_string_lossy().trim_start_matches(r"\\?\"));
    let images_root = dir.parent().unwrap().to_path_buf();
    let version = dir.file_name().unwrap().to_string_lossy().into_owned();
    let root = std::env::temp_dir().join(format!("psyche-vm-live-{}", std::process::id()));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let sid = psyche_win_vm::security::current_user_sid().unwrap();
    let gateway = Arc::new(common::FakeGateway::default());
    let manager = Manager::new(
        ManagerConfig {
            home: home.clone(),
            images_root,
            owner_sid: sid.clone(),
            roots: SensitiveRoots::new(r"C:\Users\psyche-test-nobody", &home.to_string_lossy(), r"C:\Windows", &[], r"C:\ProgramData"),
            version: "live".into(),
        },
        Arc::new(HcsBackend::new(&sid)),
        Arc::new(VirtDisk),
        gateway.clone(),
        Arc::new(AsSelf),
        Box::new(move || psyche_win_vm::win::host_resources(&std::env::temp_dir())),
    );
    let info = manager.service_info();
    eprintln!("service_info: {info}");
    assert_eq!(info["hcs"]["available"], true, "{info}");

    let t = Instant::now();
    let g = manager
        .create(CreateParams { image: Some(version), cpus: Some(2), memory_gb: Some(2), disk_gb: Some(8), ..Default::default() }, &|_| {})
        .unwrap();
    eprintln!("created in {:?}: {}", t.elapsed(), g["phase"]);
    let t = Instant::now();
    let g = manager.start("sandbox", &|e| eprintln!("progress {e}")).unwrap();
    eprintln!("started in {:?}: {}", t.elapsed(), g["phase"]);
    assert_eq!(g["phase"], "running");

    // psyche-node dials the host on vsock 7980; the relay hands it to the "Gateway".
    let deadline = Instant::now() + Duration::from_secs(90);
    while gateway.ends.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    let console = std::fs::read_to_string(home.join(r"vm\sandbox\console.log")).unwrap_or_default();
    eprintln!("--- console (tail) ---\n{}", console.chars().rev().take(3000).collect::<String>().chars().rev().collect::<String>());
    let gw = gateway.ends.lock().unwrap().pop().expect("the guest's psyche-node never connected");
    let first = common::read_some(&gw, 1);
    eprintln!("first bytes from the guest node: {:?}", String::from_utf8_lossy(&first));
    assert!(!first.is_empty());

    let st = manager.agent_status("sandbox").unwrap();
    eprintln!("agent: {}", st["agent"]);
    assert_eq!(st["agent"]["connected"], true);

    let share = root.join("share");
    std::fs::create_dir_all(&share).unwrap();
    std::fs::write(share.join("hello.txt"), "hi").unwrap();
    let g = manager.share_add("sandbox", "live", &share.to_string_lossy(), true, None).unwrap();
    eprintln!("shares: {}", g["shares"]);

    let t = Instant::now();
    let g = manager.stop("sandbox", true).unwrap();
    eprintln!("stopped in {:?}: graceful={}", t.elapsed(), g["graceful"]);
    assert_eq!(g["phase"], "stopped");
    assert_eq!(manager.delete("sandbox").unwrap(), json!({"deleted": true, "name": "sandbox"}));
    let _ = std::fs::remove_dir_all(root);
}
