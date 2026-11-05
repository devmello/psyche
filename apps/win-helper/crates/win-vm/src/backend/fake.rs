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
    shares: Vec<Plan9Share>,
    events: EventSink,
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

    pub fn live_shares(&self, name: &str) -> Vec<String> {
        self.guests.lock().unwrap().get(name).map(|g| g.shares.iter().map(|s| s.name.clone()).collect()).unwrap_or_default()
    }
}

impl VmBackend for FakeBackend {
    fn unavailable_reason(&self) -> Option<VmError> {
        self.unavailable.lock().unwrap().clone()
    }

    fn info(&self) -> Value {
        json!({"available": self.unavailable_reason().is_none(), "backend": "fake"})
    }

    fn start(&self, spec: &BootSpec, events: EventSink, prepared: &dyn Fn(&RunInfo)) -> VmResult<RunInfo> {
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
        prepared(&info);
        self.boots.lock().unwrap().push(spec.clone());
        self.guests
            .lock()
            .unwrap()
            .insert(spec.name.clone(), Guest { spec: spec.clone(), paused: false, shares: spec.shares.clone(), events });
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
        guest.shares.retain(|s| s.name != share.name);
        guest.shares.push(share.clone());
        Ok(())
    }

    fn remove_share(&self, name: &str, share: &str) -> VmResult<()> {
        let mut g = self.guests.lock().unwrap();
        let guest = g.get_mut(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?;
        guest.shares.retain(|s| s.name != share);
        Ok(())
    }

    fn connect_agent(&self, name: &str) -> VmResult<Box<dyn Conn>> {
        if *self.agent_unreachable.lock().unwrap() {
            return Err(VmError::unavailable("guest_agent_unreachable", "The guest agent is not listening yet").retryable());
        }
        let shares = {
            let g = self.guests.lock().unwrap();
            let guest = g.get(name).ok_or_else(|| VmError::conflict("vm_not_running", "not running"))?;
            let _ = &guest.spec;
            guest.shares.clone()
        };
        let (host, guest) = MemConn::pair();
        let calls = self.agent_calls.clone();
        std::thread::spawn(move || {
            crate::agent::serve(&guest, |method, params| {
                calls.lock().unwrap().push((method.to_owned(), params.clone()));
                match method {
                    crate::agent::PING => Ok(json!({"version": "1", "kernel": "6.6.0-psyche"})),
                    crate::agent::EXPORT => {
                        let out = share_path(&shares, crate::shares::SHARE_TRANSFER_OUT)
                            .ok_or(json!({"code": "unavailable", "message": "no out share"}))?;
                        let path = params["path"].as_str().unwrap_or("");
                        if path == "/missing" {
                            return Err(
                                json!({"code": "not_found", "message": "No such file", "details": {"reason": "guest_path_missing"}}),
                            );
                        }
                        let id = params["transferId"].as_str().unwrap_or("x");
                        let file = path.rsplit('/').next().unwrap_or("file");
                        let dir = out.join(id);
                        std::fs::create_dir_all(&dir).map_err(|_| json!({"code": "unavailable", "message": "mkdir"}))?;
                        std::fs::write(dir.join(file), b"exported").map_err(|_| json!({"code": "unavailable", "message": "write"}))?;
                        Ok(json!({"bytes": 8}))
                    }
                    _ => Ok(json!({"ok": true})),
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
