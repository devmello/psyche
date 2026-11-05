//! Filesystem locations from the wire spec: `$PSYCHE_HOME` defaults to `~/.psyche`; the node
//! socket is `$PSYCHE_HOME/run/node.sock` unless `PSYCHE_NODE_SOCKET` overrides it. Helper state
//! (the device identity) follows XDG (linux-desktop design §2.2): `$XDG_STATE_HOME/psyche-helper`.

use std::path::PathBuf;

/// The environment, as a lookup. Tests pass a map; `main` passes the process environment.
pub trait Env {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }
}

impl Env for std::collections::HashMap<String, String> {
    fn get(&self, key: &str) -> Option<String> {
        std::collections::HashMap::get(self, key)
            .cloned()
            .filter(|v| !v.is_empty())
    }
}

fn home_dir(env: &dyn Env) -> PathBuf {
    PathBuf::from(env.get("HOME").unwrap_or_else(|| "/".to_string()))
}

pub fn psyche_home(env: &dyn Env) -> PathBuf {
    match env.get("PSYCHE_HOME") {
        Some(home) => PathBuf::from(home),
        None => home_dir(env).join(".psyche"),
    }
}

/// `PSYCHE_NODE_SOCKET`, else `$PSYCHE_HOME/run/node.sock`. When the default does not exist but
/// the Gateway left a pointer at `run/node-socket` (a deep `$PSYCHE_HOME` moves the socket,
/// issue #50), the pointer wins.
pub fn node_socket_path(env: &dyn Env) -> PathBuf {
    if let Some(path) = env.get("PSYCHE_NODE_SOCKET") {
        return PathBuf::from(path);
    }
    let run = psyche_home(env).join("run");
    let default = run.join("node.sock");
    if !default.exists() {
        if let Ok(text) = std::fs::read_to_string(run.join("node-socket")) {
            let pointed = text.trim();
            if !pointed.is_empty() {
                return PathBuf::from(pointed);
            }
        }
    }
    default
}

pub fn handshake_secret_path(env: &dyn Env) -> PathBuf {
    psyche_home(env).join("run").join("handshake.secret")
}

/// The per-launch handshake secret, if the Gateway wrote one (trimmed). Never logged.
pub fn read_handshake_secret(env: &dyn Env) -> Option<String> {
    let text = std::fs::read_to_string(handshake_secret_path(env)).ok()?;
    let secret = text.trim();
    (!secret.is_empty()).then(|| secret.to_string())
}

/// `PSYCHE_HELPER_STATE` (tests and dev), else `$XDG_STATE_HOME/psyche-helper`, else
/// `~/.local/state/psyche-helper`.
pub fn state_dir(env: &dyn Env) -> PathBuf {
    if let Some(dir) = env.get("PSYCHE_HELPER_STATE") {
        return PathBuf::from(dir);
    }
    match env.get("XDG_STATE_HOME") {
        Some(base) if PathBuf::from(&base).is_absolute() => {
            PathBuf::from(base).join("psyche-helper")
        }
        _ => home_dir(env).join(".local/state/psyche-helper"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn home_defaults_to_dot_psyche() {
        assert_eq!(
            psyche_home(&env(&[("HOME", "/h")])),
            PathBuf::from("/h/.psyche")
        );
        assert_eq!(
            psyche_home(&env(&[("HOME", "/h"), ("PSYCHE_HOME", "/p")])),
            PathBuf::from("/p")
        );
    }

    #[test]
    fn node_socket_override_and_default() {
        let e = env(&[("PSYCHE_HOME", "/nonexistent-psyche-home")]);
        assert_eq!(
            node_socket_path(&e),
            PathBuf::from("/nonexistent-psyche-home/run/node.sock")
        );
        let e = env(&[("PSYCHE_NODE_SOCKET", "/s/n.sock"), ("PSYCHE_HOME", "/p")]);
        assert_eq!(node_socket_path(&e), PathBuf::from("/s/n.sock"));
    }

    #[test]
    fn node_socket_follows_the_pointer_when_the_default_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().join("run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::write(run.join("node-socket"), "/tmp/elsewhere/n.sock\n").unwrap();
        let e = env(&[("PSYCHE_HOME", dir.path().to_str().unwrap())]);
        assert_eq!(node_socket_path(&e), PathBuf::from("/tmp/elsewhere/n.sock"));
    }

    #[test]
    fn handshake_secret_is_trimmed_and_optional() {
        let dir = tempfile::tempdir().unwrap();
        let e = env(&[("PSYCHE_HOME", dir.path().to_str().unwrap())]);
        assert_eq!(read_handshake_secret(&e), None);
        std::fs::create_dir_all(dir.path().join("run")).unwrap();
        std::fs::write(handshake_secret_path(&e), " s3cret \n").unwrap();
        assert_eq!(read_handshake_secret(&e).as_deref(), Some("s3cret"));
        std::fs::write(handshake_secret_path(&e), "\n").unwrap();
        assert_eq!(read_handshake_secret(&e), None);
    }

    #[test]
    fn state_dir_follows_xdg_but_ignores_relative_bases() {
        assert_eq!(
            state_dir(&env(&[("HOME", "/h")])),
            PathBuf::from("/h/.local/state/psyche-helper")
        );
        assert_eq!(
            state_dir(&env(&[("HOME", "/h"), ("XDG_STATE_HOME", "/x")])),
            PathBuf::from("/x/psyche-helper")
        );
        assert_eq!(
            state_dir(&env(&[("HOME", "/h"), ("XDG_STATE_HOME", "rel")])),
            PathBuf::from("/h/.local/state/psyche-helper")
        );
        assert_eq!(
            state_dir(&env(&[("PSYCHE_HELPER_STATE", "/t")])),
            PathBuf::from("/t")
        );
    }
}
