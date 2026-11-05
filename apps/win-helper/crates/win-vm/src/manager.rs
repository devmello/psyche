//! The one Psyche guest's lifecycle (port of `VMManager.swift`, `VMSnapshots.swift`,
//! `VMImages.swift`): every `vm.*` method with the mac helper's params, results and error
//! reasons. Serialized per guest (`vm_busy`); long operations report progress through `emit`;
//! every state change is published on `events` (`watch`).
//!
//! The server calls these on a blocking thread while impersonating the owner, so file work in
//! the owner's profile uses the owner's own rights; backends switch back to LocalSystem only for
//! HCS calls. Background work (a guest exiting, a guest connection) uses `OwnerScope`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::agent::{self, AgentClient};
use crate::backend::{BackendEvent, BootSpec, EventSink, RunInfo, VmBackend};
use crate::conn::Conn;
use crate::error::{VmError, VmResult};
use crate::events::EventHub;
use crate::fsx;
use crate::granted::GrantedFolders;
use crate::hcs::doc::{self, Plan9Share};
use crate::image::{self, VerifyCache};
use crate::model::{self, HostResources, ImageRef, Phase, TransferRecord, VmConfig, VmState};
use crate::paths::{self, Bundle};
use crate::shares::{self, SensitiveRoots, ShareGrant};
use crate::snapshots::{self, SnapshotStore};
use crate::vhd::DiskOps;

/// vsock ports (mac `VsockPorts`; apps/node `guest-bootstrap.sh`). Host CID is 2.
pub const GATEWAY_NODE_PORT: u32 = 7980;
pub const GUEST_AGENT_PORT: u32 = 7000;

pub type Emit<'a> = &'a (dyn Fn(Value) + Sync);

/// Runs `f` as the owner (background work; the server impersonates per request).
pub trait OwnerScope: Send + Sync {
    fn run(&self, f: &mut dyn FnMut());
}

/// No impersonation (tests, console runs as the owner).
pub struct AsSelf;
impl OwnerScope for AsSelf {
    fn run(&self, f: &mut dyn FnMut()) {
        f()
    }
}

/// Opens a stream to the Gateway's guest pipe (as the owner; checks the server is the owner's).
pub trait GatewayConnector: Send + Sync {
    fn connect(&self, home: &Path) -> VmResult<Box<dyn Conn>>;
}

#[derive(Debug, Clone)]
pub struct ManagerConfig {
    pub home: PathBuf,
    pub images_root: PathBuf,
    pub owner_sid: String,
    pub roots: SensitiveRoots,
    pub version: String,
}

#[derive(Default)]
struct Inner {
    busy: HashSet<String>,
    agents: HashMap<String, Arc<AgentClient>>,
    agent_status: HashMap<String, Value>,
    payloads: HashMap<String, PathBuf>,
    relays: HashMap<String, Vec<Arc<dyn Conn>>>,
}

pub struct Manager {
    pub cfg: ManagerConfig,
    backend: Arc<dyn VmBackend>,
    disks: Arc<dyn DiskOps>,
    gateway: Arc<dyn GatewayConnector>,
    owner: Arc<dyn OwnerScope>,
    host: Box<dyn Fn() -> HostResources + Send + Sync>,
    verified: VerifyCache,
    pub events: EventHub,
    inner: Mutex<Inner>,
    me: Weak<Manager>,
}

/// Releases a busy claim on drop.
struct Claim<'a>(&'a Manager, String);
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.inner.lock().unwrap().busy.remove(&self.1);
    }
}

// MARK: params (mac `VMManager.*Params`)

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    pub name: Option<String>,
    pub cpus: Option<u32>,
    #[serde(rename = "memoryGB")]
    pub memory_gb: Option<u32>,
    #[serde(rename = "diskGB")]
    pub disk_gb: Option<u32>,
    pub ipsw: Option<String>,
    pub download: Option<bool>,
    pub username: Option<String>,
    pub image: Option<String>,
    pub image_sha256: Option<String>,
    /// Windows: `none` | `nat` at creation (also `configure`).
    pub network: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureParams {
    pub name: Option<String>,
    pub cpus: Option<u32>,
    #[serde(rename = "memoryGB")]
    pub memory_gb: Option<u32>,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
    pub clipboard: Option<String>,
    pub vault: Option<String>,
    pub network: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotParams {
    pub name: Option<String>,
    pub label: Option<String>,
    pub kind: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImageParams {
    pub name: Option<String>,
    pub out_dir: String,
    pub id: Option<String>,
}

fn not_running(name: &str) -> VmError {
    VmError::conflict("vm_not_running", format!("{name} is not running"))
}

fn reason_of(e: &VmError) -> String {
    e.reason.clone()
}

impl Manager {
    pub fn new(
        cfg: ManagerConfig,
        backend: Arc<dyn VmBackend>,
        disks: Arc<dyn DiskOps>,
        gateway: Arc<dyn GatewayConnector>,
        owner: Arc<dyn OwnerScope>,
        host: Box<dyn Fn() -> HostResources + Send + Sync>,
    ) -> Arc<Manager> {
        Arc::new_cyclic(|me| Manager {
            cfg,
            backend,
            disks,
            gateway,
            owner,
            host,
            verified: VerifyCache::default(),
            events: EventHub::default(),
            inner: Mutex::new(Inner::default()),
            me: me.clone(),
        })
    }

    pub fn backend(&self) -> &Arc<dyn VmBackend> {
        &self.backend
    }

    fn available(&self) -> VmResult<()> {
        match self.backend.unavailable_reason() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn bundle(&self, name: &str) -> VmResult<Bundle> {
        if !VmConfig::is_valid_name(name) {
            return Err(VmError::invalid_params("bad VM name", "name"));
        }
        Ok(Bundle::new(&self.cfg.home, name))
    }

    fn load(&self, name: &str) -> VmResult<(Bundle, VmConfig)> {
        let b = self.bundle(name)?;
        let c: Option<VmConfig> = if b.exists() { fsx::read_json(&b.config()) } else { None };
        match c {
            Some(c) if c.name == name => Ok((b, c)),
            _ => Err(VmError::not_found("vm_not_found", format!("No guest named {name}"))),
        }
    }

    fn claim(&self, name: &str) -> VmResult<Claim<'_>> {
        if !self.inner.lock().unwrap().busy.insert(name.to_owned()) {
            return Err(model::busy(name));
        }
        Ok(Claim(self, name.to_owned()))
    }

    pub fn is_busy(&self) -> bool {
        !self.inner.lock().unwrap().busy.is_empty()
    }

    fn state_of(&self, b: &Bundle) -> Option<VmState> {
        fsx::read_json(&b.state())
    }

    // MARK: status

    pub fn status(&self) -> Value {
        let guests: Vec<Value> = paths::all_bundles(&self.cfg.home)
            .iter()
            .filter_map(|b| fsx::read_json::<VmConfig>(&b.config()).map(|c| self.describe(b, &c)))
            .collect();
        json!({
            "guests": guests,
            "active": self.backend.active_count(),
            "supportsGuestProvisioning": true,
            "maxActive": model::MAX_ACTIVE,
        })
    }

    /// The mac `describe` shape, plus `network`, `guestKind`, `ipAddress` and `vsock.serviceId`.
    pub fn describe(&self, b: &Bundle, c: &VmConfig) -> Value {
        let mut state = self.state_of(b).unwrap_or_else(|| VmState::new(Phase::Created, ""));
        let running = self.backend.is_running(&c.name);
        // A service restart loses running guests (they live in this process's handles).
        if state.phase.is_active() && !running {
            state.phase = if state.provisioned { Phase::Stopped } else { Phase::Failed };
        }
        if running && self.backend.is_paused(&c.name) {
            state.phase = Phase::Paused;
        }
        let saved = b.saved_state().is_file();
        if !running && saved && state.phase == Phase::Stopped {
            state.phase = Phase::Saved;
        }
        let shares: Vec<ShareGrant> = fsx::read_json(&b.shares()).unwrap_or_default();
        let transfers: Vec<TransferRecord> = fsx::read_json(&b.transfers()).unwrap_or_default();
        let snapshots = snapshots::load(b);
        let agent = self.inner.lock().unwrap().agent_status.get(&c.name).cloned().unwrap_or_else(|| json!({"connected": false}));
        let run = if running { self.backend.run_info(&c.name) } else { None };
        let mut o = json!({
            "name": c.name,
            "phase": state.phase.as_str(),
            "provisioned": state.provisioned,
            "cpus": c.cpus,
            "memoryGB": c.memory_gb,
            "diskGB": c.disk_gb,
            "guestOS": c.guest_os,
            "username": c.username,
            "shares": shares.iter().map(|s| json!({"name": s.name, "hostPath": s.host_path, "readOnly": s.read_only, "guestPath": s.guest_path()})).collect::<Vec<_>>(),
            "vsock": {"gatewayNodePort": GATEWAY_NODE_PORT, "hostCid": 2, "serviceId": doc::vsock_service_id(GATEWAY_NODE_PORT)},
            "display": {"width": c.display_width, "height": c.display_height, "visible": false},
            "clipboard": c.clipboard,
            "vault": c.vault,
            "agent": agent,
            "psycheInstalled": state.psyche_installed,
            "permissionsGranted": state.permissions_granted,
            "savedState": saved,
            "transfers": transfers.iter().rev().take(20).rev().collect::<Vec<_>>(),
            "snapshots": snapshots,
            "network": c.network,
            "guestKind": "linux",
        });
        if state.password_rotation_pending {
            o["passwordRotationPending"] = Value::Bool(true);
        }
        if let Some(i) = &state.image {
            o["image"] = json!({"id": i.id, "guestOS": i.guest_os, "createdAt": i.created_at});
        }
        if let Some(base) = snapshots::load(b).iter().find(|s| s.kind == "base") {
            o["baseSnapshot"] = Value::String(base.id.clone());
        }
        if let Some(e) = &state.last_error {
            o["lastError"] = Value::String(e.clone());
        }
        if let Some(ip) = run.as_ref().and_then(|r| r.ip_address.clone()) {
            o["ipAddress"] = Value::String(ip);
        }
        o
    }

    /// Persists a state change (merged with the old record's flags) and publishes the guest.
    fn set_state(&self, b: &Bundle, record: VmState) -> VmResult<()> {
        let r = match self.state_of(b) {
            Some(old) => record.merged_over(&old),
            None => record,
        };
        fsx::write_json(&b.state(), &r)?;
        self.publish(b);
        Ok(())
    }

    fn publish(&self, b: &Bundle) {
        if let Some(c) = fsx::read_json::<VmConfig>(&b.config()) {
            self.events.publish(json!({"type": "vm.updated", "guest": self.describe(b, &c), "at": model::now_iso()}));
        }
    }

    fn host(&self) -> HostResources {
        (self.host)()
    }

    // MARK: create (images instead of IPSW installs)

    pub fn create(&self, p: CreateParams, emit: Emit) -> VmResult<Value> {
        self.available()?;
        if p.ipsw.is_some() {
            return Err(VmError::unsupported(
                "ipsw",
                "The sandbox PC runs a Linux guest image, not a macOS IPSW; pass image (an image version) or nothing for the newest installed image",
            ));
        }
        let name = p.name.clone().unwrap_or_else(|| "sandbox".into());
        let existing: Vec<String> = paths::all_bundles(&self.cfg.home).iter().map(|b| b.name.clone()).collect();
        model::check_create(&existing)?;
        let now = model::now_iso();
        let mut config = VmConfig::new(&name, &now);
        config.cpus = p.cpus.unwrap_or(model::DEFAULT_CPUS);
        config.memory_gb = p.memory_gb.unwrap_or(model::DEFAULT_MEMORY_GB);
        config.disk_gb = p.disk_gb.unwrap_or(model::DEFAULT_DISK_GB);
        if let Some(u) = &p.username {
            config.username = u.clone();
        }
        if let Some(n) = &p.network {
            config.network = n.clone();
        }
        let host = self.host();
        config.validate(&host)?;
        VmConfig::check_free_space(&host)?;
        let _claim = self.claim(&name)?;
        let dir = image::locate(&self.cfg.images_root, p.image.as_deref()).map_err(|e| {
            if e.reason == "image_not_found" && p.download == Some(true) {
                e.detail("download", "The desktop app downloads guest images; this service never does")
            } else {
                e
            }
        })?;
        emit(json!({"type": "vm.import", "phase": "started"}));
        let img = image::verify(&dir, p.image_sha256.as_deref(), &self.verified, |f| {
            emit(json!({"type": "vm.import", "phase": "progress", "fraction": f * 0.9}))
        })?;
        config.guest_os = Some(img.manifest.guest_os.clone());
        config.image = Some(dir.file_name().and_then(|n| n.to_str()).unwrap_or(&img.manifest.id).to_owned());
        config.image_sha256 = Some(img.manifest_sha256.clone());
        let b = self.bundle(&name)?;
        let made = (|| -> VmResult<()> {
            fsx::create_dir_all(&b.root)?;
            crate::security::protect_owner_dir(&paths::vm_root(&self.cfg.home), &self.cfg.owner_sid);
            fsx::write_json(&b.config(), &config)?;
            fsx::write_json(&b.state(), &VmState::new(Phase::Created, &now))?;
            self.disks.create_differencing(&b.system_disk(), &img.rootfs())?;
            self.disks.create_dynamic(&b.session_disk(), u64::from(config.disk_gb) << 30)?;
            let mut state = VmState::new(Phase::Installed, &model::now_iso());
            state.psyche_installed = img.manifest.psyche_installed;
            state.image = Some(ImageRef {
                id: img.manifest.id.clone(),
                guest_os: img.manifest.guest_os.clone(),
                created_at: img.manifest.created_at.clone(),
            });
            fsx::write_json(&b.state(), &state)?;
            Ok(())
        })();
        if let Err(e) = made {
            let _ = fsx::remove(&b.root);
            return Err(e);
        }
        emit(json!({"type": "vm.import", "phase": "finished"}));
        self.publish(&b);
        Ok(self.describe(&b, &config))
    }

    // MARK: start / stop

    pub fn start(&self, name: &str, emit: Emit) -> VmResult<Value> {
        self.available()?;
        let (b, config) = self.load(name)?;
        if self.backend.is_running(name) {
            return Ok(self.describe(&b, &config));
        }
        let state = self.state_of(&b).unwrap_or_else(|| VmState::new(Phase::Created, ""));
        let ready = matches!(state.phase, Phase::Installed | Phase::Stopped | Phase::Failed | Phase::Saved) || state.phase.is_active();
        if !ready {
            return Err(VmError::conflict("vm_not_ready", format!("{name} is {}; create it from an image first", state.phase.as_str())));
        }
        if self.backend.active_count() >= model::MAX_ACTIVE {
            return Err(VmError::unavailable("guest_limit", "Another sandbox PC is already running").retryable());
        }
        let _claim = self.claim(name)?;
        let spec = self.boot_spec(&b, &config, &state)?;
        let first_boot = !state.provisioned;
        let mut st = state.clone();
        st.phase = if first_boot { Phase::Provisioning } else { Phase::Starting };
        st.last_error = None;
        st.updated_at = model::now_iso();
        self.set_state(&b, st.clone())?;
        emit(json!({"type": "vm.state", "phase": st.phase.as_str()}));
        let sink = self.sink();
        let meta = b.guest_meta();
        let network_mode = config.network.clone();
        let prepared = move |info: &RunInfo| {
            let net = info.network.clone().unwrap_or_else(|| json!({"mode": network_mode}));
            let _ = fsx::write_json(&meta.join("network.json"), &net);
        };
        let booted = match self.backend.start(&spec, sink.clone(), &prepared) {
            Err(e) if e.reason == "restore_failed" && spec.restore_from.is_some() => {
                // Warm start failed: discard the state and boot cold.
                let _ = std::fs::remove_file(b.saved_state());
                emit(json!({"type": "vm.state", "phase": "starting"}));
                let cold = BootSpec { restore_from: None, ..spec.clone() };
                self.backend.start(&cold, sink, &prepared)
            }
            other => other,
        };
        if let Err(e) = booted {
            let mut failed = VmState::new(Phase::Failed, &model::now_iso());
            failed.last_error = Some(reason_of(&e));
            failed.provisioned = state.provisioned;
            let _ = self.set_state(&b, failed);
            return Err(e);
        }
        // HCS consumes a restored state file; it is invalid once the disks move on.
        if spec.restore_from.is_some() {
            let _ = std::fs::remove_file(b.saved_state());
        }
        let mut running = VmState::new(Phase::Running, &model::now_iso());
        running.provisioned = true;
        running.psyche_installed = state.psyche_installed;
        running.permissions_granted = state.permissions_granted;
        self.set_state(&b, running)?;
        Ok(self.describe(&b, &config))
    }

    /// The boot: verified image, existing disks without links, re-checked shares, meta files.
    fn boot_spec(&self, b: &Bundle, c: &VmConfig, state: &VmState) -> VmResult<BootSpec> {
        let version = c.image.as_deref().ok_or_else(|| VmError::conflict("vm_not_installed", format!("{} has no guest image", c.name)))?;
        let dir = image::locate(&self.cfg.images_root, Some(version))?;
        let img = image::verify(&dir, c.image_sha256.as_deref(), &self.verified, |_| {})?;
        for d in [b.system_disk(), b.session_disk()] {
            if !d.is_file() {
                return Err(VmError::conflict(
                    "vm_not_installed",
                    format!("{} is missing {}", c.name, d.file_name().and_then(|n| n.to_str()).unwrap_or("a disk")),
                ));
            }
        }
        crate::security::check_plain_path(&self.cfg.home, &b.system_disk())?;
        crate::security::check_plain_path(&self.cfg.home, &b.session_disk())?;
        let mut readonly = vec![img.kernel(), img.initrd()];
        for leaf in [b.system_disk(), b.session_disk()] {
            let mut cur = leaf;
            for _ in 0..64 {
                match self.disks.parent_of(&cur)? {
                    Some(parent) => {
                        readonly.push(parent.clone());
                        cur = parent;
                    }
                    None => break,
                }
            }
        }
        // Shares: the user's (re-validated: shares.json is owner-writable) plus the system ones.
        let grants: Vec<ShareGrant> = fsx::read_json(&b.shares()).unwrap_or_default();
        let mut plan9 = Vec::new();
        for g in &grants {
            let path = shares::recheck(g, &self.cfg.roots)?;
            plan9.push(Plan9Share { name: g.name.clone(), path: path.to_string_lossy().into_owned(), read_only: g.read_only });
        }
        plan9.extend(self.system_shares(b, &c.name)?);
        self.write_meta(b, c, &grants, !state.provisioned)?;
        let saved = b.saved_state();
        let restore_from = (state.provisioned && saved.is_file()).then_some(saved);
        Ok(BootSpec {
            name: c.name.clone(),
            system_id: paths::compute_system_id(&self.cfg.owner_sid, &c.name),
            kernel: img.kernel(),
            initrd: img.initrd(),
            cmdline: doc::kernel_cmdline(
                img.manifest.kernel_cmdline.as_deref(),
                &c.name,
                GATEWAY_NODE_PORT,
                GUEST_AGENT_PORT,
                shares::PLAN9_PORT,
                !state.provisioned,
            ),
            disks: vec![b.system_disk(), b.session_disk()],
            readonly_files: readonly,
            shares: plan9,
            cpus: c.cpus,
            memory_mb: u64::from(c.memory_gb) * 1024,
            nat_mac: (c.network == "nat").then(|| c.mac_address.clone()),
            restore_from,
            console_log: Some(b.console_log()),
        })
    }

    /// `psyche-meta` (read-only), `psyche-in` (read-only), `psyche-out` (read-write, only the
    /// agent writes it) and, after `install_psyche`, `psyche-payload` (read-only).
    fn system_shares(&self, b: &Bundle, name: &str) -> VmResult<Vec<Plan9Share>> {
        for d in [b.guest_meta(), b.transfer_in(), b.transfer_out()] {
            fsx::create_dir_all(&d)?;
            crate::security::check_plain_path(&self.cfg.home, &d)?;
        }
        let s = |n: &str, p: &Path, ro: bool| Plan9Share { name: n.into(), path: p.to_string_lossy().into_owned(), read_only: ro };
        let mut out = vec![
            s(shares::SHARE_META, &b.guest_meta(), true),
            s(shares::SHARE_TRANSFER_IN, &b.transfer_in(), true),
            s(shares::SHARE_TRANSFER_OUT, &b.transfer_out(), false),
        ];
        if let Some(p) = self.inner.lock().unwrap().payloads.get(name) {
            out.push(s(shares::SHARE_PAYLOAD, p, true));
        }
        Ok(out)
    }

    /// The guest's view of its setup (`/mnt/psyche/psyche-meta/{vm,shares}.json`).
    fn write_meta(&self, b: &Bundle, c: &VmConfig, grants: &[ShareGrant], first_boot: bool) -> VmResult<()> {
        fsx::create_dir_all(&b.guest_meta())?;
        fsx::write_json(
            &b.guest_meta().join("vm.json"),
            &json!({
                "name": c.name, "username": c.username, "gatewayPort": GATEWAY_NODE_PORT, "agentPort": GUEST_AGENT_PORT,
                "plan9Port": shares::PLAN9_PORT, "provision": first_boot, "network": c.network,
            }),
        )?;
        fsx::write_json(&b.guest_meta().join("shares.json"), &self.share_list(grants, &c.name))
    }

    fn share_list(&self, grants: &[ShareGrant], name: &str) -> Value {
        let mut list: Vec<Value> = grants
            .iter()
            .map(|g| json!({"name": g.name, "readOnly": g.read_only, "port": shares::PLAN9_PORT, "aname": g.name, "guestPath": g.guest_path(), "system": false}))
            .collect();
        let mut sys = vec![(shares::SHARE_TRANSFER_IN, true), (shares::SHARE_TRANSFER_OUT, false)];
        if self.inner.lock().unwrap().payloads.contains_key(name) {
            sys.push((shares::SHARE_PAYLOAD, true));
        }
        for (n, ro) in sys {
            list.push(json!({"name": n, "readOnly": ro, "port": shares::PLAN9_PORT, "aname": n, "guestPath": shares::guest_path(n), "system": true}));
        }
        Value::Array(list)
    }

    fn sink(&self) -> EventSink {
        let me = self.me.clone();
        Arc::new(move |name: &str, ev: BackendEvent| {
            let Some(m) = me.upgrade() else { return };
            match ev {
                BackendEvent::GuestConnection(conn) => m.forward(name, conn),
                BackendEvent::Exited(err) => m.stopped(name, err),
            }
        })
    }

    /// Relays one guest psyche-node stream to the Gateway's guest pipe (never its node pipe):
    /// the Gateway marks it `vm-relay` and authenticates it like any node.
    fn forward(&self, name: &str, guest: Box<dyn Conn>) {
        let guest: Arc<dyn Conn> = Arc::from(guest);
        let mut gw: Option<VmResult<Box<dyn Conn>>> = None;
        let home = self.cfg.home.clone();
        self.owner.run(&mut || gw = Some(self.gateway.connect(&home)));
        let gw = match gw.unwrap_or_else(|| Err(VmError::unavailable("gateway_unavailable", "no owner context"))) {
            Ok(c) => Arc::<dyn Conn>::from(c),
            Err(e) => {
                crate::log::warn(&format!("vm relay: Gateway guest pipe unavailable name={name} reason={}", e.reason));
                guest.shutdown();
                return;
            }
        };
        self.inner.lock().unwrap().relays.entry(name.to_owned()).or_default().extend([guest.clone(), gw.clone()]);
        let me = self.me.clone();
        let (n, g1, g2) = (name.to_owned(), guest.clone(), gw.clone());
        crate::conn::relay(guest, gw, move |stats| {
            if let Some(m) = me.upgrade()
                && let Some(list) = m.inner.lock().unwrap().relays.get_mut(&n)
            {
                list.retain(|c| !Arc::ptr_eq(c, &g1) && !Arc::ptr_eq(c, &g2));
            }
            crate::log::info(&format!(
                "vm relay closed name={n} in={} out={}",
                stats.a_to_b.load(std::sync::atomic::Ordering::Relaxed),
                stats.b_to_a.load(std::sync::atomic::Ordering::Relaxed)
            ));
        });
        crate::log::info(&format!("vm relay opened name={name}"));
    }

    fn close_relays(&self, name: &str) {
        let list = self.inner.lock().unwrap().relays.remove(name).unwrap_or_default();
        for c in list {
            c.shutdown();
        }
    }

    pub fn relay_count(&self, name: &str) -> usize {
        self.inner.lock().unwrap().relays.get(name).map(|l| l.len() / 2).unwrap_or(0)
    }

    /// The compute system exited (power-off, crash, or after stop/suspend).
    fn stopped(&self, name: &str, error: Option<String>) {
        self.close_relays(name);
        self.drop_agent(name);
        let Ok(b) = self.bundle(name) else { return };
        let mut work = || {
            if let Some(mut st) = self.state_of(&b) {
                if st.phase != Phase::Saved && st.phase != Phase::Stopped {
                    st.phase = if error.is_none() { Phase::Stopped } else { Phase::Failed };
                    st.last_error = error.clone();
                    st.updated_at = model::now_iso();
                    let _ = fsx::write_json(&b.state(), &st);
                }
            }
            self.publish(&b);
        };
        self.owner.run(&mut work);
    }

    /// Integration-service shutdown, then (on `force`) a hard stop. A guest that ignores the
    /// shutdown and `force: false` answers `guest_did_not_stop` and keeps running.
    pub fn stop(&self, name: &str, force: bool) -> VmResult<Value> {
        let (b, config) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Ok(self.describe(&b, &config));
        }
        let before = self.state_of(&b).unwrap_or_else(|| VmState::new(Phase::Running, ""));
        let mut st = before.clone();
        st.phase = Phase::Stopping;
        self.set_state(&b, st.clone())?;
        let result = match self.backend.stop(name, false, 30) {
            Err(e) if e.reason == "guest_did_not_stop" => {
                // Ask the guest agent, then the forced stop when allowed.
                let asked = self.agent(name).and_then(|a| a.call(agent::SHUTDOWN, json!({}), Duration::from_secs(10))).is_ok();
                if asked {
                    self.backend.stop(name, force, 30)
                } else if force {
                    self.backend.stop(name, true, 5)
                } else {
                    Err(e)
                }
            }
            other => other,
        };
        let graceful = match result {
            Ok(g) => g,
            Err(e) => {
                let _ = self.set_state(&b, before);
                return Err(e);
            }
        };
        st.phase = Phase::Stopped;
        st.updated_at = model::now_iso();
        self.set_state(&b, st)?;
        self.close_relays(name);
        self.drop_agent(name);
        let mut out = self.describe(&b, &config);
        out["graceful"] = Value::Bool(graceful);
        Ok(out)
    }

    pub fn pause(&self, name: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Err(not_running(name));
        }
        self.backend.pause(name)?;
        self.publish(&b);
        Ok(self.describe(&b, &c))
    }

    pub fn resume(&self, name: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Err(not_running(name));
        }
        self.backend.resume(name)?;
        self.publish(&b);
        Ok(self.describe(&b, &c))
    }

    /// Saves the machine state (HCS `SaveType: ToFile`) and stops: warm start next time.
    pub fn suspend(&self, name: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Err(not_running(name));
        }
        let _claim = self.claim(name)?;
        crate::security::check_plain_path(&self.cfg.home, &b.root)?;
        let _ = std::fs::remove_file(b.saved_state());
        if let Err(e) = self.backend.save_state(name, &b.saved_state()) {
            let _ = std::fs::remove_file(b.saved_state());
            return Err(e);
        }
        self.close_relays(name);
        self.drop_agent(name);
        let mut st = self.state_of(&b).unwrap_or_else(|| VmState::new(Phase::Running, ""));
        st.phase = Phase::Saved;
        st.provisioned = true;
        st.updated_at = model::now_iso();
        self.set_state(&b, st)?;
        Ok(self.describe(&b, &c))
    }

    // MARK: settings

    pub fn configure(&self, p: ConfigureParams) -> VmResult<Value> {
        let name = p.name.clone().unwrap_or_else(|| "sandbox".into());
        let (b, old) = self.load(&name)?;
        let hardware =
            p.cpus.is_some() || p.memory_gb.is_some() || p.display_width.is_some() || p.display_height.is_some() || p.network.is_some();
        if hardware && (self.backend.is_running(&name) || b.saved_state().is_file()) {
            return Err(VmError::conflict(
                "vm_running",
                format!("Stop {name} (and discard any saved state) before changing CPUs, memory, display or network"),
            ));
        }
        let mut c = old;
        if let Some(v) = p.cpus {
            c.cpus = v;
        }
        if let Some(v) = p.memory_gb {
            c.memory_gb = v;
        }
        if let Some(v) = p.display_width {
            c.display_width = v;
        }
        if let Some(v) = p.display_height {
            c.display_height = v;
        }
        if let Some(v) = p.clipboard {
            c.clipboard = v;
        }
        if let Some(v) = p.vault {
            c.vault = v;
        }
        if let Some(v) = p.network {
            c.network = v;
        }
        c.validate(&self.host())?;
        fsx::write_json(&b.config(), &c)?;
        self.publish(&b);
        Ok(self.describe(&b, &c))
    }

    /// No display device on the Linux guest (no "Take control" window on Windows).
    pub fn display(&self, name: &str, _visible: bool) -> VmResult<Value> {
        self.load(name)?;
        Err(VmError::unsupported("display", "The Windows sandbox PC is headless: its Linux guest has no display to show"))
    }

    // MARK: teardown

    pub fn delete(&self, name: &str) -> VmResult<Value> {
        let (b, _) = self.load(name)?;
        if self.backend.is_running(name) {
            return Err(VmError::conflict("vm_running", format!("Stop {name} before deleting it")));
        }
        let _claim = self.claim(name)?;
        crate::security::check_plain_path(&self.cfg.home, &b.root)?;
        fsx::remove(&b.root)?;
        {
            let mut i = self.inner.lock().unwrap();
            i.payloads.remove(name);
            i.agent_status.remove(name);
        }
        self.events.publish(json!({"type": "vm.deleted", "name": name}));
        crate::log::info(&format!("vm deleted name={name}"));
        Ok(json!({"deleted": true, "name": name}))
    }

    // MARK: shares

    pub fn share_add(&self, name: &str, share: &str, path: &str, read_only: bool, approval_id: Option<&str>) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        let mut grants: Vec<ShareGrant> = fsx::read_json(&b.shares()).unwrap_or_default();
        let grant = shares::validate(share, path, read_only, approval_id, &grants, &self.cfg.roots, &model::now_iso())?;
        // The owner must be able to open the folder themselves (the request runs as the owner).
        crate::security::check_dir_access(Path::new(&grant.host_path), !read_only)?;
        if self.backend.is_running(name) {
            self.backend.add_share(name, &Plan9Share { name: grant.name.clone(), path: grant.host_path.clone(), read_only })?;
        }
        grants.push(grant);
        fsx::write_json(&b.shares(), &grants)?;
        self.after_share_change(&b, &c, &grants);
        Ok(self.describe(&b, &c))
    }

    pub fn share_remove(&self, name: &str, share: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        let mut grants: Vec<ShareGrant> = fsx::read_json(&b.shares()).unwrap_or_default();
        if !grants.iter().any(|g| g.name == share) {
            return Err(VmError::not_found("share_not_found", format!("No share named {share}")));
        }
        grants.retain(|g| g.name != share);
        if self.backend.is_running(name) {
            // The guest unmounts first so open files do not pin the share.
            let list = self.share_list(&grants, name);
            let _ = self.agent(name).and_then(|a| a.call(agent::MOUNT_SHARES, json!({"shares": list}), Duration::from_secs(20)));
            self.backend.remove_share(name, share)?;
        }
        fsx::write_json(&b.shares(), &grants)?;
        self.after_share_change(&b, &c, &grants);
        Ok(self.describe(&b, &c))
    }

    /// Rewrites the guest's share list and asks a running guest to mount it (best effort: the
    /// guest also reads it at boot).
    fn after_share_change(&self, b: &Bundle, c: &VmConfig, grants: &[ShareGrant]) {
        let _ = fsx::create_dir_all(&b.guest_meta());
        let _ = fsx::write_json(&b.guest_meta().join("shares.json"), &self.share_list(grants, &c.name));
        if self.backend.is_running(&c.name) {
            let list = self.share_list(grants, &c.name);
            if self.agent(&c.name).and_then(|a| a.call(agent::MOUNT_SHARES, json!({"shares": list}), Duration::from_secs(20))).is_err() {
                self.drop_agent(&c.name);
            }
        }
        self.publish(b);
    }

    // MARK: guest agent

    fn agent(&self, name: &str) -> VmResult<Arc<AgentClient>> {
        if let Some(a) = self.inner.lock().unwrap().agents.get(name) {
            return Ok(a.clone());
        }
        let conn = self.backend.connect_agent(name)?;
        let a = Arc::new(AgentClient::new(conn));
        self.inner.lock().unwrap().agents.insert(name.to_owned(), a.clone());
        Ok(a)
    }

    fn drop_agent(&self, name: &str) {
        let mut i = self.inner.lock().unwrap();
        if let Some(a) = i.agents.remove(name) {
            a.close();
        }
        i.agent_status.insert(name.to_owned(), json!({"connected": false}));
    }

    /// `guest.ping`: the agent's version and what it reports.
    pub fn agent_status(&self, name: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Err(not_running(name));
        }
        let r = self.agent(name).and_then(|a| a.call(agent::PING, json!({}), Duration::from_secs(10)));
        match r {
            Ok(r) => {
                let mut s = Map::new();
                s.insert("connected".into(), Value::Bool(true));
                s.insert("lastSeenAt".into(), Value::String(model::now_iso()));
                for k in ["version", "accessibility", "screenRecording", "kernel", "node"] {
                    if let Some(v) = r.get(k) {
                        s.insert(k.into(), v.clone());
                    }
                }
                self.inner.lock().unwrap().agent_status.insert(name.to_owned(), Value::Object(s));
            }
            Err(e) => {
                self.drop_agent(name);
                return Err(e);
            }
        }
        self.publish(&b);
        Ok(self.describe(&b, &c))
    }

    // MARK: transfers

    fn add_transfer(&self, b: &Bundle, t: &TransferRecord) -> VmResult<()> {
        let mut all: Vec<TransferRecord> = fsx::read_json(&b.transfers()).unwrap_or_default();
        all.push(t.clone());
        let keep = all.len().saturating_sub(200);
        fsx::write_json(&b.transfers(), &all[keep..].to_vec())
    }

    /// Copies a host file or folder into `psyche-in/<id>/` (read-only in the guest at
    /// `/mnt/psyche/psyche-in/<id>/<name>`). Sensitive folders are refused.
    pub fn copy_in(&self, name: &str, host_path: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        let canonical = shares::canonical_host_path(host_path)
            .map_err(|e| if e.code == crate::error::Code::InvalidParams { VmError::invalid_params(e.message, "hostPath") } else { e })?;
        let src =
            shares::resolve_existing(&canonical).ok_or_else(|| VmError::not_found("not_found", format!("{host_path} does not exist")))?;
        self.cfg.roots.check(&canonical)?;
        self.cfg.roots.check(&src)?;
        let file_name = Path::new(&src)
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| VmError::invalid_params("hostPath names no file", "hostPath"))?
            .to_owned();
        let id = model::transfer_id();
        let dir = b.transfer_in().join(&id);
        fsx::create_dir_all(&dir)?;
        crate::security::check_plain_path(&self.cfg.home, &dir)?;
        let dest = dir.join(&file_name);
        if let Err(e) = fsx::copy_tree(Path::new(&src), &dest) {
            let _ = fsx::remove(&dir);
            return Err(e);
        }
        let t = TransferRecord {
            id: id.clone(),
            direction: "in".into(),
            host_path: src.clone(),
            guest_path: format!("{}/{id}/{file_name}", shares::guest_path(shares::SHARE_TRANSFER_IN)),
            bytes: fsx::size(&dest),
            created_at: model::now_iso(),
        };
        self.add_transfer(&b, &t)?;
        self.publish(&b);
        Ok(json!({"transfer": t, "guest": self.describe(&b, &c)}))
    }

    /// Asks the guest agent to copy one guest file into `psyche-out/<id>/`, then moves it into a
    /// granted host folder (never overwriting).
    pub fn copy_out(&self, name: &str, guest_path: &str, host_dir: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        if !self.backend.is_running(name) {
            return Err(not_running(name));
        }
        if !guest_path.starts_with('/') || guest_path.contains('\0') {
            return Err(VmError::invalid_params("guestPath must be an absolute guest path", "guestPath"));
        }
        let dir = GrantedFolders::load(&self.cfg.home).resolve_dir(host_dir)?;
        let id = model::transfer_id();
        let a = self.agent(name)?;
        if let Err(e) = a.call(agent::EXPORT, json!({"path": guest_path, "transferId": id}), Duration::from_secs(600)) {
            if e.reason == "guest_agent_closed" || e.reason == "guest_agent_timeout" {
                self.drop_agent(name);
            }
            return Err(e);
        }
        let staged = b.transfer_out().join(&id);
        crate::security::check_plain_path(&self.cfg.home, &staged)?;
        let file = std::fs::read_dir(&staged)
            .ok()
            .and_then(|mut rd| rd.find_map(|e| e.ok()))
            .map(|e| e.path())
            .ok_or_else(|| VmError::unavailable("copy_out_missing", "The guest did not produce the file"))?;
        if fsx::is_link(&file) {
            let _ = fsx::remove(&staged);
            return Err(VmError::policy_denied("copy_out_link", "The guest produced a link, not a file"));
        }
        let file_name = file.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
        let dest = fsx::unique_destination(&dir, &file_name);
        // Same volume: a rename; otherwise copy then remove.
        if std::fs::rename(&file, &dest).is_err() {
            fsx::copy_tree(&file, &dest)?;
        }
        let _ = fsx::remove(&staged);
        let t = TransferRecord {
            id,
            direction: "out".into(),
            host_path: dest.to_string_lossy().into_owned(),
            guest_path: guest_path.to_owned(),
            bytes: fsx::size(&dest),
            created_at: model::now_iso(),
        };
        self.add_transfer(&b, &t)?;
        self.publish(&b);
        Ok(json!({"transfer": t, "guest": self.describe(&b, &c)}))
    }

    // MARK: Psyche in the guest

    /// The image ships psyche-node; this updates it from a release or checkout: the payload is
    /// shared read-only (`psyche-payload`) and the agent runs its `guest-bootstrap.sh`.
    pub fn install_psyche(&self, name: &str, payload: &str, emit: Emit) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        let state = self.state_of(&b);
        if !self.backend.is_running(name) || !state.as_ref().map(|s| s.provisioned).unwrap_or(false) {
            return Err(VmError::conflict("vm_not_running", "Start the provisioned guest first"));
        }
        let canonical =
            shares::canonical_host_path(payload).map_err(|_| VmError::invalid_params("payload must be an absolute folder", "payload"))?;
        let root = shares::resolve_existing(&canonical).ok_or_else(|| {
            VmError::invalid_params(
                "payload must be a Psyche release or checkout (apps/node/scripts/guest-bootstrap.sh missing)",
                "payload",
            )
        })?;
        if !Path::new(&root).join("apps").join("node").join("scripts").join("guest-bootstrap.sh").is_file() {
            return Err(VmError::invalid_params(
                "payload must be a Psyche release or checkout (apps/node/scripts/guest-bootstrap.sh missing)",
                "payload",
            ));
        }
        self.cfg.roots.check(&root)?;
        let _claim = self.claim(name)?;
        self.inner.lock().unwrap().payloads.insert(name.to_owned(), PathBuf::from(&root));
        let _ = self.backend.remove_share(name, shares::SHARE_PAYLOAD);
        self.backend.add_share(name, &Plan9Share { name: shares::SHARE_PAYLOAD.into(), path: root.clone(), read_only: true })?;
        let grants: Vec<ShareGrant> = fsx::read_json(&b.shares()).unwrap_or_default();
        let _ = fsx::write_json(&b.guest_meta().join("shares.json"), &self.share_list(&grants, name));
        emit(json!({"type": "vm.psyche_install", "phase": "started"}));
        let a = self.agent(name)?;
        let list = self.share_list(&grants, name);
        a.call(agent::MOUNT_SHARES, json!({"shares": list}), Duration::from_secs(30))?;
        emit(json!({"type": "vm.psyche_install", "phase": "progress", "fraction": 0.3}));
        a.call(
            agent::INSTALL_PSYCHE,
            json!({"payload": shares::guest_path(shares::SHARE_PAYLOAD), "vsock": format!("2:{GATEWAY_NODE_PORT}")}),
            Duration::from_secs(900),
        )
        .map_err(|e| if e.reason == "guest_error" { VmError::unavailable("guest_bootstrap_failed", e.message) } else { e })?;
        if let Some(mut st) = state {
            st.psyche_installed = true;
            self.set_state(&b, st)?;
        }
        emit(json!({"type": "vm.psyche_install", "phase": "finished"}));
        Ok(self.describe(&b, &c))
    }

    /// macOS TCC pre-grants have no Linux counterpart.
    pub fn grant_permissions(&self, name: &str) -> VmResult<Value> {
        self.load(name)?;
        Err(VmError::unsupported(
            "grant_permissions",
            "The Linux guest has no Accessibility or Screen Recording permissions (macOS TCC) to pre-grant",
        ))
    }

    // MARK: snapshots (L6)

    /// Nothing booted: a booted phase without a running guest is stale and counts as stopped.
    fn require_resting(&self, b: &Bundle, name: &str) -> VmResult<()> {
        let phase = self.state_of(b).map(|s| s.phase).unwrap_or(Phase::Created);
        let resting = matches!(phase, Phase::Stopped | Phase::Saved | Phase::Installed | Phase::Failed) || phase.is_active();
        if self.backend.is_running(name) || !resting {
            return Err(VmError::conflict(
                "vm_running",
                format!("{name} must be installed and stopped (or saved) for snapshots and resets"),
            ));
        }
        Ok(())
    }

    pub fn snapshot(&self, p: SnapshotParams, emit: Emit) -> VmResult<Value> {
        let name = p.name.clone().unwrap_or_else(|| "sandbox".into());
        let (b, c) = self.load(&name)?;
        self.require_resting(&b, &name)?;
        let _claim = self.claim(&name)?;
        crate::security::check_plain_path(&self.cfg.home, &b.root)?;
        emit(json!({"type": "vm.snapshot", "phase": "started"}));
        let store = SnapshotStore { disks: self.disks.as_ref() };
        let record =
            store.create(&b, &c, p.kind.as_deref().unwrap_or("manual"), p.label.as_deref(), p.task_id.as_deref(), model::now_secs())?;
        emit(json!({"type": "vm.snapshot", "phase": "finished"}));
        crate::log::info(&format!("vm snapshot name={name} kind={}", record.kind));
        self.publish(&b);
        Ok(json!({"snapshot": record, "guest": self.describe(&b, &c)}))
    }

    pub fn restore(&self, name: &str, snapshot: &str, emit: Emit) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        self.require_resting(&b, name)?;
        let _claim = self.claim(name)?;
        crate::security::check_plain_path(&self.cfg.home, &b.root)?;
        let started = std::time::Instant::now();
        emit(json!({"type": "vm.reset", "phase": "started"}));
        let store = SnapshotStore { disks: self.disks.as_ref() };
        let (record, _) = store.restore(&b, snapshot, &model::now_iso())?;
        self.drop_agent(name);
        let ms = started.elapsed().as_millis() as u64;
        emit(json!({"type": "vm.reset", "phase": "finished"}));
        crate::log::info(&format!("vm restored name={name} kind={} ms={ms}", record.kind));
        self.publish(&b);
        Ok(json!({"guest": self.describe(&b, &c), "snapshot": record.id, "durationMs": ms}))
    }

    /// "Fresh PC": back to the base snapshot.
    pub fn reset(&self, name: &str, emit: Emit) -> VmResult<Value> {
        let (b, _) = self.load(name)?;
        let base = snapshots::load(&b).into_iter().find(|s| s.kind == "base").ok_or_else(|| {
            VmError::not_found("no_base_snapshot", format!("{name} has no base snapshot; take one with kind \"base\" first"))
        })?;
        self.restore(name, &base.id, emit)
    }

    pub fn snapshot_delete(&self, name: &str, snapshot: &str) -> VmResult<Value> {
        let (b, c) = self.load(name)?;
        let _claim = self.claim(name)?;
        let store = SnapshotStore { disks: self.disks.as_ref() };
        store.delete(&b, snapshot)?;
        self.publish(&b);
        Ok(self.describe(&b, &c))
    }

    // MARK: images (L7)

    /// The newest installed guest image (the mac helper's latest restore image).
    pub fn restore_image(&self) -> VmResult<Value> {
        let list = image::list(&self.cfg.images_root);
        let i = list.iter().find(|i| i["valid"] == true).ok_or_else(|| {
            VmError::not_found("image_not_found", format!("No guest image is installed in {}", self.cfg.images_root.display()))
        })?;
        Ok(json!({
            "version": i["version"], "build": i["id"], "sizeBytes": i["sizeBytes"],
            "guestOS": i["guestOS"], "createdAt": i["createdAt"], "manifestSha256": i["manifestSha256"],
        }))
    }

    /// `outDir/<id>/`: `vmlinuz`, `initrd` (from the guest's image), `rootfs.vhdx` (the guest's
    /// system disk chain, flattened) and `manifest.json` with every file's SHA-256. Never the
    /// session disk (it holds the guest node's identity), shares, transfers or saved state.
    pub fn export_image(&self, p: ExportImageParams, emit: Emit) -> VmResult<Value> {
        let name = p.name.clone().unwrap_or_else(|| "sandbox".into());
        let (b, c) = self.load(&name)?;
        self.require_resting(&b, &name)?;
        let state = self.state_of(&b);
        if !state.as_ref().map(|s| s.provisioned).unwrap_or(false) {
            return Err(VmError::conflict("vm_not_provisioned", "Only a provisioned guest can become an image (start it once first)"));
        }
        let out = shares::canonical_host_path(&p.out_dir).map_err(|_| VmError::invalid_params("outDir must be absolute", "outDir"))?;
        if !Path::new(&out).is_dir() {
            return Err(VmError::not_found("out_dir_not_found", format!("No folder at {}", p.out_dir)));
        }
        let guest_os = c.guest_os.clone().unwrap_or_else(|| "linux".into());
        let id = p.id.clone().unwrap_or_else(|| format!("{guest_os}-{}", model::compact_stamp(model::now_secs(), false)).to_lowercase());
        if !image::is_valid_id(&id) {
            return Err(VmError::invalid_params("id must match ^[a-z0-9][a-z0-9.-]{0,63}$", "id"));
        }
        let dest = Path::new(&out).join(&id);
        if dest.exists() {
            return Err(VmError::conflict("image_exists", format!("{} already exists", dest.display())));
        }
        let version = c.image.as_deref().ok_or_else(|| VmError::conflict("vm_not_installed", "The guest has no image"))?;
        let src = image::verify(&image::locate(&self.cfg.images_root, Some(version))?, c.image_sha256.as_deref(), &self.verified, |_| {})?;
        let _claim = self.claim(&name)?;
        emit(json!({"type": "vm.export", "phase": "started"}));
        let made = (|| -> VmResult<(Value, String)> {
            std::fs::create_dir(&dest).map_err(|e| VmError::io("outDir", &e))?;
            std::fs::copy(src.kernel(), dest.join(image::KERNEL)).map_err(|e| VmError::io("vmlinuz", &e))?;
            std::fs::copy(src.initrd(), dest.join(image::INITRD)).map_err(|e| VmError::io("initrd", &e))?;
            self.disks.flatten_copy(&b.system_disk(), &dest.join(image::ROOTFS))?;
            emit(json!({"type": "vm.export", "phase": "progress", "fraction": 0.6}));
            let mut files = Vec::new();
            for f in image::EXPECTED_FILES {
                let path = dest.join(f);
                let sha = image::sha256_file(&path, |_| {}).map_err(|e| VmError::io(f, &e))?;
                files.push(json!({"name": f, "bytes": fsx::size(&path), "sha256": sha}));
            }
            let mut m = json!({
                "format": image::FORMAT, "formatVersion": image::FORMAT_VERSION, "id": id, "guestOS": guest_os,
                "createdAt": model::now_iso(), "psycheVersion": self.cfg.version, "psycheInstalled": state.as_ref().map(|s| s.psyche_installed).unwrap_or(false),
                "files": files,
            });
            if let Some(cmd) = &src.manifest.kernel_cmdline {
                m["kernelCmdline"] = Value::String(cmd.clone());
            }
            let bytes = serde_json::to_vec_pretty(&m).map_err(|e| VmError::internal(e.to_string()))?;
            std::fs::write(dest.join("manifest.json"), &bytes).map_err(|e| VmError::io("manifest.json", &e))?;
            Ok((m, image::sha256_hex(&bytes)))
        })();
        let (manifest, sha) = match made {
            Ok(v) => v,
            Err(e) => {
                let _ = fsx::remove(&dest);
                return Err(e);
            }
        };
        emit(json!({"type": "vm.export", "phase": "finished"}));
        crate::log::info(&format!("vm image exported name={name} id={id}"));
        Ok(json!({"path": dest.to_string_lossy(), "manifest": manifest, "manifestSha256": sha}))
    }

    /// `service_info`: `{version, hcs: {available, reason?, …}, images: [...]}`.
    pub fn service_info(&self) -> Value {
        let mut hcs = self.backend.info();
        match self.backend.unavailable_reason() {
            None => hcs["available"] = Value::Bool(true),
            Some(e) => {
                hcs["available"] = Value::Bool(false);
                hcs["reason"] = Value::String(e.reason.clone());
                hcs["message"] = Value::String(e.message.clone());
            }
        }
        json!({
            "version": self.cfg.version,
            "hcs": hcs,
            "images": image::list(&self.cfg.images_root),
            "imagesRoot": self.cfg.images_root.to_string_lossy(),
            "ownerSid": self.cfg.owner_sid,
            "vsock": {"gatewayNodePort": GATEWAY_NODE_PORT, "guestAgentPort": GUEST_AGENT_PORT, "plan9Port": shares::PLAN9_PORT},
            "active": self.backend.active_count(),
        })
    }

    /// Whether any guest runs (idle self-stop waits for none).
    pub fn any_running(&self) -> bool {
        self.backend.active_count() > 0
    }

    /// Stops every running guest (service shutdown): graceful first, then hard.
    pub fn stop_all(&self) {
        for b in paths::all_bundles(&self.cfg.home) {
            if self.backend.is_running(&b.name) {
                let _ = self.backend.stop(&b.name, true, 20);
            }
        }
    }
}
