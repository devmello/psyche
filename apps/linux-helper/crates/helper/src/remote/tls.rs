//! TLS for the Gateway connection (linux-helper-only design §4.2). Two verifiers, and nothing
//! else:
//!
//! - **CA:** a Tailscale Serve (or any public) Gateway, verified against the bundled Mozilla
//!   roots (`webpki-roots`), name included.
//! - **Pin:** a LAN Gateway with a self-signed certificate. Only the certificate whose SPKI hashes
//!   to the pin from the link is accepted, whatever its name, issuer or dates, and the TLS
//!   handshake signature must still verify under that certificate's key, so the peer holds the
//!   key.
//!
//! TLS 1.3 only. A failed verification aborts the handshake before the client writes any
//! application data.

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// One DER element at the start of `input`: (tag, content, rest). Definite lengths only, at most
/// four length bytes, all bounds checked.
fn der_element(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    // High-tag-number form is not used by anything on the path to the SPKI.
    if tag & 0x1f == 0x1f {
        return None;
    }
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || rest.len() < count {
            return None;
        }
        let mut len = 0usize;
        for b in &rest[..count] {
            len = (len << 8) | usize::from(*b);
        }
        (len, &rest[count..])
    };
    if rest.len() < len {
        return None;
    }
    Some((tag, &rest[..len], &rest[len..]))
}

/// The DER `SubjectPublicKeyInfo` (tag and length included) of an X.509 certificate.
pub fn spki_der(cert: &[u8]) -> Option<&[u8]> {
    // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE { ... }, ... }
    let (tag, body, _) = der_element(cert)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = der_element(body)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    // [0] EXPLICIT version, optional.
    let (tag, _, after) = der_element(rest)?;
    if tag == 0xa0 {
        rest = after;
    }
    // serialNumber, signature, issuer, validity, subject
    for expected in [0x02u8, 0x30, 0x30, 0x30, 0x30] {
        let (tag, _, after) = der_element(rest)?;
        if tag != expected {
            return None;
        }
        rest = after;
    }
    // subjectPublicKeyInfo: keep its own header.
    let (tag, content, _) = der_element(rest)?;
    if tag != 0x30 {
        return None;
    }
    let header = rest.len() - der_element(rest)?.2.len() - content.len();
    Some(&rest[..header + content.len()])
}

/// base64url SHA-256 of the certificate's SPKI: the form of `certPin` and `lanCertSpki`.
pub fn spki_pin(cert: &[u8]) -> Option<String> {
    let spki = spki_der(cert)?;
    Some(URL_SAFE_NO_PAD.encode(Sha256::digest(spki)))
}

/// What the pin verifier saw, for the identity check that follows the handshake.
#[derive(Clone, Default)]
pub struct Observed(Arc<Mutex<Option<String>>>);

impl Observed {
    pub fn spki(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

#[derive(Debug)]
struct PinVerifier {
    pin: [u8; 32],
    provider: Arc<CryptoProvider>,
    observed: Observed,
}

impl std::fmt::Debug for Observed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Observed")
    }
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let spki = spki_der(end_entity.as_ref())
            .ok_or_else(|| rustls::Error::General("unreadable certificate".into()))?;
        let digest = Sha256::digest(spki);
        *self.observed.0.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(URL_SAFE_NO_PAD.encode(digest));
        if ct_eq(&digest, &self.pin) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the Gateway's certificate is not the pinned one".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 is not used".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// A client configuration for a CA-certified Gateway.
pub fn ca_config() -> Result<ClientConfig, rustls::Error> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Ok(ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

/// A client configuration that accepts only the certificate whose SPKI hashes to `pin` (base64url
/// of the SHA-256), and reports what it saw through the returned [`Observed`].
pub fn pinned_config(pin: &str) -> Result<(ClientConfig, Observed), rustls::Error> {
    let raw = URL_SAFE_NO_PAD
        .decode(pin)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| rustls::Error::General("the certificate pin is not 32 bytes".into()))?;
    let observed = Observed::default();
    let verifier = PinVerifier {
        pin: raw,
        provider: provider(),
        observed: observed.clone(),
    };
    let config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok((config, observed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cert(names: &[&str]) -> (Vec<u8>, rcgen::CertifiedKey<rcgen::KeyPair>) {
        let made = rcgen::generate_simple_self_signed(
            names.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        )
        .unwrap();
        (made.cert.der().to_vec(), made)
    }

    #[test]
    fn the_spki_walker_agrees_with_an_x509_parser() {
        for names in [&["a.local"][..], &["lab-box.local", "x.local"][..]] {
            let (der, made) = cert(names);
            let (_, parsed) = x509_parser::parse_x509_certificate(&der).unwrap();
            assert_eq!(
                spki_der(&der).unwrap(),
                parsed.tbs_certificate.subject_pki.raw
            );
            // rcgen exposes the same bytes as the key's public key DER.
            assert_eq!(
                spki_der(&der).unwrap(),
                rcgen::PublicKeyData::subject_public_key_info(&made.signing_key).as_slice()
            );
            assert_eq!(spki_pin(&der).unwrap().len(), 43);
        }
    }

    #[test]
    fn truncated_or_hostile_der_is_not_a_certificate() {
        let (der, _) = cert(&["a.local"]);
        for cut in [0, 1, 2, 5, 20, der.len() / 2, der.len() - 1] {
            // Never panics, and a cut certificate has no SPKI.
            assert!(spki_der(&der[..cut]).is_none(), "cut at {cut}");
        }
        assert!(spki_der(&[0x30, 0x84, 0xff, 0xff, 0xff, 0xff]).is_none());
        assert!(spki_der(&[0x31, 0x00]).is_none());
        assert!(spki_der(&[0x30, 0x80]).is_none());
        assert!(spki_der(b"").is_none());
    }

    #[test]
    fn the_pin_must_be_32_bytes() {
        assert!(pinned_config("short").is_err());
        assert!(pinned_config(&URL_SAFE_NO_PAD.encode([1u8; 31])).is_err());
        assert!(pinned_config(&URL_SAFE_NO_PAD.encode([1u8; 32])).is_ok());
    }

    #[test]
    fn the_ca_config_builds() {
        assert!(ca_config().is_ok());
    }
}
