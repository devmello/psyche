//! In-memory backend for lifecycle tests: guests "run" as map entries, the guest agent is a
//! thread answering like the Linux guest's agent, and tests can open guest → Gateway
//! connections or make a guest exit on its own.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};

use super::{BackendEvent, BootSpec, EventSink, RunInfo, VmBackend};
use crate::conn::{Conn, MemConn};
use crate::error::{VmError, VmResult};
use crate::hcs::doc::Plan9Share;

struct Guest {
    spec: BootSpec,
    paused: bool,
    shares: std::sync::Arc<Mutex<Vec<Plan9Share>>>,
    events: EventSink,
    /// Shares the fake guest has mounted (`/mnt/psyche/<name>`): the boot-time ones from the
    /// kernel command line, then what the control channel mounts.
    mounted: std::sync::Arc<Mutex<Vec<String>>>,
}

#[derive(Default)]
pub struct FakeBackend {
    guests: Mutex<HashMap<String, Guest>>,
    /// Boots started (specs as given), for assertions.
    pub boots: Mutex<Vec<BootSpec>>,
    pub fail_start: Mutex<Option<VmError>>,
    /// Warm start fails with `restore_failed` (the manager then boots cold).
    pub fail_restore: Mutex<bool>,
    /// The integration-service shutdown is ignored (only a forced stop works).
    pub ignore_shutdown: Mutex<bool>,
    pub agent_unreachable: Mutex<bool>,
    /// The guest image predates `export` / `install_psyche` (answers `unknown op`).
    pub legacy_guest: Mutex<bool>,
    pub unavailable: Mutex<Option<VmError>>,
    /// Agent methods called, in order.
    pub agent_calls: std::sync::Arc<Mutex<Vec<(String, Value)>>>,
}

fn share_path(shares: &[Plan9Share], name: &str) -> Option<PathBuf> {
    shares.iter().find(|s| s.name == name).map(|s| PathBuf::from(&s.path))
}

impl FakeBackend {
    /// Opens a guest → Gateway connection (as the guest's psyche-node would); returns the
    /// guest's end.
    pub fn guest_connect(&self, name: &str) -> Option<MemConn> {
        let events = self.guests.lock().unwrap().get(name)?.events.clone();
        let (inside, host_end) = MemConn::pair();
        events(name, BackendEvent::GuestConnection(Box::new(host_end)));
        Some(inside)
    }

    /// The guest powers off (or crashes with `error`) on its own.
    pub fn guest_exits(&self, name: &str, error: Option<&str>) {
        let g = self.guests.lock().unwrap().remove(name);
        if let Some(g) = g {
            (g.events)(name, BackendEvent::Exited(error.map(str::to_owned)));
        }
    }

    pub fn guest_mounts(&self, name: &str) -> Vec<String> {
        self.guests.lock().unwrap().get(name).map(|g| g.mounted.lock().unwrap().clone()).unwrap_or_default()
    }

    pub fn live_shares(&self, name: &str) -> Vec<String> {
        self.guests.lock().unwrap().get(name).map(|g| g.shares.lock().unwrap().iter().map(|s| s.name.clone()).collect()).unwrap_or_default()
    }
}

impl VmBackend for FakeBackend {
    fn unavailable_reason(&self) -> Option<VmError> {
        self.unavailable.lock().unwrap().clone()
    }

    fn info(&self) -> Value {
        json!({"available": self.unavailable_reason().is_none(), "backend": "fake"})
    }

    fn start(&self, spec: &BootSpec, events: EventSink) -> VmResult<RunInfo> {
        if let Some(e) = self.fail_start.lock().unwrap().take() {
            return Err(e);
        }
        if spec.restore_from.is_some() && *self.fail_restore.lock().unwrap() {
            return Err(VmError::unavailable("restore_failed", "The saved state could not be restored"));
        }
        for f in spec.disks.iter().chain(&spec.readonly_files) {
            if !f.is_file() {
                return Err(VmError::not_found("disk_missing", format!("{} is missing", f.display())));
            }
        }
        let info = RunInfo {
            runtime_id: Some("00000000-0000-0000-0000-000000000001".into()),
            ip_address: spec.nat_mac.as_ref().map(|_| "172.31.240.2".into()),
            network: spec.nat_mac.as_ref().map(|_| json!({"mode": "nat", "address": "172.31.240.2", "prefixLength": 24, "gateway": "172.31.240.1", "dns": ["172.31.240.1"]})),
        };
        self.boots.lock().unwrap().push(spec.clone());
        let boot_mounts: Vec<String> = spec
            .cmdline
            .split(' ')
            .filter_map(|t| t.strip_prefix("psyche.share="))
            .filter_map(|t| t.split(':').next().map(str::to_owned))
            .collect();
        let mounted = std::sync::Arc::new(Mutex::new(boot_mounts));
        let guest =
            Guest { spec: spec.clone(), paused: false, shares: std::sync::Arc::new(Mutex::new(spec.shares.clone())), events, mounted };
        self.guests.lock().unwrap().insert(spec.name.clone(), guest);
        Ok(info)
    }

    fn stop(&self, name: &str, force: bool, _timeout: u64) -> VmResult<bool> {
        let graceful = !*self.ignore_shutdown.lock().unwrap();
        if !graceful && !force {
            return Err(VmError::unavailable("guest_did_not_stop", "The guest did not shut down. Retry with force: true.").retryable());
        }
        let g = self.guests.lock().unwrap().remove(name);
        if let Some(g) = g {
            (g.events)(name, BackendEvent::Exited(None));
        }
        Ok(graceful)
    }

    fn pause(&self, name: &str) -> VmResult<()> {
        let mut g = self.guests.lock().unwrap();
        g.get_mut(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?.paused = true;
        Ok(())
    }

    fn resume(&self, name: &str) -> VmResult<()> {
        let mut g = self.guests.lock().unwrap();
        g.get_mut(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?.paused = false;
        Ok(())
    }

    fn save_state(&self, name: &str, path: &Path) -> VmResult<()> {
        std::fs::write(path, b"saved").map_err(|e| VmError::io("saved state", &e))?;
        let g = self.guests.lock().unwrap().remove(name);
        if let Some(g) = g {
            (g.events)(name, BackendEvent::Exited(None));
        }
        Ok(())
    }

    fn add_share(&self, name: &str, share: &Plan9Share) -> VmResult<()> {
        let mut g = self.guests.lock().unwrap();
        let guest = g.get_mut(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?;
        let mut s = guest.shares.lock().unwrap();
        s.retain(|x| x.name != share.name);
        s.push(share.clone());
        Ok(())
    }

    fn remove_share(&self, name: &str, share: &str) -> VmResult<()> {
        let mut g = self.guests.lock().unwrap();
        let guest = g.get_mut(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?;
        guest.shares.lock().unwrap().retain(|s| s.name != share);
        Ok(())
    }

    fn connect_agent(&self, name: &str) -> VmResult<Box<dyn Conn>> {
        if *self.agent_unreachable.lock().unwrap() {
            return Err(VmError::unavailable("guest_agent_unreachable", "The guest agent is not listening yet").retryable());
        }
        let (shares, mounted) = {
            let g = self.guests.lock().unwrap();
            let guest = g.get(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?;
            (guest.shares.clone(), guest.mounted.clone())
        };
        let legacy = *self.legacy_guest.lock().unwrap();
        let (host, guest) = MemConn::pair();
        let calls = self.agent_calls.clone();
        // Answers like deploy/windows/guest-image/guest/psyche-control.
        std::thread::spawn(move || {
            crate::agent::serve(&guest, |op, req| {
                calls.lock().unwrap().push((op.to_owned(), req.clone()));
                let unknown = || json!({"code": "invalid_params", "message": format!("unknown op {op}")});
                match op {
                    crate::agent::PING => Ok(json!({"pong": true})),
                    crate::agent::STATUS => Ok(json!({
                        "version": "0.1.0-test", "hostname": "psyche-pc", "kernel": "6.6.87.2-psyche", "uptimeSeconds": 3,
                        "node": {"running": true, "pid": 42}, "session": {"mounted": true, "freeBytes": 1, "totalBytes": 2},
                        "network": {"up": false, "addresses": []}, "shares": [],
                    })),
                    crate::agent::MOUNT => {
                        let n = req["name"].as_str().unwrap_or("").to_owned();
                        if !shares.lock().unwrap().iter().any(|s| s.name == n) {
                            return Err(json!({"code": "internal", "message": "connect(vsock host:564): no such share"}));
                        }
                        let mut m = mounted.lock().unwrap();
                        if m.contains(&n) {
                            return Err(json!({"code": "conflict", "message": format!("share {n} is already mounted")}));
                        }
                        m.push(n.clone());
                        Ok(json!({"name": n, "path": format!("/mnt/psyche/{n}"), "readOnly": req["readOnly"]}))
                    }
                    crate::agent::UMOUNT => {
                        let n = req["name"].as_str().unwrap_or("");
                        let mut m = mounted.lock().unwrap();
                        if !m.iter().any(|x| x == n) {
                            return Err(json!({"code": "not_found", "message": format!("share {n} is not mounted")}));
                        }
                        m.retain(|x| x != n);
                        Ok(json!({"unmounted": true}))
                    }
                    crate::agent::RESTART_NODE => Ok(json!({"restarting": true})),
                    crate::agent::SHUTDOWN => Ok(json!({"stopping": true})),
                    crate::agent::EXPORT if !legacy => {
                        let out = share_path(&shares.lock().unwrap(), crate::shares::SHARE_TRANSFER_OUT)
                            .ok_or(json!({"code": "internal", "message": "no out share"}))?;
                        let path = req["path"].as_str().unwrap_or("");
                        if path == "/missing" {
                            return Err(json!({"code": "not_found", "message": "No such file"}));
                        }
                        let id = req["transferId"].as_str().unwrap_or("x");
                        let file = path.rsplit('/').next().unwrap_or("file");
                        let dir = out.join(id);
                        std::fs::create_dir_all(&dir).map_err(|_| json!({"code": "internal", "message": "mkdir"}))?;
                        std::fs::write(dir.join(file), b"exported").map_err(|_| json!({"code": "internal", "message": "write"}))?;
                        Ok(json!({"bytes": 8}))
                    }
                    crate::agent::INSTALL_PSYCHE if !legacy => Ok(json!({"installed": true})),
                    _ => Err(unknown()),
                }
            });
        });
        Ok(Box::new(host))
    }

    fn is_running(&self, name: &str) -> bool {
        self.guests.lock().unwrap().contains_key(name)
    }

    fn is_paused(&self, name: &str) -> bool {
        self.guests.lock().unwrap().get(name).map(|g| g.paused).unwrap_or(false)
    }

    fn run_info(&self, name: &str) -> Option<RunInfo> {
        let g = self.guests.lock().unwrap();
        let guest = g.get(name)?;
        Some(RunInfo {
            runtime_id: Some("00000000-0000-0000-0000-000000000001".into()),
            ip_address: guest.spec.nat_mac.as_ref().map(|_| "172.31.240.2".into()),
            network: None,
        })
    }

    fn active_count(&self) -> u32 {
        self.guests.lock().unwrap().len() as u32
    }
}
