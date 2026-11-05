//! Node-side `connect` -> challenge -> `connect.verify` (wire spec v1, security §10), the same
//! sequence as `NodeHandshakeClient` in the Mac helper. The helper connects as `role: "node"`,
//! `platform: "linux"`, `deviceFamily: "linux-helper"`, and declares its capability manifest in
//! `capabilities`. It presents the per-launch handshake secret, which is what makes it the Host's
//! own helper on the Gateway's side.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use psyche_protocol::frame::{req_line, Incoming};
use psyche_protocol::signing::connect_payload;
use psyche_protocol::{
    ConnectChallenge, ConnectParams, ConnectParamsDeviceId, ConnectParamsHandshakeSecret,
    ConnectParamsName, ConnectRole, ConnectVerifyParams, DeviceFamily, DevicePlatform,
    NodeCapability, ProtocolVersionRange, PROTOCOL_VERSION,
};
use serde_json::Value;

use crate::buildinfo::{DEVICE_FAMILY, DEVICE_NAME, PLATFORM};
use crate::channel::{FrameReader, HelperError, Read1};
use crate::identity::DeviceIdentity;

pub struct HandshakeOptions {
    pub timeout: Duration,
    /// The per-launch secret from `$PSYCHE_HOME/run/handshake.secret`.
    pub handshake_secret: Option<String>,
    pub capabilities: Vec<NodeCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Paired {
    Paired,
    /// The owner has to approve this device; the code is shown in the desktop app.
    Pending {
        code: Option<String>,
    },
    Denied {
        reason: Option<String>,
    },
}

pub fn connect_params(
    identity: &DeviceIdentity,
    options: &HandshakeOptions,
) -> Result<ConnectParams, HelperError> {
    let bad = |what| HelperError::Unexpected(what);
    Ok(ConnectParams {
        capabilities: options.capabilities.clone(),
        device_family: DeviceFamily::from(DEVICE_FAMILY.to_string()),
        device_id: ConnectParamsDeviceId::try_from(identity.device_id().as_str())
            .map_err(|_| bad("device id"))?,
        handshake_secret: match &options.handshake_secret {
            Some(secret) => Some(
                ConnectParamsHandshakeSecret::try_from(secret.as_str())
                    .map_err(|_| bad("handshake secret"))?,
            ),
            None => None,
        },
        name: ConnectParamsName::try_from(DEVICE_NAME).map_err(|_| bad("name"))?,
        platform: DevicePlatform::Linux,
        protocol_version: ProtocolVersionRange {
            max: std::num::NonZeroU64::new(PROTOCOL_VERSION).ok_or_else(|| bad("version"))?,
            min: std::num::NonZeroU64::new(1).ok_or_else(|| bad("version"))?,
        },
        public_key: identity.public_key(),
        role: ConnectRole::Node,
    })
}

/// Waits for the `res` to request `id`. Other frames before pairing are ignored.
fn await_response<R: Read>(
    reader: &mut FrameReader<R>,
    id: &str,
    deadline: Instant,
) -> Result<Value, HelperError> {
    loop {
        if Instant::now() >= deadline {
            return Err(HelperError::Timeout);
        }
        match reader.read_frame()? {
            Read1::Closed => return Err(HelperError::Closed),
            Read1::Tick => {}
            Read1::Frame(Incoming::ResOk(res)) if res.id.to_string() == id => {
                return Ok(res.payload)
            }
            Read1::Frame(Incoming::ResErr(res)) if res.id.to_string() == id => {
                let code = serde_json::to_value(res.error.code)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".into());
                return Err(HelperError::Gateway { code });
            }
            Read1::Frame(_) => {}
        }
    }
}

/// Runs the handshake. Frames that arrive after `connect.verify` stay queued in `reader` for the
/// serve loop.
pub fn perform<R: Read, W: Write>(
    reader: &mut FrameReader<R>,
    writer: &mut W,
    identity: &DeviceIdentity,
    options: &HandshakeOptions,
) -> Result<Paired, HelperError> {
    let deadline = Instant::now() + options.timeout;
    let params = connect_params(identity, options)?;
    writer.write_all(&req_line("connect", "connect", &params)?)?;
    writer.flush()?;

    let challenge: ConnectChallenge =
        serde_json::from_value(await_response(reader, "connect", deadline)?)
            .map_err(|_| HelperError::Unexpected("connect did not return a challenge"))?;
    if challenge.phase != "challenge" {
        return Err(HelperError::Unexpected(
            "connect did not return a challenge",
        ));
    }

    // v1 payload: the helper does not pin a Gateway key (the node socket is the machine's own,
    // mode 0600), exactly as the Mac helper.
    let payload = connect_payload(
        &challenge.nonce,
        PLATFORM,
        DEVICE_FAMILY,
        challenge.protocol_version.get(),
        challenge.server_origin.as_str(),
        None,
    );
    let verify = serde_json::json!({
        "nonce": challenge.nonce,
        "signature": identity.sign(&payload),
    });
    // The generated type documents the shape; build it so a schema change breaks this line.
    let _typed: ConnectVerifyParams = serde_json::from_value(verify.clone())
        .map_err(|_| HelperError::Unexpected("verify params"))?;
    writer.write_all(&req_line("connect.verify", "connect.verify", &verify)?)?;
    writer.flush()?;

    let result = await_response(reader, "connect.verify", deadline)?;
    Ok(match result.get("phase").and_then(Value::as_str) {
        Some("paired") => Paired::Paired,
        Some("pending") => Paired::Pending {
            code: result
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        Some("denied") => Paired::Denied {
            reason: result
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        },
        _ => return Err(HelperError::Unexpected("unknown connect phase")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;
    use crate::capability::Registry;
    use ed25519_dalek::Verifier;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;

    const NONCE: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn options(secret: Option<&str>) -> HandshakeOptions {
        HandshakeOptions {
            timeout: Duration::from_secs(5),
            handshake_secret: secret.map(str::to_string),
            capabilities: Registry::standard(BuildInfo::current()).manifest(),
        }
    }

    /// A fake Gateway: answers `connect` with a challenge, verifies the signature, answers
    /// `connect.verify` with `verdict`. Returns the `connect` params it saw.
    fn fake_gateway(stream: UnixStream, verdict: Value) -> std::thread::JoinHandle<Value> {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let connect: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(connect["method"], "connect");
            let challenge = serde_json::json!({
                "type": "res", "id": "connect", "ok": true,
                "payload": {
                    "phase": "challenge", "nonce": NONCE, "serverOrigin": "http://127.0.0.1:9",
                    "protocolVersion": 1, "expiresAt": "2030-01-01T00:00:00Z"
                }
            });
            writeln!(writer, "{challenge}").unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            let verify: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(verify["method"], "connect.verify");

            // Verify the signature the way the Gateway does.
            let params = &connect["params"];
            let payload = connect_payload(
                NONCE,
                "linux",
                "linux-helper",
                1,
                "http://127.0.0.1:9",
                None,
            );
            let key: [u8; 32] = base64::Engine::decode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                params["publicKey"].as_str().unwrap(),
            )
            .unwrap()
            .try_into()
            .unwrap();
            let sig: [u8; 64] = base64::Engine::decode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                verify["params"]["signature"].as_str().unwrap(),
            )
            .unwrap()
            .try_into()
            .unwrap();
            ed25519_dalek::VerifyingKey::from_bytes(&key)
                .unwrap()
                .verify(&payload, &ed25519_dalek::Signature::from_bytes(&sig))
                .expect("signature verifies against connectSigningPayload");
            assert_eq!(verify["params"]["nonce"], NONCE);

            let res = serde_json::json!({
                "type": "res", "id": "connect.verify", "ok": true, "payload": verdict
            });
            writeln!(writer, "{res}").unwrap();
            connect["params"].clone()
        })
    }

    fn run(verdict: Value, secret: Option<&str>) -> (Result<Paired, HelperError>, Value) {
        let (a, b) = UnixStream::pair().unwrap();
        a.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let gateway = fake_gateway(b, verdict);
        let identity = DeviceIdentity::from_seed([5; 32]);
        let mut reader = FrameReader::new(a.try_clone().unwrap());
        let mut writer = a;
        let outcome = perform(&mut reader, &mut writer, &identity, &options(secret));
        (outcome, gateway.join().unwrap())
    }

    #[test]
    fn pairs_and_sends_the_documented_connect_params() {
        let (outcome, params) = run(
            serde_json::json!({ "phase": "paired", "deviceId": "d", "scopes": [], "serverTime": "2030-01-01T00:00:00Z", "stateVersion": 1 }),
            Some("sekrit"),
        );
        assert_eq!(outcome.unwrap(), Paired::Paired);
        assert_eq!(params["role"], "node");
        assert_eq!(params["platform"], "linux");
        assert_eq!(params["deviceFamily"], "linux-helper");
        assert_eq!(params["handshakeSecret"], "sekrit");
        assert_eq!(
            params["protocolVersion"],
            serde_json::json!({ "min": 1, "max": 1 })
        );
        assert_eq!(params["capabilities"][0]["name"], "health");
        assert!(params["deviceId"].as_str().unwrap().starts_with("dev_"));
        assert_eq!(params["publicKey"].as_str().unwrap().len(), 43);
    }

    #[test]
    fn omits_the_secret_when_there_is_none() {
        let (_, params) = run(
            serde_json::json!({ "phase": "denied", "reason": "no" }),
            None,
        );
        assert!(params.get("handshakeSecret").is_none());
    }

    #[test]
    fn reports_pending_with_the_code_and_denied_with_the_reason() {
        let (pending, _) = run(
            serde_json::json!({ "phase": "pending", "pairingRequestId": "r", "code": "ABCD-EFGH" }),
            None,
        );
        assert_eq!(
            pending.unwrap(),
            Paired::Pending {
                code: Some("ABCD-EFGH".into())
            }
        );
        let (denied, _) = run(
            serde_json::json!({ "phase": "denied", "reason": "revoked" }),
            None,
        );
        assert_eq!(
            denied.unwrap(),
            Paired::Denied {
                reason: Some("revoked".into())
            }
        );
    }

    #[test]
    fn an_error_response_to_connect_is_a_gateway_error() {
        let (a, b) = UnixStream::pair().unwrap();
        a.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let t = std::thread::spawn(move || {
            let mut reader = BufReader::new(b.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut w = b;
            writeln!(
                w,
                r#"{{"type":"res","id":"connect","ok":false,"error":{{"code":"protocol_version_mismatch","message":"m"}}}}"#
            )
            .unwrap();
        });
        let identity = DeviceIdentity::from_seed([5; 32]);
        let mut reader = FrameReader::new(a.try_clone().unwrap());
        let mut writer = a;
        let err = perform(&mut reader, &mut writer, &identity, &options(None)).unwrap_err();
        t.join().unwrap();
        assert!(
            matches!(err, HelperError::Gateway { code } if code == "protocol_version_mismatch")
        );
    }

    #[test]
    fn a_silent_gateway_times_out() {
        let (a, _b) = UnixStream::pair().unwrap();
        a.set_read_timeout(Some(Duration::from_millis(20))).unwrap();
        let identity = DeviceIdentity::from_seed([5; 32]);
        let mut reader = FrameReader::new(a.try_clone().unwrap());
        let mut writer = a;
        let mut opts = options(None);
        opts.timeout = Duration::from_millis(100);
        assert!(matches!(
            perform(&mut reader, &mut writer, &identity, &opts),
            Err(HelperError::Timeout)
        ));
    }
}
