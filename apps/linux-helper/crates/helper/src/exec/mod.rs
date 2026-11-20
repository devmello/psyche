//! `exec.host` on a machine (design §5.1): one approved argv, never a shell string.
//!
//! - **Refused without an `approvalId`.** The Gateway asks first (the card names the machine,
//!   argv, cwd and env), and the helper never runs a command it was not told was approved.
//! - **Where:** `cwd` must be a real directory inside `folder` (the folder the owner granted on
//!   this machine), and `folder` inside one of the ceiling's `exec.cwdRoots`, after symlinks, and
//!   neither may be a protected path. A read-write folder may not hold a protected path or the
//!   home folder itself, so a contained command cannot plant rc files, units or autostart entries.
//! - **What:** argv[0] by absolute path, `./relative` to cwd, or a bare name from a fixed list of
//!   system folders (never a `PATH` from the call). The helper reports the real executable and
//!   its SHA-256; with `expectSha256` (a standing grant pinned it) a different binary is refused.
//! - **Environment:** built from nothing: `PATH` (the fixed list), `HOME`, `USER`, `LOGNAME`,
//!   `LANG`, `TMPDIR=/tmp`, then the call's own `env`, whose names may not change what runs or
//!   where code loads from. No `SSH_AUTH_SOCK`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`,
//!   `XDG_RUNTIME_DIR`, `DISPLAY` or `XAUTHORITY` ever reaches a command.
//! - **Contained by default** under `bwrap` ([`contain`]); `contain: false` in the ceiling runs it
//!   on the full account. Either way `PR_SET_NO_NEW_PRIVS` is set before exec, so sudo, pkexec
//!   and setuid programs cannot raise privileges.
//! - **Bounded:** stdout and stderr stream as `node.event` `{stream, text}` and are each kept up
//!   to [`EXEC_OUTPUT_CAP_BYTES`]; a timeout, a `node.cancel` or the connection closing (a revoke)
//!   kills the whole process group (TERM, then KILL after a grace period).
//! - One journal line per command: program, argv hash, cwd, exit code, duration. Never output.

pub mod contain;

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psyche_protocol::{ErrorCode, SideEffect, TargetKind};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::capability::{Capability, CapabilityError, CapabilitySpec, InvocationContext, Registry};
use crate::fs::protected;
use crate::journal::Journal;
use crate::remote::policy::{Policy, PolicySource};

/// The Gateway's `EXEC_OUTPUT_CAP_BYTES`: kept per stream.
pub const EXEC_OUTPUT_CAP_BYTES: usize = 128 * 1024;
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
const KEYS: &[&str] = &[
    "argv",
    "cwd",
    "folder",
    "folderMode",
    "env",
    "timeoutMs",
    "expectSha256",
];

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

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("sha256:{hex}"))
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
    pub contain: bool,
    pub network: bool,
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

    if !policy.exec.enabled {
        return Err(err(
            ErrorCode::Forbidden,
            "machine_policy",
            "This computer's limits do not allow running commands",
        ));
    }
    let refuse = |reason: &str, message: String| err(ErrorCode::Forbidden, reason, &message);
    // Absolute, real directories, the folder inside a ceiling root and the cwd inside the folder.
    let real_dir = |raw: &str, what: &str| -> Result<PathBuf, CapabilityError> {
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
        Ok(real)
    };
    let folder = real_dir(folder_raw, "folder")?;
    let cwd = real_dir(cwd_raw, "cwd")?;
    if !cwd.starts_with(&folder) {
        return Err(refuse(
            "outside_folder",
            format!("{cwd_raw} is outside the granted folder"),
        ));
    }
    let in_roots = policy.exec.cwd_roots.iter().any(|r| {
        expand(r, home)
            .and_then(|r| std::fs::canonicalize(r).ok())
            .is_some_and(|r| folder.starts_with(r))
    });
    if !in_roots {
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
    let executable = resolve_executable(&argv[0], &cwd)?;
    if protected::hidden_paths(home)
        .iter()
        .any(|h| executable.starts_with(h))
    {
        return Err(refuse(
            "protected_path",
            format!("{} is protected", executable.display()),
        ));
    }
    let sha256 = sha256_file(&executable).map_err(|e| {
        err(
            ErrorCode::Unavailable,
            "unreadable",
            &format!("{}: {}", executable.display(), e.kind()),
        )
    })?;
    if let Some(want) = expect {
        if want != sha256 {
            return Err(err(
                ErrorCode::BindingMismatch,
                "executable_changed",
                "The executable changed since it was approved",
            ));
        }
    }
    Ok(Checked {
        argv,
        cwd,
        folder,
        writable,
        env,
        timeout: Duration::from_millis(timeout_ms),
        executable,
        sha256,
        contain: policy.exec.contain,
        network: policy.exec.network,
    })
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
}

/// Starts the checked command and waits for it, honouring the timeout and the cancel flag.
pub fn run(
    c: &Checked,
    home: &Path,
    ctx: &InvocationContext,
    bwrap: Option<&Path>,
) -> Result<Ran, CapabilityError> {
    let env = command_env(home, &user_name(), &c.env);
    let mut cmd = if c.contain {
        let Some(bwrap) = bwrap.filter(|b| contain::probe(b, c.network)) else {
            return Err(err(
                ErrorCode::Unavailable,
                "contain_unavailable",
                "The contained shell can't run on this computer (bubblewrap is missing or user namespaces are off); the command was not run",
            ));
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
        // SAFETY: getuid cannot fail.
        let uid = unsafe { libc::getuid() };
        let plan = contain::Plan {
            home,
            uid,
            folder: &c.folder,
            writable: c.writable,
            network: c.network,
            cwd: &c.cwd,
            sockets: &sockets,
        };
        let mut cmd = Command::new(bwrap);
        cmd.args(contain::args(&plan));
        cmd.arg("--");
        cmd.arg(&c.executable);
        cmd
    } else {
        let mut cmd = Command::new(&c.executable);
        cmd.current_dir(&c.cwd);
        cmd
    };
    cmd.args(&c.argv[1..]);
    // argv[0] as the call wrote it, as a shell would pass it.
    if !c.contain {
        cmd.arg0(OsString::from(&c.argv[0]));
    }
    cmd.env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    // SAFETY: prctl is async-signal-safe and touches only this process.
    #[cfg(target_os = "linux")]
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let started = Instant::now();
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => err(ErrorCode::NotFound, "not_found", "command not found"),
        std::io::ErrorKind::PermissionDenied => {
            err(ErrorCode::Forbidden, "os_permission", "permission denied")
        }
        k => err(
            ErrorCode::Internal,
            "spawn_failed",
            &format!("the command could not start ({k})"),
        ),
    })?;
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
                kill_group(pid, libc::SIGTERM);
                term_at = Some(Instant::now());
            }
        } else if term_at.is_some_and(|t| t.elapsed() >= KILL_GRACE) {
            kill_group(pid, libc::SIGKILL);
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Whatever is left of the group (a child that kept the pipes open) goes too. The leader is
    // not reaped yet, so its group id cannot have been reused by anyone else.
    kill_group(pid, libc::SIGKILL);
    let status = if status { child.wait().ok() } else { None };
    for r in readers {
        let _ = r.join();
    }
    let take = |k: &Arc<Mutex<Kept>>| {
        let k = k.lock().unwrap_or_else(|e| e.into_inner());
        (String::from_utf8_lossy(&k.bytes).into_owned(), k.truncated)
    };
    let (stdout, t1) = take(&out);
    let (stderr, t2) = take(&errs);
    Ok(Ran {
        exit_code: status.and_then(|s| s.code()),
        signal: status.and_then(|s| s.signal()),
        stdout,
        stderr,
        truncated: t1 || t2,
        timed_out,
        cancelled,
        duration: started.elapsed(),
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
            let hex: String = Sha256::digest(&json)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            format!("sha256:{hex}")
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
                "exec.host was cancelled; its process group was killed",
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
        }))
    }
}

impl Capability for ExecHost {
    fn spec(&self) -> CapabilitySpec {
        CapabilitySpec {
            name: "exec.host",
            description: "Run one approved argv on this computer, no shell, in a granted folder. Contained by default. Always needs an approval.",
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
        props.insert(
            "cwd".into(),
            json!({ "type": "string", "minLength": 1, "maxLength": 4096 }),
        );
        props.insert(
            "folder".into(),
            json!({ "type": "string", "minLength": 1, "maxLength": 4096 }),
        );
        props.insert(
            "folderMode".into(),
            json!({ "type": "string", "enum": ["ro", "rw"] }),
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
        Some(json!({
            "type": "object",
            "properties": props,
            "required": ["argv", "cwd"],
            "additionalProperties": false,
        }))
    }

    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        self.call(ctx)
    }
}

/// Registers `exec.host` (remote mode only; the policy gate wraps it too).
pub fn register(registry: &mut Registry, source: Arc<PolicySource>, journal: Journal) {
    registry.register(Arc::new(ExecHost {
        source,
        journal,
        bwrap: contain::find_bwrap(),
    }));
}

#[cfg(test)]
mod tests;
