//! The real backend: Hyper-V Host Compute Service (`computecore.dll`).
//!
//! Boot: grant the VM's virtual account access to its files (`HcsGrantVmAccess`), create the
//! NAT endpoint when asked, `HcsCreateComputeSystem` with the `doc::VmDoc` document, register
//! the exit callback, read the runtime id, listen on the Gateway vsock port for that VM, then
//! `HcsStartComputeSystem` (0.1–2 s for a kernel + initrd boot). The serial console is read
//! into `console.log`. Every HCS call runs as LocalSystem (`security::as_service`).

pub mod doc;
pub mod ffi;

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use windows::core::{GUID, HRESULT, PCWSTR};

use crate::backend::{BackendEvent, BootSpec, EventSink, RunInfo, VmBackend};
use crate::conn::Conn;
use crate::error::{VmError, VmResult};
use crate::hcn::Hcn;
use crate::hvsock::{self, HvListener};
use crate::security::as_service;
use doc::Plan9Share;
use ffi::{Api, Sys, Wide};

const CREATE_TIMEOUT_MS: u32 = 120_000;
const OP_TIMEOUT_MS: u32 = 60_000;

struct SysHandle(Sys);
// SAFETY: HCS system handles may be used from any thread.
unsafe impl Send for SysHandle {}
// SAFETY: as above.
unsafe impl Sync for SysHandle {}

struct Running {
    name: String,
    system_id: String,
    sys: SysHandle,
    runtime_id: GUID,
    paused: AtomicBool,
    exited: (Mutex<bool>, Condvar),
    listener: Mutex<Option<HvListener>>,
    granted: Vec<PathBuf>,
    endpoint: Option<GUID>,
    info: RunInfo,
    console_stop: Arc<AtomicBool>,
}

/// Leaked into HCS as the callback context; freed after the system handle is closed.
struct CallbackCtx {
    backend: std::sync::Weak<HcsInner>,
    name: String,
    events: EventSink,
}

struct HcsInner {
    api: Result<Api, VmError>,
    hcn: Mutex<Option<Hcn>>,
    owner_sid: String,
    owner: String,
    schema: (u32, u32),
    service: Value,
    guests: Mutex<HashMap<String, Arc<Running>>>,
}

pub struct HcsBackend(Arc<HcsInner>);

fn exit_error(data: &str) -> Option<String> {
    let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
    match v["ExitType"].as_str() {
        Some("UnexpectedExit") => Some("guest_crashed".into()),
        _ if v["Status"].as_i64().unwrap_or(0) < 0 => Some("guest_exit_error".into()),
        _ => None,
    }
}

unsafe extern "system" fn on_event(event: *const ffi::HcsEvent, context: *const c_void) {
    if event.is_null() || context.is_null() {
        return;
    }
    // SAFETY: HCS passes our context pointer and a valid event for the call's duration.
    let (ty, data, ctx) = unsafe {
        let e = &*event;
        let data = if e.data.is_null() { String::new() } else { e.data.to_string().unwrap_or_default() };
        (e.ty, data, &*(context as *const CallbackCtx))
    };
    match ty {
        ffi::EVENT_SYSTEM_EXITED | ffi::EVENT_SERVICE_DISCONNECT => {
            let err = if ty == ffi::EVENT_SERVICE_DISCONNECT { Some("hcs_disconnected".to_owned()) } else { exit_error(&data) };
            let (backend, name, events) = (ctx.backend.clone(), ctx.name.clone(), ctx.events.clone());
            // Never close the system from inside its own callback.
            std::thread::spawn(move || {
                if let Some(b) = backend.upgrade() {
                    b.finish(&name);
                }
                events(&name, BackendEvent::Exited(err));
            });
        }
        ffi::EVENT_SYSTEM_CRASH_INITIATED => crate::log::warn(&format!("vm crash initiated name={}", ctx.name)),
        _ => {}
    }
}

impl HcsInner {
    fn api(&self) -> VmResult<&Api> {
        self.api.as_ref().map_err(|e| e.clone())
    }

    fn guest(&self, name: &str) -> VmResult<Arc<Running>> {
        self.guests.lock().unwrap().get(name).cloned().ok_or_else(|| VmError::conflict("vm_not_running", format!("{name} is not running")))
    }

    fn sys_call(&self, what: &str, g: &Running, f: ffi::FnSysOp, options: Option<&Value>, timeout_ms: u32) -> VmResult<String> {
        let api = self.api()?;
        let opts = options.map(|o| Wide::new(&o.to_string()));
        as_service(|| api.run(what, timeout_ms, |op| unsafe { f(g.sys.0, op, opts.as_ref().map(|w| w.ptr()).unwrap_or(PCWSTR::null())) }))
    }

    /// Releases everything a guest held once its compute system is gone.
    fn finish(&self, name: &str) {
        let Some(g) = self.guests.lock().unwrap().remove(name) else { return };
        *g.exited.0.lock().unwrap() = true;
        g.exited.1.notify_all();
        g.console_stop.store(true, Ordering::SeqCst);
        g.listener.lock().unwrap().take();
        if let Ok(api) = self.api() {
            as_service(|| {
                // SAFETY: closes the handle opened at create; HCS stops calling back after this.
                unsafe { (api.close)(g.sys.0) };
                for f in &g.granted {
                    api.revoke_vm_access(&g.system_id, f);
                }
            });
        }
        if let (Some(ep), Some(hcn)) = (g.endpoint, self.hcn.lock().unwrap().as_ref()) {
            as_service(|| hcn.delete_endpoint(&ep));
        }
        crate::log::info(&format!("vm exited name={}", g.name));
    }

    fn wait_exit(&self, g: &Running, timeout: Duration) -> bool {
        let lock = g.exited.0.lock().unwrap();
        let (done, _) = g.exited.1.wait_timeout_while(lock, timeout, |e| !*e).unwrap();
        *done
    }
}

impl HcsBackend {
    pub fn new(owner_sid: &str) -> HcsBackend {
        let api = Api::load();
        let mut service = Value::Null;
        let mut schema = (2, 2);
        if let Ok(a) = &api {
            match as_service(|| a.service_properties(r#"{"PropertyTypes":["Basic"]}"#)) {
                Ok(v) => {
                    schema = doc::pick_schema(&v).unwrap_or((2, 2));
                    service = v;
                }
                Err(e) => service = json!({"error": e.reason}),
            }
        }
        HcsBackend(Arc::new(HcsInner {
            api,
            hcn: Mutex::new(None),
            owner_sid: owner_sid.to_owned(),
            owner: crate::paths::compute_system_owner(owner_sid),
            schema,
            service,
            guests: Mutex::new(HashMap::new()),
        }))
    }

    fn start_inner(&self, spec: &BootSpec, events: EventSink, prepared: &dyn Fn(&RunInfo)) -> VmResult<RunInfo> {
        let inner = &self.0;
        let api = inner.api()?;
        if inner.guests.lock().unwrap().contains_key(&spec.name) {
            return Err(VmError::conflict("vm_running", format!("{} is already running", spec.name)));
        }
        // A compute system left over by a crashed service run (same id) is terminated first.
        as_service(|| {
            let id = Wide::new(&spec.system_id);
            let mut sys: Sys = std::ptr::null_mut();
            // SAFETY: opens by our own id only; closed right after.
            if unsafe { (api.open)(id.ptr(), ffi::GENERIC_ALL, &mut sys) }.is_ok() && !sys.is_null() {
                let _ = api.run("Terminating a stale guest", OP_TIMEOUT_MS, |op| unsafe { (api.terminate)(sys, op, PCWSTR::null()) });
                // SAFETY: closes the handle opened above.
                unsafe { (api.close)(sys) };
            }
        });
        // The VM's virtual account needs its disks, layers, kernel, initrd and system shares.
        let mut granted = Vec::new();
        let mut to_grant: Vec<PathBuf> = spec.disks.iter().chain(&spec.readonly_files).cloned().collect();
        if let Some(saved) = &spec.restore_from {
            to_grant.push(saved.clone());
        }
        for s in spec.shares.iter().filter(|s| crate::shares::RESERVED_NAMES.contains(&s.name.as_str())) {
            to_grant.push(PathBuf::from(&s.path));
        }
        let cleanup_grants = |granted: &[PathBuf]| as_service(|| granted.iter().for_each(|f| api.revoke_vm_access(&spec.system_id, f)));
        for f in &to_grant {
            if let Err(e) = as_service(|| api.grant_vm_access(&spec.system_id, f)) {
                cleanup_grants(&granted);
                return Err(e);
            }
            granted.push(f.clone());
        }
        // NAT (opt-in).
        let mut endpoint = None;
        let mut network = None;
        if let Some(mac) = &spec.nat_mac {
            let mut hcn = inner.hcn.lock().unwrap();
            if hcn.is_none() {
                *hcn = Some(Hcn::load().inspect_err(|_| cleanup_grants(&granted))?);
            }
            let ep = as_service(|| hcn.as_ref().map(|h| h.create_endpoint(&inner.owner_sid, mac)))
                .transpose()
                .inspect_err(|_| cleanup_grants(&granted))?;
            if let Some(ep) = ep {
                network = Some(ep.guest.clone());
                endpoint = Some(ep.id);
            }
        }
        let drop_endpoint = |ep: Option<GUID>| {
            if let (Some(ep), Some(h)) = (ep, inner.hcn.lock().unwrap().as_ref()) {
                as_service(|| h.delete_endpoint(&ep));
            }
        };
        let console_pipe = format!(r"\\.\pipe\psyche-vm-console-{}", &crate::paths::sha256_hex(spec.system_id.as_bytes())[..16]);
        let document = doc::VmDoc {
            owner: inner.owner.clone(),
            schema: inner.schema,
            kernel: spec.kernel.to_string_lossy().into_owned(),
            initrd: spec.initrd.to_string_lossy().into_owned(),
            cmdline: spec.cmdline.clone(),
            cpus: spec.cpus,
            memory_mb: spec.memory_mb,
            disks: spec.disks.iter().map(|d| doc::Disk { path: d.to_string_lossy().into_owned(), read_only: false }).collect(),
            shares: spec.shares.clone(),
            plan9_port: crate::shares::PLAN9_PORT,
            vsock_ports: vec![crate::manager::GATEWAY_NODE_PORT, crate::manager::GUEST_AGENT_PORT],
            console_pipe: spec.console_log.as_ref().map(|_| console_pipe.clone()),
            network: endpoint.map(|ep| (format!("{ep:?}"), spec.nat_mac.clone().unwrap_or_default())),
            restore_from: spec.restore_from.as_ref().map(|p| p.to_string_lossy().into_owned()),
        }
        .to_json();
        let id = Wide::new(&spec.system_id);
        let config = Wide::new(&document.to_string());
        let mut sys: Sys = std::ptr::null_mut();
        let created = as_service(|| {
            api.run("Creating the guest", CREATE_TIMEOUT_MS, |op| unsafe {
                (api.create)(id.ptr(), config.ptr(), op, std::ptr::null(), &mut sys)
            })
        });
        if let Err(e) = created {
            drop_endpoint(endpoint);
            cleanup_grants(&granted);
            return Err(if spec.restore_from.is_some() {
                VmError::unavailable("restore_failed", e.message).detail("cause", e.reason)
            } else {
                e
            });
        }
        let ctx = Box::into_raw(Box::new(CallbackCtx { backend: Arc::downgrade(inner), name: spec.name.clone(), events: events.clone() }));
        let fail = |e: VmError, sys: Sys| -> VmError {
            as_service(|| {
                let _ = api.run("Terminating", OP_TIMEOUT_MS, |op| unsafe { (api.terminate)(sys, op, PCWSTR::null()) });
                // SAFETY: closes the handle created above; no callback runs after close.
                unsafe { (api.close)(sys) };
            });
            drop_endpoint(endpoint);
            cleanup_grants(&granted);
            e
        };
        // SAFETY: `ctx` stays valid until the handle is closed (it is leaked for the guest's life).
        let hr: HRESULT = as_service(|| unsafe { (api.set_callback)(sys, ffi::EVENT_OPTION_NONE, ctx as *const c_void, Some(on_event)) });
        if hr.is_err() {
            return Err(fail(ffi::hcs_error("Watching the guest", hr, ""), sys));
        }
        let props = as_service(|| {
            api.run("Reading the guest's properties", OP_TIMEOUT_MS, |op| unsafe { (api.properties)(sys, op, PCWSTR::null()) })
        });
        let runtime_id = match props
            .ok()
            .and_then(|p| serde_json::from_str::<Value>(&p).ok())
            .and_then(|v| v["RuntimeId"].as_str().and_then(hvsock::parse_guid))
        {
            Some(g) => g,
            None => return Err(fail(VmError::unavailable("hcs_error", "HCS reported no runtime id for the guest"), sys)),
        };
        // Listen for the guest's psyche-node before it boots.
        let ev = events.clone();
        let name = spec.name.clone();
        let listener = match as_service(|| {
            HvListener::bind(runtime_id, crate::manager::GATEWAY_NODE_PORT, move |s| ev(&name, BackendEvent::GuestConnection(Box::new(s))))
        }) {
            Ok(l) => l,
            Err(e) => return Err(fail(e, sys)),
        };
        let info = RunInfo {
            runtime_id: Some(format!("{runtime_id:?}").to_lowercase()),
            ip_address: network.as_ref().and_then(|n| n["address"].as_str().map(str::to_owned)),
            network: network.clone(),
        };
        prepared(&info);
        let started = as_service(|| api.run("Starting the guest", CREATE_TIMEOUT_MS, |op| unsafe { (api.start)(sys, op, PCWSTR::null()) }));
        if let Err(e) = started {
            drop(listener);
            let e =
                if spec.restore_from.is_some() { VmError::unavailable("restore_failed", e.message).detail("cause", e.reason) } else { e };
            return Err(fail(e, sys));
        }
        let console_stop = Arc::new(AtomicBool::new(false));
        if let Some(log) = &spec.console_log
            && let Ok(file) = std::fs::File::create(log)
        {
            spawn_console(console_pipe, file, console_stop.clone());
        }
        let running = Arc::new(Running {
            name: spec.name.clone(),
            system_id: spec.system_id.clone(),
            sys: SysHandle(sys),
            runtime_id,
            paused: AtomicBool::new(false),
            exited: (Mutex::new(false), Condvar::new()),
            listener: Mutex::new(Some(listener)),
            granted,
            endpoint,
            info: info.clone(),
            console_stop,
        });
        inner.guests.lock().unwrap().insert(spec.name.clone(), running);
        crate::log::info(&format!(
            "vm started name={} schema={}.{} warm={}",
            spec.name,
            inner.schema.0,
            inner.schema.1,
            spec.restore_from.is_some()
        ));
        Ok(info)
    }
}

/// Copies the guest's serial console into `console.log` (capped at 4 MiB).
fn spawn_console(pipe: String, mut file: std::fs::File, stop: Arc<AtomicBool>) {
    use std::io::Write;
    std::thread::spawn(move || {
        let conn = (0..100).find_map(|_| {
            if stop.load(Ordering::SeqCst) {
                return None;
            }
            match as_service(|| crate::pipeclient::PipeConn::open(&pipe, 200)) {
                Ok(c) => Some(c),
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(100));
                    None
                }
            }
        });
        let Some(conn) = conn else { return };
        let mut written = 0usize;
        let mut buf = [0u8; 4096];
        while !stop.load(Ordering::SeqCst) {
            match conn.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if written < 4 << 20 {
                        let _ = file.write_all(&buf[..n]);
                        written += n;
                    }
                }
            }
        }
    });
}

impl VmBackend for HcsBackend {
    fn unavailable_reason(&self) -> Option<VmError> {
        match &self.0.api {
            Err(e) => Some(e.clone()),
            Ok(_) if self.0.service.get("error").is_some() => Some(VmError::unavailable(
                self.0.service["error"].as_str().unwrap_or("hcs_unavailable"),
                "The Host Compute Service refused the service (it must run as LocalSystem)",
            )),
            Ok(_) => None,
        }
    }

    fn info(&self) -> Value {
        let props = &self.0.service;
        let basic = props["Properties"].as_array().and_then(|a| a.first()).unwrap_or(props);
        json!({
            "backend": "hcs",
            "schema": format!("{}.{}", self.0.schema.0, self.0.schema.1),
            "supportedSchemaVersions": basic["SupportedSchemaVersions"],
        })
    }

    fn start(&self, spec: &BootSpec, events: EventSink, prepared: &dyn Fn(&RunInfo)) -> VmResult<RunInfo> {
        self.start_inner(spec, events, prepared)
    }

    fn stop(&self, name: &str, force: bool, timeout_secs: u64) -> VmResult<bool> {
        let inner = &self.0;
        let Ok(g) = inner.guest(name) else { return Ok(true) };
        let opts = (inner.schema >= (2, 5)).then(doc::shutdown_options);
        let asked = inner.sys_call("Shutting the guest down", &g, inner.api()?.shutdown, opts.as_ref(), OP_TIMEOUT_MS);
        if asked.is_ok() && inner.wait_exit(&g, Duration::from_secs(timeout_secs)) {
            return Ok(true);
        }
        if !force {
            return Err(VmError::unavailable("guest_did_not_stop", "The guest did not shut down. Retry with force: true.").retryable());
        }
        inner.sys_call("Stopping the guest", &g, inner.api()?.terminate, None, OP_TIMEOUT_MS)?;
        inner.wait_exit(&g, Duration::from_secs(15));
        Ok(false)
    }

    fn pause(&self, name: &str) -> VmResult<()> {
        let g = self.0.guest(name)?;
        self.0.sys_call("Pausing the guest", &g, self.0.api()?.pause, None, OP_TIMEOUT_MS)?;
        g.paused.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn resume(&self, name: &str) -> VmResult<()> {
        let g = self.0.guest(name)?;
        self.0.sys_call("Resuming the guest", &g, self.0.api()?.resume, None, OP_TIMEOUT_MS)?;
        g.paused.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn save_state(&self, name: &str, path: &Path) -> VmResult<()> {
        let inner = &self.0;
        let g = inner.guest(name)?;
        let api = inner.api()?;
        let was_paused = g.paused.load(Ordering::SeqCst);
        if !was_paused {
            inner.sys_call("Pausing the guest", &g, api.pause, None, OP_TIMEOUT_MS)?;
        }
        let saved = inner.sys_call("Saving the guest", &g, api.save, Some(&doc::save_options(&path.to_string_lossy())), 600_000);
        if let Err(e) = saved {
            if !was_paused {
                let _ = inner.sys_call("Resuming the guest", &g, api.resume, None, OP_TIMEOUT_MS);
            }
            return Err(VmError::unavailable(
                "save_failed",
                format!("Saving the machine state failed; the guest keeps running ({})", e.message),
            ));
        }
        inner.sys_call("Stopping the guest", &g, api.terminate, None, OP_TIMEOUT_MS)?;
        inner.wait_exit(&g, Duration::from_secs(15));
        Ok(())
    }

    fn add_share(&self, name: &str, share: &Plan9Share) -> VmResult<()> {
        let inner = &self.0;
        let g = inner.guest(name)?;
        let api = inner.api()?;
        let req = Wide::new(&doc::add_share_request(share, crate::shares::PLAN9_PORT).to_string());
        as_service(|| {
            api.run("Adding a share", OP_TIMEOUT_MS, |op| unsafe { (api.modify)(g.sys.0, op, req.ptr(), std::ptr::null_mut()) })
        })?;
        Ok(())
    }

    fn remove_share(&self, name: &str, share: &str) -> VmResult<()> {
        let inner = &self.0;
        let g = inner.guest(name)?;
        let api = inner.api()?;
        let req = Wide::new(&doc::remove_share_request(share, crate::shares::PLAN9_PORT).to_string());
        as_service(|| {
            api.run("Removing a share", OP_TIMEOUT_MS, |op| unsafe { (api.modify)(g.sys.0, op, req.ptr(), std::ptr::null_mut()) })
        })?;
        Ok(())
    }

    fn connect_agent(&self, name: &str) -> VmResult<Box<dyn Conn>> {
        let g = self.0.guest(name)?;
        let s = as_service(|| hvsock::connect_vsock(g.runtime_id, crate::manager::GUEST_AGENT_PORT, 3000))?;
        Ok(Box::new(s))
    }

    fn is_running(&self, name: &str) -> bool {
        self.0.guests.lock().unwrap().contains_key(name)
    }

    fn is_paused(&self, name: &str) -> bool {
        self.0.guests.lock().unwrap().get(name).map(|g| g.paused.load(Ordering::SeqCst)).unwrap_or(false)
    }

    fn run_info(&self, name: &str) -> Option<RunInfo> {
        self.0.guests.lock().unwrap().get(name).map(|g| g.info.clone())
    }

    fn active_count(&self) -> u32 {
        self.0.guests.lock().unwrap().len() as u32
    }
}
