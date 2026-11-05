//! The pure model (port of `PsycheHelperCore/VM/VMModel.swift`): configuration, lifecycle,
//! state record, guest cap, transfer records. HCS lives behind `backend::VmBackend`.
//!
//! Windows differences: the guest is Linux (no installer step: a guest is `installed` as soon as
//! its disks exist), resources have lower floors, `diskFormat` is always `vhdx`, the MAC is a
//! Hyper-V one, and `network` (`none` | `nat`) is a setting (the mac guest always has NAT).

use serde::{Deserialize, Serialize};

use crate::error::{Code, VmError, VmResult};

/// Host resources the defaults and limits are checked against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostResources {
    pub cpu_count: u32,
    pub memory_gb: u32,
    pub free_disk_gb: u64,
}

fn default_display_width() -> u32 {
    1920
}
fn default_display_height() -> u32 {
    1200
}
fn default_disk_format() -> String {
    "vhdx".into()
}
fn default_username() -> String {
    "psyche".into()
}
fn default_clipboard() -> String {
    "paste-only".into()
}
fn default_vault() -> String {
    "host".into()
}
fn default_network() -> String {
    "none".into()
}

/// One guest's settings (`config.json`). Defaults: 4 vCPU / 4 GB / 64 GB session disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmConfig {
    pub name: String,
    pub cpus: u32,
    #[serde(rename = "memoryGB")]
    pub memory_gb: u32,
    #[serde(rename = "diskGB")]
    pub disk_gb: u32,
    #[serde(default = "default_display_width")]
    pub display_width: u32,
    #[serde(default = "default_display_height")]
    pub display_height: u32,
    /// Hyper-V range (`00:15:5d:…`), fixed per guest; used only for the opt-in NAT adapter.
    pub mac_address: String,
    #[serde(default = "default_disk_format")]
    pub disk_format: String,
    #[serde(default = "default_username")]
    pub username: String,
    /// Guest OS of the image, e.g. "linux".
    #[serde(default, rename = "guestOS")]
    pub guest_os: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default = "default_clipboard")]
    pub clipboard: String,
    #[serde(default = "default_vault")]
    pub vault: String,
    /// `none` (default) or `nat` (owner opt-in; never bridged to the LAN).
    #[serde(default = "default_network")]
    pub network: String,
    /// The image version (`vm-images\<imageVersion>`) the guest boots.
    #[serde(default)]
    pub image: Option<String>,
    /// SHA-256 of that image's `manifest.json` when the guest was created: a swapped image is
    /// refused at boot.
    #[serde(default, rename = "imageSha256")]
    pub image_sha256: Option<String>,
}

pub const DEFAULT_CPUS: u32 = 4;
pub const DEFAULT_MEMORY_GB: u32 = 4;
pub const DEFAULT_DISK_GB: u32 = 64;
pub const MIN_CPUS: u32 = 1;
pub const MIN_MEMORY_GB: u32 = 2;
pub const MIN_DISK_GB: u32 = 8;
pub const MAX_CPUS: u32 = 32;
pub const MAX_MEMORY_GB: u32 = 256;
pub const MAX_DISK_GB: u32 = 2048;
/// Free space a new guest needs (the session disk is dynamic; the system layer starts empty).
pub const MIN_FREE_DISK_GB: u64 = 8;

pub const CLIPBOARD_MODES: [&str; 3] = ["off", "paste-only", "bidirectional"];
pub const VAULT_PLACEMENTS: [&str; 2] = ["host", "guest"];
pub const NETWORK_MODES: [&str; 2] = ["none", "nat"];

impl VmConfig {
    pub fn new(name: &str, now: &str) -> VmConfig {
        VmConfig {
            name: name.to_owned(),
            cpus: DEFAULT_CPUS,
            memory_gb: DEFAULT_MEMORY_GB,
            disk_gb: DEFAULT_DISK_GB,
            display_width: default_display_width(),
            display_height: default_display_height(),
            mac_address: random_mac(),
            disk_format: default_disk_format(),
            username: default_username(),
            guest_os: None,
            created_at: now.to_owned(),
            clipboard: default_clipboard(),
            vault: default_vault(),
            network: default_network(),
            image: None,
            image_sha256: None,
        }
    }

    /// `^[a-z0-9][a-z0-9-]{0,31}$`
    pub fn is_valid_name(s: &str) -> bool {
        let b = s.as_bytes();
        !b.is_empty()
            && b.len() <= 32
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    }

    /// The guest leaves the host at least 2 CPUs and 4 GB (when it has them), and the session
    /// disk fits the limits.
    pub fn validate(&self, host: &HostResources) -> VmResult<()> {
        if !Self::is_valid_name(&self.name) {
            return Err(VmError::invalid_params("name must match ^[a-z0-9][a-z0-9-]{0,31}$", "name"));
        }
        let max_cpus = MIN_CPUS.max(host.cpu_count.saturating_sub(2)).min(MAX_CPUS);
        if self.cpus < MIN_CPUS || self.cpus > max_cpus {
            return Err(VmError::invalid_params(format!("cpus must be {MIN_CPUS}–{max_cpus} on this PC"), "cpus"));
        }
        let max_mem = MIN_MEMORY_GB.max(host.memory_gb.saturating_sub(4)).min(MAX_MEMORY_GB);
        if self.memory_gb < MIN_MEMORY_GB || self.memory_gb > max_mem {
            return Err(VmError::invalid_params(format!("memoryGB must be {MIN_MEMORY_GB}–{max_mem} on this PC"), "memoryGB"));
        }
        if self.disk_gb < MIN_DISK_GB || self.disk_gb > MAX_DISK_GB {
            return Err(VmError::invalid_params(format!("diskGB must be {MIN_DISK_GB}–{MAX_DISK_GB}"), "diskGB"));
        }
        if !(640..=3840).contains(&self.display_width) || !(480..=2400).contains(&self.display_height) {
            return Err(VmError::invalid_params("display must be 640×480 to 3840×2400", "display"));
        }
        if !CLIPBOARD_MODES.contains(&self.clipboard.as_str()) {
            return Err(VmError::invalid_params("clipboard is off, paste-only or bidirectional", "clipboard"));
        }
        if !VAULT_PLACEMENTS.contains(&self.vault.as_str()) {
            return Err(VmError::invalid_params("vault is host or guest", "vault"));
        }
        if !NETWORK_MODES.contains(&self.network.as_str()) {
            return Err(VmError::invalid_params("network is none or nat", "network"));
        }
        let u = self.username.as_bytes();
        if u.is_empty() || u.len() > 32 || !u.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return Err(VmError::invalid_params("username must be lowercase letters and digits", "username"));
        }
        Ok(())
    }

    /// Free space check for a new guest (mac: `disk_full`).
    pub fn check_free_space(host: &HostResources) -> VmResult<()> {
        if host.free_disk_gb < MIN_FREE_DISK_GB {
            return Err(VmError::unavailable("disk_full", format!("At least {MIN_FREE_DISK_GB} GB free disk space is needed for a guest"))
                .detail("freeDiskGB", host.free_disk_gb));
        }
        Ok(())
    }
}

/// A locally administered unicast MAC in Hyper-V's dynamic range (`00:15:5d:xx:xx:xx`).
pub fn random_mac() -> String {
    let b = random_bytes::<3>();
    format!("00:15:5d:{:02x}:{:02x}:{:02x}", b[0], b[1], b[2])
}

/// OS randomness (`BCryptGenRandom` through `RtlGenRandom`-backed std hashing is not enough here).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    crate::win::random_fill(&mut out);
    out
}

/// Lifecycle (`VMPhase`, `packages/protocol` `VmPhase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Created,
    Installing,
    Installed,
    Provisioning,
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
    Paused,
    Saved,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Created => "created",
            Phase::Installing => "installing",
            Phase::Installed => "installed",
            Phase::Provisioning => "provisioning",
            Phase::Stopped => "stopped",
            Phase::Starting => "starting",
            Phase::Running => "running",
            Phase::Stopping => "stopping",
            Phase::Failed => "failed",
            Phase::Paused => "paused",
            Phase::Saved => "saved",
        }
    }

    /// Phases with a live compute system (or one being created).
    pub fn is_active(self) -> bool {
        matches!(self, Phase::Installing | Phase::Provisioning | Phase::Starting | Phase::Running | Phase::Stopping | Phase::Paused)
    }

    /// The mac helper's transition table.
    pub fn can_move(self, next: Phase) -> bool {
        use Phase::*;
        let allowed: &[Phase] = match self {
            Created => &[Installing, Failed, Installed],
            Installing => &[Installed, Failed, Created],
            Installed => &[Provisioning, Starting, Failed],
            Provisioning => &[Running, Stopped, Failed],
            Stopped => &[Starting, Failed],
            Starting => &[Running, Stopped, Failed],
            Running => &[Stopping, Stopped, Failed, Paused],
            Paused => &[Running, Saved, Stopping, Stopped, Failed],
            Saved => &[Starting, Stopped, Failed],
            Stopping => &[Stopped, Failed, Running],
            Failed => &[Created, Installed, Stopped, Starting, Installing, Provisioning],
        };
        allowed.contains(&next)
    }
}

/// `state.json`: where a guest stands across service restarts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VmState {
    pub phase: Phase,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Whether the first boot (session disk formatted, node identity created) completed.
    #[serde(default)]
    pub provisioned: bool,
    #[serde(default)]
    pub psyche_installed: bool,
    #[serde(default)]
    pub permissions_granted: bool,
    #[serde(default)]
    pub password_rotation_pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub id: String,
    #[serde(rename = "guestOS")]
    pub guest_os: String,
    pub created_at: String,
}

impl VmState {
    pub fn new(phase: Phase, now: &str) -> VmState {
        VmState {
            phase,
            updated_at: now.to_owned(),
            last_error: None,
            provisioned: false,
            psyche_installed: false,
            permissions_granted: false,
            password_rotation_pending: false,
            image: None,
        }
    }

    /// `setState` merge: flags survive phase changes unless the caller set them.
    pub fn merged_over(mut self, old: &VmState) -> VmState {
        self.psyche_installed |= old.psyche_installed;
        self.permissions_granted |= old.permissions_granted;
        self.provisioned |= old.provisioned;
        self.password_rotation_pending |= old.password_rotation_pending;
        if self.image.is_none() {
            self.image = old.image.clone();
        }
        self
    }
}

/// One guest per user (ADR-009). HCS has no framework cap like macOS's two guests.
pub const MAX_ACTIVE: u32 = 1;

pub fn check_create(existing: &[String]) -> VmResult<()> {
    if let Some(other) = existing.first() {
        return Err(VmError::conflict("guest_exists", format!("Psyche keeps one sandbox PC per user; {other} already exists"))
            .detail("name", other.as_str()));
    }
    Ok(())
}

/// One copy in or out of the guest (`VMTransferRecord`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRecord {
    pub id: String,
    pub direction: String,
    pub host_path: String,
    pub guest_path: String,
    pub bytes: u64,
    pub created_at: String,
}

/// 12 lowercase hex characters (the mac helper's 12-character UUID prefix).
pub fn transfer_id() -> String {
    random_bytes::<6>().iter().map(|b| format!("{b:02x}")).collect()
}

/// 24 characters from an unambiguous alphabet (the mac helper's `randomPassword`).
pub fn random_password() -> String {
    const A: &[u8] = b"abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    random_bytes::<24>().iter().map(|b| A[*b as usize % A.len()] as char).collect()
}

/// `2026-11-05T12:34:56Z` (the mac helper's `AppleDates` / ISO-8601 without fractions).
pub fn iso8601(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// `20261105-123456` for snapshot ids, `20261105` for image ids.
pub fn compact_stamp(unix_secs: u64, with_time: bool) -> String {
    let (y, m, d) = civil_from_days((unix_secs / 86_400) as i64);
    let rem = unix_secs % 86_400;
    if with_time {
        format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
    } else {
        format!("{y:04}{m:02}{d:02}")
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn now_iso() -> String {
    iso8601(now_secs())
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `vm_busy` (another operation holds the guest).
pub fn busy(name: &str) -> VmError {
    VmError::new(Code::Conflict, "vm_busy", format!("{name} is busy with another operation")).retryable()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostResources {
        HostResources { cpu_count: 16, memory_gb: 32, free_disk_gb: 500 }
    }

    #[test]
    fn names() {
        assert!(VmConfig::is_valid_name("sandbox"));
        assert!(VmConfig::is_valid_name("0-a"));
        assert!(!VmConfig::is_valid_name("-a"));
        assert!(!VmConfig::is_valid_name("Sandbox"));
        assert!(!VmConfig::is_valid_name(""));
        assert!(!VmConfig::is_valid_name(&"a".repeat(33)));
        assert!(!VmConfig::is_valid_name("a_b"));
    }

    #[test]
    fn validation_leaves_the_host_room() {
        let mut c = VmConfig::new("sandbox", "now");
        c.validate(&host()).unwrap();
        c.cpus = 15;
        assert_eq!(c.validate(&host()).unwrap_err().details["field"], "cpus");
        c.cpus = 14;
        c.memory_gb = 29;
        assert_eq!(c.validate(&host()).unwrap_err().details["field"], "memoryGB");
        c.memory_gb = 28;
        c.validate(&host()).unwrap();
        c.network = "bridge".into();
        assert_eq!(c.validate(&host()).unwrap_err().details["field"], "network");
        c.network = "nat".into();
        c.clipboard = "all".into();
        assert_eq!(c.validate(&host()).unwrap_err().details["field"], "clipboard");
        // A tiny host still allows the floor.
        let small = HostResources { cpu_count: 2, memory_gb: 4, free_disk_gb: 10 };
        let mut c = VmConfig::new("a", "now");
        c.cpus = 1;
        c.memory_gb = 2;
        c.validate(&small).unwrap();
        let full = HostResources { free_disk_gb: 3, ..small };
        assert_eq!(VmConfig::check_free_space(&full).unwrap_err().reason, "disk_full");
    }

    #[test]
    fn config_json_keys_match_the_mac_bundle() {
        let c = VmConfig::new("sandbox", "2026-01-01T00:00:00Z");
        let v = serde_json::to_value(&c).unwrap();
        for k in [
            "name",
            "cpus",
            "memoryGB",
            "diskGB",
            "displayWidth",
            "macAddress",
            "diskFormat",
            "guestOS",
            "createdAt",
            "clipboard",
            "vault",
            "network",
        ] {
            assert!(v.get(k).is_some(), "{k}");
        }
        // Older files without optional keys still load.
        let old: VmConfig =
            serde_json::from_str(r#"{"name":"a","cpus":2,"memoryGB":4,"diskGB":40,"macAddress":"00:15:5d:00:00:01"}"#).unwrap();
        assert_eq!(old.network, "none");
        assert_eq!(old.clipboard, "paste-only");
    }

    #[test]
    fn transitions_follow_the_mac_table() {
        assert!(Phase::Installed.can_move(Phase::Provisioning));
        assert!(Phase::Running.can_move(Phase::Paused));
        assert!(Phase::Paused.can_move(Phase::Saved));
        assert!(!Phase::Stopped.can_move(Phase::Running));
        assert!(!Phase::Saved.can_move(Phase::Running));
        assert!(Phase::Failed.can_move(Phase::Starting));
        assert!(Phase::Running.is_active() && !Phase::Saved.is_active());
        assert_eq!(serde_json::to_value(Phase::Provisioning).unwrap(), "provisioning");
    }

    #[test]
    fn state_merge_keeps_flags() {
        let mut old = VmState::new(Phase::Running, "t");
        old.psyche_installed = true;
        old.provisioned = true;
        let new = VmState::new(Phase::Stopped, "t2").merged_over(&old);
        assert!(new.psyche_installed && new.provisioned);
        assert_eq!(new.phase, Phase::Stopped);
    }

    #[test]
    fn dates() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_793_836_800), "2026-11-05T00:00:00Z");
        assert_eq!(iso8601(951_825_600), "2000-02-29T12:00:00Z");
        assert_eq!(compact_stamp(1_793_836_800 + 3723, true), "20261105-010203");
        assert_eq!(compact_stamp(1_793_836_800, false), "20261105");
    }

    #[test]
    fn random_values() {
        let m = random_mac();
        assert!(m.starts_with("00:15:5d:") && m.len() == 17);
        assert_eq!(transfer_id().len(), 12);
        let p = random_password();
        assert_eq!(p.len(), 24);
        assert_ne!(p, random_password());
        assert!(check_create(&[]).is_ok());
        assert_eq!(check_create(&["sandbox".into()]).unwrap_err().reason, "guest_exists");
    }
}
