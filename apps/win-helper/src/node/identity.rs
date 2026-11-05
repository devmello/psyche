//! Ed25519 device identity (security §4, §10), byte-compatible with `PsycheWire.DeviceIdentity`:
//!
//! - `publicKey`: base64url of the raw 32-byte public key.
//! - `deviceId`: `dev_` + the first 22 base64url characters of SHA-256(raw public key).
//! - signatures: raw 64-byte Ed25519, base64url.
//!
//! The private key is stored in `$PSYCHE_HOME\helper\device.key.dpapi`, sealed with DPAPI
//! (`CryptProtectData`, CurrentUser scope, with fixed optional entropy), never in plaintext. Only
//! this Windows user on this machine can open it.

use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey};

use super::encoding::{b64url, random_bytes, sha256};
use super::paths::{Env, helper_dir, psyche_home};

#[derive(Clone)]
pub struct DeviceIdentity {
    key: SigningKey,
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceIdentity")
            .field("device_id", &self.device_id())
            .finish_non_exhaustive()
    }
}

impl DeviceIdentity {
    pub fn generate() -> Self {
        DeviceIdentity {
            key: SigningKey::from_bytes(&random_bytes::<32>()),
        }
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        DeviceIdentity {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.key.to_bytes()
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// base64url raw 32-byte public key.
    pub fn public_key(&self) -> String {
        b64url(&self.public_key_bytes())
    }

    /// `dev_` + first 22 base64url characters of SHA-256(raw public key).
    pub fn device_id(&self) -> String {
        let digest = b64url(&sha256(&self.public_key_bytes()));
        format!("dev_{}", &digest[..22])
    }

    /// base64url Ed25519 signature (64 bytes).
    pub fn sign(&self, payload: &[u8]) -> String {
        b64url(&self.key.sign(payload).to_bytes())
    }
}

/// Bytes signed for `connect.verify` (`connectSigningPayload`): `psyche-connect-v1` (or `-v2`
/// with the Gateway key appended), nonce, platform, deviceFamily, protocolVersion, serverOrigin,
/// joined with `\n`. Fields containing a newline are refused (the payload would be ambiguous).
pub fn connect_signing_payload(
    nonce: &str,
    platform: &str,
    device_family: &str,
    protocol_version: u32,
    server_origin: &str,
    gateway_key: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut fields = vec![
        ("nonce", nonce),
        ("platform", platform),
        ("deviceFamily", device_family),
        ("serverOrigin", server_origin),
    ];
    if let Some(k) = gateway_key {
        fields.push(("gatewayKey", k));
    }
    for (name, value) in &fields {
        if value.is_empty() || value.contains(['\r', '\n']) {
            return Err(format!("{name} must be a non-empty single-line string"));
        }
    }
    if protocol_version < 1 {
        return Err("protocolVersion must be a positive integer".into());
    }
    let version = protocol_version.to_string();
    let mut parts = vec![
        if gateway_key.is_some() {
            "psyche-connect-v2"
        } else {
            "psyche-connect-v1"
        },
        nonce,
        platform,
        device_family,
        &version,
        server_origin,
    ];
    if let Some(k) = gateway_key {
        parts.push(k);
    }
    Ok(parts.join("\n").into_bytes())
}

#[derive(Debug)]
pub enum IdentityStoreError {
    Malformed,
    AlreadyExists,
    Io(String),
    Dpapi(String),
}

impl std::fmt::Display for IdentityStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityStoreError::Malformed => write!(f, "device key is malformed"),
            IdentityStoreError::AlreadyExists => write!(f, "device key already exists"),
            IdentityStoreError::Io(e) => write!(f, "device key I/O error: {e}"),
            IdentityStoreError::Dpapi(e) => write!(f, "device key DPAPI error: {e}"),
        }
    }
}

impl std::error::Error for IdentityStoreError {}

/// The DPAPI-sealed key file.
#[derive(Debug, Clone)]
pub struct DpapiIdentityStore {
    pub path: PathBuf,
}

const MAGIC: &[u8; 4] = b"PDK1";
const ENTROPY: &[u8] = b"psyche.win-helper.device-key.v1";

impl DpapiIdentityStore {
    pub fn new(path: PathBuf) -> Self {
        DpapiIdentityStore { path }
    }

    pub fn default_path(env: &Env) -> PathBuf {
        helper_dir(&psyche_home(env)).join("device.key.dpapi")
    }

    pub fn for_env(env: &Env) -> Self {
        Self::new(Self::default_path(env))
    }

    pub fn kind(&self) -> &'static str {
        "dpapi_file"
    }

    pub fn load(&self) -> Result<Option<DeviceIdentity>, IdentityStoreError> {
        let sealed = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(IdentityStoreError::Io(e.kind().to_string())),
        };
        if sealed.len() > 8192 {
            return Err(IdentityStoreError::Malformed);
        }
        let plain = crate::win::dpapi::unprotect(&sealed, ENTROPY)
            .map_err(|e| IdentityStoreError::Dpapi(e.to_string()))?;
        if plain.len() != 36 || &plain[..4] != MAGIC {
            return Err(IdentityStoreError::Malformed);
        }
        let mut seed = [0u8; 32];
        seed.copy_from_slice(&plain[4..]);
        Ok(Some(DeviceIdentity::from_seed(seed)))
    }

    /// Persists a new identity; fails with `AlreadyExists` when another process won the race.
    pub fn save(&self, identity: &DeviceIdentity) -> Result<(), IdentityStoreError> {
        let dir = self.path.parent().unwrap_or(Path::new("."));
        std::fs::create_dir_all(dir).map_err(|e| IdentityStoreError::Io(e.kind().to_string()))?;
        let mut plain = Vec::with_capacity(36);
        plain.extend_from_slice(MAGIC);
        plain.extend_from_slice(&identity.seed());
        let sealed = crate::win::dpapi::protect(&plain, ENTROPY, "Psyche Helper device key")
            .map_err(|e| IdentityStoreError::Dpapi(e.to_string()))?;
        zeroize::Zeroize::zeroize(&mut plain);
        let tmp = self.path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            crate::node::encoding::hex(&random_bytes::<4>())
        ));
        std::fs::write(&tmp, &sealed).map_err(|e| IdentityStoreError::Io(e.kind().to_string()))?;
        // MoveFileEx without REPLACE_EXISTING fails if the key exists, so a concurrent creator's
        // key survives (the mac helper uses link(2) for the same reason).
        let result = crate::win::fs::move_no_replace(&tmp, &self.path);
        let _ = std::fs::remove_file(&tmp);
        match result {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(IdentityStoreError::AlreadyExists)
            }
            Err(e) => Err(IdentityStoreError::Io(e.kind().to_string())),
        }
    }

    pub fn remove(&self) -> Result<(), IdentityStoreError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(IdentityStoreError::Io(e.kind().to_string())),
        }
    }

    /// Loads the identity, creating it on first use. A concurrent creator's key wins.
    pub fn load_or_create(&self) -> Result<DeviceIdentity, IdentityStoreError> {
        if let Some(existing) = self.load()? {
            return Ok(existing);
        }
        let fresh = DeviceIdentity::generate();
        match self.save(&fresh) {
            Ok(()) => Ok(fresh),
            Err(IdentityStoreError::AlreadyExists) => {
                self.load()?.ok_or(IdentityStoreError::Malformed)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    #[test]
    fn signing_payload_matches_typescript() {
        let p = connect_signing_payload("n0nce", "windows", "win-helper", 1, "psyche://node", None)
            .unwrap();
        assert_eq!(
            String::from_utf8(p).unwrap(),
            "psyche-connect-v1\nn0nce\nwindows\nwin-helper\n1\npsyche://node"
        );
        let p2 = connect_signing_payload("n", "windows", "win-helper", 1, "o", Some("gk")).unwrap();
        assert_eq!(
            String::from_utf8(p2).unwrap(),
            "psyche-connect-v2\nn\nwindows\nwin-helper\n1\no\ngk"
        );
        assert!(connect_signing_payload("a\nb", "windows", "win-helper", 1, "o", None).is_err());
        assert!(connect_signing_payload("a", "", "win-helper", 1, "o", None).is_err());
        assert!(connect_signing_payload("a", "windows", "win-helper", 0, "o", None).is_err());
    }

    #[test]
    fn identity_matches_the_wire_derivations() {
        // RFC 8032 test vector 1.
        let seed: [u8; 32] = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        let id = DeviceIdentity::from_seed(seed);
        assert_eq!(
            crate::node::encoding::hex(&id.public_key_bytes()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
        assert_eq!(id.public_key().len(), 43);
        let digest = b64url(&sha256(&id.public_key_bytes()));
        assert_eq!(id.device_id(), format!("dev_{}", &digest[..22]));
        assert_eq!(id.device_id().len(), 26);
        // RFC 8032: the signature of the empty message.
        let sig = crate::node::encoding::b64url_decode(&id.sign(b"")).unwrap();
        assert_eq!(
            crate::node::encoding::hex(&sig),
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        );
        let vk = VerifyingKey::from_bytes(&id.public_key_bytes()).unwrap();
        let s =
            Signature::from_slice(&crate::node::encoding::b64url_decode(&id.sign(b"hi")).unwrap())
                .unwrap();
        assert!(vk.verify(b"hi", &s).is_ok());
    }

    #[test]
    fn dpapi_store_round_trip_and_never_plaintext() {
        let dir = std::env::temp_dir().join(format!("psyche-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = DpapiIdentityStore::new(dir.join("helper").join("device.key.dpapi"));
        assert!(store.load().unwrap().is_none());
        let a = store.load_or_create().unwrap();
        let b = store.load_or_create().unwrap();
        assert_eq!(a.device_id(), b.device_id());
        let raw = std::fs::read(&store.path).unwrap();
        assert!(
            !raw.windows(32).any(|w| w == a.seed()),
            "the seed must not appear in the file"
        );
        assert!(matches!(
            store.save(&DeviceIdentity::generate()),
            Err(IdentityStoreError::AlreadyExists)
        ));
        std::fs::write(&store.path, b"garbage").unwrap();
        assert!(store.load().is_err());
        store.remove().unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
