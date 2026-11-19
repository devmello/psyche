//! The Xvfb process: a free display from 90, a private authority file, a child of the helper
//! that dies with it (linux-desktop design §7.4).
//!
//! Trust in the server comes from the server, never from a probe:
//! - **Ready means ours.** Xvfb runs with `-displayfd`, and writes its display number there only
//!   once it holds the display's lock and listens. A display another account took first makes
//!   our Xvfb exit instead.
//! - **Every connection is checked.** Before a stream is used, `SO_PEERCRED` must name our child
//!   and our uid. A server another account bound on the same name (the socket file or the
//!   abstract socket) is refused.
//! - **It dies with the helper.** It is forked from the process-lifetime spawner thread
//!   (`spawn.rs`), so `PR_SET_PDEATHSIG` fires when the helper exits, not when a call returns.
//! - **Cleanup touches only our files.** `stop` runs once; it removes the lock and the socket
//!   only while the lock still names our server, and the authority file name is unique per start.

use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::spawn::{check_peer, spawn_tied};
use super::xauth::{self, Cookie};

#[derive(Debug, Clone)]
pub struct XvfbConfig {
    pub width: u32,
    pub height: u32,
    /// Where to start looking for a free display number (the design says 90).
    pub first_display: u32,
    pub xvfb_path: String,
    /// `$XDG_RUNTIME_DIR`, for `psyche/xauth-<n>-<random>`.
    pub runtime_dir: Option<String>,
    pub ready_timeout: Duration,
}

impl XvfbConfig {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            first_display: 90,
            xvfb_path: "Xvfb".into(),
            runtime_dir: std::env::var("XDG_RUNTIME_DIR")
                .ok()
                .filter(|v| !v.is_empty()),
            ready_timeout: Duration::from_secs(8),
        }
    }
}

pub struct XvfbServer {
    child: Child,
    pub display_number: u32,
    pub cookie: Cookie,
    pub xauthority: PathBuf,
    pub width: u32,
    pub height: u32,
    stopped: bool,
}

pub fn socket_path(n: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{n}"))
}

pub fn lock_path(n: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X{n}-lock"))
}

/// The pid an X lock file names (`/tmp/.X<n>-lock` holds it as text, padded).
pub fn lock_pid(lock: &Path) -> Option<u32> {
    std::fs::read_to_string(lock).ok()?.trim().parse().ok()
}

/// Connects to display `n` without checking who answers: the socket file when there is one,
/// else the abstract socket of the same name. Only for "is the number taken?" probes; anything
/// that sends data uses `connect_verified`.
pub fn connect_stream(n: u32) -> std::io::Result<UnixStream> {
    match UnixStream::connect(socket_path(n)) {
        Ok(s) => Ok(s),
        Err(file_err) => connect_abstract(n).map_err(|_| file_err),
    }
}

fn connect_abstract(n: u32) -> std::io::Result<UnixStream> {
    #[cfg(target_os = "linux")]
    {
        use std::os::linux::net::SocketAddrExt;
        let name = format!("/tmp/.X11-unix/X{n}");
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
        UnixStream::connect_addr(&addr)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = n;
        Err(std::io::Error::other("no abstract sockets here"))
    }
}

/// Connects to display `n` and accepts the stream only when the server behind it is `server_pid`
/// running as this user. Tries the socket file, then the abstract socket (where
/// `/tmp/.X11-unix` is read-only, as under WSLg, Xvfb has only the abstract one).
pub fn connect_verified(n: u32, server_pid: u32) -> Result<UnixStream, String> {
    let mut why = Vec::new();
    for (what, attempt) in [
        ("socket file", UnixStream::connect(socket_path(n))),
        ("abstract socket", connect_abstract(n)),
    ] {
        match attempt {
            Ok(stream) => match check_peer(&stream, server_pid) {
                Ok(()) => return Ok(stream),
                Err(e) => why.push(format!("{what}: {e}")),
            },
            Err(e) => why.push(format!("{what}: {e}")),
        }
    }
    Err(format!(":{n} is not our server ({})", why.join("; ")))
}

/// Whether display `n` looks taken: its socket or lock file exists and something answers or
/// lives behind it. A stale lock from a dead server does not count. This only picks a number to
/// try; `-displayfd` and the peer check decide whether the server is ours.
pub fn display_in_use(n: u32) -> bool {
    if connect_stream(n).is_ok() {
        return true;
    }
    match std::fs::read_to_string(lock_path(n)) {
        Ok(text) => text
            .trim()
            .parse::<i32>()
            // SAFETY: signal 0 only checks that the process exists.
            .map(|pid| unsafe { libc::kill(pid, 0) } == 0)
            .unwrap_or(true),
        Err(_) => false,
    }
}

/// Removes a dead server's socket and lock, but only while the lock still names `pid`: anyone
/// who took the display number since has written their own pid there.
pub fn remove_if_ours(socket: &Path, lock: &Path, pid: u32) {
    if lock_pid(lock) == Some(pid) {
        let _ = std::fs::remove_file(socket);
        let _ = std::fs::remove_file(lock);
    }
}

/// A pipe for `-displayfd`: (read end, write end), both close-on-exec in this process.
fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` has room for the two descriptors pipe2 writes.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: pipe2 just returned these descriptors and nothing else owns them.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// Waits until `fd` is readable (or at EOF) or `timeout` passes.
fn readable(fd: &impl AsRawFd, timeout: Duration) -> bool {
    let mut p = libc::pollfd {
        fd: fd.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
    // SAFETY: one valid pollfd.
    unsafe { libc::poll(&mut p, 1, ms) > 0 }
}

/// The display number Xvfb wrote to its `-displayfd` (`"90\n"`).
pub fn parse_displayfd(text: &str) -> Option<u32> {
    let line = text.strip_suffix('\n')?;
    if line.is_empty() || !line.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    line.parse().ok()
}

impl XvfbServer {
    pub fn start(config: &XvfbConfig) -> Result<XvfbServer, String> {
        let dir = xauth::runtime_dir(config.runtime_dir.as_deref())
            .map_err(|e| format!("runtime dir: {e}"))?;
        let cookie = xauth::new_cookie().map_err(|e| format!("cookie: {e}"))?;
        let mut last = String::from("no free display");
        for n in config.first_display..config.first_display + 40 {
            if display_in_use(n) {
                continue;
            }
            let name = xauth::file_name(n).map_err(|e| format!("auth file name: {e}"))?;
            let auth = dir.join(name);
            xauth::write_file(&auth, n, &cookie).map_err(|e| format!("auth file: {e}"))?;
            match Self::spawn_on(config, n, &auth, cookie) {
                Ok(server) => return Ok(server),
                Err(e) => {
                    crate::log(&format!("vscreen: display :{n}: {e}"));
                    let _ = std::fs::remove_file(&auth);
                    last = e;
                }
            }
        }
        Err(last)
    }

    fn spawn_on(
        config: &XvfbConfig,
        n: u32,
        auth: &Path,
        cookie: Cookie,
    ) -> Result<XvfbServer, String> {
        let (read_end, write_end) = pipe().map_err(|e| format!("pipe: {e}"))?;
        let write_fd = write_end.as_raw_fd();
        let mut cmd = Command::new(&config.xvfb_path);
        cmd.arg(format!(":{n}"))
            .args(["-screen", "0"])
            .arg(format!("{}x{}x24", config.width, config.height))
            .args(["-nolisten", "tcp", "-noreset", "-auth"])
            .arg(auth)
            .arg("-displayfd")
            .arg(write_fd.to_string())
            .env_clear()
            .env(
                "PATH",
                std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into()),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: fcntl is async-signal-safe. The write end stays open across exec in the child
        // only; this process keeps it close-on-exec, so no other child inherits it.
        unsafe {
            cmd.pre_exec(move || {
                if libc::fcntl(write_fd, libc::F_SETFD, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = spawn_tied(cmd);
        // Our copy of the write end goes now, so the read end sees EOF if Xvfb exits.
        drop(write_end);
        let mut child = child.map_err(|e| format!("could not start {}: {e}", config.xvfb_path))?;
        let fail = |child: &mut Child, why: String| {
            let _ = child.kill();
            let _ = child.wait();
            Err(why)
        };
        let deadline = Instant::now() + config.ready_timeout;
        let mut reader = std::fs::File::from(read_end);
        let mut got = Vec::new();
        while !got.ends_with(b"\n") {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Xvfb :{n} exited at start ({status})"));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return fail(&mut child, format!("Xvfb :{n} did not become ready"));
            }
            if !readable(&reader, left.min(Duration::from_millis(100))) {
                continue;
            }
            let mut buf = [0u8; 16];
            match reader.read(&mut buf) {
                Ok(0) => {
                    let _ = child.wait();
                    return Err(format!("Xvfb :{n} closed -displayfd without a number"));
                }
                Ok(k) => got.extend_from_slice(&buf[..k]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(e) => return fail(&mut child, format!("-displayfd: {e}")),
            }
            if got.len() > 16 {
                return fail(&mut child, "-displayfd: too long".into());
            }
        }
        match parse_displayfd(&String::from_utf8_lossy(&got)) {
            Some(reported) if reported == n => {}
            other => {
                return fail(
                    &mut child,
                    format!("Xvfb reported display {other:?}, not :{n}"),
                )
            }
        }
        // Ready and ours by its own word; now prove that what answers on :n is this child.
        if let Err(e) = connect_verified(n, child.id()) {
            return fail(&mut child, e);
        }
        Ok(XvfbServer {
            child,
            display_number: n,
            cookie,
            xauthority: auth.to_path_buf(),
            width: config.width,
            height: config.height,
            stopped: false,
        })
    }

    pub fn display(&self) -> String {
        format!(":{}", self.display_number)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn is_running(&mut self) -> bool {
        !self.stopped && matches!(self.child.try_wait(), Ok(None))
    }

    /// Stops the server and removes its files. Runs once: a later call (the `Drop` of an old
    /// handle) does nothing, so it can never touch a newer server's files.
    pub fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let pid = self.child.id();
        if matches!(self.child.try_wait(), Ok(None)) {
            // SIGTERM first: Xvfb then removes its own lock and sockets.
            // SAFETY: `pid` is our own child, not yet reaped.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline && matches!(self.child.try_wait(), Ok(None)) {
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.xauthority);
        remove_if_ours(
            &socket_path(self.display_number),
            &lock_path(self.display_number),
            pid,
        );
    }
}

impl Drop for XvfbServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displayfd_text_is_a_number_and_a_newline() {
        assert_eq!(parse_displayfd("90\n"), Some(90));
        assert_eq!(parse_displayfd("90"), None, "not finished yet");
        for bad in ["\n", "9 0\n", "-1\n", "x\n", "90\n91\n"] {
            assert_eq!(parse_displayfd(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn only_our_lock_and_socket_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join(".X90-lock");
        let socket = dir.path().join("X90");
        std::fs::write(&socket, "").unwrap();
        // Someone else's server took the number: their pid is in the lock.
        std::fs::write(&lock, "      4242\n").unwrap();
        remove_if_ours(&socket, &lock, 1111);
        assert!(lock.exists() && socket.exists(), "a stranger's files stay");
        // Our dead server's lock: both go.
        std::fs::write(&lock, "      1111\n").unwrap();
        remove_if_ours(&socket, &lock, 1111);
        assert!(!lock.exists() && !socket.exists());
        // No lock at all (Xvfb cleaned up after itself): nothing to do, nothing fails.
        std::fs::write(&socket, "").unwrap();
        remove_if_ours(&socket, &lock, 1111);
        assert!(socket.exists());
    }

    #[test]
    fn a_second_stop_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let auth = dir.path().join("xauth-990-aaaa");
        std::fs::write(&auth, "x").unwrap();
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let mut server = XvfbServer {
            child,
            display_number: 990,
            cookie: [0; 16],
            xauthority: auth.clone(),
            width: 1,
            height: 1,
            stopped: false,
        };
        assert!(server.is_running());
        server.stop();
        assert!(!server.is_running());
        assert!(!auth.exists());
        // A newer server's file under the same name (not possible with unique names, but the
        // flag must hold on its own): the late stop from Drop leaves it.
        std::fs::write(&auth, "newer").unwrap();
        server.stop();
        drop(server);
        assert_eq!(std::fs::read_to_string(&auth).unwrap(), "newer");
    }
}
