//! Filesystem locations from the wire spec: `$PSYCHE_HOME` defaults to `~/.psyche`; the node
//! socket is `$PSYCHE_HOME/run/node.sock` unless `PSYCHE_NODE_SOCKET` overrides it. Helper state
//! (the device identity) follows XDG (linux-desktop design §2.2): `$XDG_STATE_HOME/psyche-helper`.

use std::path::PathBuf;

/// The environment, as a lookup. Tests pass a map; `main` passes the process environment.
pub trait Env {
    fn get(&self, key: &str) -> Option<String>;

    /// The account's home. A map says `HOME`; the process environment says what passwd says (see
    /// [`passwd_home`]), because the account's own manager can set `$HOME` to anything and the
    /// policy's `~` must not follow it.
    fn home(&self) -> Option<String> {
        self.get("HOME")
    }
}

pub struct ProcessEnv;

impl Env for ProcessEnv {
    fn get(&self, key: &str) -> Option<String> {
        std::env::var(key).ok().filter(|v| !v.is_empty())
    }

    fn home(&self) -> Option<String> {
        passwd_home().map(|p| p.to_string_lossy().into_owned())
    }
}

/// The home directory of the effective user from the passwd database (`getpwuid_r`), never from
/// `$HOME`. `None` when there is no entry or its directory is not absolute.
pub fn passwd_home() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let mut buf = vec![0u8; 4096];
    loop {
        // SAFETY: all-zero is a valid (empty) passwd; getpwuid_r fills it.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: the buffer and out-pointers are valid for the call.
        let rc = unsafe {
            libc::getpwuid_r(
                uid,
                &mut pwd,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut result,
            )
        };
        if rc == libc::ERANGE && buf.len() < 1 << 20 {
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 || result.is_null() || pwd.pw_dir.is_null() {
            return None;
        }
        // SAFETY: pw_dir points at a NUL-terminated string inside `buf`.
        let dir = unsafe { std::ffi::CStr::from_ptr(pwd.pw_dir) };
        let path = PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes()));
        return path.is_absolute().then_some(path);
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
    PathBuf::from(env.home().unwrap_or_else(|| "/".to_string()))
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
    fn the_process_home_is_the_passwd_home_not_home() {
        // The child run: HOME=/ must not change what the helper takes as the account's home.
        if std::env::var_os("PSYCHE_TEST_HOME_CHILD").is_some() {
            let want = passwd_home().expect("checked by the parent run");
            assert_eq!(ProcessEnv.home().as_deref(), want.to_str());
            assert_ne!(ProcessEnv.home().as_deref(), Some("/"));
            assert_eq!(
                psyche_home(&ProcessEnv),
                want.join(".psyche"),
            );
            return;
        }
        // No passwd entry (a rootless container with an arbitrary UID) or a home of `/`: nothing to compare.
        match passwd_home() {
            None => return,
            Some(h) if h == std::path::Path::new("/") => return,
            Some(_) => {}
        }
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "paths::tests::the_process_home_is_the_passwd_home_not_home",
                "--test-threads=1",
            ])
            .env("HOME", "/")
            .env("PSYCHE_TEST_HOME_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("1 passed"));
        // A map still says HOME (tests and dev).
        assert_eq!(env(&[("HOME", "/h")]).home().as_deref(), Some("/h"));
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
