//! Keeps the helper connected: connect -> handshake -> serve, reconnecting with capped
//! exponential backoff when the Gateway restarts, while pairing is pending, or after a denial.
//! Exits when the helper has been idle for the quiet period (design §4.4).

use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::backoff::{random_unit, Backoff};
use crate::capability::Registry;
use crate::channel::FrameReader;
use crate::handshake::{perform, HandshakeOptions, Paired};
use crate::identity::DeviceIdentity;
use crate::idle::IdleTimer;
use crate::paths::{self, Env};
use crate::session::{serve, ServeEnd};

/// Read timeout on the node socket: how often the serve loop wakes to check the idle timer.
const TICK: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Paired, served, and the Gateway closed the connection.
    Served,
    /// Paired and idle for the whole quiet period.
    Idle,
    Pending {
        code: Option<String>,
    },
    Denied,
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Exit {
    Stopped,
    Idle,
}

pub struct Daemon {
    identity: DeviceIdentity,
    registry: Registry,
    socket: PathBuf,
    secret_env: Box<dyn Env + Send + Sync>,
    backoff: Backoff,
    idle: Arc<IdleTimer>,
    stop: Arc<AtomicBool>,
}

impl Daemon {
    pub fn new(
        identity: DeviceIdentity,
        registry: Registry,
        env: Box<dyn Env + Send + Sync>,
        idle: Arc<IdleTimer>,
    ) -> Self {
        Self {
            identity,
            registry,
            socket: paths::node_socket_path(env.as_ref()),
            secret_env: env,
            backoff: Backoff::default(),
            idle,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_backoff(mut self, backoff: Backoff) -> Self {
        self.backoff = backoff;
        self
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    /// Runs until stopped or idle.
    pub fn run(&mut self) -> Exit {
        while !self.stopped() {
            let delay = match self.run_once() {
                Outcome::Idle => return Exit::Idle,
                Outcome::Served => {
                    self.backoff.reset();
                    self.backoff.initial
                }
                Outcome::Pending { .. } => self.backoff.pending_retry,
                Outcome::Denied => self.backoff.denied_retry,
                Outcome::Failed => self.backoff.next_failure(random_unit()),
            };
            if self.sleep(delay) {
                return Exit::Idle;
            }
        }
        Exit::Stopped
    }

    /// Sleeps `delay` in slices. Returns true when the idle timer ran out meanwhile (nothing is
    /// connected, so nothing is in flight).
    fn sleep(&self, delay: Duration) -> bool {
        let deadline = Instant::now() + delay;
        while !self.stopped() && Instant::now() < deadline {
            if self.idle.expired(0) {
                return true;
            }
            std::thread::sleep(TICK.min(deadline.saturating_duration_since(Instant::now())));
        }
        false
    }

    /// One connect -> handshake -> serve cycle.
    pub fn run_once(&self) -> Outcome {
        let stream = match UnixStream::connect(&self.socket) {
            Ok(s) => s,
            Err(e) => {
                // A Gateway that is not up yet is normal; anything else is worth a line.
                if e.kind() != std::io::ErrorKind::NotFound
                    && e.kind() != std::io::ErrorKind::ConnectionRefused
                {
                    crate::log(&format!("connect failed: {:?}", e.kind()));
                }
                return Outcome::Failed;
            }
        };
        if stream.set_read_timeout(Some(TICK)).is_err() {
            return Outcome::Failed;
        }
        let Ok(write_half) = stream.try_clone() else {
            return Outcome::Failed;
        };
        let mut reader = FrameReader::new(stream);
        let mut writer = write_half;
        let options = HandshakeOptions {
            timeout: Duration::from_secs(10),
            handshake_secret: paths::read_handshake_secret(self.secret_env.as_ref()),
            capabilities: self.registry.manifest(),
        };
        crate::log(&format!(
            "phase=connecting capabilities={}",
            options.capabilities.len()
        ));
        match perform(&mut reader, &mut writer, &self.identity, &options) {
            Ok(Paired::Paired) => {
                crate::log(&format!("serving capabilities={}", self.registry.len()));
                self.idle.touch();
                match serve(
                    &mut reader,
                    writer,
                    self.registry.clone(),
                    Arc::clone(&self.idle),
                ) {
                    Ok(ServeEnd::Idle) => {
                        crate::log("idle: exiting");
                        Outcome::Idle
                    }
                    Ok(ServeEnd::Closed) => {
                        crate::log("gateway closed the connection");
                        Outcome::Served
                    }
                    Err(e) => {
                        crate::log(&format!("connection failed: {e}"));
                        Outcome::Failed
                    }
                }
            }
            Ok(Paired::Pending { code }) => {
                // The code is shown to the owner to compare in the desktop app; it is not a secret.
                crate::log(&format!(
                    "pairing pending: approve this device in Psyche (code {})",
                    code.as_deref().unwrap_or("?")
                ));
                Outcome::Pending { code }
            }
            Ok(Paired::Denied { .. }) => {
                crate::log("pairing denied");
                Outcome::Denied
            }
            Err(e) => {
                crate::log(&format!("handshake failed: {e}"));
                Outcome::Failed
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;

    fn env_for(home: &std::path::Path) -> Box<dyn Env + Send + Sync> {
        let mut m = HashMap::new();
        m.insert(
            "PSYCHE_HOME".to_string(),
            home.to_str().unwrap().to_string(),
        );
        Box::new(m)
    }

    fn daemon(home: &std::path::Path, idle: Option<Duration>) -> Daemon {
        Daemon::new(
            DeviceIdentity::from_seed([2; 32]),
            Registry::standard(BuildInfo::current()),
            env_for(home),
            Arc::new(IdleTimer::new(idle)),
        )
    }

    /// Minimal Gateway: accepts one connection, completes the handshake with `phase`, then holds
    /// the connection open `hold` before closing it.
    fn gateway(
        listener: UnixListener,
        phase: &'static str,
        hold: Duration,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut w = stream;
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            writeln!(w, r#"{{"type":"res","id":"connect","ok":true,"payload":{{"phase":"challenge","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","serverOrigin":"o","protocolVersion":1,"expiresAt":"2030-01-01T00:00:00Z"}}}}"#).unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            let payload = match phase {
                "paired" => {
                    r#"{"phase":"paired","deviceId":"d","scopes":[],"serverTime":"2030-01-01T00:00:00Z","stateVersion":1}"#
                }
                "pending" => r#"{"phase":"pending","pairingRequestId":"r","code":"AAAA-BBBB"}"#,
                _ => r#"{"phase":"denied","reason":"no"}"#,
            };
            writeln!(
                w,
                r#"{{"type":"res","id":"connect.verify","ok":true,"payload":{payload}}}"#
            )
            .unwrap();
            std::thread::sleep(hold);
        })
    }

    fn setup() -> (tempfile::TempDir, UnixListener) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("run")).unwrap();
        let listener = UnixListener::bind(dir.path().join("run/node.sock")).unwrap();
        (dir, listener)
    }

    #[test]
    fn no_gateway_is_a_quiet_failure() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(daemon(dir.path(), None).run_once(), Outcome::Failed);
    }

    #[test]
    fn a_closed_connection_is_served_and_pending_and_denied_are_reported() {
        for (phase, expected) in [
            ("paired", Outcome::Served),
            (
                "pending",
                Outcome::Pending {
                    code: Some("AAAA-BBBB".into()),
                },
            ),
            ("denied", Outcome::Denied),
        ] {
            let (dir, listener) = setup();
            let g = gateway(listener, phase, Duration::from_millis(50));
            assert_eq!(daemon(dir.path(), None).run_once(), expected, "{phase}");
            g.join().unwrap();
        }
    }

    #[test]
    fn a_paired_helper_exits_when_idle() {
        let (dir, listener) = setup();
        let g = gateway(listener, "paired", Duration::from_secs(3));
        let started = Instant::now();
        let mut d = daemon(dir.path(), Some(Duration::from_millis(400)));
        assert_eq!(d.run(), Exit::Idle);
        assert!(started.elapsed() < Duration::from_secs(3));
        g.join().unwrap();
    }

    #[test]
    fn with_no_gateway_the_helper_still_exits_when_idle() {
        let dir = tempfile::tempdir().unwrap();
        let mut d = daemon(dir.path(), Some(Duration::from_millis(300)));
        let mut quick = Backoff::default();
        quick.initial = Duration::from_millis(20);
        quick.max = Duration::from_millis(50);
        d = d.with_backoff(quick);
        assert_eq!(d.run(), Exit::Idle);
    }

    #[test]
    fn the_stop_flag_ends_the_loop() {
        let dir = tempfile::tempdir().unwrap();
        let mut d = daemon(dir.path(), None);
        d.stop_flag().store(true, Ordering::SeqCst);
        assert_eq!(d.run(), Exit::Stopped);
    }
}
