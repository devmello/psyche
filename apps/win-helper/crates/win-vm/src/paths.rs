//! Names and locations (contract "Service", "Control pipe", "Storage", "Guest ⇄ host").
//!
//! - Service `PsycheVM-<owner SID>`, control pipe `\\.\pipe\psyche-vm-<owner SID>`.
//! - VMs: `$PSYCHE_HOME\vm\<name>\` (the mac bundle root): `config.json`, `state.json`,
//!   `shares.json`, `transfers.json`, `system.vhdx` (differencing child of the image's
//!   `rootfs.vhdx`), `sessiondata.vhdx`, `SavedState.vmrs`, `snapshots\<id>\`, `transfer\{in,out}\`,
//!   `guest\` (the read-only `psyche-meta` share), `console.log`.
//! - Images: `<images root>\<imageVersion>\{vmlinuz, initrd, rootfs.vhdx, manifest.json}`, the
//!   root being `%LOCALAPPDATA%\Psyche\vm-images` of the owner.
//! - Gateway guest pipe: `$PSYCHE_HOME\run\guest-socket`, else
//!   `\\.\pipe\psyche-guest-<first 16 hex of sha256(utf8(path.resolve(PSYCHE_HOME)))>`.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `S-1-5-21-…` (and well-known `S-1-5-18`), the only SID form the service accepts.
pub fn is_valid_sid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() >= 3
        && parts.len() <= 16
        && parts[0] == "S"
        && parts[1] == "1"
        && parts[2..].iter().all(|p| !p.is_empty() && p.len() <= 10 && p.bytes().all(|c| c.is_ascii_digit()))
}

pub fn service_name(owner_sid: &str) -> String {
    format!("PsycheVM-{owner_sid}")
}

pub const SERVICE_DISPLAY_NAME: &str = "Psyche sandbox PC";

pub fn control_pipe_name(owner_sid: &str) -> String {
    format!(r"\\.\pipe\psyche-vm-{owner_sid}")
}

/// `std::path::absolute` without a trailing separator (`path.resolve` in Node).
pub fn absolute(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let s = abs.to_string_lossy().into_owned();
    let trimmed = s.trim_end_matches(['\\', '/']);
    if trimmed.len() < s.len() && !trimmed.ends_with(':') && !trimmed.is_empty() { PathBuf::from(trimmed) } else { abs }
}

/// First 16 hex characters of SHA-256 over the absolute home path.
pub fn home_hash(home: &Path) -> String {
    sha256_hex(absolute(home).to_string_lossy().as_bytes())[..16].to_owned()
}

pub fn computed_guest_pipe(home: &Path) -> String {
    format!(r"\\.\pipe\psyche-guest-{}", home_hash(home))
}

pub fn guest_socket_pointer(home: &Path) -> PathBuf {
    home.join("run").join("guest-socket")
}

/// Whether `s` names a local named pipe.
pub fn is_pipe_path(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    (l.starts_with(r"\\.\pipe\") || l.starts_with(r"\\?\pipe\"))
        && l.len() > r"\\.\pipe\".len()
        && !s[r"\\.\pipe\".len()..].contains(['/', '\\'])
}

/// The Gateway guest pipe: the pointer file's content when it names a `psyche-guest-` pipe,
/// otherwise the computed name. `pointer` is the pointer file's text (read by the caller as the
/// owner).
pub fn guest_pipe(home: &Path, pointer: Option<&str>) -> String {
    if let Some(text) = pointer {
        let line = text.trim();
        let name = line.get(r"\\.\pipe\".len()..).unwrap_or("");
        if is_pipe_path(line) && name.starts_with("psyche-guest-") {
            return line.to_owned();
        }
    }
    computed_guest_pipe(home)
}

pub fn vm_root(home: &Path) -> PathBuf {
    home.join("vm")
}

/// One guest's directory and files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub name: String,
    pub root: PathBuf,
}

impl Bundle {
    pub fn new(home: &Path, name: &str) -> Bundle {
        Bundle { name: name.to_owned(), root: vm_root(home).join(name) }
    }
    pub fn config(&self) -> PathBuf {
        self.root.join("config.json")
    }
    pub fn state(&self) -> PathBuf {
        self.root.join("state.json")
    }
    pub fn shares(&self) -> PathBuf {
        self.root.join("shares.json")
    }
    pub fn transfers(&self) -> PathBuf {
        self.root.join("transfers.json")
    }
    /// The guest's root file system layer (differencing child of the image's `rootfs.vhdx`).
    pub fn system_disk(&self) -> PathBuf {
        self.root.join("system.vhdx")
    }
    /// The writable session disk (`/dev/sdb`: home, node identity, workspace).
    pub fn session_disk(&self) -> PathBuf {
        self.root.join("sessiondata.vhdx")
    }
    /// HCS saved state (`HcsSaveComputeSystem` `ToFile`).
    pub fn saved_state(&self) -> PathBuf {
        self.root.join("SavedState.vmrs")
    }
    pub fn snapshots(&self) -> PathBuf {
        self.root.join("snapshots")
    }
    pub fn snapshot(&self, id: &str) -> PathBuf {
        self.snapshots().join(id)
    }
    pub fn transfer_in(&self) -> PathBuf {
        self.root.join("transfer").join("in")
    }
    pub fn transfer_out(&self) -> PathBuf {
        self.root.join("transfer").join("out")
    }
    /// The read-only `psyche-meta` share: `shares.json`, `network.json`, `vm.json`.
    pub fn guest_meta(&self) -> PathBuf {
        self.root.join("guest")
    }
    pub fn console_log(&self) -> PathBuf {
        self.root.join("console.log")
    }
    pub fn exists(&self) -> bool {
        self.config().is_file()
    }
}

/// Valid guest names under the VM root that have a `config.json`, sorted.
pub fn all_bundles(home: &Path) -> Vec<Bundle> {
    let mut names: Vec<String> = std::fs::read_dir(vm_root(home))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.into_iter().filter(|n| crate::model::VmConfig::is_valid_name(n)).map(|n| Bundle::new(home, &n)).filter(Bundle::exists).collect()
}

/// The HCS compute system id for a guest: unique per owner and name.
pub fn compute_system_id(owner_sid: &str, name: &str) -> String {
    format!("psyche-{}-{name}", &sha256_hex(owner_sid.as_bytes())[..12])
}

/// The HCS `Owner` string of every compute system this service creates.
pub fn compute_system_owner(owner_sid: &str) -> String {
    format!("psyche-vm-{}", &sha256_hex(owner_sid.as_bytes())[..12])
}

/// Where the service logs (a SYSTEM-owned folder; the owner may read it).
pub fn log_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("Psyche").join("vm-service")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sids() {
        assert!(is_valid_sid("S-1-5-21-1825757875-3616296202-2718152036-1001"));
        assert!(is_valid_sid("S-1-5-18"));
        assert!(!is_valid_sid("S-1-5-21-x"));
        assert!(!is_valid_sid("S-1"));
        assert!(!is_valid_sid("S-1-5-21-1\\..\\x"));
        assert!(!is_valid_sid(r"S-1-5-21-123 & calc"));
    }

    #[test]
    fn names_follow_the_contract() {
        let sid = "S-1-5-21-1-2-3-1001";
        assert_eq!(service_name(sid), "PsycheVM-S-1-5-21-1-2-3-1001");
        assert_eq!(control_pipe_name(sid), r"\\.\pipe\psyche-vm-S-1-5-21-1-2-3-1001");
        let id = compute_system_id(sid, "sandbox");
        assert!(id.starts_with("psyche-") && id.ends_with("-sandbox"));
        assert_ne!(compute_system_id("S-1-5-21-9", "sandbox"), id);
    }

    #[test]
    fn guest_pipe_matches_the_gateway_hash() {
        let home = PathBuf::from(r"C:\Users\someone\.psyche");
        // createHash("sha256").update("C:\\Users\\someone\\.psyche").digest("hex").slice(0, 16)
        let want = format!(r"\\.\pipe\psyche-guest-{}", &sha256_hex(br"C:\Users\someone\.psyche")[..16]);
        assert_eq!(guest_pipe(&home, None), want);
        assert_eq!(guest_pipe(&PathBuf::from(r"C:\Users\someone\.psyche\"), None), want);
        assert_eq!(guest_pipe(&home, Some("\\\\.\\pipe\\psyche-guest-abc\r\n")), r"\\.\pipe\psyche-guest-abc");
        // Only a psyche-guest pipe is followed: never the node pipe or another path.
        assert_eq!(guest_pipe(&home, Some(r"\\.\pipe\psyche-node-abc")), want);
        assert_eq!(guest_pipe(&home, Some(r"C:\x")), want);
        assert_eq!(guest_pipe(&home, Some(r"\\.\pipe\psyche-guest-a\..\x")), want);
    }

    #[test]
    fn bundle_layout() {
        let b = Bundle::new(Path::new(r"C:\h"), "sandbox");
        assert_eq!(b.config(), PathBuf::from(r"C:\h\vm\sandbox\config.json"));
        assert_eq!(b.snapshot("base-1"), PathBuf::from(r"C:\h\vm\sandbox\snapshots\base-1"));
        assert_eq!(b.transfer_out(), PathBuf::from(r"C:\h\vm\sandbox\transfer\out"));
    }
}
