//! Base64url (no padding, as the wire uses), standard base64, hex and OS randomness.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Accepts base64url with or without padding (`Base64URL.decode` in the Swift helper does too).
pub fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).ok()
}

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn b64_decode(text: &str) -> Option<Vec<u8>> {
    STANDARD.decode(text).ok()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).into()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&sha256(bytes))
}

/// Cryptographically secure random bytes from the OS (`BCryptGenRandom`, system-preferred RNG).
pub fn random_bytes<const N: usize>() -> [u8; N] {
    use windows::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    let mut out = [0u8; N];
    // SAFETY: the buffer is valid for N bytes; a null algorithm handle is allowed with the flag.
    let status = unsafe { BCryptGenRandom(None, &mut out, BCRYPT_USE_SYSTEM_PREFERRED_RNG) };
    assert!(status.is_ok(), "BCryptGenRandom failed");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trip_without_padding() {
        let raw = [0xfbu8, 0xff, 0xfe, 0x00, 0x01];
        let s = b64url(&raw);
        assert_eq!(s, "-__-AAE");
        assert_eq!(b64url_decode(&s).unwrap(), raw);
        assert_eq!(b64url_decode("-__-AAE=").unwrap(), raw);
        assert!(b64url_decode("***").is_none());
    }

    #[test]
    fn sha256_of_empty() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn random_differs() {
        assert_ne!(random_bytes::<16>(), random_bytes::<16>());
    }
}
