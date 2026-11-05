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

#[cfg(test)]
mod tests {
    use super::*;

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
