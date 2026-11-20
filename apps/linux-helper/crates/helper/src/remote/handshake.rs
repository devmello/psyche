//! `connect` -> challenge -> `connect.verify` to a remote Gateway (design §4.1, §6.1).
//!
//! What differs from the local socket handshake:
//!
//! - **The Gateway is checked first.** The challenge must pass `verify::verify_challenge` before
//!   anything is signed. On any failure the helper writes nothing more: no signature, no token.
//! - **v2 signing.** The signature covers the Gateway key that was just verified
//!   (`psyche-connect-v2`), and `connect.verify` names that key, so a relay cannot strip it.
//! - **The setup token rides in `connect.verify`**, after the checks, never in `connect`.
//! - There is no handshake secret: this is not the Gateway's own machine.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use psyche_protocol::frame::{req_line, Incoming};
use psyche_protocol::signing::connect_payload;
use psyche_protocol::{
    ConnectChallenge, ConnectParams, ConnectParamsDeviceId, ConnectParamsName, ConnectRole,
    ConnectVerifyParams, DeviceFamily, DevicePlatform, NodeCapability, ProtocolVersionRange,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};

use super::verify::{verify_challenge, Expect, IdentityError};
use crate::buildinfo::{DEVICE_FAMILY, PLATFORM};
use crate::channel::{FrameReader, HelperError, Read1};
use crate::identity::DeviceIdentity;

pub struct Options<'a> {
    pub timeout: Duration,
    pub name: &'a str,
    pub capabilities: Vec<NodeCapability>,
    /// Only a pairing presents one.
    pub setup_token: Option<&'a str>,
    pub expect: Expect<'a>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Paired,
    Pending {
        code: Option<String>,
    },
    Denied {
        reason: Option<String>,
        code: Option<String>,
    },
}

#[derive(Debug)]
pub enum Failure {
    /// The Gateway failed a check; nothing was signed.
    Identity(IdentityError),
    /// The Gateway answered with an error (`protocol_version_mismatch`, a rate limit, ...).
    Gateway(String),
    Transport(HelperError),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Identity(e) => write!(f, "{e} ({})", e.code()),
            Failure::Gateway(code) => write!(f, "the Gateway refused the handshake: {code}"),
            Failure::Transport(e) => write!(f, "{e}"),
        }
    }
}

impl From<HelperError> for Failure {
    fn from(e: HelperError) -> Self {
        match e {
            HelperError::Gateway { code } => Failure::Gateway(code),
            other => Failure::Transport(other),
        }
    }
}

impl From<std::io::Error> for Failure {
    fn from(e: std::io::Error) -> Self {
        Failure::Transport(HelperError::Io(e))
    }
}

pub fn connect_params(
    identity: &DeviceIdentity,
    name: &str,
    capabilities: Vec<NodeCapability>,
) -> Result<ConnectParams, HelperError> {
    let bad = HelperError::Unexpected;
    Ok(ConnectParams {
        capabilities,
        device_family: DeviceFamily::from(DEVICE_FAMILY.to_string()),
        device_id: ConnectParamsDeviceId::try_from(identity.device_id().as_str())
            .map_err(|_| bad("device id"))?,
        handshake_secret: None,
        name: ConnectParamsName::try_from(name).map_err(|_| bad("name"))?,
        platform: DevicePlatform::Linux,
        protocol_version: ProtocolVersionRange {
            max: std::num::NonZeroU64::new(PROTOCOL_VERSION).ok_or_else(|| bad("version"))?,
            min: std::num::NonZeroU64::new(1).ok_or_else(|| bad("version"))?,
        },
        public_key: identity.public_key(),
        role: ConnectRole::Node,
    })
}

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
            // Before pairing nothing else is expected; whatever it is, it is not acted on.
            Read1::Frame(_) => {}
        }
    }
}

/// Runs the handshake. On `Ok` the Gateway proved its identity (and, for a pairing, accepted or
/// queued this device). Frames that arrive afterwards stay queued in `reader`.
///
/// Returns the verified Gateway key with the verdict.
pub fn perform<R: Read, W: Write>(
    reader: &mut FrameReader<R>,
    writer: &mut W,
    identity: &DeviceIdentity,
    options: &Options<'_>,
) -> Result<(String, Verdict), Failure> {
    let deadline = Instant::now() + options.timeout;
    let params = connect_params(identity, options.name, options.capabilities.clone())?;
    writer.write_all(&req_line("connect", "connect", &params).map_err(HelperError::Frame)?)?;
    writer.flush()?;

    let challenge: ConnectChallenge =
        serde_json::from_value(await_response(reader, "connect", deadline)?)
            .map_err(|_| HelperError::Unexpected("connect did not return a challenge"))?;

    // Everything about the Gateway is decided here, before the device key signs anything.
    let gateway_key = verify_challenge(&challenge, &identity.public_key(), &options.expect)
        .map_err(Failure::Identity)?;

    let payload = connect_payload(
        &challenge.nonce,
        PLATFORM,
        DEVICE_FAMILY,
        challenge.protocol_version.get(),
        challenge.server_origin.as_str(),
        Some(&gateway_key),
    );
    let mut verify = json!({
        "nonce": challenge.nonce,
        "signature": identity.sign(&payload),
        "gatewayKey": gateway_key,
    });
    if let Some(token) = options.setup_token {
        verify["setupToken"] = json!(token);
    }
    // The generated type documents the shape; build it so a schema change breaks this line.
    let _typed: ConnectVerifyParams = serde_json::from_value(verify.clone())
        .map_err(|_| HelperError::Unexpected("verify params"))?;
    writer.write_all(
        &req_line("connect.verify", "connect.verify", &verify).map_err(HelperError::Frame)?,
    )?;
    writer.flush()?;

    let result = await_response(reader, "connect.verify", deadline)?;
    let text = |key: &str| result.get(key).and_then(Value::as_str).map(str::to_string);
    let verdict = match result.get("phase").and_then(Value::as_str) {
        Some("paired") => Verdict::Paired,
        Some("pending") => Verdict::Pending { code: text("code") },
        Some("denied") => Verdict::Denied {
            reason: text("reason"),
            code: text("code"),
        },
        _ => return Err(HelperError::Unexpected("unknown connect phase").into()),
    };
    Ok((gateway_key, verdict))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buildinfo::BuildInfo;
    use crate::capability::Registry;
    use crate::remote::testutil::{FakeGateway, GatewayCfg, LanCert, Script};
    use crate::remote::transport::dial;
    use std::sync::Arc;

    const TOKEN: &str = "pst_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

    fn run(
        gateway: &FakeGateway,
        target: &crate::remote::transport::Target,
        pinned: Option<&str>,
        token: Option<&str>,
    ) -> Result<(String, Verdict), Failure> {
        let dialed = dial(target).unwrap();
        let identity = DeviceIdentity::from_seed([5; 32]);
        let mut reader = FrameReader::new(dialed.link.reader());
        let mut writer = dialed.link.writer();
        let observed = dialed.observed.spki();
        let lan = match &target.security {
            crate::remote::transport::Security::Pin(pin) => {
                Some(crate::remote::verify::LanExpect {
                    pin,
                    observed_spki: observed.as_deref(),
                })
            }
            _ => None,
        };
        let _ = gateway;
        let options = Options {
            timeout: Duration::from_secs(5),
            name: "lab-box",
            capabilities: Registry::standard(BuildInfo::current()).manifest(),
            setup_token: token,
            expect: Expect {
                dialed_origin: &target.origin,
                pinned_key: pinned,
                first_seen_key: None,
                lan,
            },
        };
        perform(&mut reader, &mut writer, &identity, &options)
    }

    fn connect_verify_of(gateway: &FakeGateway) -> Option<Value> {
        gateway
            .frames()
            .into_iter()
            .find(|f| f["method"] == "connect.verify")
    }

    #[test]
    fn pairs_with_a_v2_signature_over_the_verified_key_and_the_token_only_in_verify() {
        let gateway = FakeGateway::start(Script::gateway(GatewayCfg::new()));
        let key = gateway.gateway_key();
        let (proved, verdict) =
            run(&gateway, &gateway.target_plain(), Some(&key), Some(TOKEN)).unwrap();
        assert_eq!(proved, key);
        assert_eq!(verdict, Verdict::Paired);

        let frames = gateway.frames();
        let connect = &frames[0];
        assert_eq!(connect["method"], "connect");
        assert!(connect["params"].get("handshakeSecret").is_none());
        assert!(
            !connect.to_string().contains(TOKEN),
            "the token never rides in connect"
        );
        assert_eq!(connect["params"]["name"], "lab-box");
        assert_eq!(connect["params"]["role"], "node");
        let verify = connect_verify_of(&gateway).unwrap();
        assert_eq!(verify["params"]["setupToken"], TOKEN);
        assert_eq!(verify["params"]["gatewayKey"], key);

        // The signature is the v2 payload, so a relay cannot present it as v1.
        use base64::Engine;
        let device_key: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(connect["params"]["publicKey"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let sig: [u8; 64] = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(verify["params"]["signature"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&device_key).unwrap();
        let origin = gateway.target_plain().origin;
        let v2 = connect_payload(
            crate::remote::testutil::NONCE,
            "linux",
            "linux-helper",
            1,
            &origin,
            Some(&key),
        );
        let v1 = connect_payload(
            crate::remote::testutil::NONCE,
            "linux",
            "linux-helper",
            1,
            &origin,
            None,
        );
        let sig = ed25519_dalek::Signature::from_bytes(&sig);
        assert!(vk.verify_strict(&v2, &sig).is_ok());
        assert!(vk.verify_strict(&v1, &sig).is_err());
    }

    #[test]
    fn a_paired_device_sends_no_token() {
        let gateway = FakeGateway::start(Script::gateway(GatewayCfg::new()));
        let key = gateway.gateway_key();
        run(&gateway, &gateway.target_plain(), Some(&key), None).unwrap();
        assert!(connect_verify_of(&gateway).unwrap()["params"]
            .get("setupToken")
            .is_none());
    }

    fn assert_nothing_signed(gateway: &FakeGateway) {
        assert!(
            connect_verify_of(gateway).is_none(),
            "no connect.verify (no signature, no token) after a failed check"
        );
        for f in gateway.frames() {
            assert!(!f.to_string().contains(TOKEN), "token leaked: {f}");
        }
    }

    #[test]
    fn every_challenge_failure_stops_before_connect_verify() {
        type Tamper = Arc<dyn Fn(&mut Value) + Send + Sync>;
        let cases: Vec<(&str, IdentityError, Tamper)> = vec![
            (
                "another origin",
                IdentityError::OriginMismatch,
                Arc::new(|c| c["serverOrigin"] = json!("http://127.0.0.1:1")),
            ),
            (
                "no key",
                IdentityError::IdentityMissing,
                Arc::new(|c| {
                    c.as_object_mut().unwrap().remove("gatewayKey");
                }),
            ),
            (
                "no signature",
                IdentityError::IdentityMissing,
                Arc::new(|c| {
                    c.as_object_mut().unwrap().remove("gatewaySignature");
                }),
            ),
            (
                "bad signature",
                IdentityError::IdentityInvalid,
                Arc::new(|c| c["gatewaySignature"] = json!("A".repeat(86))),
            ),
            (
                "another nonce",
                IdentityError::IdentityInvalid,
                Arc::new(|c| c["nonce"] = json!("B".repeat(43))),
            ),
        ];
        for (label, expected, tamper) in cases {
            let mut cfg = GatewayCfg::new();
            cfg.tamper = Some(tamper);
            let gateway = FakeGateway::start(Script::gateway(cfg));
            let key = gateway.gateway_key();
            let result = run(&gateway, &gateway.target_plain(), Some(&key), Some(TOKEN));
            assert!(
                matches!(&result, Err(Failure::Identity(e)) if *e == expected),
                "{label}: {result:?}"
            );
            assert_nothing_signed(&gateway);
        }
    }

    #[test]
    fn a_different_gateway_key_than_the_pinned_one_stops_before_connect_verify() {
        let gateway = FakeGateway::start(Script::gateway(GatewayCfg::new()));
        let pinned = {
            use base64::Engine;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
                ed25519_dalek::SigningKey::from_bytes(&[9u8; 32])
                    .verifying_key()
                    .to_bytes(),
            )
        };
        let result = run(
            &gateway,
            &gateway.target_plain(),
            Some(&pinned),
            Some(TOKEN),
        );
        assert!(matches!(
            result,
            Err(Failure::Identity(IdentityError::IdentityChanged))
        ));
        assert_nothing_signed(&gateway);
    }

    #[test]
    fn lan_vouching_for_another_certificate_stops_before_connect_verify() {
        let mut cfg = GatewayCfg::new();
        cfg.lan_cert = LanCert::Other("DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw".into());
        let gateway = FakeGateway::start_tls(Script::gateway(cfg));
        let key = gateway.gateway_key();
        let result = run(&gateway, &gateway.target_tls(), Some(&key), Some(TOKEN));
        assert!(matches!(
            result,
            Err(Failure::Identity(IdentityError::CertChanged))
        ));
        assert_nothing_signed(&gateway);
    }

    #[test]
    fn lan_without_any_vouching_stops_before_connect_verify() {
        let gateway = FakeGateway::start_tls(Script::gateway(GatewayCfg::new()));
        let key = gateway.gateway_key();
        let result = run(&gateway, &gateway.target_tls(), Some(&key), Some(TOKEN));
        assert!(matches!(
            result,
            Err(Failure::Identity(IdentityError::CertMissing))
        ));
        assert_nothing_signed(&gateway);
    }

    #[test]
    fn lan_with_the_served_certificate_vouched_pairs() {
        let mut cfg = GatewayCfg::new();
        cfg.lan_cert = LanCert::Served;
        let gateway = FakeGateway::start_tls(Script::gateway(cfg));
        let key = gateway.gateway_key();
        let (_, verdict) = run(&gateway, &gateway.target_tls(), Some(&key), Some(TOKEN)).unwrap();
        assert_eq!(verdict, Verdict::Paired);
    }

    #[test]
    fn verdicts_pending_denied_and_gateway_errors_are_reported() {
        for (verdict, expected) in [
            (
                json!({"phase":"pending","pairingRequestId":"r","code":"ABCD-EFGH"}),
                Verdict::Pending {
                    code: Some("ABCD-EFGH".into()),
                },
            ),
            (
                json!({"phase":"denied","reason":"gone","code":"device_revoked"}),
                Verdict::Denied {
                    reason: Some("gone".into()),
                    code: Some("device_revoked".into()),
                },
            ),
            (
                json!({"phase":"denied","reason":"used","code":"setup_token_invalid"}),
                Verdict::Denied {
                    reason: Some("used".into()),
                    code: Some("setup_token_invalid".into()),
                },
            ),
        ] {
            let mut cfg = GatewayCfg::new();
            cfg.verdict = verdict;
            let gateway = FakeGateway::start(Script::gateway(cfg));
            let key = gateway.gateway_key();
            let (_, got) = run(&gateway, &gateway.target_plain(), Some(&key), None).unwrap();
            assert_eq!(got, expected);
        }
        let mut cfg = GatewayCfg::new();
        cfg.connect_error = Some("protocol_version_mismatch".into());
        let gateway = FakeGateway::start(Script::gateway(cfg));
        let key = gateway.gateway_key();
        let result = run(&gateway, &gateway.target_plain(), Some(&key), None);
        assert!(
            matches!(result, Err(Failure::Gateway(code)) if code == "protocol_version_mismatch")
        );
    }
}
