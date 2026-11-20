//! A fake Gateway for the remote tests: a real TCP listener, optionally with a real TLS server
//! (a fresh self-signed certificate), a real WebSocket upgrade, and a scripted node protocol on
//! top. It signs challenges with a real Ed25519 identity key the way the Gateway does
//! (`gatewaySigningPayload`, `lanCertSigningPayload`), so the helper's checks run against the
//! same bytes. Compiled for tests only.

#![allow(clippy::result_large_err, clippy::type_complexity)]

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use psyche_protocol::signing::{gateway_payload, lan_cert_payload};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde_json::{json, Value};
use tungstenite::Message;

use super::tls::spki_pin;
use super::transport::{Security, Target};

pub const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

pub fn other_pin() -> String {
    URL_SAFE_NO_PAD.encode([7u8; 32])
}

enum Srv {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ServerConnection, TcpStream>>),
}

struct Counting {
    inner: Srv,
    bytes: Arc<AtomicUsize>,
}

impl Read for Counting {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = match &mut self.inner {
            Srv::Plain(s) => s.read(buf),
            Srv::Tls(s) => s.read(buf),
        }?;
        self.bytes.fetch_add(n, Ordering::SeqCst);
        Ok(n)
    }
}

impl Write for Counting {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match &mut self.inner {
            Srv::Plain(s) => s.write(buf),
            Srv::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match &mut self.inner {
            Srv::Plain(s) => s.flush(),
            Srv::Tls(s) => s.flush(),
        }
    }
}

#[derive(Clone)]
pub enum Raw {
    /// Echo every text frame back.
    Echo,
    /// Read (so pings are answered) and say nothing.
    Silent,
    /// Do not read at all, so no pong ever comes back.
    IgnoresPings,
    SendBinary,
    SendText(String),
    /// The node protocol, as the Gateway speaks it.
    Gateway,
}

/// How the fake Gateway behaves at the protocol level.
#[derive(Clone)]
pub struct GatewayCfg {
    pub key: SigningKey,
    /// `serverOrigin` in the challenge. `None`: the origin the helper dialed.
    pub origin: Option<String>,
    pub send_identity: bool,
    pub lan_cert: LanCert,
    /// Answer to `connect.verify`.
    pub verdict: Value,
    /// Answer `connect` with this error code instead of a challenge.
    pub connect_error: Option<String>,
    /// Edits the challenge payload after it was signed.
    pub tamper: Option<Arc<dyn Fn(&mut Value) + Send + Sync>>,
    /// Frames sent after a `paired` verdict.
    pub after_paired: Vec<Value>,
    /// Close the socket right after answering `connect.verify`.
    pub close_after_verdict: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub enum LanCert {
    None,
    /// Vouch for the certificate actually served.
    Served,
    /// Vouch for this SPKI instead.
    Other(String),
}

impl GatewayCfg {
    pub fn new() -> Self {
        Self {
            key: SigningKey::from_bytes(&[42u8; 32]),
            origin: None,
            send_identity: true,
            lan_cert: LanCert::None,
            verdict: json!({
                "phase": "paired", "deviceId": "dev_x", "scopes": ["node"],
                "serverTime": "2030-01-01T00:00:00Z", "stateVersion": 1
            }),
            connect_error: None,
            tamper: None,
            after_paired: vec![],
            close_after_verdict: false,
        }
    }

    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }
}

impl Default for GatewayCfg {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct Script {
    pub raw: Raw,
    pub cfg: GatewayCfg,
}

impl Script {
    pub fn echo() -> Self {
        Self::raw(Raw::Echo)
    }
    pub fn silent() -> Self {
        Self::raw(Raw::Silent)
    }
    pub fn ignores_pings() -> Self {
        Self::raw(Raw::IgnoresPings)
    }
    pub fn send_binary() -> Self {
        Self::raw(Raw::SendBinary)
    }
    pub fn send_text(text: &str) -> Self {
        Self::raw(Raw::SendText(text.to_string()))
    }
    pub fn gateway(cfg: GatewayCfg) -> Self {
        Self {
            raw: Raw::Gateway,
            cfg,
        }
    }
    fn raw(raw: Raw) -> Self {
        Self {
            raw,
            cfg: GatewayCfg::new(),
        }
    }
}

#[derive(Default)]
struct Seen {
    app_bytes: AtomicUsize,
    upgrade: Mutex<String>,
    frames: Mutex<Vec<Value>>,
    connections: AtomicUsize,
}

pub struct FakeGateway {
    pub addr: SocketAddr,
    seen: Arc<Seen>,
    pin: Option<String>,
    cfg_key: String,
    stop: Arc<AtomicBool>,
}

impl Drop for FakeGateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop.
        let _ = TcpStream::connect(self.addr);
    }
}

impl FakeGateway {
    pub fn start(script: Script) -> Self {
        Self::launch(script, false)
    }

    pub fn start_tls(script: Script) -> Self {
        Self::launch(script, true)
    }

    fn launch(script: Script, tls: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Seen::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (server_config, pin) = if tls {
            let made = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()]).unwrap();
            let der = made.cert.der().to_vec();
            let pin = spki_pin(&der).unwrap();
            let key =
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(made.signing_key.serialize_der()));
            let config = ServerConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![der.into()], key)
            .unwrap();
            (Some(Arc::new(config)), Some(pin))
        } else {
            (None, None)
        };
        let cfg_key = script.cfg.public_key();
        let served_pin = pin.clone();
        let thread_seen = Arc::clone(&seen);
        let thread_stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if thread_stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                thread_seen.connections.fetch_add(1, Ordering::SeqCst);
                let (script, seen, config, pin) = (
                    script.clone(),
                    Arc::clone(&thread_seen),
                    server_config.clone(),
                    served_pin.clone(),
                );
                std::thread::spawn(move || serve_one(stream, script, seen, config, pin, addr));
            }
        });
        Self {
            addr,
            seen,
            pin,
            cfg_key,
            stop,
        }
    }

    pub fn pin(&self) -> String {
        self.pin.clone().expect("a TLS gateway")
    }

    pub fn gateway_key(&self) -> String {
        self.cfg_key.clone()
    }

    pub fn target_plain(&self) -> Target {
        Target {
            host: "127.0.0.1".into(),
            port: self.addr.port(),
            origin: format!("http://127.0.0.1:{}", self.addr.port()),
            security: Security::PlainLoopback,
        }
    }

    pub fn target_tls(&self) -> Target {
        Target {
            host: "127.0.0.1".into(),
            port: self.addr.port(),
            origin: format!("https://127.0.0.1:{}", self.addr.port()),
            security: Security::Pin(self.pin()),
        }
    }

    /// Bytes the server read from the client after the TLS handshake (the upgrade request and
    /// anything after it). Zero means the client wrote nothing at all.
    pub fn app_bytes_received(&self) -> usize {
        std::thread::sleep(Duration::from_millis(100));
        self.seen.app_bytes.load(Ordering::SeqCst)
    }

    pub fn upgrade_request(&self) -> String {
        std::thread::sleep(Duration::from_millis(100));
        self.seen.upgrade.lock().unwrap().clone()
    }

    pub fn frames(&self) -> Vec<Value> {
        self.seen.frames.lock().unwrap().clone()
    }

    pub fn connections(&self) -> usize {
        self.seen.connections.load(Ordering::SeqCst)
    }
}

fn serve_one(
    tcp: TcpStream,
    script: Script,
    seen: Arc<Seen>,
    tls: Option<Arc<ServerConfig>>,
    pin: Option<String>,
    addr: SocketAddr,
) {
    let _ = tcp.set_read_timeout(Some(Duration::from_secs(10)));
    let inner = match tls {
        None => Srv::Plain(tcp),
        Some(config) => {
            let Ok(mut conn) = ServerConnection::new(config) else {
                return;
            };
            let mut tcp = tcp;
            while conn.is_handshaking() {
                if conn.complete_io(&mut tcp).is_err() {
                    return;
                }
            }
            Srv::Tls(Box::new(StreamOwned::new(conn, tcp)))
        }
    };
    let stream = Counting {
        inner,
        bytes: Arc::new(AtomicUsize::new(0)),
    };
    let counter = Arc::clone(&stream.bytes);
    let upgrade_seen = Arc::clone(&seen);
    let callback = move |req: &tungstenite::handshake::server::Request,
                         resp: tungstenite::handshake::server::Response| {
        let mut text = format!("{} {} HTTP/1.1", req.method(), req.uri());
        for (k, v) in req.headers() {
            text.push_str(&format!("\n{}: {}", k, v.to_str().unwrap_or("?")));
        }
        *upgrade_seen.upgrade.lock().unwrap() = text;
        Ok(resp)
    };
    let result = tungstenite::accept_hdr(stream, callback);
    seen.app_bytes
        .store(counter.load(Ordering::SeqCst), Ordering::SeqCst);
    let Ok(mut ws) = result else { return };
    let report = |ws: &tungstenite::WebSocket<Counting>| {
        seen.app_bytes
            .store(ws.get_ref().bytes.load(Ordering::SeqCst), Ordering::SeqCst);
    };
    match &script.raw {
        Raw::IgnoresPings => std::thread::sleep(Duration::from_secs(3)),
        Raw::SendBinary => {
            let _ = ws.send(Message::Binary(vec![1, 2, 3].into()));
            std::thread::sleep(Duration::from_millis(500));
        }
        Raw::SendText(text) => {
            let _ = ws.send(Message::text(text.clone()));
            std::thread::sleep(Duration::from_millis(500));
        }
        Raw::Echo | Raw::Silent => loop {
            match ws.read() {
                Ok(Message::Text(t)) if matches!(script.raw, Raw::Echo) => {
                    if ws.send(Message::Text(t)).is_err() {
                        return;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => return,
                Ok(_) => {}
            }
        },
        Raw::Gateway => gateway_loop(&mut ws, &script.cfg, &seen, pin, addr, &report),
    }
}

fn gateway_loop(
    ws: &mut tungstenite::WebSocket<Counting>,
    cfg: &GatewayCfg,
    seen: &Seen,
    pin: Option<String>,
    addr: SocketAddr,
    report: &dyn Fn(&tungstenite::WebSocket<Counting>),
) {
    loop {
        let message = match ws.read() {
            Ok(m) => m,
            Err(_) => return,
        };
        report(ws);
        let Message::Text(text) = message else {
            if matches!(message, Message::Close(_)) {
                return;
            }
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else {
            return;
        };
        seen.frames.lock().unwrap().push(frame.clone());
        let id = frame["id"].as_str().unwrap_or("").to_string();
        let send = |ws: &mut tungstenite::WebSocket<Counting>, v: Value| {
            let _ = ws.send(Message::text(v.to_string()));
        };
        match frame["method"].as_str() {
            Some("connect") => {
                if let Some(code) = &cfg.connect_error {
                    send(
                        ws,
                        json!({"type":"res","id":id,"ok":false,"error":{"code":code,"message":"m"}}),
                    );
                    continue;
                }
                let device_key = frame["params"]["publicKey"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let origin = cfg.origin.clone().unwrap_or_else(|| {
                    if pin.is_some() {
                        format!("https://127.0.0.1:{}", addr.port())
                    } else {
                        format!("http://127.0.0.1:{}", addr.port())
                    }
                });
                let mut challenge = json!({
                    "phase": "challenge", "nonce": NONCE, "serverOrigin": origin,
                    "protocolVersion": 1, "expiresAt": "2030-01-01T00:00:00Z"
                });
                if cfg.send_identity {
                    challenge["gatewayKey"] = json!(cfg.public_key());
                    let sig = cfg.key.sign(&gateway_payload(NONCE, &origin, &device_key));
                    challenge["gatewaySignature"] = json!(URL_SAFE_NO_PAD.encode(sig.to_bytes()));
                    let spki = match (&cfg.lan_cert, &pin) {
                        (LanCert::Served, Some(p)) => Some(p.clone()),
                        (LanCert::Other(o), _) => Some(o.clone()),
                        _ => None,
                    };
                    if let Some(spki) = spki {
                        let sig =
                            cfg.key
                                .sign(&lan_cert_payload(NONCE, &origin, &device_key, &spki));
                        challenge["lanCertSpki"] = json!(spki);
                        challenge["lanCertSignature"] =
                            json!(URL_SAFE_NO_PAD.encode(sig.to_bytes()));
                    }
                }
                if let Some(tamper) = &cfg.tamper {
                    tamper(&mut challenge);
                }
                send(
                    ws,
                    json!({"type":"res","id":id,"ok":true,"payload":challenge}),
                );
            }
            Some("connect.verify") => {
                send(
                    ws,
                    json!({"type":"res","id":id,"ok":true,"payload":cfg.verdict.clone()}),
                );
                if cfg.verdict["phase"] == "paired" {
                    for extra in &cfg.after_paired {
                        send(ws, extra.clone());
                    }
                }
                if cfg.close_after_verdict {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    return;
                }
            }
            Some("node.unpair") => {
                send(
                    ws,
                    json!({"type":"res","id":id,"ok":true,"payload":{"device":{}}}),
                );
            }
            // A machine holds only the `node` scope.
            Some("devices.revokeSelf") => {
                send(
                    ws,
                    json!({"type":"res","id":id,"ok":false,"error":{"code":"forbidden","message":"scope"}}),
                );
            }
            _ => {}
        }
    }
}
