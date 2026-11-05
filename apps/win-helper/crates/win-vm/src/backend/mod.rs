//! The hypervisor behind a seam (mac `VMBackend`), so lifecycle, shares, snapshots, the agent
//! channel and relaying are tested with `FakeBackend`; `crate::hcs::HcsBackend` is the real one.

pub mod fake;

use std::path::PathBuf;
use std::sync::Arc;

use crate::conn::Conn;
use crate::error::VmResult;
use crate::hcs::doc::Plan9Share;

/// Everything one boot needs (computed by the manager; never read from owner-writable files
/// without re-validation).
#[derive(Debug, Clone, PartialEq)]
pub struct BootSpec {
    pub name: String,
    /// HCS compute system id.
    pub system_id: String,
    pub kernel: PathBuf,
    pub initrd: PathBuf,
    pub cmdline: String,
    /// `system.vhdx`, `sessiondata.vhdx` (SCSI 0:0, 0:1).
    pub disks: Vec<PathBuf>,
    /// Files the VM worker must be able to open read-only (kernel, initrd, parent layers).
    pub readonly_files: Vec<PathBuf>,
    pub shares: Vec<Plan9Share>,
    pub cpus: u32,
    pub memory_mb: u64,
    /// Attach the opt-in NAT adapter with this MAC.
    pub nat_mac: Option<String>,
    /// Warm start from a saved state.
    pub restore_from: Option<PathBuf>,
    /// Where the serial console is written.
    pub console_log: Option<PathBuf>,
}

/// What the backend reports while a guest runs.
pub enum BackendEvent {
    /// A guest connection to the Gateway vsock port; the manager relays it.
    GuestConnection(Box<dyn Conn>),
    /// The compute system exited (`None` = clean power-off).
    Exited(Option<String>),
}

pub type EventSink = Arc<dyn Fn(&str, BackendEvent) + Send + Sync>;

/// A running guest's facts for `status`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunInfo {
    pub runtime_id: Option<String>,
    /// NAT address handed to the guest (from the HNS endpoint), when NAT is on.
    pub ip_address: Option<String>,
    pub network: Option<serde_json::Value>,
}

pub trait VmBackend: Send + Sync {
    /// `None` when guests can run here; otherwise the reason every lifecycle call answers.
    fn unavailable_reason(&self) -> Option<crate::error::VmError>;
    /// `service_info.hcs` details (schema versions, build).
    fn info(&self) -> serde_json::Value;
    /// Creates and boots the compute system. `prepared` runs once the network (if any) is known
    /// and before the guest boots (the manager writes `network.json` for the guest). Guest
    /// connections and the exit arrive on `events`.
    fn start(&self, spec: &BootSpec, events: EventSink, prepared: &dyn Fn(&RunInfo)) -> VmResult<RunInfo>;
    /// Graceful shutdown (integration service), waiting up to `timeout_secs`; then a hard stop
    /// when `force`. Returns whether it stopped gracefully; errors `guest_did_not_stop` when it
    /// did not and `force` is false.
    fn stop(&self, name: &str, force: bool, timeout_secs: u64) -> VmResult<bool>;
    fn pause(&self, name: &str) -> VmResult<()>;
    fn resume(&self, name: &str) -> VmResult<()>;
    /// Pauses, saves the machine state to `path` and stops (resumes on failure).
    fn save_state(&self, name: &str, path: &std::path::Path) -> VmResult<()>;
    fn add_share(&self, name: &str, share: &Plan9Share) -> VmResult<()>;
    fn remove_share(&self, name: &str, share: &str) -> VmResult<()>;
    /// Connects to the guest agent's vsock port.
    fn connect_agent(&self, name: &str) -> VmResult<Box<dyn Conn>>;
    fn is_running(&self, name: &str) -> bool;
    fn is_paused(&self, name: &str) -> bool;
    fn run_info(&self, name: &str) -> Option<RunInfo>;
    fn active_count(&self) -> u32;
}
