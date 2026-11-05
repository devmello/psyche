//! Node-side `connect` → challenge → `connect.verify` (wire spec v1; port of `NodeHandshakeClient`).
//! The helper connects as `role: "node"`, `platform: "windows"`, `deviceFamily: "win-helper"`,
//! declares its manifest in `capabilities` and presents the per-launch handshake secret.

use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::AsyncRead;

use super::channel::{FrameReader, FrameWriter};
use super::encoding::b64url_decode;
use super::frames::{Frame, PROTOCOL_VERSION, ResFrame};
use super::identity::{DeviceIdentity, connect_signing_payload};
use super::log::HelperLog;

pub const PLATFORM: &str = "windows";
pub const DEVICE_FAMILY: &str = "win-helper";
pub const NODE_NAME: &str = "Psyche (Helper)";

#[derive(Clone)]
pub struct HandshakeOptions {
    pub timeout: Duration,
    /// Sign the challenge and send `connect.verify`; when false stop after the challenge.
    pub verify: bool,
    pub handshake_secret: Option<String>,
    pub name: String,
    pub capabilities: Vec<Value>,
}

impl Default for HandshakeOptions {
    fn default() -> Self {
        HandshakeOptions {
            timeout: Duration::from_secs(10),
            verify: true,
            handshake_secret: None,
            name: NODE_NAME.into(),
            capabilities: Vec::new(),
        }
    }
}

/// `ConnectResult` (`paired` | `pending` | `denied`).
#[derive(Debug, Clone, PartialEq)]
pub struct ConnectOutcome {
    pub phase: String,
    /// Pending: the pairing code shown to the owner. Denied: the machine-readable cause.
    pub code: Option<String>,
    pub reason: Option<String>,
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Completion {
    ChallengeOnly {
        nonce_bytes: usize,
        protocol_version: u32,
    },
    Completed(ConnectOutcome),
}

#[derive(Debug)]
pub enum HandshakeError {
    Gateway { code: String },
    UnexpectedFrame,
    Closed,
    TimedOut,
    Io(std::io::Error),
    Sign(String),
}

impl std::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeError::Gateway { code } => write!(f, "Gateway refused the handshake: {code}"),
            HandshakeError::UnexpectedFrame => write!(f, "Unexpected frame from the Gateway"),
            HandshakeError::Closed => write!(f, "The Gateway closed the connection"),
            HandshakeError::TimedOut => write!(f, "The handshake timed out"),
            HandshakeError::Io(e) => write!(f, "I/O error during the handshake: {}", e.kind()),
            HandshakeError::Sign(e) => write!(f, "Could not build the signing payload: {e}"),
        }
    }
}

impl std::error::Error for HandshakeError {}

/// `ConnectParams` for this helper.
pub fn connect_params(identity: &DeviceIdentity, options: &HandshakeOptions) -> Value {
    let mut o = Map::new();
    o.insert(
        "protocolVersion".into(),
        json!({ "min": 1, "max": PROTOCOL_VERSION }),
    );
    o.insert("deviceId".into(), identity.device_id().into());
    o.insert("publicKey".into(), identity.public_key().into());
    o.insert("role".into(), "node".into());
    o.insert("platform".into(), PLATFORM.into());
    o.insert("deviceFamily".into(), DEVICE_FAMILY.into());
    o.insert("name".into(), options.name.clone().into());
    o.insert(
        "capabilities".into(),
        Value::Array(options.capabilities.clone()),
    );
    if let Some(s) = &options.handshake_secret {
        o.insert("handshakeSecret".into(), s.clone().into());
    }
    Value::Object(o)
}

async fn await_response<R: AsyncRead + Unpin>(
    reader: &mut FrameReader<R>,
    id: &str,
) -> Result<ResFrame, HandshakeError> {
    loop {
        match reader.next().await.map_err(HandshakeError::Io)? {
            None => return Err(HandshakeError::Closed),
            Some(Frame::Res(res)) if res.id == id => return Ok(res),
            // Events or Gateway requests before pairing are ignored here.
            Some(_) => continue,
        }
    }
}

fn gateway_error(res: &ResFrame) -> HandshakeError {
    HandshakeError::Gateway {
        code: res
            .error
            .as_ref()
            .map(|e| e.code.clone())
            .unwrap_or_else(|| "unknown".into()),
    }
}

/// Runs the handshake. Frames that arrive after `connect.verify` stay queued in `reader` for the
/// serve loop.
pub async fn perform<R: AsyncRead + Unpin>(
    identity: &DeviceIdentity,
    options: &HandshakeOptions,
    reader: &mut FrameReader<R>,
    writer: &FrameWriter,
    log: &HelperLog,
) -> Result<Completion, HandshakeError> {
    match tokio::time::timeout(
        options.timeout,
        perform_inner(identity, options, reader, writer, log),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(HandshakeError::TimedOut),
    }
}

async fn perform_inner<R: AsyncRead + Unpin>(
    identity: &DeviceIdentity,
    options: &HandshakeOptions,
    reader: &mut FrameReader<R>,
    writer: &FrameWriter,
    log: &HelperLog,
) -> Result<Completion, HandshakeError> {
    log.info(format!(
        "phase=connecting role=node deviceFamily={DEVICE_FAMILY} capabilities={}",
        options.capabilities.len()
    ));
    writer
        .send(&Frame::req(
            "connect",
            "connect",
            Some(connect_params(identity, options)),
        ))
        .map_err(|_| HandshakeError::Closed)?;

    let res = await_response(reader, "connect").await?;
    let payload = match (&res.ok, &res.payload) {
        (true, Some(p)) => p.clone(),
        _ => return Err(gateway_error(&res)),
    };
    let phase = payload.get("phase").and_then(Value::as_str);
    let nonce = payload.get("nonce").and_then(Value::as_str);
    let origin = payload.get("serverOrigin").and_then(Value::as_str);
    let version = payload.get("protocolVersion").and_then(Value::as_u64);
    let (Some("challenge"), Some(nonce), Some(origin), Some(version)) =
        (phase, nonce, origin, version)
    else {
        return Err(HandshakeError::UnexpectedFrame);
    };
    let nonce_bytes = b64url_decode(nonce).map(|b| b.len()).unwrap_or(0);
    log.info(format!(
        "phase=challenge nonceBytes={nonce_bytes} protocolVersion={version}"
    ));
    if !options.verify {
        return Ok(Completion::ChallengeOnly {
            nonce_bytes,
            protocol_version: version as u32,
        });
    }

    let signing =
        connect_signing_payload(nonce, PLATFORM, DEVICE_FAMILY, version as u32, origin, None)
            .map_err(HandshakeError::Sign)?;
    let verify = json!({ "nonce": nonce, "signature": identity.sign(&signing) });
    log.info("phase=verifying");
    writer
        .send(&Frame::req(
            "connect.verify",
            "connect.verify",
            Some(verify),
        ))
        .map_err(|_| HandshakeError::Closed)?;

    let res = await_response(reader, "connect.verify").await?;
    let payload = match (&res.ok, &res.payload) {
        (true, Some(p)) => p.clone(),
        _ => return Err(gateway_error(&res)),
    };
    let str_of = |k: &str| payload.get(k).and_then(Value::as_str).map(str::to_owned);
    let outcome = ConnectOutcome {
        phase: str_of("phase").ok_or(HandshakeError::UnexpectedFrame)?,
        code: str_of("code"),
        reason: str_of("reason"),
        node_id: str_of("nodeId"),
    };
    log.info(format!("phase={}", outcome.phase));
    Ok(Completion::Completed(outcome))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_params_shape() {
        let id = DeviceIdentity::from_seed([7u8; 32]);
        let opts = HandshakeOptions {
            handshake_secret: Some("s3cret".into()),
            capabilities: vec![json!({"name": "x"})],
            ..Default::default()
        };
        let p = connect_params(&id, &opts);
        assert_eq!(p["role"], "node");
        assert_eq!(p["platform"], "windows");
        assert_eq!(p["deviceFamily"], "win-helper");
        assert_eq!(p["name"], "Psyche (Helper)");
        assert_eq!(p["protocolVersion"], json!({"min": 1, "max": 1}));
        assert_eq!(p["deviceId"], id.device_id());
        assert_eq!(p["publicKey"], id.public_key());
        assert_eq!(p["handshakeSecret"], "s3cret");
        assert_eq!(p["capabilities"][0]["name"], "x");
        let p = connect_params(&id, &HandshakeOptions::default());
        assert!(p.get("handshakeSecret").is_none());
    }
}
