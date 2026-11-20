//! The contained shell (design §5.1): `bwrap` arguments for one approved command.
//!
//! - The root file system is read-only; `/dev` and `/proc` are fresh, `/tmp` is a private tmpfs.
//! - `/run` is an empty tmpfs (#1512 review r1, finding 1): the user's runtime folder (session
//!   bus, keyring, gpg-agent and ssh-agent sockets) and every system socket there
//!   (`docker.sock`, `screen`, the system bus) are gone. A read-only mount never stops
//!   `connect()`, so hiding is the only cover for a path socket. With the network on, DNS's
//!   files come back read-only (`/run/systemd/resolve`, and whatever `/etc/resolv.conf` points
//!   to under `/run`). Known sockets outside `/run` (LXD, Incus) are covered by `/dev/null`.
//! - Only the granted folder is writable, and only when it was granted read-write. Inside it,
//!   the ceiling's read-only `files.roots` stay read-only, and so do git hooks and config and
//!   launch configs ([`super::launch`]).
//! - An empty tmpfs (or `/dev/null`) covers each hidden secret that exists
//!   (`fs::protected::HOME_HIDDEN`), and each socket the helper's own environment names.
//! - `--unshare-all` (user, ipc, pid, net, uts, cgroup). The network (`--share-net`) only when
//!   the card granted it and the ceiling allows it, and then with the seccomp filter of
//!   [`super::seccomp`]: the host's network namespace holds every abstract unix socket (an X
//!   server, D-Bus), so no `AF_UNIX` socket can be made at all.
//! - The executable that was hashed is bound by its open descriptor over its own path
//!   (`--ro-bind-fd`), so what runs is the inode whose SHA-256 the card was bound to.
//! - `--die-with-parent`; `--new-session` (no TIOCSTI into the helper's tty); the pid namespace
//!   ends every process of the command with it.
//!
//! If `bwrap` is missing or cannot set up its namespaces, the command does not run uncontained:
//! the caller answers `contain_unavailable`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::launch::Masks;
use crate::fs::protected;

/// Where `bwrap` may be. No `$PATH` search: a planted `bwrap` earlier on the path is not run.
pub const BWRAP_PATHS: &[&str] = &["/usr/bin/bwrap", "/bin/bwrap"];

/// Sockets outside `/run` that reach a root daemon (container managers).
pub const SYSTEM_SOCKETS: &[&str] = &[
    "/var/snap/lxd/common/lxd/unix.socket",
    "/var/lib/lxd/unix.socket",
    "/var/lib/incus/unix.socket",
];

pub fn find_bwrap() -> Option<PathBuf> {
    BWRAP_PATHS.iter().map(PathBuf::from).find(|p| p.is_file())
}

/// What one contained run needs to know.
pub struct Plan<'a> {
    pub home: &'a Path,
    /// The granted folder, shown inside at the same path.
    pub folder: &'a Path,
    pub writable: bool,
    pub network: bool,
    pub cwd: &'a Path,
    /// Sockets named by the helper's own environment, to cover.
    pub sockets: &'a [PathBuf],
    /// The ceiling's read-only roots (only those inside a writable folder matter).
    pub read_only: &'a [PathBuf],
    /// Launch configs to show read-only inside a writable folder.
    pub masks: &'a Masks,
    /// The executable's open descriptor and real path: bound over that path.
    pub executable: Option<(i32, &'a Path)>,
    /// argv[0] as the call wrote it.
    pub argv0: Option<&'a str>,
    /// The seccomp filter's descriptor (with the network on).
    pub seccomp: Option<i32>,
}

fn push(out: &mut Vec<OsString>, parts: &[&str]) {
    out.extend(parts.iter().map(OsString::from));
}

fn push_path(out: &mut Vec<OsString>, flag: &str, a: &Path, b: &Path) {
    out.push(flag.into());
    out.push(a.as_os_str().to_os_string());
    out.push(b.as_os_str().to_os_string());
}

fn push_one(out: &mut Vec<OsString>, flag: &str, a: &Path) {
    out.push(flag.into());
    out.push(a.as_os_str().to_os_string());
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
    if let Some(fd) = plan.seccomp {
        out.push("--seccomp".into());
        out.push(fd.to_string().into());
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
            "--tmpfs",
            "/run",
        ],
    );
    let mut covers = vec![PathBuf::from("/tmp"), PathBuf::from("/run")];
    if std::fs::symlink_metadata("/var/run").is_ok_and(|m| m.is_dir()) {
        push_one(&mut out, "--tmpfs", Path::new("/var/run"));
        covers.push(PathBuf::from("/var/run"));
    }
    if plan.network {
        // DNS only. With the network on no unix socket can be made, so resolved's varlink
        // socket in there is out of reach too; with it off nothing of /run comes back.
        let resolve = Path::new("/run/systemd/resolve");
        if resolve.is_dir() {
            push_path(&mut out, "--ro-bind", resolve, resolve);
        }
        if let Ok(real) = std::fs::canonicalize("/etc/resolv.conf") {
            if real.starts_with("/run") && !real.starts_with(resolve) && real.is_file() {
                push_path(&mut out, "--ro-bind", &real, &real);
            }
        }
    }
    for sock in SYSTEM_SOCKETS {
        let sock = Path::new(sock);
        if std::fs::symlink_metadata(sock).is_ok() {
            push_path(&mut out, "--ro-bind", Path::new("/dev/null"), sock);
        }
    }
    // The folder before the hidden paths: a read-only folder that holds the home folder must not
    // show what the tmpfs mounts below cover.
    push_path(
        &mut out,
        if plan.writable { "--bind" } else { "--ro-bind" },
        plan.folder,
        plan.folder,
    );
    if plan.writable {
        let mut read_only: Vec<PathBuf> = Vec::new();
        for r in plan.read_only {
            if r.starts_with(plan.folder) && r != plan.folder && r.is_dir() {
                push_path(&mut out, "--ro-bind", r, r);
                read_only.push(r.clone());
            }
        }
        let inside = |p: &PathBuf| p.starts_with(plan.folder) && !covered_by(p, &read_only);
        for p in plan.masks.existing.iter().filter(|p| inside(p)) {
            push_path(&mut out, "--ro-bind", p, p);
        }
        for p in plan.masks.missing_dirs.iter().filter(|p| inside(p)) {
            push_one(&mut out, "--tmpfs", p);
            push_one(&mut out, "--remount-ro", p);
        }
        for p in plan.masks.missing_files.iter().filter(|p| inside(p)) {
            push_path(&mut out, "--ro-bind", Path::new("/dev/null"), p);
        }
    }
    for hidden in protected::hidden_paths(plan.home) {
        match std::fs::symlink_metadata(&hidden) {
            Ok(m) if m.is_dir() => {
                push_one(&mut out, "--tmpfs", &hidden);
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
    if let Some((fd, path)) = plan.executable {
        out.push("--ro-bind-fd".into());
        out.push(fd.to_string().into());
        out.push(path.as_os_str().to_os_string());
    }
    if let Some(argv0) = plan.argv0 {
        out.push("--argv0".into());
        out.push(argv0.into());
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

    fn has3(a: &[String], x: &str, y: &str, z: &str) -> bool {
        a.windows(3).any(|w| w[0] == x && w[1] == y && w[2] == z)
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
        std::fs::create_dir_all(home.join("proj/keep")).unwrap();
        std::fs::write(home.join(".password-store"), "file, not a folder").unwrap();
        std::fs::write(home.join(".Xauthority"), "cookie").unwrap();
        let sock = dir.path().join("agent.sock");
        std::fs::write(&sock, "").unwrap();
        let folder = home.join("proj");
        let keep = folder.join("keep");
        let outside = home.join("elsewhere");
        let masks = Masks {
            existing: vec![folder.join(".git/hooks"), keep.join(".envrc")],
            missing_dirs: vec![folder.join(".vscode")],
            missing_files: vec![folder.join(".envrc")],
        };
        let exe = folder.join("build.sh");
        let plan = Plan {
            home: &home,
            folder: &folder,
            writable: true,
            network: false,
            cwd: &folder,
            sockets: &[
                sock.clone(),
                home.join(".ssh/agent.sock"),
                PathBuf::from("/tmp/x"),
            ],
            read_only: &[keep.clone(), outside.clone()],
            masks: &masks,
            executable: Some((7, &exe)),
            argv0: Some("./build.sh"),
            seccomp: None,
        };
        let a = strings(&args(&plan));
        let at = |s: &str| a.iter().position(|x| x == s).unwrap_or(usize::MAX);
        assert!(a.contains(&"--unshare-all".into()));
        assert!(!a.contains(&"--share-net".into()), "network off");
        assert!(!a.contains(&"--seccomp".into()));
        // /run is empty, and DNS stays out with the network off.
        assert!(a.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == "/run"));
        assert!(!a.contains(&"/run/systemd/resolve".into()));
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
        assert!(has3(&a, "--ro-bind", "/dev/null", &pass));
        let xauth = home.join(".Xauthority").display().to_string();
        assert!(has3(&a, "--ro-bind", "/dev/null", &xauth));
        assert!(!a.contains(&home.join(".gnupg").display().to_string()));
        // The socket outside every cover is masked; ones under a cover or under /tmp are not repeated.
        let sock_s = sock.display().to_string();
        assert!(has3(&a, "--ro-bind", "/dev/null", &sock_s));
        assert!(!a.contains(&"/tmp/x".into()));
        // The read-only root inside the folder is read-only; one outside is not mentioned.
        let keep_s = keep.display().to_string();
        assert!(has3(&a, "--ro-bind", &keep_s, &keep_s));
        assert!(!a.contains(&outside.display().to_string()));
        // Launch configs: existing bound over themselves, missing covered, none inside `keep`.
        let hooks = folder.join(".git/hooks").display().to_string();
        assert!(has3(&a, "--ro-bind", &hooks, &hooks));
        let vscode = folder.join(".vscode").display().to_string();
        assert!(a.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == vscode));
        assert!(a
            .windows(2)
            .any(|w| w[0] == "--remount-ro" && w[1] == vscode));
        let envrc = folder.join(".envrc").display().to_string();
        assert!(has3(&a, "--ro-bind", "/dev/null", &envrc));
        assert!(!a.contains(&keep.join(".envrc").display().to_string()));
        // The hashed executable is bound by descriptor, last, with argv[0] as written.
        let exe_s = exe.display().to_string();
        let fd_at = a
            .windows(3)
            .position(|w| w[0] == "--ro-bind-fd" && w[1] == "7" && w[2] == exe_s)
            .unwrap();
        assert!(fd_at > ssh_at);
        assert_eq!(a[at("--argv0") + 1], "./build.sh");
        assert_eq!(a[at("--chdir") + 1], folder_s);
        // Read-only folder, network on: DNS back, the filter on, no launch masks needed.
        let ro = Plan {
            writable: false,
            network: true,
            seccomp: Some(9),
            ..plan
        };
        let a = strings(&args(&ro));
        assert!(a.contains(&"--share-net".into()));
        assert_eq!(a[at_of(&a, "--seccomp") + 1], "9");
        assert!(!a.windows(2).any(|w| w[0] == "--bind"));
        assert!(has3(&a, "--ro-bind", &folder_s, &folder_s));
        assert!(!a.contains(&hooks));
        if Path::new("/run/systemd/resolve").is_dir() {
            assert!(a.contains(&"/run/systemd/resolve".into()));
        }
    }

    fn at_of(a: &[String], s: &str) -> usize {
        a.iter().position(|x| x == s).unwrap()
    }
}
