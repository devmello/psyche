#![allow(clippy::result_large_err)]

//! Manager lifecycle against the fake backend: every `vm.*` method with the mac helper's result
//! shapes and error reasons.

mod common;

use common::*;
use psyche_win_vm::conn::Conn;
use psyche_win_vm::manager::{ConfigureParams, CreateParams, ExportImageParams, SnapshotParams};
use psyche_win_vm::paths::Bundle;
use serde_json::{Value, json};

fn create(e: &Env) -> Value {
    let (_log, emit) = recorder();
    e.manager.create(CreateParams::default(), &emit).unwrap()
}

#[test]
fn full_lifecycle_matches_the_mac_shapes() {
    let e = env("full");
    let (_watch_id, mut events) = e.manager.events.subscribe();
    assert_eq!(e.manager.status(), json!({"guests": [], "active": 0, "supportsGuestProvisioning": true, "maxActive": 1}));

    // create: from the newest image, verified, disks made.
    let (log, emit) = recorder();
    let g = e.manager.create(CreateParams { cpus: Some(2), memory_gb: Some(4), ..Default::default() }, &emit).unwrap();
    assert_eq!(g["name"], "sandbox");
    assert_eq!(g["phase"], "installed");
    assert_eq!(g["guestOS"], "linux");
    assert_eq!(g["provisioned"], false);
    assert_eq!(g["psycheInstalled"], true, "the image ships psyche-node");
    assert_eq!(g["image"]["id"], "linux-1");
    assert_eq!(g["vsock"], json!({"gatewayNodePort": 7980, "hostCid": 2, "serviceId": "00001f2c-facb-11e6-bd58-64006a7986d3"}));
    assert_eq!(g["network"], "none");
    for k in [
        "cpus",
        "memoryGB",
        "diskGB",
        "username",
        "shares",
        "display",
        "clipboard",
        "vault",
        "agent",
        "permissionsGranted",
        "savedState",
        "transfers",
        "snapshots",
    ] {
        assert!(g.get(k).is_some(), "describe has {k}");
    }
    let phases: Vec<String> = log.lock().unwrap().iter().filter_map(|v| v["phase"].as_str().map(str::to_owned)).collect();
    assert_eq!(phases.first().map(String::as_str), Some("started"));
    assert_eq!(phases.last().map(String::as_str), Some("finished"));
    let b = Bundle::new(&e.home, "sandbox");
    assert!(b.system_disk().is_file() && b.session_disk().is_file());
    let config: Value = serde_json::from_slice(&std::fs::read(b.config()).unwrap()).unwrap();
    assert_eq!(config["image"], "linux-1");
    assert_eq!(config["imageSha256"].as_str().unwrap().len(), 64);

    // start: first boot provisions.
    let (log, emit) = recorder();
    let g = e.manager.start("sandbox", &emit).unwrap();
    assert_eq!(g["phase"], "running");
    assert_eq!(g["provisioned"], true);
    assert_eq!(log.lock().unwrap()[0], json!({"type": "vm.state", "phase": "provisioning"}));
    let boot = e.fake.boots.lock().unwrap()[0].clone();
    assert_eq!(
        boot.cmdline,
        "console=ttyS0 quiet psyche.port=7980 psyche.share=psyche-in:vsock:564:ro psyche.share=psyche-out:vsock:564:rw"
    );
    assert_eq!(boot.disks, vec![b.system_disk(), b.session_disk()]);
    assert!(boot.readonly_files.iter().any(|f| f.ends_with("rootfs.vhdx")), "parent layers are granted read-only");
    let names: Vec<&str> = boot.shares.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["psyche-in", "psyche-out"]);
    assert!(boot.shares.iter().find(|s| s.name == "psyche-out").map(|s| !s.read_only).unwrap());
    assert!(boot.nat_mac.is_none() && boot.restore_from.is_none());
    // Starting a running guest answers its state.
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap()["phase"], "running");

    // The guest's psyche-node reaches the Gateway's guest pipe through the relay.
    let guest = e.fake.guest_connect("sandbox").unwrap();
    guest.write_all(b"{\"type\":\"req\"}\n").unwrap();
    assert!(wait_until(|| !e.gateway.ends.lock().unwrap().is_empty()));
    let gw = e.gateway.ends.lock().unwrap().remove(0);
    assert_eq!(read_some(&gw, 15), b"{\"type\":\"req\"}\n");
    gw.write_all(b"ok").unwrap();
    assert_eq!(read_some(&guest, 2), b"ok");
    assert_eq!(e.manager.relay_count("sandbox"), 1);

    // agent_status
    let g = e.manager.agent_status("sandbox").unwrap();
    assert_eq!(g["agent"]["connected"], true);
    assert_eq!(g["agent"]["version"], "0.1.0-test");
    assert_eq!(g["agent"]["node"]["running"], true);

    // shares: read-only by default, read-write needs an approval, applied live.
    let proj = e.root.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let p = proj.to_string_lossy().into_owned();
    let err = e.manager.share_add("sandbox", "proj", &p, false, None).unwrap_err();
    assert_eq!(err.reason, "share_rw_needs_approval");
    let g = e.manager.share_add("sandbox", "proj", &p, false, Some("ap_1")).unwrap();
    assert_eq!(g["shares"][0]["guestPath"], "/mnt/psyche/proj");
    assert_eq!(g["shares"][0]["readOnly"], false);
    assert!(e.fake.live_shares("sandbox").contains(&"proj".to_owned()));
    assert!(e.fake.guest_mounts("sandbox").contains(&"proj".to_owned()), "mounted live through the control channel");
    let calls = e.fake.agent_calls.lock().unwrap().clone();
    let mount = calls.iter().find(|(op, r)| op == "mount" && r["name"] == "proj").unwrap();
    assert_eq!(mount.1["readOnly"], false);
    assert_eq!(mount.1["port"], 564);
    assert_eq!(mount.1["fsRoot"], true);
    assert_eq!(e.manager.share_add("sandbox", "proj", &p, true, None).unwrap_err().reason, "share_exists");
    assert_eq!(e.manager.share_add("sandbox", "home", &e.home.to_string_lossy(), true, None).unwrap_err().reason, "share_forbidden");
    let g = e.manager.share_remove("sandbox", "proj").unwrap();
    assert_eq!(g["shares"], json!([]));
    assert!(!e.fake.live_shares("sandbox").contains(&"proj".to_owned()));
    assert!(!e.fake.guest_mounts("sandbox").contains(&"proj".to_owned()), "unmounted in the guest first");
    assert_eq!(e.manager.share_remove("sandbox", "proj").unwrap_err().reason, "share_not_found");

    // copy_in / copy_out
    std::fs::write(proj.join("notes.txt"), "hello").unwrap();
    let r = e.manager.copy_in("sandbox", &proj.join("notes.txt").to_string_lossy()).unwrap();
    let t = &r["transfer"];
    assert_eq!(t["direction"], "in");
    assert_eq!(t["bytes"], 5);
    let id = t["id"].as_str().unwrap();
    assert_eq!(t["guestPath"], format!("/mnt/psyche/psyche-in/{id}/notes.txt"));
    assert!(b.transfer_in().join(id).join("notes.txt").is_file());
    assert_eq!(e.manager.copy_in("sandbox", &e.home.to_string_lossy()).unwrap_err().reason, "share_forbidden");
    let out = e.root.join("granted");
    std::fs::create_dir_all(&out).unwrap();
    assert_eq!(e.manager.copy_out("sandbox", "/home/psyche/report.pdf", &out.to_string_lossy()).unwrap_err().reason, "no_granted_folders");
    std::fs::write(e.home.join("config.json"), json!({"permissions": {"folders": [{"path": out.to_string_lossy()}]}}).to_string()).unwrap();
    std::fs::write(out.join("report.pdf"), "old").unwrap();
    let r = e.manager.copy_out("sandbox", "/home/psyche/report.pdf", &out.to_string_lossy()).unwrap();
    assert_eq!(r["transfer"]["direction"], "out");
    assert!(r["transfer"]["hostPath"].as_str().unwrap().ends_with("report 2.pdf"), "never overwrites");
    assert_eq!(std::fs::read(out.join("report 2.pdf")).unwrap(), b"exported");
    assert_eq!(std::fs::read(out.join("report.pdf")).unwrap(), b"old");
    assert_eq!(e.manager.copy_out("sandbox", "/missing", &out.to_string_lossy()).unwrap_err().reason, "guest_not_found");
    assert_eq!(e.manager.copy_out("sandbox", "rel", &out.to_string_lossy()).unwrap_err().details["field"], "guestPath");
    assert_eq!(e.manager.copy_out("sandbox", "/x", &e.root.to_string_lossy()).unwrap_err().reason, "outside_granted_folders");
    assert_eq!(e.manager.status()["guests"][0]["transfers"].as_array().unwrap().len(), 2);

    // pause / resume
    assert_eq!(e.manager.pause("sandbox").unwrap()["phase"], "paused");
    assert_eq!(e.manager.resume("sandbox").unwrap()["phase"], "running");

    // configure: hardware only while stopped; clipboard any time.
    assert_eq!(e.manager.configure(ConfigureParams { cpus: Some(4), ..Default::default() }).unwrap_err().reason, "vm_running");
    assert_eq!(e.manager.configure(ConfigureParams { clipboard: Some("off".into()), ..Default::default() }).unwrap()["clipboard"], "off");

    // suspend → saved; start → warm.
    let g = e.manager.suspend("sandbox").unwrap();
    assert_eq!((g["phase"].as_str(), g["savedState"].as_bool()), (Some("saved"), Some(true)));
    assert_eq!(e.manager.relay_count("sandbox"), 0, "relays close with the guest");
    let g = e.manager.start("sandbox", &|_| {}).unwrap();
    assert_eq!(g["phase"], "running");
    let warm = e.fake.boots.lock().unwrap()[1].clone();
    assert_eq!(warm.restore_from, Some(b.saved_state()));
    assert!(!b.saved_state().exists(), "a restored state file is discarded");

    // stop
    let g = e.manager.stop("sandbox", false).unwrap();
    assert_eq!((g["phase"].as_str(), g["graceful"].as_bool()), (Some("stopped"), Some(true)));
    assert_eq!(e.manager.agent_status("sandbox").unwrap_err().reason, "vm_not_running");

    // snapshots
    let (log, emit) = recorder();
    let s = e.manager.snapshot(SnapshotParams { kind: Some("base".into()), ..Default::default() }, &emit).unwrap();
    assert_eq!(s["snapshot"]["kind"], "base");
    assert_eq!(s["snapshot"]["method"], "vhdx-differencing");
    assert_eq!(s["guest"]["baseSnapshot"], s["snapshot"]["id"]);
    assert_eq!(log.lock().unwrap().len(), 2);
    let base = s["snapshot"]["id"].as_str().unwrap().to_owned();
    let m = e.manager.snapshot(SnapshotParams { label: Some("before".into()), ..Default::default() }, &|_| {}).unwrap();
    let manual = m["snapshot"]["id"].as_str().unwrap().to_owned();
    assert_eq!(m["guest"]["snapshots"].as_array().unwrap().len(), 2);
    let r = e.manager.reset("sandbox", &|_| {}).unwrap();
    assert_eq!(r["snapshot"], base.as_str());
    assert!(r["durationMs"].is_u64());
    assert_eq!(r["guest"]["phase"], "stopped");
    let r = e.manager.restore("sandbox", &manual, &|_| {}).unwrap();
    assert_eq!(r["snapshot"], manual.as_str());
    let g = e.manager.snapshot_delete("sandbox", &manual).unwrap();
    assert_eq!(g["snapshots"].as_array().unwrap().len(), 1);
    assert_eq!(e.manager.snapshot_delete("sandbox", &manual).unwrap_err().reason, "snapshot_not_found");

    // export_image: a verifiable image without the session disk.
    let exp = e.root.join("exports");
    std::fs::create_dir_all(&exp).unwrap();
    let x = e
        .manager
        .export_image(
            ExportImageParams { name: None, out_dir: exp.to_string_lossy().into_owned(), id: Some("linux-export".into()) },
            &|_| {},
        )
        .unwrap();
    let dir = exp.join("linux-export");
    assert_eq!(x["path"], dir.to_string_lossy().as_ref());
    assert!(!dir.join("sessiondata.vhdx").exists());
    let img = psyche_win_vm::image::verify(&dir, x["manifestSha256"].as_str(), &Default::default(), |_| {}).unwrap();
    assert_eq!(img.manifest.id, "linux-export");
    assert_eq!(
        e.manager
            .export_image(
                ExportImageParams { name: None, out_dir: exp.to_string_lossy().into_owned(), id: Some("linux-export".into()) },
                &|_| {}
            )
            .unwrap_err()
            .reason,
        "image_exists"
    );

    // delete
    assert_eq!(e.manager.delete("sandbox").unwrap(), json!({"deleted": true, "name": "sandbox"}));
    assert_eq!(e.manager.status()["guests"], json!([]));
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap_err().reason, "vm_not_found");

    // Every state change was published for watch.
    let mut types = Vec::new();
    while let Ok(ev) = events.try_recv() {
        types.push(ev["type"].as_str().unwrap_or("").to_owned());
        if ev["type"] == "vm.updated" {
            assert!(ev["guest"]["name"] == "sandbox" && ev["at"].is_string());
        }
    }
    assert!(types.iter().filter(|t| *t == "vm.updated").count() > 10);
    assert_eq!(types.last().map(String::as_str), Some("vm.deleted"));
}

#[test]
fn create_rules() {
    let e = env("create");
    let ipsw = e.manager.create(CreateParams { ipsw: Some(r"C:\x.ipsw".into()), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!((ipsw.reason.as_str(), ipsw.details["feature"].as_str()), ("unsupported", Some("ipsw")));
    let bad = e.manager.create(CreateParams { name: Some("Bad_Name".into()), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!(bad.details["field"], "name");
    let pinned = e.manager.create(CreateParams { image_sha256: Some("0".repeat(64)), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!(pinned.reason, "image_checksum_mismatch");
    assert!(!Bundle::new(&e.home, "sandbox").root.exists(), "a failed create leaves nothing");
    let missing =
        e.manager.create(CreateParams { image: Some("linux-9".into()), download: Some(true), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!(missing.reason, "image_not_found");
    assert!(missing.details.contains_key("download"));
    let g = e.manager.create(CreateParams { network: Some("nat".into()), ..Default::default() }, &|_| {}).unwrap();
    assert_eq!(g["network"], "nat");
    let twice = e.manager.create(CreateParams { name: Some("other".into()), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!(twice.reason, "guest_exists");
    // NAT: the adapter is attached and the guest learns its address.
    e.manager.start("sandbox", &|_| {}).unwrap();
    assert!(e.fake.boots.lock().unwrap()[0].nat_mac.as_deref().unwrap().starts_with("00:15:5d:"));
    assert_eq!(e.manager.status()["guests"][0]["ipAddress"], "172.31.240.2");
}

#[test]
fn unsupported_mac_features_say_why() {
    let e = env("unsupported");
    create(&e);
    for err in [e.manager.display("sandbox", true).unwrap_err(), e.manager.grant_permissions("sandbox").unwrap_err()] {
        assert_eq!((err.code.as_str(), err.reason.as_str()), ("unavailable", "unsupported"));
        assert!(!err.message.is_empty());
    }
    assert_eq!(e.manager.display("nope", true).unwrap_err().reason, "vm_not_found");
}

#[test]
fn image_tampering_is_refused_at_boot() {
    let e = env("tamper");
    create(&e);
    std::fs::write(e.images.join("linux-1").join("vmlinuz"), b"KERNEL").unwrap();
    let err = e.manager.start("sandbox", &|_| {}).unwrap_err();
    assert_eq!(err.reason, "image_checksum_mismatch");
    // A swapped manifest (re-signed by someone else) is refused too: the guest pins its hash.
    let e = env("swap");
    create(&e);
    write_image(&e.images, "linux-1", "2027-01-01T00:00:00Z");
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap_err().reason, "image_checksum_mismatch");
    assert!(e.fake.boots.lock().unwrap().is_empty());
}

#[test]
fn owner_edited_shares_are_rechecked_before_boot() {
    let e = env("shares-json");
    create(&e);
    let b = Bundle::new(&e.home, "sandbox");
    std::fs::write(
        b.shares(),
        json!([{"name": "sys", "hostPath": r"C:\Windows\System32", "readOnly": false, "approvalId": "x"}]).to_string(),
    )
    .unwrap();
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap_err().reason, "share_forbidden");
    assert!(e.fake.boots.lock().unwrap().is_empty());
}

#[test]
fn stop_force_and_guest_exit() {
    let e = env("stop");
    create(&e);
    e.manager.start("sandbox", &|_| {}).unwrap();
    *e.fake.ignore_shutdown.lock().unwrap() = true;
    *e.fake.agent_unreachable.lock().unwrap() = true;
    let err = e.manager.stop("sandbox", false).unwrap_err();
    assert_eq!(err.reason, "guest_did_not_stop");
    assert!(err.retryable);
    assert_eq!(e.manager.status()["guests"][0]["phase"], "running", "a refused stop keeps the guest running");
    let g = e.manager.stop("sandbox", true).unwrap();
    assert_eq!((g["phase"].as_str(), g["graceful"].as_bool()), (Some("stopped"), Some(false)));
    // The guest powers off on its own, then crashes on the next run.
    *e.fake.ignore_shutdown.lock().unwrap() = false;
    e.manager.start("sandbox", &|_| {}).unwrap();
    e.fake.guest_exits("sandbox", None);
    assert!(wait_until(|| e.manager.status()["guests"][0]["phase"] == "stopped"));
    e.manager.start("sandbox", &|_| {}).unwrap();
    e.fake.guest_exits("sandbox", Some("guest_crashed"));
    assert!(wait_until(|| e.manager.status()["guests"][0]["phase"] == "failed"));
    assert_eq!(e.manager.status()["guests"][0]["lastError"], "guest_crashed");
    // A failed guest starts again.
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap()["phase"], "running");
    assert_eq!(e.manager.delete("sandbox").unwrap_err().reason, "vm_running");
    assert_eq!(e.manager.snapshot(SnapshotParams::default(), &|_| {}).unwrap_err().reason, "vm_running");
}

#[test]
fn warm_start_falls_back_to_cold_and_boot_failures_are_recorded() {
    let e = env("warm");
    create(&e);
    e.manager.start("sandbox", &|_| {}).unwrap();
    e.manager.suspend("sandbox").unwrap();
    *e.fake.fail_restore.lock().unwrap() = true;
    let (log, emit) = recorder();
    assert_eq!(e.manager.start("sandbox", &emit).unwrap()["phase"], "running");
    let boots = e.fake.boots.lock().unwrap().clone();
    assert!(boots.last().unwrap().restore_from.is_none(), "booted cold");
    assert!(log.lock().unwrap().iter().any(|v| v["phase"] == "starting"));
    e.manager.stop("sandbox", true).unwrap();
    *e.fake.fail_start.lock().unwrap() = Some(psyche_win_vm::error::VmError::unavailable("hcs_access_denied", "denied"));
    assert_eq!(e.manager.start("sandbox", &|_| {}).unwrap_err().reason, "hcs_access_denied");
    let g = &e.manager.status()["guests"][0];
    assert_eq!((g["phase"].as_str(), g["lastError"].as_str()), (Some("failed"), Some("hcs_access_denied")));
}

#[test]
fn unavailable_hcs_answers_every_lifecycle_call() {
    let e = env("nohcs");
    *e.fake.unavailable.lock().unwrap() =
        Some(psyche_win_vm::error::VmError::unavailable("hcs_unavailable", "Turn on Virtual Machine Platform"));
    assert_eq!(e.manager.create(CreateParams::default(), &|_| {}).unwrap_err().reason, "hcs_unavailable");
    let info = e.manager.service_info();
    assert_eq!(info["hcs"]["available"], false);
    assert_eq!(info["hcs"]["reason"], "hcs_unavailable");
    assert_eq!(info["images"][0]["version"], "linux-1");
    assert_eq!(info["version"], "0.0.0-test");
    assert_eq!(info["protocol"], psyche_win_vm::protocol::PROTOCOL_VERSION);
    // status still answers (the UI shows the reason from service_info).
    assert_eq!(e.manager.status()["guests"], json!([]));
    let ri = e.manager.restore_image().unwrap();
    assert_eq!((ri["version"].as_str(), ri["build"].as_str()), (Some("linux-1"), Some("linux-1")));
}

#[test]
fn install_psyche_shares_the_payload_and_runs_the_bootstrap() {
    let e = env("install");
    create(&e);
    e.manager.start("sandbox", &|_| {}).unwrap();
    let payload = e.root.join("checkout");
    assert_eq!(e.manager.install_psyche("sandbox", &payload.to_string_lossy(), &|_| {}).unwrap_err().details["field"], "payload");
    std::fs::create_dir_all(payload.join("apps").join("node").join("scripts")).unwrap();
    std::fs::write(payload.join("apps").join("node").join("scripts").join("guest-bootstrap.sh"), "#!/bin/sh\n").unwrap();
    let (log, emit) = recorder();
    let g = e.manager.install_psyche("sandbox", &payload.to_string_lossy(), &emit).unwrap();
    assert_eq!(g["psycheInstalled"], true);
    assert!(e.fake.live_shares("sandbox").contains(&"psyche-payload".to_owned()));
    let calls = e.fake.agent_calls.lock().unwrap().clone();
    assert!(calls.iter().any(|(op, r)| op == "mount" && r["name"] == "psyche-payload" && r["readOnly"] == true && r["fsRoot"] == false));
    let install = calls.iter().find(|(m, _)| m == "install_psyche").unwrap();
    assert_eq!(install.1["payload"], "/mnt/psyche/psyche-payload");
    let phases: Vec<Value> = log.lock().unwrap().iter().map(|v| v["phase"].clone()).collect();
    assert_eq!(phases, vec![json!("started"), json!("progress"), json!("finished")]);
}

#[test]
fn busy_guests_refuse_concurrent_work() {
    let e = std::sync::Arc::new(env("busy"));
    create(&e);
    // Two threads race snapshots of one guest: each call either succeeds or answers vm_busy.
    let e2 = e.clone();
    let t = std::thread::spawn(move || {
        (0..20)
            .map(|_| e2.manager.snapshot(SnapshotParams { kind: Some("task".into()), ..Default::default() }, &|_| {}))
            .collect::<Vec<_>>()
    });
    let mine: Vec<_> =
        (0..20).map(|_| e.manager.snapshot(SnapshotParams { kind: Some("task".into()), ..Default::default() }, &|_| {})).collect();
    let theirs = t.join().unwrap();
    for r in mine.iter().chain(theirs.iter()) {
        if let Err(err) = r {
            assert_eq!(err.reason, "vm_busy");
            assert!(err.retryable);
        }
    }
    let snaps = e.manager.status()["guests"][0]["snapshots"].as_array().unwrap().len();
    assert_eq!(snaps, 3, "task snapshots are pruned to the newest 3");
}

#[test]
fn shares_granted_while_stopped_are_mounted_after_boot() {
    let e = env("boot-shares");
    create(&e);
    let proj = e.root.join("proj two");
    std::fs::create_dir_all(&proj).unwrap();
    e.manager.share_add("sandbox", "proj two", &proj.to_string_lossy(), true, None).unwrap();
    e.manager.start("sandbox", &|_| {}).unwrap();
    let boot = e.fake.boots.lock().unwrap()[0].clone();
    assert!(boot.shares.iter().any(|s| s.name == "proj two" && s.read_only), "the Plan9 share exists from boot");
    assert!(!boot.cmdline.contains("proj"), "a name with a space cannot ride the command line");
    assert!(wait_until(|| e.fake.guest_mounts("sandbox").contains(&"proj two".to_owned())));
    assert!(wait_until(|| e.fake.agent_calls.lock().unwrap().iter().any(|(op, _)| op == "restart_node")));
}

#[test]
fn older_guest_images_answer_unsupported_for_new_ops() {
    let e = env("legacy");
    create(&e);
    *e.fake.legacy_guest.lock().unwrap() = true;
    e.manager.start("sandbox", &|_| {}).unwrap();
    let out = e.root.join("granted");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(e.home.join("config.json"), json!({"permissions": {"folders": [{"path": out.to_string_lossy()}]}}).to_string()).unwrap();
    let err = e.manager.copy_out("sandbox", "/home/psyche/a.txt", &out.to_string_lossy()).unwrap_err();
    assert_eq!((err.reason.as_str(), err.details["feature"].as_str()), ("unsupported", Some("export")));
}

#[test]
fn image_minimums_apply_at_create() {
    let e = env("mins");
    let mut m: Value = serde_json::from_slice(&std::fs::read(e.images.join("linux-1").join("manifest.json")).unwrap()).unwrap();
    m["resources"] = json!({"minMemoryMiB": 8192, "minCpus": 1});
    std::fs::write(e.images.join("linux-1").join("manifest.json"), m.to_string()).unwrap();
    let err = e.manager.create(CreateParams { memory_gb: Some(4), ..Default::default() }, &|_| {}).unwrap_err();
    assert_eq!(err.details["field"], "memoryGB");
    e.manager.create(CreateParams { memory_gb: Some(8), ..Default::default() }, &|_| {}).unwrap();
}
