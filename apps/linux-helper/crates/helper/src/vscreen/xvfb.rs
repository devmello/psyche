//! The Xvfb process: first free display from 90, a private authority file, a child of the helper
//! that dies with it (linux-desktop design §7.4).

use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use super::xauth::{self, Cookie};

#[derive(Debug, Clone)]
pub struct XvfbConfig {
    pub width: u32,
    pub height: u32,
    /// Where to start looking for a free display number (the design says 90).
    pub first_display: u32,
    pub xvfb_path: String,
    /// `$XDG_RUNTIME_DIR`, for `psyche/xauth-<n>`.
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
            runtime_dir: std::env::var("XDG_RUNTIME_DIR").ok().filter(|v| !v.is_empty()),
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
}

pub fn socket_path(n: u32) -> PathBuf {
    PathBuf::from(format!("/tmp/.X11-unix/X{n}"))
}

/// Whether display `n` looks taken: its socket or lock file exists and something answers or
/// lives behind it. A stale lock from a dead server does not count.
pub fn display_in_use(n: u32) -> bool {
    if socket_path(n).exists() && UnixStream::connect(socket_path(n)).is_ok() {
        return true;
    }
    match std::fs::read_to_string(format!("/tmp/.X{n}-lock")) {
        Ok(text) => text
            .trim()
            .parse::<i32>()
            // SAFETY: signal 0 only checks that the process exists.
            .map(|pid| unsafe { libc::kill(pid, 0) } == 0)
            .unwrap_or(true),
        Err(_) => false,
    }
}

impl XvfbServer {
    pub fn start(config: &XvfbConfig) -> Result<XvfbServer, String> {
        let dir = xauth::runtime_dir(config.runtime_dir.as_deref())
            .map_err(|e| format!("runtime dir: {e}"))?;
        let cookie = xauth::new_cookie().map_err(|e| format!("cookie: {e}"))?;
        let host = xauth::hostname();
        let mut last = String::from("no free display");
        for n in config.first_display..config.first_display + 40 {
            if display_in_use(n) {
                continue;
            }
            let auth = dir.join(format!("xauth-{n}"));
            xauth::write_file(&auth, &host, n, &cookie).map_err(|e| format!("auth file: {e}"))?;
            match Self::spawn_on(config, n, &auth, cookie) {
                Ok(server) => return Ok(server),
                Err(e) => {
                    let _ = std::fs::remove_file(&auth);
                    last = e;
                }
            }
        }
        Err(last)
    }

    fn spawn_on(config: &XvfbConfig, n: u32, auth: &Path, cookie: Cookie) -> Result<XvfbServer, String> {
        let mut cmd = Command::new(&config.xvfb_path);
        cmd.arg(format!(":{n}"))
            .args(["-screen", "0"])
            .arg(format!("{}x{}x24", config.width, config.height))
            .args(["-nolisten", "tcp", "-noreset", "-auth"])
            .arg(auth)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: only async-signal-safe calls (prctl) between fork and exec. The server must
        // not outlive the helper, and a server left behind would keep the display number.
        unsafe {
            cmd.pre_exec(|| {
                #[cfg(target_os = "linux")]
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start {}: {e}", config.xvfb_path))?;
        let deadline = Instant::now() + config.ready_timeout;
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Xvfb :{n} exited at start ({status})"));
            }
            if UnixStream::connect(socket_path(n)).is_ok() {
                return Ok(XvfbServer {
                    child,
                    display_number: n,
                    cookie,
                    xauthority: auth.to_path_buf(),
                    width: config.width,
                    height: config.height,
                });
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Xvfb :{n} did not become ready"));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn display(&self) -> String {
        format!(":{}", self.display_number)
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Stops the server and removes the authority file.
    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(&self.xauthority);
        let _ = std::fs::remove_file(socket_path(self.display_number));
        let _ = std::fs::remove_file(format!("/tmp/.X{}-lock", self.display_number));
    }
}

impl Drop for XvfbServer {
    fn drop(&mut self) {
        self.stop();
    }
}
