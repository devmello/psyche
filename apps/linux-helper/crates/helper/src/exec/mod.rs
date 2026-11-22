//! `exec.host` on a machine (design §5.1): one approved argv, never a shell string.
//!
//! - **Refused without an `approvalId`.** The Gateway asks first (the card names the machine,
//!   argv, cwd, env, the network and the executable's SHA-256), and the helper never runs a
//!   command it was not told was approved.
//! - **What runs is what was approved.** The Gateway learns the executable and its SHA-256 from
//!   `exec.resolve` before the card, and `exec.host` requires that hash back (`expectSha256`).
//!   The helper opens the executable once, hashes that open file, and runs that same file: the
//!   contained shell binds the descriptor over its path (#1512 review r1, finding 10). A file
//!   that changes while it is hashed is refused.
//! - **Where:** `cwd` must be a real directory inside `folder` (the folder the owner granted on
//!   this machine), and `folder` inside one of the ceiling's `exec.cwdRoots`, after symlinks, and
//!   neither may be a protected path. `folder` must be its own real path and, with `folderId`,
//!   still the folder that was granted (`folder_moved`: a swapped root is refused). A read-write
//!   folder may not hold a protected path or the home folder itself, nor lie in a read-only
//!   `files.roots` entry; read-only roots inside it stay read-only.
//! - **Environment:** built from nothing: `PATH` (the fixed list), `HOME`, `USER`, `LOGNAME`,
//!   `LANG`, `TMPDIR=/tmp`, then the call's own `env`, whose names may not change what runs or
//!   where code loads from. No `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`,
//!   `DISPLAY` or `XAUTHORITY` ever reaches a command.
//! - **Contained by default** under `bwrap` ([`contain`]): no network unless the card granted it
//!   (`network: true`) and the ceiling allows it, and then no unix sockets ([`seccomp`]). With
//!   `contain: false` in the ceiling it runs on the full account, and the card says so (the
//!   Gateway checks `expectContained`). Either way `PR_SET_NO_NEW_PRIVS` is set before exec, so
//!   sudo, pkexec and setuid programs cannot raise privileges.
//! - **Bounded:** stdout and stderr stream as `node.event` `{stream, text}` and are each kept up
//!   to [`EXEC_OUTPUT_CAP_BYTES`], and cut further so the result fits in one frame as JSON. A
//!   timeout, a `node.cancel` or the connection closing (a revoke) kills every process of the
//!   command: the pid namespace when contained; on the full account a transient
//!   `systemd-run --user --scope` per call (so `setsid` children die too), or the process group
//!   where no user manager runs.
//! - One journal line per command: program, argv hash, cwd, exit code, duration. Never output.

pub mod contain;
pub mod launch;
pub mod seccomp;

use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use psyche_protocol::{ErrorCode, SideEffect, TargetKind};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::capability::{Capability, CapabilityError, CapabilitySpec, InvocationContext, Registry};
use crate::fs::{fit, protected};
use crate::journal::Journal;
use crate::remote::policy::{Mode, Policy, PolicySource};

/// The Gateway's `EXEC_OUTPUT_CAP_BYTES`: kept per stream.
pub const EXEC_OUTPUT_CAP_BYTES: usize = 128 * 1024;
/// Each stream's text in the result, JSON-encoded, at most: both fit in one 1 MiB frame.
pub const EXEC_OUTPUT_JSON_BUDGET: usize = 384 * 1024;
pub const EXEC_DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const EXEC_TIMEOUT_MS_MAX: u64 = 600_000;
pub const KILL_GRACE: Duration = Duration::from_secs(2);
/// Bare names are looked up here only.
pub const SAFE_PATH: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
];
const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";
const SYSTEMCTL: &str = "/usr/bin/systemctl";
const KEYS: &[&str] = &[
    "argv",
    "cwd",
    "folder",
    "folderMode",
    "folderId",
    "env",
    "timeoutMs",
    "expectSha256",
    "expectContained",
    "network",
];
const RESOLVE_KEYS: &[&str] = &["argv0", "cwd"];

fn err(code: ErrorCode, reason: &str, message: &str) -> CapabilityError {
    CapabilityError::new(code, reason, message)
}
fn invalid(message: &str) -> CapabilityError {
    err(ErrorCode::InvalidParams, "invalid_params", message)
}

/// Names a call may not set: they change what runs, where code loads from, or reach the
/// owner's agents and buses.
pub fn reserved_env(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "IFS",
        "ENV",
        "BASH_ENV",
        "NODE_OPTIONS",
        "PYTHONSTARTUP",
        "PYTHONPATH",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYOPT",
        "RUBYLIB",
        "PROMPT_COMMAND",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "GPG_AGENT_INFO",
        "DBUS_SESSION_BUS_ADDRESS",
        "DBUS_SYSTEM_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_EXEC_PATH",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
    ];
    const PREFIX: &[&str] = &[
        "LD_",
        "PSYCHE_",
        "SUDO_",
        "BASH_FUNC_",
        "GIO_",
        "GTK_",
        "QT_",
    ];
    EXACT.contains(&name) || PREFIX.iter().any(|p| name.starts_with(p))
}

fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('A'..='Z'))
        && name.len() <= 64
        && chars.all(|c| matches!(c, 'A'..='Z' | '0'..='9' | '_'))
}

/// The whole environment of a command: nothing of the helper's own but what is listed here.
pub fn command_env(home: &Path, user: &str, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = vec![
        ("PATH".to_string(), SAFE_PATH.join(":")),
        ("HOME".to_string(), home.display().to_string()),
        ("USER".to_string(), user.to_string()),
        ("LOGNAME".to_string(), user.to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
        ("TMPDIR".to_string(), "/tmp".to_string()),
    ];
    out.extend(extra.iter().cloned());
    out
}

/// The account's name, from the passwd entry of the effective uid.
fn user_name() -> String {
    // SAFETY: getpwuid returns a pointer to static storage or null; read before another call.
    unsafe {
        let pw = libc::getpwuid(libc::geteuid());
        if pw.is_null() || (*pw).pw_name.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr((*pw).pw_name)
            .to_string_lossy()
            .into_owned()
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_reader(mut r: impl Read) -> std::io::Result<String> {
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("sha256:{}", hex(&h.finalize())))
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    sha256_reader(File::open(path)?)
}

/// argv[0] → the real file that runs.
pub fn resolve_executable(argv0: &str, cwd: &Path) -> Result<PathBuf, CapabilityError> {
    let candidates: Vec<PathBuf> = if argv0.contains('/') {
        let p = Path::new(argv0);
        vec![if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }]
    } else {
        SAFE_PATH.iter().map(|d| Path::new(d).join(argv0)).collect()
    };
    for c in candidates {
        let Ok(real) = std::fs::canonicalize(&c) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&real) else {
            continue;
        };
        if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
            return Ok(real);
        }
    }
    Err(err(
        ErrorCode::NotFound,
        "not_found",
        &if argv0.contains('/') {
            format!("{argv0} is not an executable file")
        } else {
            format!(
                "{argv0} is not in {}; give its absolute path",
                SAFE_PATH.join(":")
            )
        },
    ))
}

/// One executable, open: the file that is hashed is the file that runs.
#[derive(Debug)]
pub struct Program {
    pub path: PathBuf,
    pub file: File,
    pub sha256: String,
}

/// Opens the resolved executable (never through a link), hashes the open file, and refuses one
/// that changed while it was read.
pub fn open_program(path: &Path, home: &Path) -> Result<Program, CapabilityError> {
    if protected::hidden_paths(home)
        .iter()
        .any(|h| path.starts_with(h))
    {
        return Err(err(
            ErrorCode::Forbidden,
            "protected_path",
            &format!("{} is protected", path.display()),
        ));
    }
    let unreadable = |e: std::io::Error| {
        err(
            ErrorCode::Unavailable,
            "unreadable",
            &format!("{}: {}", path.display(), e.kind()),
        )
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(unreadable)?;
    let before = file.metadata().map_err(unreadable)?;
    if !before.is_file() || before.permissions().mode() & 0o111 == 0 {
        return Err(err(
            ErrorCode::NotFound,
            "not_found",
            &format!("{} is not an executable file", path.display()),
        ));
    }
    struct At<'a>(&'a File, u64);
    impl Read for At<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.0.read_at(buf, self.1)?;
            self.1 += n as u64;
            Ok(n)
        }
    }
    let sha256 = sha256_reader(At(&file, 0)).map_err(unreadable)?;
    let after = file.metadata().map_err(unreadable)?;
    if (before.len(), before.mtime(), before.mtime_nsec())
        != (after.len(), after.mtime(), after.mtime_nsec())
    {
        return Err(err(
            ErrorCode::Conflict,
            "executable_changing",
            &format!("{} changed while it was read", path.display()),
        ));
    }
    Ok(Program {
        path: path.to_path_buf(),
        file,
        sha256,
    })
}

fn expand(path: &str, home: &Path) -> Option<PathBuf> {
    let p = if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    protected::lexical(p.to_str()?)
}

fn refuse(reason: &str, message: String) -> CapabilityError {
    err(ErrorCode::Forbidden, reason, &message)
}

/// `raw` as an absolute, real, unprotected directory: (as written, real).
fn real_dir(raw: &str, what: &str, home: &Path) -> Result<(PathBuf, PathBuf), CapabilityError> {
    let Some(lex) = protected::lexical(raw) else {
        return Err(invalid(&format!(
            "{what} must be an absolute path without `..`"
        )));
    };
    let real = std::fs::canonicalize(&lex).map_err(|_| {
        err(
            ErrorCode::NotFound,
            "not_found",
            &format!("{raw} does not exist"),
        )
    })?;
    if !real.is_dir() {
        return Err(invalid(&format!("{raw} is not a folder")));
    }
    if protected::is_protected(&lex, home) || protected::is_protected(&real, home) {
        return Err(refuse(
            "protected_path",
            format!("{raw} is protected on this computer"),
        ));
    }
    Ok((lex, real))
}

fn in_cwd_roots(policy: &Policy, home: &Path, folder: &Path) -> bool {
    policy.exec.cwd_roots.iter().any(|r| {
        expand(r, home)
            .and_then(|r| std::fs::canonicalize(r).ok())
            .is_some_and(|r| folder.starts_with(r))
    })
}

fn shell_off() -> CapabilityError {
    err(
        ErrorCode::Forbidden,
        "machine_policy",
        "This computer's limits do not allow running commands",
    )
}

/// One parsed, checked call.
#[derive(Debug)]
pub struct Checked {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub folder: PathBuf,
    pub writable: bool,
    pub env: Vec<(String, String)>,
    pub timeout: Duration,
    pub executable: PathBuf,
    pub sha256: String,
    /// The open executable: what runs.
    pub program: File,
    pub contain: bool,
    /// The network, as granted on the card and allowed by the ceiling.
    pub network: bool,
    /// The ceiling's read-only file roots (real paths): read-only inside the folder too.
    pub read_only: Vec<PathBuf>,
}

/// Parses and checks one call against the ceiling, before anything runs.
pub fn check(policy: &Policy, home: &Path, params: &Value) -> Result<Checked, CapabilityError> {
    let Some(map) = params.as_object() else {
        return Err(invalid("params must be an object"));
    };
    if let Some(k) = map.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(invalid(&format!("unknown param: {k}")));
    }
    let argv: Vec<String> = match map.get("argv") {
        Some(Value::Array(a)) if !a.is_empty() && a.len() <= 256 => a
            .iter()
            .map(|v| match v {
                Value::String(s) if !s.contains('\0') => Ok(s.clone()),
                _ => Err(invalid("argv must be strings without NUL")),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(invalid("argv must be a non-empty array of strings")),
    };
    if argv[0].is_empty() {
        return Err(invalid("argv[0] is empty"));
    }
    let string = |key: &str| -> Result<Option<&str>, CapabilityError> {
        match map.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(invalid(&format!("{key} must be a string"))),
        }
    };
    let boolean = |key: &str| -> Result<Option<bool>, CapabilityError> {
        match map.get(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(invalid(&format!("{key} must be a boolean"))),
        }
    };
    let Some(cwd_raw) = string("cwd")? else {
        return Err(invalid("cwd is required"));
    };
    let folder_raw = string("folder")?.unwrap_or(cwd_raw);
    let writable = match string("folderMode")? {
        None | Some("ro") => false,
        Some("rw") => true,
        Some(_) => return Err(invalid("folderMode must be \"ro\" or \"rw\"")),
    };
    let mut env = Vec::new();
    match map.get("env") {
        None => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                let Value::String(v) = v else {
                    return Err(invalid("env values must be strings"));
                };
                if !env_name_ok(k) || v.contains('\0') {
                    return Err(invalid(&format!("env {k} is not a valid variable")));
                }
                if reserved_env(k) {
                    return Err(invalid(&format!("env {k} is fixed")));
                }
                env.push((k.clone(), v.clone()));
            }
        }
        Some(_) => return Err(invalid("env must map names to strings")),
    }
    env.sort();
    let timeout_ms = match map.get("timeoutMs") {
        None => EXEC_DEFAULT_TIMEOUT_MS,
        Some(v) => match v.as_u64() {
            Some(n) if (1..=EXEC_TIMEOUT_MS_MAX).contains(&n) => n,
            _ => {
                return Err(invalid(&format!(
                    "timeoutMs must be an integer in 1..{EXEC_TIMEOUT_MS_MAX}"
                )))
            }
        },
    };
    let expect = string("expectSha256")?;
    let network = boolean("network")?.unwrap_or(false);
    let expect_contained = boolean("expectContained")?;
    let folder_id = string("folderId")?;

    if !policy.exec.enabled {
        return Err(shell_off());
    }
    if expect_contained.is_some_and(|c| c != policy.exec.contain) {
        return Err(err(
            ErrorCode::BindingMismatch,
            "containment_changed",
            "This computer's limits changed since the command was approved (contained or full account); it was not run",
        ));
    }
    if network && policy.exec.contain && !policy.exec.network {
        return Err(refuse(
            "machine_policy",
            "This computer's limits keep commands off the network".into(),
        ));
    }
    let (folder_lex, folder) = real_dir(folder_raw, "folder", home)?;
    // The grant names the folder's real path: one that is now reached through a link, or is
    // another folder at the same path, is not the folder that was granted.
    let moved = || {
        refuse(
            "folder_moved",
            format!("{folder_raw} is not the folder that was granted any more; ask for it again"),
        )
    };
    if folder_lex != folder {
        return Err(moved());
    }
    if let Some(id) = folder_id {
        let now = std::fs::metadata(&folder)
            .map(|m| format!("{:x}:{:x}", m.dev(), m.ino()))
            .unwrap_or_default();
        if now != id {
            return Err(moved());
        }
    }
    let (_, cwd) = real_dir(cwd_raw, "cwd", home)?;
    if !cwd.starts_with(&folder) {
        return Err(refuse(
            "outside_folder",
            format!("{cwd_raw} is outside the granted folder"),
        ));
    }
    if !in_cwd_roots(policy, home, &folder) {
        return Err(refuse(
            "machine_policy",
            "This computer's limits do not allow that folder".into(),
        ));
    }
    if writable && policy.exec.contain && protected::holds_protected(&folder, home) {
        return Err(refuse(
            "folder_holds_protected",
            format!(
                "{} holds your home folder or protected files; grant a folder inside it to let commands write",
                folder.display()
            ),
        ));
    }
    // The ceiling's file roots: a read-write folder may not lie in a read-only one (the deepest
    // root that holds it decides), and read-only roots inside it stay read-only.
    let unmoved = crate::fs::ro_roots_unmoved(policy, home);
    if writable {
        unmoved?;
    }
    let roots = crate::fs::real_roots(policy, home);
    if writable {
        let decider = roots
            .iter()
            .filter(|(_, real, _)| folder.starts_with(real))
            .max_by_key(|(_, real, mode)| (real.components().count(), *mode == Mode::Ro));
        if decider.is_some_and(|(_, _, mode)| *mode == Mode::Ro) {
            return Err(refuse(
                "read_only_root",
                format!("{} is read-only on this computer", folder.display()),
            ));
        }
    }
    let read_only: Vec<PathBuf> = roots
        .into_iter()
        .filter(|(_, _, mode)| *mode == Mode::Ro)
        .map(|(_, real, _)| real)
        .collect();
    let executable = resolve_executable(&argv[0], &cwd)?;
    let program = open_program(&executable, home)?;
    // The card was bound to this hash: nothing runs that was not.
    let Some(expect) = expect else {
        return Err(invalid(
            "expectSha256 is required: ask exec.resolve first, and bind the card to it",
        ));
    };
    if expect != program.sha256 {
        return Err(err(
            ErrorCode::BindingMismatch,
            "executable_changed",
            "The executable changed since it was approved",
        ));
    }
    Ok(Checked {
        argv,
        cwd,
        folder,
        writable,
        env,
        timeout: Duration::from_millis(timeout_ms),
        executable,
        sha256: program.sha256,
        program: program.file,
        contain: policy.exec.contain,
        network: if policy.exec.contain { network } else { true },
        read_only,
    })
}

/// `exec.resolve`: what argv[0] runs in `cwd`, and its SHA-256, so the card can be bound to it.
/// Also says how commands run here (contained or not, whether the network may be granted).
pub fn resolve(policy: &Policy, home: &Path, params: &Value) -> Result<Value, CapabilityError> {
    let Some(map) = params.as_object() else {
        return Err(invalid("params must be an object"));
    };
    if let Some(k) = map.keys().find(|k| !RESOLVE_KEYS.contains(&k.as_str())) {
        return Err(invalid(&format!("unknown param: {k}")));
    }
    let get = |k: &str| map.get(k).and_then(Value::as_str);
    let (Some(argv0), Some(cwd_raw)) = (get("argv0"), get("cwd")) else {
        return Err(invalid("argv0 and cwd are required strings"));
    };
    if argv0.is_empty() || argv0.contains('\0') {
        return Err(invalid("argv0 is empty"));
    }
    if !policy.exec.enabled {
        return Err(shell_off());
    }
    let (_, cwd) = real_dir(cwd_raw, "cwd", home)?;
    if !in_cwd_roots(policy, home, &cwd) {
        return Err(refuse(
            "machine_policy",
            "This computer's limits do not allow that folder".into(),
        ));
    }
    let executable = resolve_executable(argv0, &cwd)?;
    let program = open_program(&executable, home)?;
    Ok(json!({
        "executable": program.path.display().to_string(),
        "executableSha256": program.sha256,
        "contained": policy.exec.contain,
        "networkAllowed": !policy.exec.contain || policy.exec.network,
    }))
}

/// One stream's kept output.
#[derive(Default)]
struct Kept {
    bytes: Vec<u8>,
    truncated: bool,
}

/// Reads one pipe to its end: keeps up to the cap, streams what it keeps as UTF-8 text (a
/// character split across reads waits for its other half), drains the rest so the child never
/// blocks on a full pipe.
fn pump<R: Read + Send + 'static>(
    mut pipe: R,
    stream: &'static str,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
    kept: Arc<Mutex<Kept>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let slice = {
                let mut k = kept.lock().unwrap_or_else(|e| e.into_inner());
                let room = EXEC_OUTPUT_CAP_BYTES.saturating_sub(k.bytes.len());
                if n > room {
                    k.truncated = true;
                }
                let take = n.min(room);
                k.bytes.extend_from_slice(&buf[..take]);
                buf[..take].to_vec()
            };
            if slice.is_empty() {
                continue;
            }
            carry.extend_from_slice(&slice);
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => carry.len(),
            };
            if valid > 0 {
                let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                emit(json!({ "stream": stream, "text": text }));
            }
        }
        if !carry.is_empty() {
            emit(json!({ "stream": stream, "text": String::from_utf8_lossy(&carry) }));
        }
    })
}

/// Whether the group leader exited, without reaping it (Linux: `waitid(WNOWAIT)`), so the
/// group id stays reserved until the last kill.
#[cfg(target_os = "linux")]
fn leader_exited(child: &mut std::process::Child) -> std::io::Result<bool> {
    // SAFETY: zeroed is a valid siginfo_t; waitid fills it.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: waits on our own child without reaping it.
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            child.id() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: si_pid is set by waitid when a child changed state, zero otherwise.
    Ok(unsafe { info.si_pid() } != 0)
}

#[cfg(not(target_os = "linux"))]
fn leader_exited(child: &mut std::process::Child) -> std::io::Result<bool> {
    // Not a machine platform: reaping early only risks a reused group id on a dev box.
    child.try_wait().map(|s| s.is_some())
}

fn kill_group(pid: i32, sig: libc::c_int) {
    // SAFETY: signals the process group we created; a stale group fails with ESRCH.
    unsafe {
        libc::kill(-pid, sig);
    }
}

/// The user's runtime folder, when the user manager can be reached there.
fn user_manager() -> Option<PathBuf> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        // SAFETY: getuid cannot fail.
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })));
    (runtime.join("systemd/private").exists() || runtime.join("bus").exists()).then_some(runtime)
}

/// Whether a transient user scope can be made here (checked once): on the full account each
/// command gets one, so every process it starts, `setsid` ones too, ends with it.
fn scopes_work() -> Option<&'static PathBuf> {
    static WORKS: OnceLock<Option<PathBuf>> = OnceLock::new();
    WORKS
        .get_or_init(|| {
            let runtime = user_manager()?;
            if !Path::new(SYSTEMD_RUN).is_file() || !Path::new(SYSTEMCTL).is_file() {
                return None;
            }
            let ok = Command::new(SYSTEMD_RUN)
                .args([
                    "--user",
                    "--scope",
                    "--quiet",
                    "--collect",
                    "--",
                    "/bin/true",
                ])
                .env_clear()
                .env("XDG_RUNTIME_DIR", &runtime)
                .env("PATH", SAFE_PATH.join(":"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            ok.then_some(runtime)
        })
        .as_ref()
}

/// Signals every process of a transient scope; quick, and quiet when it is already gone.
fn kill_scope(unit: &str, runtime: &Path, sig: &str) {
    let child = Command::new(SYSTEMCTL)
        .args(["--user", "kill", "--signal", sig, unit])
        .env_clear()
        .env("XDG_RUNTIME_DIR", runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// What ends every process of the command.
enum Tree {
    PidNamespace,
    Scope { unit: String, runtime: PathBuf },
    ProcessGroup,
}

impl Tree {
    fn name(&self) -> &'static str {
        match self {
            Tree::PidNamespace => "pid_namespace",
            Tree::Scope { .. } => "scope",
            Tree::ProcessGroup => "process_group",
        }
    }
    fn kill(&self, pid: i32, sig: libc::c_int) {
        kill_group(pid, sig);
        if let Tree::Scope { unit, runtime } = self {
            kill_scope(
                unit,
                runtime,
                if sig == libc::SIGKILL {
                    "SIGKILL"
                } else {
                    "SIGTERM"
                },
            );
        }
    }
}

/// Ends one contained read-write command for the launch-config stubs (see [`launch::Stubs`]).
struct StubsHeld;
impl Drop for StubsHeld {
    fn drop(&mut self) {
        launch::Stubs::global().end();
    }
}

/// What ran and how it ended.
#[derive(Debug)]
pub struct Ran {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration: Duration,
    /// How the whole tree was ended: `pid_namespace`, `scope` or `process_group`.
    pub tree: &'static str,
    /// Launch entries the command made in its read-write folder, moved aside.
    pub quarantined: Vec<launch::Quarantined>,
}

fn spawn_err(e: std::io::Error) -> CapabilityError {
    match e.kind() {
        std::io::ErrorKind::NotFound => err(ErrorCode::NotFound, "not_found", "command not found"),
        std::io::ErrorKind::PermissionDenied => {
            err(ErrorCode::Forbidden, "os_permission", "permission denied")
        }
        k => err(
            ErrorCode::Internal,
            "spawn_failed",
            &format!("the command could not start ({k})"),
        ),
    }
}

/// Starts the checked command and waits for it, honouring the timeout and the cancel flag.
pub fn run(
    c: &Checked,
    home: &Path,
    ctx: &InvocationContext,
    bwrap: Option<&Path>,
) -> Result<Ran, CapabilityError> {
    // The approved file was replaced at its path (renamed over, removed): it is not run, and
    // nothing else is run in its place. (Moved elsewhere, it still runs: bwrap binds the inode.)
    if c.program.metadata().map(|m| m.nlink()).unwrap_or(0) == 0 {
        return Err(err(
            ErrorCode::BindingMismatch,
            "executable_changed",
            "The executable was replaced since it was approved; it was not run",
        ));
    }
    let mut env = command_env(home, &user_name(), &c.env);
    // Descriptors the child keeps across exec (the executable, the seccomp filter).
    let mut keep: Vec<i32> = Vec::new();
    let mut _filter = None;
    let mut _stubs = None;
    let mut before: Option<launch::Before> = None;
    let tree;
    let mut cmd = if c.contain {
        let Some(bwrap) = bwrap.filter(|b| contain::probe(b, c.network)) else {
            return Err(err(
                ErrorCode::Unavailable,
                "contain_unavailable",
                "The contained shell can't run on this computer (bubblewrap is missing or user namespaces are off); the command was not run",
            ));
        };
        let seccomp_fd = if c.network {
            // With the network on and no filter, unix sockets would be open: refuse instead.
            let program = seccomp::program().ok_or_else(|| {
                err(
                    ErrorCode::Unavailable,
                    "contain_unavailable",
                    "The contained shell can't keep unix sockets closed on this CPU, so it does not run commands with the network; the command was not run",
                )
            })?;
            let fd = seccomp::pipe_with(&program).map_err(|e| {
                err(
                    ErrorCode::Internal,
                    "spawn_failed",
                    &format!("the sandbox filter could not be set up ({})", e.kind()),
                )
            })?;
            let raw = fd.as_raw_fd();
            keep.push(raw);
            _filter = Some(fd);
            Some(raw)
        } else {
            None
        };
        let masks = if c.writable {
            let m = launch::Stubs::global().begin(launch::masks(&c.folder, &c.cwd, &c.read_only));
            _stubs = Some(StubsHeld);
            // What launch entries are there now: any new one afterwards is moved aside.
            before = Some(launch::before(&c.folder, &c.cwd));
            m
        } else {
            launch::Masks::default()
        };
        let sockets: Vec<PathBuf> = ["SSH_AUTH_SOCK", "GPG_AGENT_INFO"]
            .iter()
            .filter_map(std::env::var_os)
            .filter_map(|v| {
                let s = v.to_string_lossy().into_owned();
                // GPG_AGENT_INFO is `path:pid:proto`.
                s.split(':').next().map(PathBuf::from)
            })
            .collect();
        let exe_fd = c.program.as_raw_fd();
        keep.push(exe_fd);
        let plan = contain::Plan {
            home,
            folder: &c.folder,
            writable: c.writable,
            network: c.network,
            cwd: &c.cwd,
            sockets: &sockets,
            read_only: &c.read_only,
            masks: &masks,
            executable: Some((exe_fd, &c.executable)),
            argv0: Some(&c.argv[0]),
            seccomp: seccomp_fd,
        };
        let mut cmd = Command::new(bwrap);
        cmd.args(contain::args(&plan));
        cmd.arg("--");
        cmd.arg(&c.executable);
        tree = Tree::PidNamespace;
        cmd
    } else if let Some(runtime) = scopes_work() {
        // The full account, in a scope of its own. The command sees XDG_RUNTIME_DIR (systemd-run
        // needs it): on the full account it could open that folder anyway.
        let mut rnd = [0u8; 8];
        let _ = getrandom::fill(&mut rnd);
        let unit = format!("psyche-exec-{}.scope", hex(&rnd));
        env.push(("XDG_RUNTIME_DIR".to_string(), runtime.display().to_string()));
        let mut cmd = Command::new(SYSTEMD_RUN);
        cmd.args(["--user", "--scope", "--quiet", "--collect"])
            .arg(format!("--unit={unit}"))
            .arg("--")
            .arg(&c.executable)
            .current_dir(&c.cwd);
        tree = Tree::Scope {
            unit,
            runtime: runtime.clone(),
        };
        cmd
    } else {
        let mut cmd = Command::new(&c.executable);
        // argv[0] as the call wrote it, as a shell would pass it.
        cmd.arg0(OsString::from(&c.argv[0])).current_dir(&c.cwd);
        tree = Tree::ProcessGroup;
        cmd
    };
    cmd.args(&c.argv[1..]);
    cmd.env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    // SAFETY: prctl and fcntl are async-signal-safe and touch only this process; `keep` is not
    // reallocated in the child.
    #[cfg(target_os = "linux")]
    unsafe {
        let keep = keep.clone();
        cmd.pre_exec(move || {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            for fd in &keep {
                let flags = libc::fcntl(*fd, libc::F_GETFD);
                if flags < 0 || libc::fcntl(*fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(spawn_err)?;
    drop(_filter.take());
    let pid = i32::try_from(child.id()).unwrap_or(0);
    let out = Arc::new(Mutex::new(Kept::default()));
    let errs = Arc::new(Mutex::new(Kept::default()));
    let mut readers = Vec::new();
    if let Some(p) = child.stdout.take() {
        readers.push(pump(p, "stdout", Arc::clone(&ctx.emit), Arc::clone(&out)));
    }
    if let Some(p) = child.stderr.take() {
        readers.push(pump(p, "stderr", Arc::clone(&ctx.emit), Arc::clone(&errs)));
    }
    let mut timed_out = false;
    let mut cancelled = false;
    let mut term_at: Option<Instant> = None;
    let mut killed = false;
    let status = loop {
        match leader_exited(&mut child) {
            Ok(true) => break true,
            Ok(false) => {}
            Err(_) => break false,
        }
        if term_at.is_none() {
            if ctx.cancelled.load(Ordering::SeqCst) {
                cancelled = true;
            } else if started.elapsed() >= c.timeout {
                timed_out = true;
            }
            if cancelled || timed_out {
                tree.kill(pid, libc::SIGTERM);
                term_at = Some(Instant::now());
            }
        } else if !killed && term_at.is_some_and(|t| t.elapsed() >= KILL_GRACE) {
            tree.kill(pid, libc::SIGKILL);
            killed = true;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Whatever is left (a child that kept the pipes open, a `setsid` one in the scope) goes too.
    // The leader is not reaped yet, so its group id cannot have been reused by anyone else.
    tree.kill(pid, libc::SIGKILL);
    let status = if status { child.wait().ok() } else { None };
    for r in readers {
        let _ = r.join();
    }
    let take = |k: &Arc<Mutex<Kept>>| {
        let k = k.lock().unwrap_or_else(|e| e.into_inner());
        let text = String::from_utf8_lossy(&k.bytes).into_owned();
        // Cut again by encoded size: the whole result is one frame.
        let (text, cut) = fit::fit_str(&text, EXEC_OUTPUT_JSON_BUDGET);
        (text, k.truncated || cut)
    };
    let (stdout, t1) = take(&out);
    let (stderr, t2) = take(&errs);
    // The sandbox is gone: new launch entries the command made are moved aside (stubs other
    // commands still mount over stay), then this command's stubs go.
    let quarantined = before
        .map(|b| launch::quarantine(&c.folder, &c.cwd, &b))
        .unwrap_or_default();
    drop(_stubs);
    Ok(Ran {
        exit_code: status.and_then(|s| s.code()),
        signal: status.and_then(|s| s.signal()),
        stdout,
        stderr,
        truncated: t1 || t2,
        timed_out,
        cancelled,
        duration: started.elapsed(),
        tree: tree.name(),
        quarantined,
    })
}

/// The capability.
pub struct ExecHost {
    pub source: Arc<PolicySource>,
    pub journal: Journal,
    /// Where bwrap is (tests aim it elsewhere, or nowhere).
    pub bwrap: Option<PathBuf>,
}

impl ExecHost {
    pub fn call(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        if ctx.approval_id.as_deref().is_none_or(str::is_empty) {
            return Err(err(
                ErrorCode::ApprovalRequired,
                "host_exec_always_asks",
                "exec.host always needs an approval",
            ));
        }
        let loaded = self.source.load();
        let home = &self.source.home;
        let checked = check(&loaded.policy, home, &ctx.params)?;
        let argv_sha = {
            let json = serde_json::to_vec(&checked.argv).unwrap_or_default();
            format!("sha256:{}", hex(&Sha256::digest(&json)))
        };
        let program = checked
            .executable
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ran = run(&checked, home, ctx, self.bwrap.as_deref());
        let (exit, outcome) = match &ran {
            Ok(r) if r.cancelled => (String::new(), "cancelled"),
            Ok(r) if r.timed_out => (String::new(), "timed_out"),
            Ok(r) => (
                r.exit_code.map(|c| c.to_string()).unwrap_or_default(),
                if r.exit_code == Some(0) {
                    "ok"
                } else {
                    "failed"
                },
            ),
            Err(e) => (
                String::new(),
                if e.reason == "contain_unavailable" {
                    "not_run"
                } else {
                    "error"
                },
            ),
        };
        self.journal.send(
            "exec",
            &format!(
                "psyche ran {program} in {} ({outcome})",
                checked.cwd.display()
            ),
            &[
                ("program", checked.executable.display().to_string()),
                ("argv_sha256", argv_sha),
                ("cwd", checked.cwd.display().to_string()),
                ("contained", checked.contain.to_string()),
                ("network", checked.network.to_string()),
                ("outcome", outcome.into()),
                ("exit_code", exit),
                (
                    "duration_ms",
                    ran.as_ref()
                        .map(|r| r.duration.as_millis().to_string())
                        .unwrap_or_default(),
                ),
            ],
        );
        let ran = ran?;
        if ran.cancelled {
            return Err(err(
                ErrorCode::Cancelled,
                "cancelled",
                "exec.host was cancelled; its processes were killed",
            ));
        }
        Ok(json!({
            "exitCode": ran.exit_code,
            "signal": ran.signal,
            "stdout": ran.stdout,
            "stderr": ran.stderr,
            "truncated": ran.truncated,
            "timedOut": ran.timed_out,
            "durationMs": u64::try_from(ran.duration.as_millis()).unwrap_or(u64::MAX),
            "executable": checked.executable.display().to_string(),
            "executableSha256": checked.sha256,
            "cwd": checked.cwd.display().to_string(),
            "contained": checked.contain,
            "network": checked.network,
            "tree": ran.tree,
            "quarantined": ran.quarantined.iter().map(|q| json!({
                "path": q.path.display().to_string(),
                "movedTo": q.moved_to.display().to_string(),
            })).collect::<Vec<_>>(),
        }))
    }
}

impl Capability for ExecHost {
    fn spec(&self) -> CapabilitySpec {
        CapabilitySpec {
            name: "exec.host",
            description: "Run one approved argv on this computer, no shell, in a granted folder. Contained by default, without the network unless granted. Always needs an approval and the executable's SHA-256 from exec.resolve.",
            side_effect: SideEffect::Destructive,
            target_kind: Some(TargetKind::Command),
            streaming: true,
        }
    }

    fn input_schema(&self) -> Option<Value> {
        let mut props = Map::new();
        props.insert(
            "argv".into(),
            json!({ "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 256 }),
        );
        for key in ["cwd", "folder"] {
            props.insert(
                key.into(),
                json!({ "type": "string", "minLength": 1, "maxLength": 4096 }),
            );
        }
        props.insert(
            "folderMode".into(),
            json!({ "type": "string", "enum": ["ro", "rw"] }),
        );
        props.insert(
            "folderId".into(),
            json!({ "type": "string", "maxLength": 64 }),
        );
        props.insert(
            "env".into(),
            json!({ "type": "object", "additionalProperties": { "type": "string" } }),
        );
        props.insert(
            "timeoutMs".into(),
            json!({ "type": "integer", "minimum": 1, "maximum": EXEC_TIMEOUT_MS_MAX }),
        );
        props.insert(
            "expectSha256".into(),
            json!({ "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }),
        );
        props.insert("expectContained".into(), json!({ "type": "boolean" }));
        props.insert("network".into(), json!({ "type": "boolean" }));
        Some(json!({
            "type": "object",
            "properties": props,
            "required": ["argv", "cwd", "expectSha256"],
            "additionalProperties": false,
        }))
    }

    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        self.call(ctx)
    }
}

/// `exec.resolve` (read): the executable and its hash, before the card.
pub struct ExecResolve {
    pub source: Arc<PolicySource>,
}

impl Capability for ExecResolve {
    fn spec(&self) -> CapabilitySpec {
        CapabilitySpec {
            name: "exec.resolve",
            description: "Which file argv[0] runs in cwd on this computer and its SHA-256, and whether commands here are contained and may get the network. Runs nothing.",
            side_effect: SideEffect::Read,
            target_kind: Some(TargetKind::Command),
            streaming: false,
        }
    }

    fn input_schema(&self) -> Option<Value> {
        Some(json!({
            "type": "object",
            "properties": {
                "argv0": { "type": "string", "minLength": 1, "maxLength": 4096 },
                "cwd": { "type": "string", "minLength": 1, "maxLength": 4096 },
            },
            "required": ["argv0", "cwd"],
            "additionalProperties": false,
        }))
    }

    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        let loaded = self.source.load();
        resolve(&loaded.policy, &self.source.home, &ctx.params)
    }
}

/// Registers `exec.host` and `exec.resolve` (remote mode only; the policy gate wraps them too).
pub fn register(registry: &mut Registry, source: Arc<PolicySource>, journal: Journal) {
    registry.register(Arc::new(ExecResolve {
        source: Arc::clone(&source),
    }));
    registry.register(Arc::new(ExecHost {
        source,
        journal,
        bwrap: contain::find_bwrap(),
    }));
}

#[cfg(test)]
mod tests;
