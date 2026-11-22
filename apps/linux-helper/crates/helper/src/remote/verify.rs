//! The helper's half of the Gateway identity pin (design §4.1; the client rules of
//! `createGatewayVerifier` in `apps/desktop/src/lib/gateway-identity.ts`, strict mode). Before it
//! signs anything, a challenge must:
//!
//! 1. name the origin that was dialed;
//! 2. carry the Gateway's identity key and a signature by it;
//! 3. verify over `psyche-gateway-v1 \n nonce \n serverOrigin \n this device's public key`;
//! 4. carry the pinned key (or, for a first pair without a link, the same key on every attempt);
//! 5. on the LAN, vouch for the certificate this connection was served with
//!    (`lanCertSignature`), and that certificate must be the one the TLS layer saw and the pin.
//!
//! Every check fails closed with its own reason. Nothing is signed and no token is sent after a
//! failure.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use psyche_protocol::signing::{gateway_payload, lan_cert_payload};
use psyche_protocol::ConnectChallenge;
use sha2::{Digest, Sha256};

use super::link::is_base64url_32_bytes;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityError {
    /// The challenge names a different origin than the one dialed.
    OriginMismatch,
    /// No key or no signature in the challenge.
    IdentityMissing,
    /// The signature does not verify for this nonce, origin and device.
    IdentityInvalid,
    /// A different key than the pinned (or first-seen) one.
    IdentityChanged,
    /// LAN: the challenge does not vouch for a certificate, or none was seen.
    CertMissing,
    /// LAN: the certificate signature does not verify.
    CertInvalid,
    /// LAN: the vouched certificate is not the one served, or not the pinned one.
    CertChanged,
}

impl IdentityError {
    pub fn code(self) -> &'static str {
        match self {
            IdentityError::OriginMismatch => "gateway_origin_mismatch",
            IdentityError::IdentityMissing => "gateway_identity_missing",
            IdentityError::IdentityInvalid => "gateway_identity_invalid",
            IdentityError::IdentityChanged => "gateway_identity_changed",
            IdentityError::CertMissing => "gateway_cert_missing",
            IdentityError::CertInvalid => "gateway_cert_invalid",
            IdentityError::CertChanged => "gateway_cert_changed",
        }
    }
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            IdentityError::OriginMismatch => {
                "the Gateway named a different address than the one dialed"
            }
            IdentityError::IdentityMissing => "the Gateway did not prove its identity",
            IdentityError::IdentityInvalid => "the Gateway's identity proof does not verify",
            IdentityError::IdentityChanged => "the Gateway's identity changed",
            IdentityError::CertMissing => "the Gateway did not vouch for its certificate",
            IdentityError::CertInvalid => "the Gateway's certificate proof does not verify",
            IdentityError::CertChanged => "the Gateway's certificate is not the pinned one",
        })
    }
}

impl std::error::Error for IdentityError {}

/// What a connection must satisfy.
pub struct Expect<'a> {
    /// The origin the helper dialed, as it wrote it (`https://host[:port]`).
    pub dialed_origin: &'a str,
    /// The pinned Gateway key.
    pub pinned_key: Option<&'a str>,
    /// First pair without a link: the key seen on an earlier attempt of this same pairing.
    pub first_seen_key: Option<&'a str>,
    /// LAN only: the certificate pin from the link, and the SPKI the TLS layer actually saw.
    pub lan: Option<LanExpect<'a>>,
}

pub struct LanExpect<'a> {
    pub pin: &'a str,
    pub observed_spki: Option<&'a str>,
}

fn verify(key: &str, payload: &[u8], signature: &str) -> bool {
    if !is_base64url_32_bytes(key) || signature.len() != 86 {
        return false;
    }
    let (Ok(key), Ok(signature)) = (
        URL_SAFE_NO_PAD.decode(key),
        URL_SAFE_NO_PAD.decode(signature),
    ) else {
        return false;
    };
    let (Ok(key), Ok(signature)) = (<[u8; 32]>::try_from(key), <[u8; 64]>::try_from(signature))
    else {
        return false;
    };
    VerifyingKey::from_bytes(&key)
        .and_then(|k| k.verify_strict(payload, &Signature::from_bytes(&signature)))
        .is_ok()
}

/// A scheme, host and port, with the default port filled in, or `None`.
fn origin_parts(text: &str) -> Option<(String, String, u16)> {
    let text = text.strip_suffix('/').unwrap_or(text);
    let (scheme, rest) = text.split_once("://")?;
    let default = match scheme {
        "https" => 443,
        "http" => 80,
        _ => return None,
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\']) {
        return None;
    }
    let (host, port) = if let Some(after) = rest.strip_prefix('[') {
        let close = after.find(']')?;
        let tail = &after[close + 1..];
        let port = match tail {
            "" => default,
            t => t.strip_prefix(':')?.parse().ok()?,
        };
        (format!("[{}]", &after[..close]), port)
    } else {
        match rest.split_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().ok()?),
            None => (rest.to_string(), default),
        }
    };
    Some((scheme.to_string(), host.to_ascii_lowercase(), port))
}

pub fn same_origin(dialed: &str, named: &str) -> bool {
    match (origin_parts(dialed), origin_parts(named)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

/// `sha256:<hex>` of the raw Gateway key, what the owner compares on the Mac.
pub fn fingerprint(key_b64url: &str) -> Option<String> {
    let raw = URL_SAFE_NO_PAD.decode(key_b64url).ok()?;
    let digest = Sha256::digest(raw);
    Some(format!(
        "sha256:{}",
        digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

/// Checks a challenge. On success: the Gateway key it proved.
pub fn verify_challenge(
    challenge: &ConnectChallenge,
    device_public_key: &str,
    expect: &Expect<'_>,
) -> Result<String, IdentityError> {
    if challenge.phase != "challenge" {
        return Err(IdentityError::IdentityMissing);
    }
    let named = challenge.server_origin.to_string();
    if !same_origin(expect.dialed_origin, &named) {
        return Err(IdentityError::OriginMismatch);
    }
    let (Some(key), Some(signature)) = (&challenge.gateway_key, &challenge.gateway_signature)
    else {
        return Err(IdentityError::IdentityMissing);
    };
    if !verify(
        key,
        &gateway_payload(&challenge.nonce, &named, device_public_key),
        signature,
    ) {
        return Err(IdentityError::IdentityInvalid);
    }
    match (expect.pinned_key, expect.first_seen_key) {
        (Some(pinned), _) if pinned != key => return Err(IdentityError::IdentityChanged),
        (None, Some(first)) if first != key => return Err(IdentityError::IdentityChanged),
        _ => {}
    }
    if let Some(lan) = &expect.lan {
        let (Some(spki), Some(cert_signature), Some(observed)) = (
            &challenge.lan_cert_spki,
            &challenge.lan_cert_signature,
            lan.observed_spki,
        ) else {
            return Err(IdentityError::CertMissing);
        };
        if !verify(
            key,
            &lan_cert_payload(&challenge.nonce, &named, device_public_key, spki),
            cert_signature,
        ) {
            return Err(IdentityError::CertInvalid);
        }
        // What the Gateway vouched for must be what this connection is talking to, and what the
        // link pinned.
        if spki != observed || spki != lan.pin {
            return Err(IdentityError::CertChanged);
        }
    }
    Ok(key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    const NONCE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const DEVICE: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
    const ORIGIN: &str = "https://a.ts.net";
    const SPKI: &str = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[3u8; 32])
    }
    fn public(k: &SigningKey) -> String {
        URL_SAFE_NO_PAD.encode(k.verifying_key().to_bytes())
    }
    fn sign(k: &SigningKey, payload: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(k.sign(payload).to_bytes())
    }

    /// A challenge as the Gateway builds it, with optional LAN proof.
    fn challenge(k: &SigningKey, origin: &str, lan: bool) -> serde_json::Value {
        let mut c = json!({
            "phase": "challenge", "nonce": NONCE, "serverOrigin": origin,
            "protocolVersion": 1, "expiresAt": "2030-01-01T00:00:00Z",
            "gatewayKey": public(k),
            "gatewaySignature": sign(k, &gateway_payload(NONCE, origin, DEVICE)),
        });
        if lan {
            c["lanCertSpki"] = json!(SPKI);
            c["lanCertSignature"] = json!(sign(k, &lan_cert_payload(NONCE, origin, DEVICE, SPKI)));
        }
        c
    }

    fn check(c: &serde_json::Value, expect: &Expect<'_>) -> Result<String, IdentityError> {
        let ch: ConnectChallenge = serde_json::from_value(c.clone()).unwrap();
        verify_challenge(&ch, DEVICE, expect)
    }

    fn serve_expect<'a>(pinned: Option<&'a str>) -> Expect<'a> {
        Expect {
            dialed_origin: ORIGIN,
            pinned_key: pinned,
            first_seen_key: None,
            lan: None,
        }
    }

    #[test]
    fn a_good_challenge_returns_the_proved_key() {
        let k = key();
        let pk = public(&k);
        let got = check(&challenge(&k, ORIGIN, false), &serve_expect(Some(&pk))).unwrap();
        assert_eq!(got, pk);
    }

    #[test]
    fn each_failure_has_its_own_reason_and_nothing_passes() {
        let k = key();
        let pk = public(&k);
        let other = SigningKey::from_bytes(&[4u8; 32]);
        let base = challenge(&k, ORIGIN, false);

        // 1. another origin (a relay, a tunnel, a squatter)
        let mut c = challenge(&k, "https://evil.example", false);
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::OriginMismatch)
        );
        c = challenge(&k, "https://a.ts.net:8443", false);
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::OriginMismatch)
        );
        c = challenge(&k, "http://a.ts.net", false);
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::OriginMismatch)
        );

        // 2. no proof at all (an older Gateway, or a relay stripping it)
        for field in ["gatewayKey", "gatewaySignature"] {
            let mut c = base.clone();
            c.as_object_mut().unwrap().remove(field);
            assert_eq!(
                check(&c, &serve_expect(Some(&pk))),
                Err(IdentityError::IdentityMissing),
                "{field}"
            );
        }

        // 3. a signature that does not verify: wrong signer, bad bytes, another nonce, origin
        // or device (a replay)
        let mut c = base.clone();
        c["gatewaySignature"] = json!(sign(&other, &gateway_payload(NONCE, ORIGIN, DEVICE)));
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::IdentityInvalid)
        );
        for payload in [
            gateway_payload("B".repeat(43).as_str(), ORIGIN, DEVICE),
            gateway_payload(NONCE, "https://b.ts.net", DEVICE),
            gateway_payload(NONCE, ORIGIN, "somebody-else"),
            psyche_protocol::signing::connect_payload(
                NONCE,
                "linux",
                "linux-helper",
                1,
                ORIGIN,
                None,
            ),
        ] {
            let mut c = base.clone();
            c["gatewaySignature"] = json!(sign(&k, &payload));
            assert_eq!(
                check(&c, &serve_expect(Some(&pk))),
                Err(IdentityError::IdentityInvalid)
            );
        }
        let mut c = base.clone();
        c["gatewaySignature"] = json!("A".repeat(86));
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::IdentityInvalid)
        );
        // A key that is not on the curve or not 32 bytes never verifies.
        let mut c = base.clone();
        c["gatewayKey"] = json!("A".repeat(43));
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::IdentityInvalid)
        );

        // 4. a valid proof by a different key than the pinned one
        let c = challenge(&other, ORIGIN, false);
        assert_eq!(
            check(&c, &serve_expect(Some(&pk))),
            Err(IdentityError::IdentityChanged)
        );
        let first = public(&other);
        let e = Expect {
            first_seen_key: Some(&first),
            ..serve_expect(None)
        };
        assert_eq!(check(&base, &e), Err(IdentityError::IdentityChanged));
        assert!(check(&challenge(&other, ORIGIN, false), &e).is_ok());
    }

    #[test]
    fn a_wrong_phase_proves_nothing() {
        let k = key();
        let mut c = challenge(&k, ORIGIN, false);
        c["phase"] = json!("paired");
        assert_eq!(
            check(&c, &serve_expect(Some(&public(&k)))),
            Err(IdentityError::IdentityMissing)
        );
    }

    fn lan_expect<'a>(pk: &'a str, observed: Option<&'a str>, pin: &'a str) -> Expect<'a> {
        Expect {
            dialed_origin: ORIGIN,
            pinned_key: Some(pk),
            first_seen_key: None,
            lan: Some(LanExpect {
                pin,
                observed_spki: observed,
            }),
        }
    }

    #[test]
    fn lan_requires_a_vouched_certificate_that_is_the_one_served_and_pinned() {
        let k = key();
        let pk = public(&k);
        let other = SigningKey::from_bytes(&[4u8; 32]);
        let good = challenge(&k, ORIGIN, true);
        assert!(check(&good, &lan_expect(&pk, Some(SPKI), SPKI)).is_ok());

        // The TLS layer saw nothing, or the challenge vouches for nothing.
        assert_eq!(
            check(&good, &lan_expect(&pk, None, SPKI)),
            Err(IdentityError::CertMissing)
        );
        for field in ["lanCertSpki", "lanCertSignature"] {
            let mut c = good.clone();
            c.as_object_mut().unwrap().remove(field);
            assert_eq!(
                check(&c, &lan_expect(&pk, Some(SPKI), SPKI)),
                Err(IdentityError::CertMissing),
                "{field}"
            );
        }
        // The vouching signature is by someone else, or over other bytes.
        let mut c = good.clone();
        c["lanCertSignature"] = json!(sign(&other, &lan_cert_payload(NONCE, ORIGIN, DEVICE, SPKI)));
        assert_eq!(
            check(&c, &lan_expect(&pk, Some(SPKI), SPKI)),
            Err(IdentityError::CertInvalid)
        );
        let mut c = good.clone();
        c["lanCertSignature"] = json!(sign(&k, &lan_cert_payload(NONCE, ORIGIN, "x", SPKI)));
        assert_eq!(
            check(&c, &lan_expect(&pk, Some(SPKI), SPKI)),
            Err(IdentityError::CertInvalid)
        );
        // A relay with its own certificate: the Gateway vouched for SPKI, the connection shows
        // another (or the link pinned another).
        let relay = "DAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAw";
        assert_eq!(
            check(&good, &lan_expect(&pk, Some(relay), SPKI)),
            Err(IdentityError::CertChanged)
        );
        assert_eq!(
            check(&good, &lan_expect(&pk, Some(SPKI), relay)),
            Err(IdentityError::CertChanged)
        );
    }

    #[test]
    fn origins_compare_by_scheme_host_and_port_with_default_ports_filled_in() {
        assert!(same_origin("https://a.ts.net", "https://a.ts.net"));
        assert!(same_origin("https://a.ts.net", "https://a.ts.net/"));
        assert!(same_origin("https://a.ts.net", "https://A.ts.net:443"));
        assert!(same_origin(
            "https://[fd00::1]:7979",
            "https://[fd00::1]:7979"
        ));
        for named in [
            "https://a.ts.net:444",
            "http://a.ts.net",
            "https://b.ts.net",
            "https://a.ts.net/x",
            "https://user@a.ts.net",
            "",
            "a.ts.net",
            "wss://a.ts.net",
            "https://a.ts.net:x",
        ] {
            assert!(!same_origin("https://a.ts.net", named), "{named}");
        }
        // No loopback aliasing: localhost is not 127.0.0.1 here.
        assert!(!same_origin("http://127.0.0.1:9", "http://localhost:9"));
    }

    #[test]
    fn fingerprints_are_sha256_hex_of_the_raw_key() {
        let fp = fingerprint("AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM").unwrap();
        assert!(fp.starts_with("sha256:") && fp.len() == 7 + 64);
        assert!(fingerprint("!!").is_none());
    }
}
