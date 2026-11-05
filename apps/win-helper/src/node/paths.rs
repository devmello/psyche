//! Filesystem locations (wire spec, Windows edition).
//!
//! - `$PSYCHE_HOME` defaults to `%USERPROFILE%\.psyche`.
//! - The node transport is a named pipe. The Gateway writes the pipe it listens on into
//!   `$PSYCHE_HOME\run\node-socket` (the same pointer file the mac helper's Gateway writes); the
//!   helper always reads it first. `PSYCHE_NODE_SOCKET` overrides it (tests, custom setups). Only
//!   when neither exists is the name computed: `\\.\pipe\psyche-node-<h>`, where `<h>` is the first
//!   16 hex characters of SHA-256 over the UTF-8 bytes of the absolute `$PSYCHE_HOME` path
//!   (`path.resolve(home)` in Node, `std::path::absolute` here: same separators, no trailing one).
//! - The per-launch handshake secret is `$PSYCHE_HOME\run\handshake.secret`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::encoding::sha256_hex;

/// A snapshot of the environment (injectable for tests).
#[derive(Debug, Clone, Default)]
pub struct Env(pub HashMap<String, String>);

impl Env {
    pub fn current() -> Env {
        Env(std::env::vars().collect())
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        // Windows environment names are case-insensitive.
        self.0
            .get(key)
            .or_else(|| self.0.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    }

    pub fn with(mut self, key: &str, value: impl Into<String>) -> Env {
        self.0.insert(key.to_owned(), value.into());
        self
    }
}

pub fn user_profile(env: &Env) -> PathBuf {
    if let Some(p) = env.get("USERPROFILE") {
        return PathBuf::from(p);
    }
    match (env.get("HOMEDRIVE"), env.get("HOMEPATH")) {
        (Some(d), Some(p)) => PathBuf::from(format!("{d}{p}")),
        _ => PathBuf::from("C:\\"),
    }
}

/// `$PSYCHE_HOME`, made absolute.
pub fn psyche_home(env: &Env) -> PathBuf {
    let raw = match env.get("PSYCHE_HOME") {
        Some(h) => PathBuf::from(h),
        None => user_profile(env).join(".psyche"),
    };
    absolute(&raw)
}

/// `std::path::absolute` without a trailing separator (except for a bare root).
pub fn absolute(p: &Path) -> PathBuf {
    let abs = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let s = abs.to_string_lossy().into_owned();
    let trimmed = s.trim_end_matches(['\\', '/']);
    if trimmed.len() < s.len() && !trimmed.ends_with(':') && !trimmed.is_empty() {
        PathBuf::from(trimmed)
    } else {
        abs
    }
}

/// First 16 hex characters of SHA-256 over the absolute home path (pipe name, mutex name).
pub fn home_hash(home: &Path) -> String {
    sha256_hex(home.to_string_lossy().as_bytes())[..16].to_owned()
}

/// `\\.\pipe\psyche-node-<home hash>`.
pub fn computed_pipe_name(home: &Path) -> String {
    format!(r"\\.\pipe\psyche-node-{}", home_hash(home))
}

pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run")
}

pub fn node_socket_pointer(home: &Path) -> PathBuf {
    run_dir(home).join("node-socket")
}

pub fn handshake_secret_path(home: &Path) -> PathBuf {
    run_dir(home).join("handshake.secret")
}

pub fn log_path(home: &Path) -> PathBuf {
    home.join("logs").join("helper.log")
}

/// Where the helper keeps its own state (`device.key.dpapi`).
pub fn helper_dir(home: &Path) -> PathBuf {
    home.join("helper")
}

/// Whether `s` names a local named pipe (`\\.\pipe\…` or `\\?\pipe\…`).
pub fn is_pipe_path(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    (l.starts_with(r"\\.\pipe\") || l.starts_with(r"\\?\pipe\")) && l.len() > r"\\.\pipe\".len()
}

/// Where the Gateway's node pipe is, and how the helper learned it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeLocation {
    pub path: String,
    pub source: &'static str,
}

/// `PSYCHE_NODE_SOCKET`, else the pointer file, else the computed name. Read on every connect
/// attempt, so a Gateway restart that moves the pipe is followed.
pub fn node_pipe(env: &Env) -> PipeLocation {
    if let Some(p) = env.get("PSYCHE_NODE_SOCKET")
        && is_pipe_path(p)
    {
        return PipeLocation { path: p.to_owned(), source: "env" };
    }
    let home = psyche_home(env);
    if let Ok(text) = std::fs::read_to_string(node_socket_pointer(&home)) {
        let line = text.trim();
        if is_pipe_path(line) {
            return PipeLocation { path: line.to_owned(), source: "pointer" };
        }
    }
    PipeLocation { path: computed_pipe_name(&home), source: "computed" }
}

/// The per-launch handshake secret, trimmed, if the Gateway wrote one. Never logged.
pub fn read_handshake_secret(env: &Env) -> Option<String> {
    let text = std::fs::read_to_string(handshake_secret_path(&psyche_home(env))).ok()?;
    let t = text.trim();
    (!t.is_empty()).then(|| t.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psyche-paths-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("run")).unwrap();
        d
    }

    #[test]
    fn home_defaults_to_user_profile() {
        let env = Env::default().with("USERPROFILE", r"C:\Users\someone");
        assert_eq!(psyche_home(&env), PathBuf::from(r"C:\Users\someone\.psyche"));
        let env = env.with("PSYCHE_HOME", r"D:\data\psyche\");
        assert_eq!(psyche_home(&env), PathBuf::from(r"D:\data\psyche"));
    }

    #[test]
    fn computed_pipe_matches_node_hash() {
        // createHash("sha256").update("C:\\Users\\someone\\.psyche").digest("hex").slice(0, 16)
        let home = PathBuf::from(r"C:\Users\someone\.psyche");
        let name = computed_pipe_name(&home);
        assert!(name.starts_with(r"\\.\pipe\psyche-node-"));
        assert_eq!(name.len(), r"\\.\pipe\psyche-node-".len() + 16);
        assert_eq!(home_hash(&home), sha256_hex(br"C:\Users\someone\.psyche")[..16]);
    }

    #[test]
    fn pointer_file_wins_over_computed_and_env_wins_over_pointer() {
        let home = temp_home("pointer");
        let env = Env::default().with("PSYCHE_HOME", home.to_string_lossy());
        assert_eq!(node_pipe(&env).source, "computed");
        std::fs::write(home.join("run").join("node-socket"), "\\\\.\\pipe\\psyche-node-from-file\n").unwrap();
        assert_eq!(node_pipe(&env), PipeLocation { path: r"\\.\pipe\psyche-node-from-file".into(), source: "pointer" });
        // A Unix socket path written by another Gateway build is not a pipe: ignored.
        std::fs::write(home.join("run").join("node-socket"), "/tmp/node.sock\n").unwrap();
        assert_eq!(node_pipe(&env).source, "computed");
        let env = env.with("PSYCHE_NODE_SOCKET", r"\\.\pipe\override");
        assert_eq!(node_pipe(&env).path, r"\\.\pipe\override");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn secret_is_trimmed_and_optional() {
        let home = temp_home("secret");
        let env = Env::default().with("PSYCHE_HOME", home.to_string_lossy());
        assert_eq!(read_handshake_secret(&env), None);
        std::fs::write(home.join("run").join("handshake.secret"), "  abc123 \r\n").unwrap();
        assert_eq!(read_handshake_secret(&env).as_deref(), Some("abc123"));
        std::fs::write(home.join("run").join("handshake.secret"), "\n").unwrap();
        assert_eq!(read_handshake_secret(&env), None);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn pipe_paths() {
        assert!(is_pipe_path(r"\\.\pipe\x"));
        assert!(is_pipe_path(r"\\?\PIPE\x"));
        assert!(!is_pipe_path(r"\\.\pipe\"));
        assert!(!is_pipe_path(r"C:\x"));
    }
}
