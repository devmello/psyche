//! The WebSocket to the Gateway (design §4.2): TCP, then TLS (CA or SPKI pin), then the upgrade.
//!
//! - `wss://host[:port]/ws` only. The address comes from `remote.json`, never from the network.
//!   No credentials, no query, no `Origin` header, no extensions, text frames only, at most
//!   `MAX_FRAME_BYTES` per frame.
//! - The TLS handshake is driven to the end before the upgrade request is written, so a
//!   certificate that fails verification gets no byte of HTTP, let alone a token.
//! - [`WsLink`] adapts the socket to the NDJSON `Read`/`Write` the handshake and serve loop
//!   already speak: one text message per frame. A message holding a newline is refused.
//! - A ping goes out every 25 seconds (NAT and DERP paths stay open) and a link that has heard
//!   nothing for 90 seconds is dead.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psyche_protocol::MAX_FRAME_BYTES;
use rustls::pki_types::ServerName;
use rustls::{ClientConnection, StreamOwned};
use tungstenite::client::IntoClientRequest;
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use super::link::{canonical_gateway_origin, Origin};
use super::tls::{ca_config, pinned_config, Observed};

pub const PING_EVERY: Duration = Duration::from_secs(25);
pub const DEAD_AFTER: Duration = Duration::from_secs(90);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a blocked read wakes up to let the keepalive and the stop flag run.
pub const READ_TICK: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Security {
    /// CA-certified (Tailscale Serve): the bundled roots and the name.
    Ca,
    /// A LAN certificate: only this SPKI hash (base64url SHA-256).
    Pin(String),
    /// `ws://` to a loopback address. Tests only: no build of the helper can dial in the clear.
    #[cfg(test)]
    PlainLoopback,
}

/// Where to dial, and what must be true of the other end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// Connect to this host (no brackets) and port.
    pub host: String,
    pub port: u16,
    /// The origin the Gateway must name in its challenge (`serverOrigin`).
    pub origin: String,
    pub security: Security,
}

impl Target {
    /// From a saved or linked Gateway origin. `None` when the origin is not one this helper
    /// would dial (see `link::canonical_gateway_origin`).
    pub fn from_origin(gateway_url: &str, cert_pin: Option<&str>) -> Option<Target> {
        let origin = canonical_gateway_origin(gateway_url, cert_pin.is_some())?;
        Some(Target::of(&origin, cert_pin))
    }

    pub fn of(origin: &Origin, cert_pin: Option<&str>) -> Target {
        Target {
            host: origin.host_for_connect().to_string(),
            port: origin.port_or_default(),
            origin: origin.https(),
            security: match cert_pin {
                Some(pin) => Security::Pin(pin.to_string()),
                None => Security::Ca,
            },
        }
    }

    fn request_url(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        let scheme = match self.security {
            #[cfg(test)]
            Security::PlainLoopback => "ws",
            _ => "wss",
        };
        format!("{scheme}://{host}:{}/ws", self.port)
    }
}

#[derive(Debug)]
pub enum TransportError {
    Connect(String),
    Tls(String),
    /// The Gateway served a certificate that is not the pinned one.
    PinMismatch,
    Upgrade(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Connect(m) => write!(f, "could not connect: {m}"),
            TransportError::Tls(m) => write!(f, "TLS refused the Gateway: {m}"),
            TransportError::PinMismatch => {
                write!(f, "the Gateway's certificate is not the pinned one")
            }
            TransportError::Upgrade(m) => write!(f, "the WebSocket upgrade failed: {m}"),
        }
    }
}

impl std::error::Error for TransportError {}

pub enum Conn {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Conn {
    fn tcp(&self) -> &TcpStream {
        match self {
            Conn::Plain(s) => s,
            Conn::Tls(s) => &s.sock,
        }
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.read(buf),
            Conn::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Conn::Plain(s) => s.write(buf),
            Conn::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Plain(s) => s.flush(),
            Conn::Tls(s) => s.flush(),
        }
    }
}

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, TransportError> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| TransportError::Connect(e.kind().to_string()))?;
    let mut last = TransportError::Connect("no address".into());
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(e) => last = TransportError::Connect(e.kind().to_string()),
        }
    }
    Err(last)
}

/// A connected, upgraded WebSocket and what the TLS layer saw.
pub struct Dialed {
    pub link: WsLink,
    /// The SPKI hash of the certificate this connection was served with (pinned mode).
    pub observed: Observed,
}

/// Dials the Gateway. Everything that can fail does so before a single application byte for a
/// bad certificate, and before the upgrade for any TLS failure.
pub fn dial(target: &Target) -> Result<Dialed, TransportError> {
    let tcp = tcp_connect(&target.host, target.port)?;
    let _ = tcp.set_nodelay(true);
    tcp.set_read_timeout(Some(CONNECT_TIMEOUT))
        .and_then(|()| tcp.set_write_timeout(Some(CONNECT_TIMEOUT)))
        .map_err(|e| TransportError::Connect(e.kind().to_string()))?;

    let mut observed = Observed::default();
    let conn = match &target.security {
        #[cfg(test)]
        Security::PlainLoopback => Conn::Plain(tcp),
        security => {
            let config = match security {
                Security::Ca => ca_config(),
                Security::Pin(pin) => pinned_config(pin).map(|(config, seen)| {
                    observed = seen;
                    config
                }),
                #[cfg(test)]
                Security::PlainLoopback => unreachable!(),
            }
            .map_err(|e| TransportError::Tls(e.to_string()))?;
            let name = ServerName::try_from(target.host.clone())
                .map_err(|_| TransportError::Tls("not a valid server name".into()))?;
            let mut connection = ClientConnection::new(Arc::new(config), name)
                .map_err(|e| TransportError::Tls(e.to_string()))?;
            let mut tcp = tcp;
            // Finish the handshake before anything else is written.
            while connection.is_handshaking() {
                if let Err(e) = connection.complete_io(&mut tcp) {
                    if let Security::Pin(pin) = &target.security {
                        if observed.spki().is_some_and(|seen| seen != *pin) {
                            return Err(TransportError::PinMismatch);
                        }
                    }
                    return Err(TransportError::Tls(e.to_string()));
                }
            }
            Conn::Tls(Box::new(StreamOwned::new(connection, tcp)))
        }
    };

    let request = target
        .request_url()
        .into_client_request()
        .map_err(|e| TransportError::Upgrade(e.to_string()))?;
    // `into_client_request` adds no `Origin`; a native client sends none.
    debug_assert!(request.headers().get("origin").is_none());
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES))
        .accept_unmasked_frames(false);
    let (socket, response) = tungstenite::client::client_with_config(request, conn, Some(config))
        .map_err(|e| TransportError::Upgrade(e.to_string()))?;
    // We offered no extension and no subprotocol: a server that picks one is not following the
    // upgrade it was asked for.
    if response.headers().contains_key("sec-websocket-extensions")
        || response.headers().contains_key("sec-websocket-protocol")
    {
        return Err(TransportError::Upgrade(
            "the Gateway chose an extension or protocol that was not offered".into(),
        ));
    }
    socket
        .get_ref()
        .tcp()
        .set_read_timeout(Some(READ_TICK))
        .map_err(|e| TransportError::Connect(e.kind().to_string()))?;
    Ok(Dialed {
        link: WsLink::new(socket),
        observed,
    })
}

struct Shared {
    socket: Mutex<WebSocket<Conn>>,
    /// Writers queued for the socket; the reader steps aside while this is non-zero.
    waiting_writers: AtomicUsize,
    stop: AtomicBool,
    clock: Mutex<Clock>,
}

struct Clock {
    last_rx: Instant,
    last_ping: Instant,
}

/// A WebSocket as the NDJSON byte stream the handshake and serve loop expect.
pub struct WsLink {
    shared: Arc<Shared>,
}

impl WsLink {
    fn new(socket: WebSocket<Conn>) -> Self {
        let now = Instant::now();
        Self {
            shared: Arc::new(Shared {
                socket: Mutex::new(socket),
                waiting_writers: AtomicUsize::new(0),
                stop: AtomicBool::new(false),
                clock: Mutex::new(Clock {
                    last_rx: now,
                    last_ping: now,
                }),
            }),
        }
    }

    pub fn reader(&self) -> WsReader {
        WsReader {
            shared: Arc::clone(&self.shared),
            ready: VecDeque::new(),
            ping_every: PING_EVERY,
            dead_after: DEAD_AFTER,
        }
    }

    pub fn writer(&self) -> WsWriter {
        WsWriter {
            shared: Arc::clone(&self.shared),
            pending: Vec::new(),
        }
    }

    /// Makes the reader report end of stream at its next tick.
    pub fn stop_flag(&self) -> StopHandle {
        StopHandle(Arc::clone(&self.shared))
    }

    /// Sends a close frame, best effort.
    pub fn close(&self) {
        let mut socket = self.shared.socket.lock().unwrap_or_else(|e| e.into_inner());
        let _ = socket.close(None);
        let _ = socket.flush();
    }
}

#[derive(Clone)]
pub struct StopHandle(Arc<Shared>);

impl StopHandle {
    pub fn stop(&self) {
        self.0.stop.store(true, Ordering::SeqCst);
    }
}

pub struct WsReader {
    shared: Arc<Shared>,
    ready: VecDeque<u8>,
    ping_every: Duration,
    dead_after: Duration,
}

fn other(kind: ErrorKind, what: &str) -> std::io::Error {
    std::io::Error::new(kind, what.to_string())
}

impl WsReader {
    #[cfg(test)]
    pub fn with_keepalive(mut self, ping_every: Duration, dead_after: Duration) -> Self {
        self.ping_every = ping_every;
        self.dead_after = dead_after;
        self
    }

    fn keepalive(&self, socket: &mut WebSocket<Conn>) -> std::io::Result<()> {
        let now = Instant::now();
        let mut clock = self.shared.clock.lock().unwrap_or_else(|e| e.into_inner());
        if now.duration_since(clock.last_rx) >= self.dead_after {
            return Err(other(
                ErrorKind::ConnectionAborted,
                "the Gateway went silent",
            ));
        }
        if now.duration_since(clock.last_ping) >= self.ping_every {
            clock.last_ping = now;
            match socket.send(Message::Ping(Vec::new().into())) {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                Err(e) => return Err(other(ErrorKind::BrokenPipe, &e.to_string())),
            }
        }
        Ok(())
    }

    fn heard(&self) {
        self.shared
            .clock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_rx = Instant::now();
    }
}

impl Read for WsReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if !self.ready.is_empty() {
                let n = out.len().min(self.ready.len());
                for slot in out.iter_mut().take(n) {
                    *slot = self.ready.pop_front().unwrap_or(0);
                }
                return Ok(n);
            }
            if self.shared.stop.load(Ordering::SeqCst) {
                return Ok(0);
            }
            // Let a queued writer have the socket.
            while self.shared.waiting_writers.load(Ordering::SeqCst) > 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
            let shared = Arc::clone(&self.shared);
            let mut socket = shared.socket.lock().unwrap_or_else(|e| e.into_inner());
            self.keepalive(&mut socket)?;
            // Finish any frame a writer left queued.
            match socket.flush() {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(0)
                }
                Err(e) => return Err(other(ErrorKind::BrokenPipe, &e.to_string())),
            }
            match socket.read() {
                Ok(Message::Text(text)) => {
                    self.heard();
                    if text.as_bytes().iter().any(|b| *b == b'\n' || *b == b'\r') {
                        return Err(other(ErrorKind::InvalidData, "a frame holds a line break"));
                    }
                    self.ready.extend(text.as_bytes());
                    self.ready.push_back(b'\n');
                }
                Ok(Message::Binary(_)) => {
                    return Err(other(ErrorKind::InvalidData, "binary frame"));
                }
                Ok(Message::Ping(_) | Message::Pong(_)) => {
                    self.heard();
                    // The pong answer is queued by the library; push it out.
                    let _ = socket.flush();
                }
                Ok(Message::Close(_)) => return Ok(0),
                Ok(Message::Frame(_)) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Err(std::io::Error::from(ErrorKind::WouldBlock));
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(0)
                }
                Err(e) => return Err(other(ErrorKind::BrokenPipe, &e.to_string())),
            }
        }
    }
}

pub struct WsWriter {
    shared: Arc<Shared>,
    pending: Vec<u8>,
}

impl WsWriter {
    fn send_line(&self, line: &[u8]) -> std::io::Result<()> {
        let text = std::str::from_utf8(line)
            .map_err(|_| other(ErrorKind::InvalidData, "a frame is not UTF-8"))?;
        self.shared.waiting_writers.fetch_add(1, Ordering::SeqCst);
        let mut socket = self.shared.socket.lock().unwrap_or_else(|e| e.into_inner());
        let sent = socket.send(Message::text(text.to_string()));
        drop(socket);
        self.shared.waiting_writers.fetch_sub(1, Ordering::SeqCst);
        match sent {
            Ok(()) => Ok(()),
            // Queued; the reader flushes it on its next turn.
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => Ok(()),
            Err(e) => Err(other(ErrorKind::BrokenPipe, &e.to_string())),
        }
    }
}

impl Write for WsWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.pending.extend_from_slice(buf);
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.send_line(&line[..line.len() - 1])?;
        }
        if self.pending.len() > MAX_FRAME_BYTES {
            return Err(other(ErrorKind::InvalidData, "frame too large"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::testutil::{FakeGateway, Script};
    use std::io::{BufRead, BufReader};

    #[test]
    fn plain_loopback_round_trips_lines_both_ways() {
        let gateway = FakeGateway::start(Script::echo());
        let dialed = dial(&gateway.target_plain()).unwrap();
        let mut writer = dialed.link.writer();
        let mut reader = BufReader::new(dialed.link.reader());
        writer.write_all(b"{\"a\":1}\n").unwrap();
        let mut line = String::new();
        loop {
            match reader.read_line(&mut line) {
                Ok(_) => break,
                Err(e) if e.kind() == ErrorKind::WouldBlock => continue,
                Err(e) => panic!("{e}"),
            }
        }
        assert_eq!(line, "{\"a\":1}\n");
        // No Origin header, no extensions were sent.
        let upgrade = gateway.upgrade_request();
        assert!(upgrade.starts_with("GET /ws HTTP/1.1"), "{upgrade}");
        let lower = upgrade.to_ascii_lowercase();
        assert!(!lower.contains("\norigin:"), "{upgrade}");
        assert!(!lower.contains("sec-websocket-extensions"), "{upgrade}");
        assert!(!lower.contains("authorization"), "{upgrade}");
        assert!(!upgrade.contains('?'), "no query: {upgrade}");
    }

    #[test]
    fn a_binary_frame_and_a_line_break_inside_a_frame_end_the_link() {
        for payload in [Script::send_binary(), Script::send_text("{\"a\":\n1}")] {
            let gateway = FakeGateway::start(payload);
            let dialed = dial(&gateway.target_plain()).unwrap();
            let mut reader = dialed.link.reader();
            let mut buf = [0u8; 64];
            let err = loop {
                match reader.read(&mut buf) {
                    Err(e) if e.kind() == ErrorKind::WouldBlock => continue,
                    other => break other,
                }
            };
            assert!(err.is_err(), "must be refused");
        }
    }

    #[test]
    fn a_gateway_that_never_answers_pings_is_dead_after_the_deadline() {
        let dead = FakeGateway::start(Script::ignores_pings());
        let dialed = dial(&dead.target_plain()).unwrap();
        let mut reader = dialed
            .link
            .reader()
            .with_keepalive(Duration::from_millis(50), Duration::from_millis(400));
        let started = Instant::now();
        let mut buf = [0u8; 8];
        let err = loop {
            match reader.read(&mut buf) {
                Err(e) if e.kind() == ErrorKind::WouldBlock => continue,
                other => break other,
            }
        };
        assert_eq!(err.unwrap_err().kind(), ErrorKind::ConnectionAborted);
        assert!(started.elapsed() >= Duration::from_millis(400));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_gateway_that_answers_pings_stays_alive() {
        let live = FakeGateway::start(Script::silent());
        let dialed = dial(&live.target_plain()).unwrap();
        let mut reader = dialed
            .link
            .reader()
            .with_keepalive(Duration::from_millis(50), Duration::from_millis(400));
        let started = Instant::now();
        let mut buf = [0u8; 8];
        while started.elapsed() < Duration::from_millis(900) {
            match reader.read(&mut buf) {
                Err(e) if e.kind() == ErrorKind::WouldBlock => continue,
                other => panic!("the link died: {other:?}"),
            }
        }
    }

    #[test]
    fn the_stop_handle_ends_the_stream() {
        let gateway = FakeGateway::start(Script::silent());
        let dialed = dial(&gateway.target_plain()).unwrap();
        let mut reader = dialed.link.reader();
        dialed.link.stop_flag().stop();
        let mut buf = [0u8; 8];
        assert_eq!(reader.read(&mut buf).unwrap(), 0);
    }

    #[test]
    fn the_wrong_pin_gets_no_upgrade_and_no_byte_after_the_tls_handshake() {
        let gateway = FakeGateway::start_tls(Script::echo());
        let mut target = gateway.target_tls();
        target.security = Security::Pin(crate::remote::testutil::other_pin());
        let result = dial(&target);
        assert!(matches!(result, Err(TransportError::PinMismatch)));
        assert_eq!(gateway.app_bytes_received(), 0);
        assert!(gateway.upgrade_request().is_empty());
    }

    #[test]
    fn the_right_pin_connects_and_reports_the_spki_it_saw() {
        let gateway = FakeGateway::start_tls(Script::echo());
        let dialed = dial(&gateway.target_tls()).unwrap();
        assert_eq!(
            dialed.observed.spki().as_deref(),
            Some(gateway.pin().as_str())
        );
        assert!(gateway.upgrade_request().starts_with("GET /ws HTTP/1.1"));
    }

    #[test]
    fn a_certificate_a_ca_never_signed_fails_the_ca_mode() {
        let gateway = FakeGateway::start_tls(Script::echo());
        let mut target = gateway.target_tls();
        target.security = Security::Ca;
        assert!(matches!(dial(&target), Err(TransportError::Tls(_))));
        assert_eq!(gateway.app_bytes_received(), 0);
    }

    #[test]
    fn only_https_origins_make_a_target() {
        assert!(Target::from_origin("https://a.ts.net", None).is_some());
        assert!(Target::from_origin("http://a.ts.net", None).is_none());
        assert!(Target::from_origin("https://a.ts.net/ws", None).is_none());
        assert!(Target::from_origin("https://192.168.1.4", None).is_none());
        assert!(Target::from_origin("https://192.168.1.4:7979", Some(&"A".repeat(43))).is_some());
        let t = Target::from_origin("https://[fd00::1]:7979", Some(&"A".repeat(43))).unwrap();
        assert_eq!(t.request_url(), "wss://[fd00::1]:7979/ws");
    }
}
