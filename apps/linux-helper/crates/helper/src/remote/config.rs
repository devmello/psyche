//! `remote.json` and the files around it (design §3.6). Everything here is the helper's own
//! state, on this computer, never under `~/.psyche` (that is the Mac's):
//!
//! - `$XDG_CONFIG_HOME/psyche-helper/remote.json` (0600): `gatewayUrl`, `gatewayKey`, an optional
//!   `certPin` (LAN) and the machine name. Read strictly: an unknown field, a wrong shape or an
//!   origin the helper would not dial is an error, never a default.
//! - `$XDG_STATE_HOME/psyche-helper/remote-identity.json` (0600): the device key for this
//!   Gateway.
//! - `$XDG_STATE_HOME/psyche-helper/remote-status.json` (0600): what `status` shows of the
//!   running helper.
//!
//! Directories are created 0700. A file anyone else can read, or a directory anyone else can write
//! to, is refused.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::link::{canonical_gateway_origin, is_base64url_32_bytes, name_ok};
use super::transport::Target;
use crate::identity::REMOTE_IDENTITY_FILE;
use crate::paths::Env;

pub const REMOTE_FILE: &str = "remote.json";
pub const STATUS_FILE: &str = "remote-status.json";

/// `PSYCHE_HELPER_CONFIG` (tests and dev), else `$XDG_CONFIG_HOME/psyche-helper`, else
/// `~/.config/psyche-helper`.
pub fn config_dir(env: &dyn Env) -> PathBuf {
    if let Some(dir) = env.get("PSYCHE_HELPER_CONFIG") {
        return PathBuf::from(dir);
    }
    match env.get("XDG_CONFIG_HOME") {
        Some(base) if PathBuf::from(&base).is_absolute() => {
            PathBuf::from(base).join("psyche-helper")
        }
        _ => PathBuf::from(env.get("HOME").unwrap_or_else(|| "/".to_string()))
            .join(".config/psyche-helper"),
    }
}

#[derive(Debug)]
pub enum ConfigError {
    Io(std::io::Error),
    /// A file others can read, or a directory others can write to.
    Unsafe(String),
    Invalid(String),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigError::Io(e) => write!(f, "i/o: {e}"),
            ConfigError::Unsafe(m) | ConfigError::Invalid(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for ConfigError {}

impl From<std::io::Error> for ConfigError {
    fn from(e: std::io::Error) -> Self {
        ConfigError::Io(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemoteConfig {
    pub version: u32,
    /// `https://host[:port]`, canonical.
    pub gateway_url: String,
    /// base64url raw Ed25519 key of the Gateway identity.
    pub gateway_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_pin: Option<String>,
    pub machine_name: String,
}

impl RemoteConfig {
    pub fn new(
        gateway_url: String,
        gateway_key: String,
        cert_pin: Option<String>,
        machine_name: String,
    ) -> Self {
        Self {
            version: 1,
            gateway_url,
            gateway_key,
            cert_pin,
            machine_name,
        }
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        let bad = |what: &str| Err(ConfigError::Invalid(format!("remote.json: bad {what}")));
        if self.version != 1 {
            return bad("version");
        }
        match canonical_gateway_origin(&self.gateway_url, self.cert_pin.is_some()) {
            Some(origin) if origin.https() == self.gateway_url => {}
            _ => return bad("gatewayUrl"),
        }
        if !is_base64url_32_bytes(&self.gateway_key) {
            return bad("gatewayKey");
        }
        if let Some(pin) = &self.cert_pin {
            if !is_base64url_32_bytes(pin) {
                return bad("certPin");
            }
        }
        if !name_ok(&self.machine_name) {
            return bad("machineName");
        }
        Ok(())
    }

    pub fn target(&self) -> Result<Target, ConfigError> {
        Target::from_origin(&self.gateway_url, self.cert_pin.as_deref())
            .ok_or_else(|| ConfigError::Invalid("remote.json: bad gatewayUrl".into()))
    }
}

/// Creates `dir` (and parents) 0700 when it is missing.
pub fn ensure_private_dir(dir: &Path) -> Result<(), ConfigError> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    check_dir(dir)
}

/// Refuses a directory that someone else owns or that group or others can write to: they could
/// swap the files in it.
pub fn check_dir(dir: &Path) -> Result<(), ConfigError> {
    let meta = fs::metadata(dir)?;
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    if meta.uid() != me || meta.permissions().mode() & 0o022 != 0 {
        return Err(ConfigError::Unsafe(format!(
            "{} must be owned by you and not writable by others (chmod 700 {})",
            dir.display(),
            dir.display()
        )));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    let dir = path
        .parent()
        .ok_or_else(|| ConfigError::Invalid("no parent".into()))?;
    ensure_private_dir(dir)?;
    let tmp = dir.join(format!(
        "{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let _ = fs::remove_file(&tmp);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn read_private(path: &Path) -> Result<Option<Vec<u8>>, ConfigError> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if let Some(dir) = path.parent() {
        check_dir(dir)?;
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(ConfigError::Unsafe(format!(
            "{} is mode {mode:o}; it must be 0600 (chmod 600 {})",
            path.display(),
            path.display()
        )));
    }
    Ok(Some(fs::read(path)?))
}

pub fn remote_path(config_dir: &Path) -> PathBuf {
    config_dir.join(REMOTE_FILE)
}

/// `None` when this computer is not paired.
pub fn load(config_dir: &Path) -> Result<Option<RemoteConfig>, ConfigError> {
    let Some(bytes) = read_private(&remote_path(config_dir))? else {
        return Ok(None);
    };
    let config: RemoteConfig = serde_json::from_slice(&bytes)
        .map_err(|e| ConfigError::Invalid(format!("remote.json: {e}")))?;
    config.validate()?;
    Ok(Some(config))
}

pub fn save(config_dir: &Path, config: &RemoteConfig) -> Result<(), ConfigError> {
    config.validate()?;
    let mut bytes =
        serde_json::to_vec_pretty(config).map_err(|e| ConfigError::Invalid(e.to_string()))?;
    bytes.push(b'\n');
    write_private(&remote_path(config_dir), &bytes)
}

/// What the running helper last said about itself, for `status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StatusFile {
    /// `connecting`, `connected`, `offline`, `waiting_for_approval` or `stopped`.
    pub state: String,
    /// Seconds since the Unix epoch.
    pub since: u64,
    /// The helper process that wrote it, so `status` can tell a stale file from a live one.
    pub pid: u32,
    /// A short, content-free reason for the last failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn write_status(state_dir: &Path, status: &StatusFile) {
    if let Ok(bytes) = serde_json::to_vec(status) {
        let _ = write_private(&state_dir.join(STATUS_FILE), &bytes);
    }
}

pub fn read_status(state_dir: &Path) -> Option<StatusFile> {
    let bytes = read_private(&state_dir.join(STATUS_FILE)).ok()??;
    serde_json::from_slice(&bytes).ok()
}

/// Removes the key, the saved Gateway and the status. The key file is overwritten before it is
/// unlinked, so it does not linger in a freed block. Missing files are fine.
pub fn wipe(config_dir: &Path, state_dir: &Path) -> Result<(), ConfigError> {
    let key = state_dir.join(REMOTE_IDENTITY_FILE);
    if let Ok(meta) = fs::metadata(&key) {
        if let Ok(mut file) = fs::OpenOptions::new().write(true).open(&key) {
            let zeros = vec![0u8; usize::try_from(meta.len()).unwrap_or(0).min(1 << 20)];
            let _ = file.write_all(&zeros);
            let _ = file.sync_all();
        }
    }
    let mut result = Ok(());
    for path in [key, remote_path(config_dir), state_dir.join(STATUS_FILE)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => result = Err(ConfigError::Io(e)),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const KEY: &str = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
    const PIN: &str = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

    fn config() -> RemoteConfig {
        RemoteConfig::new(
            "https://a.ts.net".into(),
            KEY.into(),
            None,
            "lab-box".into(),
        )
    }

    #[test]
    fn config_dir_follows_xdg_and_ignores_relative_bases() {
        let env = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            config_dir(&env(&[("HOME", "/h")])),
            PathBuf::from("/h/.config/psyche-helper")
        );
        assert_eq!(
            config_dir(&env(&[("HOME", "/h"), ("XDG_CONFIG_HOME", "/x")])),
            PathBuf::from("/x/psyche-helper")
        );
        assert_eq!(
            config_dir(&env(&[("HOME", "/h"), ("XDG_CONFIG_HOME", "rel")])),
            PathBuf::from("/h/.config/psyche-helper")
        );
    }

    #[test]
    fn save_then_load_is_0600_in_a_0700_directory() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_dir = dir.path().join("cfg");
        assert!(load(&cfg_dir).unwrap().is_none());
        save(&cfg_dir, &config()).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&remote_path(&cfg_dir)), 0o600);
        assert_eq!(mode(&cfg_dir), 0o700);
        assert_eq!(load(&cfg_dir).unwrap().unwrap(), config());
        // A LAN entry round-trips with its pin.
        let lan = RemoteConfig::new(
            "https://192.168.1.4:7979".into(),
            KEY.into(),
            Some(PIN.into()),
            "lab-box".into(),
        );
        save(&cfg_dir, &lan).unwrap();
        assert_eq!(load(&cfg_dir).unwrap().unwrap(), lan);
    }

    #[test]
    fn a_readable_file_or_a_writable_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_dir = dir.path().join("cfg");
        save(&cfg_dir, &config()).unwrap();
        let file = remote_path(&cfg_dir);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(load(&cfg_dir), Err(ConfigError::Unsafe(_))));
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::set_permissions(&cfg_dir, fs::Permissions::from_mode(0o775)).unwrap();
        assert!(matches!(load(&cfg_dir), Err(ConfigError::Unsafe(_))));
        fs::set_permissions(&cfg_dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(load(&cfg_dir).unwrap().is_some());
    }

    #[test]
    fn a_tampered_file_is_invalid_not_defaulted() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_dir = dir.path().join("cfg");
        save(&cfg_dir, &config()).unwrap();
        let file = remote_path(&cfg_dir);
        let good = fs::read_to_string(&file).unwrap();
        for (label, edited) in [
            (
                "extra field",
                good.replace("\"version\"", "\"scopes\": [\"admin\"], \"version\""),
            ),
            (
                "plain http",
                good.replace("https://a.ts.net", "http://a.ts.net"),
            ),
            (
                "loopback",
                good.replace("https://a.ts.net", "https://127.0.0.1"),
            ),
            (
                "lan host without a pin",
                good.replace("https://a.ts.net", "https://192.168.1.4"),
            ),
            ("short key", good.replace(KEY, "abc")),
            ("hidden name", good.replace("lab-box", "lab\\u202ebox")),
            ("version", good.replace("\"version\": 1", "\"version\": 2")),
            ("not json", "nope".to_string()),
        ] {
            fs::write(&file, edited).unwrap();
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
            assert!(
                matches!(load(&cfg_dir), Err(ConfigError::Invalid(_))),
                "{label}"
            );
        }
    }

    #[test]
    fn wipe_removes_the_key_the_gateway_and_the_status() {
        let dir = tempfile::tempdir().unwrap();
        let (cfg_dir, state) = (dir.path().join("cfg"), dir.path().join("state"));
        save(&cfg_dir, &config()).unwrap();
        let key = crate::identity::load_or_create_file(&state, REMOTE_IDENTITY_FILE).unwrap();
        write_status(
            &state,
            &StatusFile {
                state: "connected".into(),
                since: 1,
                pid: 1,
                detail: None,
            },
        );
        assert!(state.join(STATUS_FILE).exists());
        wipe(&cfg_dir, &state).unwrap();
        assert!(!remote_path(&cfg_dir).exists());
        assert!(!state.join(REMOTE_IDENTITY_FILE).exists());
        assert!(!state.join(STATUS_FILE).exists());
        // The next key is a different one, and wiping twice is fine.
        let fresh = crate::identity::load_or_create_file(&state, REMOTE_IDENTITY_FILE).unwrap();
        assert_ne!(key.device_id(), fresh.device_id());
        wipe(&cfg_dir, &state).unwrap();
        wipe(&cfg_dir, &state).unwrap();
    }

    #[test]
    fn the_status_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_status(dir.path()).is_none());
        let status = StatusFile {
            state: "offline".into(),
            since: 5,
            pid: 2,
            detail: Some("x".into()),
        };
        write_status(dir.path(), &status);
        assert_eq!(read_status(dir.path()).unwrap(), status);
    }
}
