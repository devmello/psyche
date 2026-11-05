//! The helper's Ed25519 device identity (security §10): a key that never leaves this machine and
//! a device id. The Gateway pairs the key; the helper never chooses scopes.
//!
//! Stored at `<state dir>/identity.json` (0600, directory 0700, written atomically). A file that
//! group or others can read is refused: the key is the helper's whole authority.

use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum IdentityError {
    Io(std::io::Error),
    /// The file is readable by group or others.
    Permissions {
        path: PathBuf,
        mode: u32,
    },
    /// The file is not a helper identity file.
    Malformed(PathBuf),
    Random,
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityError::Io(e) => write!(f, "identity i/o: {e}"),
            IdentityError::Permissions { path, mode } => write!(
                f,
                "{} is mode {mode:o}; it must be 0600 (chmod 600 {})",
                path.display(),
                path.display()
            ),
            IdentityError::Malformed(path) => {
                write!(f, "{} is not a psyche-helper identity file", path.display())
            }
            IdentityError::Random => write!(f, "no system randomness available"),
        }
    }
}

impl std::error::Error for IdentityError {}

impl From<std::io::Error> for IdentityError {
    fn from(e: std::io::Error) -> Self {
        IdentityError::Io(e)
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    version: u32,
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    /// base64url, the 32-byte Ed25519 seed.
    seed: String,
}

pub struct DeviceIdentity {
    key: SigningKey,
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the key.
        f.debug_struct("DeviceIdentity")
            .field("device_id", &self.device_id())
            .finish()
    }
}

impl DeviceIdentity {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn generate() -> Result<Self, IdentityError> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|_| IdentityError::Random)?;
        Ok(Self::from_seed(seed))
    }

    /// base64url raw 32-byte public key, as `connect` expects.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.key.verifying_key().to_bytes())
    }

    /// `dev_` + first 22 base64url chars of SHA-256(raw public key), as the desktop and the Mac
    /// helper derive it.
    pub fn device_id(&self) -> String {
        let digest = Sha256::digest(self.key.verifying_key().to_bytes());
        let encoded = URL_SAFE_NO_PAD.encode(digest);
        format!("dev_{}", &encoded[..22])
    }

    /// base64url Ed25519 signature (64 bytes).
    pub fn sign(&self, payload: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(self.key.sign(payload).to_bytes())
    }

    fn stored(&self) -> Stored {
        Stored {
            version: 1,
            device_id: self.device_id(),
            public_key: self.public_key(),
            seed: URL_SAFE_NO_PAD.encode(self.key.to_bytes()),
        }
    }
}

pub fn identity_path(state_dir: &Path) -> PathBuf {
    state_dir.join("identity.json")
}

/// Reads the identity without ever writing: `None` when there is none yet. This is what
/// `--print-identity` uses.
pub fn load(state_dir: &Path) -> Result<Option<DeviceIdentity>, IdentityError> {
    let path = identity_path(state_dir);
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(IdentityError::Permissions { path, mode });
    }
    let stored: Stored = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|_| IdentityError::Malformed(path.clone()))?;
    let seed: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&stored.seed)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| IdentityError::Malformed(path.clone()))?;
    let identity = DeviceIdentity::from_seed(seed);
    // The stored fields are derived; a file that disagrees with its own seed was edited.
    if stored.version != 1
        || stored.public_key != identity.public_key()
        || stored.device_id != identity.device_id()
    {
        return Err(IdentityError::Malformed(path));
    }
    Ok(Some(identity))
}

/// Loads the identity, creating it (0600, atomically) on first run. Only the running helper
/// calls this, never `--print-identity`.
pub fn load_or_create(state_dir: &Path) -> Result<DeviceIdentity, IdentityError> {
    if let Some(identity) = load(state_dir)? {
        return Ok(identity);
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state_dir)?;
    let identity = DeviceIdentity::generate()?;
    let path = identity_path(state_dir);
    let tmp = state_dir.join(format!("identity.json.{}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    file.write_all(&serde_json::to_vec_pretty(&identity.stored()).expect("identity serializes"))?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&tmp, &path)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn device_id_is_dev_plus_22_chars_of_the_key_digest() {
        let id = DeviceIdentity::from_seed([7; 32]);
        let device_id = id.device_id();
        assert!(device_id.starts_with("dev_"));
        assert_eq!(device_id.len(), 4 + 22);
        assert_eq!(id.public_key().len(), 43);
        // The same key always gives the same id.
        assert_eq!(device_id, DeviceIdentity::from_seed([7; 32]).device_id());
        assert_ne!(device_id, DeviceIdentity::from_seed([8; 32]).device_id());
    }

    #[test]
    fn signatures_verify_and_are_86_base64url_chars() {
        let id = DeviceIdentity::from_seed([1; 32]);
        let signature = id.sign(b"payload");
        assert_eq!(signature.len(), 86);
        let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
            .decode(&signature)
            .unwrap()
            .try_into()
            .unwrap();
        let public: [u8; 32] = URL_SAFE_NO_PAD
            .decode(id.public_key())
            .unwrap()
            .try_into()
            .unwrap();
        let verifying = ed25519_dalek::VerifyingKey::from_bytes(&public).unwrap();
        assert!(verifying
            .verify(
                b"payload",
                &ed25519_dalek::Signature::from_bytes(&sig_bytes)
            )
            .is_ok());
        assert!(verifying
            .verify(b"other", &ed25519_dalek::Signature::from_bytes(&sig_bytes))
            .is_err());
    }

    #[test]
    fn load_never_creates_and_load_or_create_is_stable_0600() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        assert!(load(&state).unwrap().is_none());
        assert!(!state.exists(), "read-only load must not create anything");

        let first = load_or_create(&state).unwrap();
        let mode = fs::metadata(identity_path(&state))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
        let dir_mode = fs::metadata(&state).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o700);
        let second = load_or_create(&state).unwrap();
        assert_eq!(first.device_id(), second.device_id());
        assert_eq!(
            load(&state).unwrap().unwrap().public_key(),
            first.public_key()
        );
    }

    #[test]
    fn a_group_readable_identity_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        load_or_create(dir.path()).unwrap();
        let path = identity_path(dir.path());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        assert!(matches!(
            load(dir.path()),
            Err(IdentityError::Permissions { mode: 0o640, .. })
        ));
    }

    #[test]
    fn a_tampered_or_foreign_file_is_malformed() {
        let dir = tempfile::tempdir().unwrap();
        let path = identity_path(dir.path());
        fs::write(&path, "{\"version\":1}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(load(dir.path()), Err(IdentityError::Malformed(_))));

        // A file whose device id disagrees with its seed was edited by hand.
        let real = DeviceIdentity::from_seed([3; 32]);
        let mut stored = real.stored();
        stored.device_id = "dev_aaaaaaaaaaaaaaaaaaaaaa".into();
        fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        assert!(matches!(load(dir.path()), Err(IdentityError::Malformed(_))));
    }

    #[test]
    fn debug_never_prints_the_key() {
        let id = DeviceIdentity::from_seed([9; 32]);
        let text = format!("{id:?}");
        assert!(!text.contains(&URL_SAFE_NO_PAD.encode([9u8; 32])));
    }
}
