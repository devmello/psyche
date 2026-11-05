//! Sealing keychain values to Windows Hello (pure crypto; the Hello signature is an input).
//!
//! A Hello key's RSASSA-PKCS1-v1_5 signature is deterministic, so signing a fixed message after a
//! Hello gesture reproduces the same bytes every time, and nothing else can produce them (the
//! private key stays in the TPM). From that signature the helper derives a wrapping key
//! (HKDF-SHA256) that encrypts an X25519 secret. Values are sealed to the X25519 public key
//! (ephemeral ECDH + HKDF + AES-256-GCM, bound to the item's target name), so storing needs no
//! prompt, while opening needs the signature, i.e. Windows Hello.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::node::encoding::{b64url, b64url_decode, random_bytes};

/// What the Hello key signs to unlock the wrapping key.
pub const WRAP_MESSAGE: &[u8] = b"psyche.keychain.v1|wrap-key";
const WRAP_AAD: &[u8] = b"psyche.keychain.v1|wrap-record";
const SALT: &[u8] = b"psyche-win-helper/keychain";

pub const SEALED_ALG: &str = "hello-x25519-hkdf-aes256gcm";
pub const PLAIN_ALG: &str = "credman";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    Malformed,
    /// The record was made for another Hello key (the key was recreated).
    WrongKey,
    Decrypt,
}

/// The stored wrapping key: an X25519 secret encrypted under the Hello-derived key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrapRecord {
    pub v: u32,
    /// Public half (base64url).
    #[serde(rename = "pub")]
    pub public: String,
    pub nonce: String,
    pub ct: String,
    /// Hex SHA-256 of the Hello key's SPKI, to tell a recreated Hello key apart.
    pub kid: String,
}

/// One stored value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemRecord {
    pub v: u32,
    pub alg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
    /// Ciphertext (sealed) or the value itself (plain), base64url.
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kid: Option<String>,
}

impl ItemRecord {
    pub fn requires_auth(&self) -> bool {
        self.alg == SEALED_ALG
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(b: &[u8]) -> Result<ItemRecord, SealError> {
        let r: ItemRecord = serde_json::from_slice(b).map_err(|_| SealError::Malformed)?;
        if r.v != 1 || (r.alg != SEALED_ALG && r.alg != PLAIN_ALG) {
            return Err(SealError::Malformed);
        }
        Ok(r)
    }
}

fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(info, out.as_mut())
        .expect("32-byte HKDF output");
    out
}

fn aead(key: &[u8; 32]) -> Aes256Gcm {
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
}

/// Wrapping key from the Hello signature over `WRAP_MESSAGE`.
fn wrap_key(signature: &[u8]) -> Zeroizing<[u8; 32]> {
    hkdf32(signature, SALT, b"wrap-key.v1")
}

/// Creates a new X25519 pair and its wrap record.
pub fn new_wrap_record(signature: &[u8], kid: &str) -> (WrapRecord, StaticSecret) {
    let secret = StaticSecret::from(random_bytes::<32>());
    let public = PublicKey::from(&secret);
    let nonce = random_bytes::<12>();
    let key = wrap_key(signature);
    let bytes = Zeroizing::new(secret.to_bytes());
    let ct = aead(&key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: bytes.as_ref(),
                aad: WRAP_AAD,
            },
        )
        .expect("AES-GCM encryption");
    (
        WrapRecord {
            v: 1,
            public: b64url(public.as_bytes()),
            nonce: b64url(&nonce),
            ct: b64url(&ct),
            kid: kid.to_owned(),
        },
        secret,
    )
}

pub fn wrap_public(r: &WrapRecord) -> Result<PublicKey, SealError> {
    let b: [u8; 32] = b64url_decode(&r.public)
        .and_then(|v| v.try_into().ok())
        .ok_or(SealError::Malformed)?;
    Ok(PublicKey::from(b))
}

/// Decrypts the X25519 secret with the Hello signature.
pub fn open_wrap_record(
    r: &WrapRecord,
    signature: &[u8],
    kid: &str,
) -> Result<StaticSecret, SealError> {
    if r.v != 1 {
        return Err(SealError::Malformed);
    }
    if r.kid != kid {
        return Err(SealError::WrongKey);
    }
    let nonce = b64url_decode(&r.nonce)
        .filter(|n| n.len() == 12)
        .ok_or(SealError::Malformed)?;
    let ct = b64url_decode(&r.ct).ok_or(SealError::Malformed)?;
    let key = wrap_key(signature);
    let plain = Zeroizing::new(
        aead(&key)
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: WRAP_AAD,
                },
            )
            .map_err(|_| SealError::Decrypt)?,
    );
    let bytes: [u8; 32] = plain
        .as_slice()
        .try_into()
        .map_err(|_| SealError::Malformed)?;
    let secret = StaticSecret::from(bytes);
    if b64url(PublicKey::from(&secret).as_bytes()) != r.public {
        return Err(SealError::Decrypt);
    }
    Ok(secret)
}

fn item_key(shared: &[u8], epk: &[u8], public: &[u8], target: &str) -> Zeroizing<[u8; 32]> {
    let mut salt = Vec::with_capacity(64);
    salt.extend_from_slice(epk);
    salt.extend_from_slice(public);
    hkdf32(shared, &salt, format!("item.v1|{target}").as_bytes())
}

/// Seals `value` for `target` to the wrapping public key (no prompt).
pub fn seal(public: &PublicKey, kid: &str, target: &str, value: &[u8]) -> ItemRecord {
    let eph = StaticSecret::from(random_bytes::<32>());
    let epk = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(public);
    let key = item_key(shared.as_bytes(), epk.as_bytes(), public.as_bytes(), target);
    let nonce = random_bytes::<12>();
    let ct = aead(&key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: value,
                aad: target.as_bytes(),
            },
        )
        .expect("AES-GCM encryption");
    ItemRecord {
        v: 1,
        alg: SEALED_ALG.into(),
        epk: Some(b64url(epk.as_bytes())),
        nonce: Some(b64url(&nonce)),
        data: b64url(&ct),
        kid: Some(kid.to_owned()),
    }
}

/// Opens a sealed record with the unwrapped secret.
pub fn open(
    secret: &StaticSecret,
    target: &str,
    r: &ItemRecord,
) -> Result<Zeroizing<Vec<u8>>, SealError> {
    let epk: [u8; 32] = r
        .epk
        .as_deref()
        .and_then(b64url_decode)
        .and_then(|v| v.try_into().ok())
        .ok_or(SealError::Malformed)?;
    let nonce = r
        .nonce
        .as_deref()
        .and_then(b64url_decode)
        .filter(|n| n.len() == 12)
        .ok_or(SealError::Malformed)?;
    let ct = b64url_decode(&r.data).ok_or(SealError::Malformed)?;
    let public = PublicKey::from(secret);
    let shared = secret.diffie_hellman(&PublicKey::from(epk));
    let key = item_key(shared.as_bytes(), &epk, public.as_bytes(), target);
    aead(&key)
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: target.as_bytes(),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| SealError::Decrypt)
}

pub fn plain(value: &[u8]) -> ItemRecord {
    ItemRecord {
        v: 1,
        alg: PLAIN_ALG.into(),
        epk: None,
        nonce: None,
        data: b64url(value),
        kid: None,
    }
}

pub fn open_plain(r: &ItemRecord) -> Result<Zeroizing<Vec<u8>>, SealError> {
    b64url_decode(&r.data)
        .map(Zeroizing::new)
        .ok_or(SealError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_round_trip_bound_to_target_and_key() {
        let sig = [9u8; 256];
        let (wrap, secret) = new_wrap_record(&sig, "kid1");
        let public = wrap_public(&wrap).unwrap();
        let rec = seal(&public, "kid1", "Psyche/vault/main", b"kek-bytes");
        assert!(rec.requires_auth());
        let back = ItemRecord::from_bytes(&rec.to_bytes()).unwrap();
        let unwrapped = open_wrap_record(&wrap, &sig, "kid1").unwrap();
        assert_eq!(unwrapped.to_bytes(), secret.to_bytes());
        assert_eq!(
            open(&unwrapped, "Psyche/vault/main", &back)
                .unwrap()
                .as_slice(),
            b"kek-bytes"
        );
        // Another target name (a copied credential) does not open.
        assert_eq!(
            open(&unwrapped, "Psyche/vault/other", &back).unwrap_err(),
            SealError::Decrypt
        );
        // Another Hello signature or key id does not unwrap.
        assert_eq!(
            open_wrap_record(&wrap, &[8u8; 256], "kid1").err(),
            Some(SealError::Decrypt)
        );
        assert_eq!(
            open_wrap_record(&wrap, &sig, "kid2").err(),
            Some(SealError::WrongKey)
        );
    }

    #[test]
    fn plain_records_and_malformed_input() {
        let p = plain(b"v");
        assert!(!p.requires_auth());
        assert_eq!(
            open_plain(&ItemRecord::from_bytes(&p.to_bytes()).unwrap())
                .unwrap()
                .as_slice(),
            b"v"
        );
        assert_eq!(
            ItemRecord::from_bytes(b"{}").unwrap_err(),
            SealError::Malformed
        );
        assert_eq!(
            ItemRecord::from_bytes(br#"{"v":2,"alg":"credman","data":""}"#).unwrap_err(),
            SealError::Malformed
        );
    }
}
