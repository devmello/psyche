//! Signing payloads, byte-identical to `connectSigningPayload` in `packages/protocol`
//! (`methods/connect.ts`) and `ConnectSigning` in the Mac helper.

/// `connect.verify` payload. With `gateway_key` it is the v2 form (`psyche-connect-v2`, the key
/// appended); without it, v1. Fields are joined by `\n`, so none may contain one (the
/// `deviceFamily` pattern forbids it).
pub fn connect_payload(
    nonce: &str,
    platform: &str,
    device_family: &str,
    protocol_version: u64,
    server_origin: &str,
    gateway_key: Option<&str>,
) -> Vec<u8> {
    let version = protocol_version.to_string();
    let mut fields = vec![
        if gateway_key.is_none() {
            "psyche-connect-v1"
        } else {
            "psyche-connect-v2"
        },
        nonce,
        platform,
        device_family,
        &version,
        server_origin,
    ];
    if let Some(key) = gateway_key {
        fields.push(key);
    }
    fields.join("\n").into_bytes()
}

/// What the Gateway signs in its challenge (`gatewaySigningPayload`).
pub fn gateway_payload(nonce: &str, server_origin: &str, device_public_key: &str) -> Vec<u8> {
    ["psyche-gateway-v1", nonce, server_origin, device_public_key]
        .join("\n")
        .into_bytes()
}

/// What the Gateway signs to vouch for the TLS certificate of a LAN connection
/// (`lanCertSigningPayload`): `psyche-lan-cert-v1`, nonce, serverOrigin, device key, SPKI hash.
pub fn lan_cert_payload(
    nonce: &str,
    server_origin: &str,
    device_public_key: &str,
    spki: &str,
) -> Vec<u8> {
    [
        "psyche-lan-cert-v1",
        nonce,
        server_origin,
        device_public_key,
        spki,
    ]
    .join("\n")
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    // The inputs of `packages/protocol/test/gateway-identity.test.ts`, whose Gateway fixture
    // hash is also pinned by the iOS `GatewayIdentityTests`. The v1, v2 and LAN hashes are the
    // SHA-256 of the strings `connectSigningPayload` and `lanCertSigningPayload` build from the
    // same inputs.
    const NONCE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const DEVICE: &str = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
    const GATEWAY: &str = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
    const SPKI: &str = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
    const ORIGIN: &str = "https://studio-mac.tail1234.ts.net";

    fn hex_sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn payload_bytes_match_the_typescript_fixtures() {
        assert_eq!(
            hex_sha(&gateway_payload(NONCE, ORIGIN, DEVICE)),
            "a7614e437ff769b36ea9d4c3ee5d134314525e23ae03bdcdfe243ef437bf0d3d"
        );
        assert_eq!(
            hex_sha(&connect_payload(
                NONCE,
                "linux",
                "linux-helper",
                1,
                ORIGIN,
                None
            )),
            "5fa1fcf92d0724cd6b147ab58bcc1f38e5c23bc0c51771a56160faf960935fcf"
        );
        assert_eq!(
            hex_sha(&connect_payload(
                NONCE,
                "linux",
                "linux-helper",
                1,
                ORIGIN,
                Some(GATEWAY)
            )),
            "c0fe7146e3e456afd5fe40584e41919c49496d72b1e7cf16c2ef96a30bc16e82"
        );
        assert_eq!(
            hex_sha(&lan_cert_payload(NONCE, ORIGIN, DEVICE, SPKI)),
            "254bbccd086863102a64c6fe4624552ac1edd7dd92e18cdec7e41f4cd51089d6"
        );
    }

    #[test]
    fn lan_cert_payload_shape() {
        assert_eq!(
            String::from_utf8(lan_cert_payload("N", "o", "D", "S")).unwrap(),
            "psyche-lan-cert-v1\nN\no\nD\nS"
        );
    }

    #[test]
    fn v1_payload_matches_the_documented_shape() {
        let p = connect_payload("N", "linux", "linux-helper", 1, "http://127.0.0.1:1", None);
        assert_eq!(
            String::from_utf8(p).unwrap(),
            "psyche-connect-v1\nN\nlinux\nlinux-helper\n1\nhttp://127.0.0.1:1"
        );
    }

    #[test]
    fn v2_payload_appends_the_gateway_key() {
        let p = connect_payload("N", "linux", "linux-helper", 1, "o", Some("K"));
        assert_eq!(
            String::from_utf8(p).unwrap(),
            "psyche-connect-v2\nN\nlinux\nlinux-helper\n1\no\nK"
        );
    }

    #[test]
    fn gateway_payload_shape() {
        assert_eq!(
            String::from_utf8(gateway_payload("N", "o", "D")).unwrap(),
            "psyche-gateway-v1\nN\no\nD"
        );
    }
}
