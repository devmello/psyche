//! The `remote` loop: keeps this computer connected to its Gateway (design §4.2).
//!
//! - Reconnects with the L3 backoff (0.5 s to 30 s, jittered), reset after a connection that
//!   stayed paired for 10 s. A ping every 25 s keeps NAT and DERP paths alive (`transport`).
//! - **Exit 78 (`EX_CONFIG`), so a service manager does not restart it in a loop:**
//!   - the Gateway answered `denied` with `device_revoked`: the key and `remote.json` are wiped;
//!   - the Gateway failed an identity check *after* the pinned TLS authenticated it, or
//!     `protocol_version_mismatch`: the key is kept (the owner may re-pair), nothing is signed;
//!   - this computer is not paired.
//! - **A certificate that is not the pinned one does not stop the helper.** That failure happens
//!   inside TLS, before the peer has proved anything, so anyone on the LAN can cause it (mDNS or
//!   ARP spoofing, a recycled address) and so can the Gateway's own certificate rotation. The
//!   helper writes nothing to it, says `certificate_changed` in its status and journal, and
//!   retries slowly (30 s doubling to 10 minutes).
//! - The helper never goes idle in remote mode: the box is a computer the agent can use at any
//!   time.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::config::{self, RemoteConfig, StatusFile};
use super::handshake::{self, Failure, Options, Verdict};
use super::transport::{dial, StopHandle, Target, TransportError, WsLink, WsReader, WsWriter};
use super::verify::{Expect, IdentityError, LanExpect};
use crate::backoff::{random_unit, Backoff};
use crate::capability::Registry;
use crate::channel::{FrameReader, HelperError};
use crate::identity::DeviceIdentity;
use crate::idle::IdleTimer;
use crate::session::{serve, ServeEnd};

pub const EXIT_CONFIG: u8 = 78;
/// A connection that stayed paired this long counts as healthy: the backoff starts over.
pub const HEALTHY_AFTER: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// What a handshake has to satisfy beyond the transport.
#[derive(Debug, Clone, Default)]
pub struct Pins {
    pub gateway_key: Option<String>,
    /// First pair without a link: the key an earlier attempt of this pairing saw.
    pub first_seen_key: Option<String>,
    /// LAN: the certificate pin.
    pub cert_pin: Option<String>,
}

pub struct Session {
    pub reader: FrameReader<WsReader>,
    pub writer: WsWriter,
    pub link: WsLink,
}

#[derive(Debug)]
pub enum AttemptError {
    Dial(TransportError),
    Handshake(Failure),
}

impl std::fmt::Display for AttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttemptError::Dial(e) => write!(f, "{e}"),
            AttemptError::Handshake(e) => write!(f, "{e}"),
        }
    }
}

/// Dials and runs the handshake. The Gateway is verified before anything is signed; on `Ok` the
/// verdict says what it did with this device.
pub fn attempt(
    target: &Target,
    identity: &DeviceIdentity,
    name: &str,
    capabilities: Vec<psyche_protocol::NodeCapability>,
    pins: &Pins,
    token: Option<&str>,
) -> Result<(String, Verdict, Session), AttemptError> {
    let dialed = dial(target).map_err(AttemptError::Dial)?;
    let mut reader = FrameReader::new(dialed.link.reader());
    let mut writer = dialed.link.writer();
    let observed = dialed.observed.spki();
    let options = Options {
        timeout: HANDSHAKE_TIMEOUT,
        name,
        capabilities,
        setup_token: token,
        expect: Expect {
            dialed_origin: &target.origin,
            pinned_key: pins.gateway_key.as_deref(),
            first_seen_key: pins.first_seen_key.as_deref(),
            lan: pins.cert_pin.as_deref().map(|pin| LanExpect {
                pin,
                observed_spki: observed.as_deref(),
            }),
        },
    };
    match handshake::perform(&mut reader, &mut writer, identity, &options) {
        Ok((key, verdict)) => Ok((
            key,
            verdict,
            Session {
                reader,
                writer,
                link: dialed.link,
            },
        )),
        Err(failure) => {
            dialed.link.close();
            Err(AttemptError::Handshake(failure))
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Exit {
    Stopped,
    /// `denied` with `device_revoked`: key and `remote.json` wiped.
    Revoked,
    /// A check on the Gateway failed (or its certificate is not the pinned one). Key kept.
    IdentityMismatch(IdentityError),
    VersionMismatch,
}

impl Exit {
    pub fn code(&self) -> u8 {
        match self {
            Exit::Stopped => 0,
            _ => EXIT_CONFIG,
        }
    }
}

#[derive(Debug)]
enum Outcome {
    Served {
        lasted: Duration,
    },
    Pending,
    Denied,
    Revoked,
    Identity(IdentityError),
    VersionMismatch,
    /// TLS served a certificate that is not the pinned one.
    CertificateChanged,
    Failed,
}

pub struct RemoteDaemon {
    config: RemoteConfig,
    target: Target,
    identity: DeviceIdentity,
    registry: Registry,
    config_dir: std::path::PathBuf,
    state_dir: std::path::PathBuf,
    backoff: Backoff,
    cert_backoff: Backoff,
    stop: Arc<AtomicBool>,
    current: Mutex<Option<StopHandle>>,
}

/// Retry schedule for a certificate that is not the pinned one: 30 s doubling to 10 minutes.
fn slow_backoff() -> Backoff {
    let mut b = Backoff::default();
    b.initial = Duration::from_secs(30);
    b.max = Duration::from_secs(600);
    b
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl RemoteDaemon {
    pub fn new(
        config: RemoteConfig,
        identity: DeviceIdentity,
        registry: Registry,
        config_dir: std::path::PathBuf,
        state_dir: std::path::PathBuf,
    ) -> Result<Self, config::ConfigError> {
        let target = config.target()?;
        Ok(Self::with_target(
            config, target, identity, registry, config_dir, state_dir,
        ))
    }

    /// For tests that dial a local fake Gateway.
    pub fn with_target(
        config: RemoteConfig,
        target: Target,
        identity: DeviceIdentity,
        registry: Registry,
        config_dir: std::path::PathBuf,
        state_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            config,
            target,
            identity,
            registry,
            config_dir,
            state_dir,
            backoff: Backoff::default(),
            cert_backoff: slow_backoff(),
            stop: Arc::new(AtomicBool::new(false)),
            current: Mutex::new(None),
        }
    }

    pub fn with_backoff(mut self, backoff: Backoff) -> Self {
        self.backoff = backoff;
        self
    }

    pub fn with_cert_backoff(mut self, backoff: Backoff) -> Self {
        self.cert_backoff = backoff;
        self
    }

    pub fn stop_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.stop)
    }

    /// Stops the loop and ends the current connection.
    pub fn stopper(&self) -> impl Fn() + Send + Sync + 'static {
        let stop = Arc::clone(&self.stop);
        move || stop.store(true, Ordering::SeqCst)
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn status(&self, state: &str, detail: Option<&str>) {
        if let Err(e) = config::write_status(
            &self.state_dir,
            &StatusFile {
                state: state.into(),
                since: now_secs(),
                pid: std::process::id(),
                detail: detail.map(str::to_string),
            },
        ) {
            crate::log(&format!("status file: {e}"));
        }
    }

    pub fn run(&mut self) -> Exit {
        while !self.stopped() {
            self.status("connecting", None);
            let mut cert_changed = false;
            let delay = match self.run_once() {
                Outcome::Revoked => {
                    crate::log("this computer was removed on the Gateway: wiping its key");
                    if let Err(e) = config::wipe(&self.config_dir, &self.state_dir) {
                        crate::log(&format!("wipe: {e}"));
                    }
                    return Exit::Revoked;
                }
                Outcome::Identity(e) => {
                    self.status("identity_mismatch", Some(e.code()));
                    crate::log(&format!(
                        "refusing the Gateway: {e} ({}); the key is kept, pair again to trust a new one",
                        e.code()
                    ));
                    return Exit::IdentityMismatch(e);
                }
                Outcome::VersionMismatch => {
                    self.status("version_mismatch", None);
                    crate::log(
                        "the Gateway speaks no protocol version this helper does; update it",
                    );
                    return Exit::VersionMismatch;
                }
                Outcome::CertificateChanged => {
                    cert_changed = true;
                    self.status("certificate_changed", Some("certificate_changed"));
                    crate::log(
                        "the Gateway's certificate is not the pinned one; nothing was sent to it. \
                         If the Gateway's certificate really changed, run `psyche-helper pair \
                         --replace` with a new link; otherwise something else is answering at \
                         this address",
                    );
                    self.cert_backoff.next_failure(random_unit())
                }
                Outcome::Served { lasted } => {
                    if lasted >= HEALTHY_AFTER {
                        self.backoff.reset();
                        self.cert_backoff.reset();
                        self.backoff.initial
                    } else {
                        self.backoff.next_failure(random_unit())
                    }
                }
                Outcome::Pending => self.backoff.pending_retry,
                Outcome::Denied => self.backoff.denied_retry,
                Outcome::Failed => self.backoff.next_failure(random_unit()),
            };
            if !self.stopped() && !cert_changed {
                self.status("offline", None);
            }
            self.sleep(delay);
        }
        self.status("stopped", None);
        Exit::Stopped
    }

    fn sleep(&self, delay: Duration) {
        let deadline = Instant::now() + delay;
        while !self.stopped() && Instant::now() < deadline {
            std::thread::sleep(
                Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }

    fn run_once(&self) -> Outcome {
        let pins = Pins {
            gateway_key: Some(self.config.gateway_key.clone()),
            first_seen_key: None,
            cert_pin: self.config.cert_pin.clone(),
        };
        let (_, verdict, mut session) = match attempt(
            &self.target,
            &self.identity,
            &self.config.machine_name,
            self.registry.manifest(),
            &pins,
            None,
        ) {
            Ok(done) => done,
            Err(AttemptError::Dial(TransportError::PinMismatch)) => {
                return Outcome::CertificateChanged
            }
            Err(AttemptError::Dial(e)) => {
                crate::log(&format!("connect failed: {e}"));
                return Outcome::Failed;
            }
            Err(AttemptError::Handshake(Failure::Identity(e))) => return Outcome::Identity(e),
            Err(AttemptError::Handshake(Failure::Gateway(code)))
                if code == "protocol_version_mismatch" =>
            {
                return Outcome::VersionMismatch
            }
            Err(AttemptError::Handshake(e)) => {
                crate::log(&format!("handshake failed: {e}"));
                return Outcome::Failed;
            }
        };
        match verdict {
            Verdict::Paired => {
                let paired_at = Instant::now();
                self.status("connected", None);
                crate::log(&format!("serving capabilities={}", self.registry.len()));
                *self.current.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(session.link.stop_flag());
                if self.stopped() {
                    session.link.close();
                    return Outcome::Failed;
                }
                let idle = Arc::new(IdleTimer::new(None));
                let ended = serve(
                    &mut session.reader,
                    session.writer,
                    self.registry.clone(),
                    idle,
                );
                session.link.close();
                *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
                match ended {
                    Ok(ServeEnd::Closed | ServeEnd::Idle) => {
                        crate::log("the Gateway closed the connection");
                    }
                    Err(e) => crate::log(&format!("connection failed: {e}")),
                }
                Outcome::Served {
                    lasted: paired_at.elapsed(),
                }
            }
            Verdict::Pending { code } => {
                self.status("waiting_for_approval", None);
                crate::log(&format!(
                    "waiting for the owner to approve this computer in Psyche (code {})",
                    code.as_deref().unwrap_or("?")
                ));
                session.link.close();
                Outcome::Pending
            }
            Verdict::Denied { code, .. } => {
                session.link.close();
                if code.as_deref() == Some("device_revoked") {
                    Outcome::Revoked
                } else {
                    crate::log("the Gateway denied this computer");
                    Outcome::Denied
                }
            }
        }
    }

    /// Ends the live connection, if any, and the loop.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self
            .current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            handle.stop();
        }
    }
}

impl Session {
    /// Sends one request and waits for its answer. For `unpair`.
    pub fn request(
        &mut self,
        id: &str,
        method: &str,
        params: &serde_json::Value,
        timeout: Duration,
    ) -> Result<(), HelperError> {
        use crate::channel::Read1;
        use psyche_protocol::frame::{req_line, Incoming};
        self.writer
            .write_all(&req_line(id, method, params)?)
            .map_err(HelperError::Io)?;
        self.writer.flush().map_err(HelperError::Io)?;
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(HelperError::Timeout);
            }
            match self.reader.read_frame()? {
                Read1::Closed => return Err(HelperError::Closed),
                Read1::Tick => {}
                Read1::Frame(Incoming::ResOk(res)) if res.id.to_string() == id => return Ok(()),
                Read1::Frame(Incoming::ResErr(res)) if res.id.to_string() == id => {
                    return Err(HelperError::Gateway {
                        code: serde_json::to_value(res.error.code)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_string))
                            .unwrap_or_default(),
                    })
                }
                Read1::Frame(_) => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;
    use crate::remote::testutil::{FakeGateway, GatewayCfg, LanCert, Script};
    use serde_json::json;

    struct Fx {
        dir: tempfile::TempDir,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
            }
        }
        fn cfg_dir(&self) -> std::path::PathBuf {
            self.dir.path().join("cfg")
        }
        fn state(&self) -> std::path::PathBuf {
            self.dir.path().join("state")
        }
        /// A paired machine: remote.json and a key on disk, a daemon aimed at `target`.
        fn daemon(&self, gateway_key: &str, target: Target) -> RemoteDaemon {
            let config = RemoteConfig::new(
                "https://a.ts.net".into(),
                gateway_key.into(),
                None,
                "lab-box".into(),
            );
            config::save(&self.cfg_dir(), &config).unwrap();
            let identity = crate::identity::load_or_create_file(
                &self.state(),
                crate::identity::REMOTE_IDENTITY_FILE,
            )
            .unwrap();
            let mut quick = Backoff::default();
            quick.initial = Duration::from_millis(20);
            quick.max = Duration::from_millis(60);
            RemoteDaemon::with_target(
                config,
                target,
                identity,
                Registry::standard(BuildInfo::current()),
                self.cfg_dir(),
                self.state(),
            )
            .with_backoff(quick)
        }
    }

    #[test]
    fn a_revoked_device_wipes_its_key_and_exits_78() {
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.verdict = json!({"phase":"denied","reason":"removed","code":"device_revoked"});
        let gateway = FakeGateway::start(Script::gateway(cfg));
        let mut daemon = fx.daemon(&gateway.gateway_key(), gateway.target_plain());
        let exit = daemon.run();
        assert_eq!(exit, Exit::Revoked);
        assert_eq!(exit.code(), 78);
        assert!(
            !fx.state()
                .join(crate::identity::REMOTE_IDENTITY_FILE)
                .exists(),
            "key wiped"
        );
        assert!(
            !config::remote_path(&fx.cfg_dir()).exists(),
            "remote.json wiped"
        );
        assert_eq!(gateway.connections(), 1, "no retry loop after a revocation");
    }

    #[test]
    fn an_identity_mismatch_exits_78_and_keeps_the_key_and_signs_nothing() {
        let fx = Fx::new();
        let wrong = {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                ed25519_dalek::SigningKey::from_bytes(&[9u8; 32])
                    .verifying_key()
                    .to_bytes(),
            )
        };
        let gateway = FakeGateway::start(Script::gateway(GatewayCfg::new()));
        let mut daemon = fx.daemon(&wrong, gateway.target_plain());
        let exit = daemon.run();
        assert_eq!(exit, Exit::IdentityMismatch(IdentityError::IdentityChanged));
        assert_eq!(exit.code(), 78);
        assert!(
            fx.state()
                .join(crate::identity::REMOTE_IDENTITY_FILE)
                .exists(),
            "key kept"
        );
        assert!(config::remote_path(&fx.cfg_dir()).exists());
        assert!(
            gateway
                .frames()
                .iter()
                .all(|f| f["method"] != "connect.verify"),
            "nothing was signed for the wrong Gateway"
        );
        let status = config::read_status(&fx.state()).unwrap();
        assert_eq!(status.state, "identity_mismatch");
    }

    #[test]
    fn a_protocol_version_mismatch_exits_78_and_keeps_the_key() {
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.connect_error = Some("protocol_version_mismatch".into());
        let gateway = FakeGateway::start(Script::gateway(cfg));
        let mut daemon = fx.daemon(&gateway.gateway_key(), gateway.target_plain());
        assert_eq!(daemon.run(), Exit::VersionMismatch);
        assert!(fx
            .state()
            .join(crate::identity::REMOTE_IDENTITY_FILE)
            .exists());
    }

    #[test]
    fn a_certificate_that_is_not_the_pinned_one_retries_slowly_and_never_exits_78() {
        let fx = Fx::new();
        let gateway = FakeGateway::start_tls(Script::gateway(GatewayCfg::new()));
        let mut target = gateway.target_tls();
        target.security =
            crate::remote::transport::Security::Pin(crate::remote::testutil::other_pin());
        let mut quick = Backoff::default();
        quick.initial = Duration::from_millis(20);
        quick.max = Duration::from_millis(60);
        let mut daemon = fx
            .daemon(&gateway.gateway_key(), target)
            .with_cert_backoff(quick);
        let stop = daemon.stopper();
        let handle = std::thread::spawn(move || daemon.run());
        let deadline = Instant::now() + Duration::from_secs(10);
        while gateway.connections() < 3 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let status = config::read_status(&fx.state()).unwrap();
        stop();
        // Anyone on the LAN can serve another certificate: the helper keeps trying, says why,
        // keeps its key, and never writes a byte to the stranger.
        assert_eq!(handle.join().unwrap(), Exit::Stopped);
        assert!(
            gateway.connections() >= 3,
            "retried: {}",
            gateway.connections()
        );
        assert!(matches!(
            status.state.as_str(),
            "certificate_changed" | "connecting"
        ));
        assert_eq!(gateway.app_bytes_received(), 0);
        assert!(fx
            .state()
            .join(crate::identity::REMOTE_IDENTITY_FILE)
            .exists());
        assert!(config::remote_path(&fx.cfg_dir()).exists());
    }

    #[test]
    fn a_certificate_the_gateway_vouched_against_after_tls_authenticated_it_still_exits_78() {
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.lan_cert = LanCert::Other("DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw".into());
        let gateway = FakeGateway::start_tls(Script::gateway(cfg));
        let mut daemon = fx.daemon(&gateway.gateway_key(), gateway.target_tls());
        daemon.config.cert_pin = Some(gateway.pin());
        let exit = daemon.run();
        assert_eq!(exit, Exit::IdentityMismatch(IdentityError::CertChanged));
        assert_eq!(exit.code(), 78);
    }

    #[test]
    fn it_reconnects_after_the_gateway_goes_away_and_serves_over_lan_tls() {
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.lan_cert = LanCert::Served;
        cfg.close_after_verdict = true;
        let gateway = FakeGateway::start_tls(Script::gateway(cfg));
        let mut daemon = fx.daemon(&gateway.gateway_key(), gateway.target_tls());
        daemon.config.cert_pin = Some(gateway.pin());
        let stop = daemon.stopper();
        let handle = std::thread::spawn(move || daemon.run());
        let deadline = Instant::now() + Duration::from_secs(10);
        while gateway.connections() < 3 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        stop();
        assert_eq!(handle.join().unwrap(), Exit::Stopped);
        assert!(
            gateway.connections() >= 3,
            "reconnected: {}",
            gateway.connections()
        );
        // Every connection verified the Gateway and signed with the v2 payload.
        let verifies = gateway
            .frames()
            .into_iter()
            .filter(|f| f["method"] == "connect.verify")
            .count();
        assert!(verifies >= 3);
    }

    #[test]
    fn a_pending_approval_is_retried_without_exiting() {
        let fx = Fx::new();
        let mut cfg = GatewayCfg::new();
        cfg.verdict = json!({"phase":"pending","pairingRequestId":"r","code":"ABCD-EFGH"});
        let gateway = FakeGateway::start(Script::gateway(cfg));
        let mut daemon = fx.daemon(&gateway.gateway_key(), gateway.target_plain());
        daemon.backoff.pending_retry = Duration::from_millis(30);
        let stop = daemon.stopper();
        let handle = std::thread::spawn(move || daemon.run());
        let deadline = Instant::now() + Duration::from_secs(10);
        while gateway.connections() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        stop();
        assert_eq!(handle.join().unwrap(), Exit::Stopped);
        assert!(gateway.connections() >= 2);
    }
}
