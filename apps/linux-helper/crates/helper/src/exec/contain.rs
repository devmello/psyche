//! The contained shell (design §5.1): `bwrap` arguments for one approved command.
//!
//! - The root file system is read-only; `/dev` and `/proc` are fresh, `/tmp` is a private tmpfs.
//! - Only the granted folder is writable, and only when it was granted read-write.
//! - An empty tmpfs covers each hidden secret that exists (`fs::protected::HOME_HIDDEN`) and the
//!   user's runtime folder (`/run/user/<uid>`: the session bus, the keyring, gpg-agent and
//!   ssh-agent sockets, the user manager's socket that `systemd-run --user` needs).
//! - A socket the helper's own environment names (`SSH_AUTH_SOCK`, `GPG_AGENT_INFO`) that lies
//!   elsewhere is covered too; the command's environment never names them anyway.
//! - `--unshare-all` (user, ipc, pid, net, uts, cgroup), `--share-net` only when the ceiling
//!   allows network; `--die-with-parent`; `--new-session` (no TIOCSTI into the helper's tty).
//!
//! If `bwrap` is missing or cannot set up its namespaces, the command does not run uncontained:
//! the caller answers `contain_unavailable`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::fs::protected;

/// Where `bwrap` may be. No `$PATH` search: a planted `bwrap` earlier on the path is not run.
pub const BWRAP_PATHS: &[&str] = &["/usr/bin/bwrap", "/bin/bwrap"];

pub fn find_bwrap() -> Option<PathBuf> {
    BWRAP_PATHS.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// What one contained run needs to know.
pub struct Plan<'a> {
    pub home: &'a Path,
    pub uid: u32,
    /// The granted folder, shown inside at the same path.
    pub folder: &'a Path,
    pub writable: bool,
    pub network: bool,
    pub cwd: &'a Path,
    /// Sockets named by the helper's own environment, to cover.
    pub sockets: &'a [PathBuf],
}

fn push(out: &mut Vec<OsString>, parts: &[&str]) {
    out.extend(parts.iter().map(OsString::from));
}

fn push_path(out: &mut Vec<OsString>, flag: &str, a: &Path, b: &Path) {
    out.push(flag.into());
    out.push(a.as_os_str().to_os_string());
    out.push(b.as_os_str().to_os_string());
}

fn covered_by(path: &Path, covers: &[PathBuf]) -> bool {
    covers.iter().any(|c| path.starts_with(c))
}

/// The arguments before `--`.
pub fn args(plan: &Plan) -> Vec<OsString> {
    let mut out = Vec::new();
    push(
        &mut out,
        &["--die-with-parent", "--new-session", "--unshare-all"],
    );
    if plan.network {
        push(&mut out, &["--share-net"]);
    }
    push(
        &mut out,
        &[
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
        ],
    );
    let runtime = PathBuf::from(format!("/run/user/{}", plan.uid));
    let mut covers = vec![PathBuf::from("/tmp")];
    if runtime.is_dir() {
        out.push("--tmpfs".into());
        out.push(runtime.as_os_str().to_os_string());
        covers.push(runtime);
    }
    // The folder before the hidden paths: a read-only folder that holds the home folder must not
    // show what the tmpfs mounts below cover.
    push_path(
        &mut out,
        if plan.writable { "--bind" } else { "--ro-bind" },
        plan.folder,
        plan.folder,
    );
    for hidden in protected::hidden_paths(plan.home) {
        match std::fs::symlink_metadata(&hidden) {
            Ok(m) if m.is_dir() => {
                out.push("--tmpfs".into());
                out.push(hidden.as_os_str().to_os_string());
                covers.push(hidden);
            }
            Ok(_) => {
                push_path(&mut out, "--ro-bind", Path::new("/dev/null"), &hidden);
                covers.push(hidden);
            }
            Err(_) => {}
        }
    }
    for sock in plan.sockets {
        if covered_by(sock, &covers) || !sock.is_absolute() {
            continue;
        }
        if std::fs::symlink_metadata(sock).is_ok() {
            push_path(&mut out, "--ro-bind", Path::new("/dev/null"), sock);
        }
    }
    out.push("--chdir".into());
    out.push(plan.cwd.as_os_str().to_os_string());
    out
}

/// Whether `bwrap` can set up a sandbox here now: it runs `/bin/true` (or `/usr/bin/true`) under
/// the same namespaces. False when user namespaces are off or an LSM refuses them.
pub fn probe(bwrap: &Path, network: bool) -> bool {
    let truth = ["/usr/bin/true", "/bin/true"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file());
    let Some(truth) = truth else { return false };
    let mut cmd = Command::new(bwrap);
    cmd.args(["--die-with-parent", "--unshare-all"]);
    if network {
        cmd.arg("--share-net");
    }
    cmd.args([
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--",
    ])
    .arg(&truth)
    .env_clear()
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(v: &[OsString]) -> Vec<String> {
        v.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn the_arguments_hide_secrets_after_the_folder_and_bind_it_by_mode() {
        // Not under /tmp: the sandbox's own /tmp covers everything there already.
        let base = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|h| h.is_dir() && !h.starts_with("/tmp"))
            .unwrap_or_else(std::env::temp_dir);
        let dir = tempfile::Builder::new()
            .prefix(".h5-contain-test-")
            .tempdir_in(base)
            .unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join(".config/psyche-helper")).unwrap();
        std::fs::create_dir_all(home.join("proj")).unwrap();
        std::fs::write(home.join(".password-store"), "file, not a folder").unwrap();
        let sock = dir.path().join("agent.sock");
        std::fs::write(&sock, "").unwrap();
        let folder = home.join("proj");
        let plan = Plan {
            home: &home,
            uid: 4_000_000_000,
            folder: &folder,
            writable: true,
            network: false,
            cwd: &folder,
            sockets: &[
                sock.clone(),
                home.join(".ssh/agent.sock"),
                PathBuf::from("/tmp/x"),
            ],
        };
        let a = strings(&args(&plan));
        let at = |s: &str| a.iter().position(|x| x == s).unwrap_or(usize::MAX);
        assert!(a.contains(&"--unshare-all".into()));
        assert!(!a.contains(&"--share-net".into()), "network off");
        let folder_s = folder.display().to_string();
        let bind = a
            .windows(3)
            .position(|w| w[0] == "--bind" && w[1] == folder_s);
        assert!(bind.is_some(), "{a:?}");
        let ssh = home.join(".ssh").display().to_string();
        let ssh_at = a
            .windows(2)
            .position(|w| w[0] == "--tmpfs" && w[1] == ssh)
            .unwrap();
        assert!(ssh_at > bind.unwrap(), "hidden after the folder");
        assert!(a.contains(&home.join(".config/psyche-helper").display().to_string()));
        // A file is covered by /dev/null; a missing one is skipped.
        let pass = home.join(".password-store").display().to_string();
        assert!(a
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2] == pass));
        assert!(!a.contains(&home.join(".gnupg").display().to_string()));
        // The socket outside every cover is masked; ones under a cover or under /tmp are not repeated.
        let sock_s = sock.display().to_string();
        assert!(a
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == "/dev/null" && w[2] == sock_s));
        assert!(!a.contains(&"/tmp/x".into()));
        assert_eq!(a[at("--chdir") + 1], folder_s);
        // Read-only folder, network on.
        let ro = Plan {
            writable: false,
            network: true,
            ..plan
        };
        let a = strings(&args(&ro));
        assert!(a.contains(&"--share-net".into()));
        assert!(!a.windows(2).any(|w| w[0] == "--bind"));
        assert!(a
            .windows(3)
            .any(|w| w[0] == "--ro-bind" && w[1] == folder_s));
    }
}
