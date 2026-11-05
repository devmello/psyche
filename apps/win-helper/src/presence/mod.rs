//! `presence.*`: the Windows Hello presence key (the mac helper's Secure Enclave key).
//!
//! - `presence.public_key` → `{publicKey, keyId, kind, algorithm}`: `publicKey` is base64url DER
//!   `SubjectPublicKeyInfo` of a TPM-backed RSA-2048 Hello key, `keyId` the hex SHA-256 of those
//!   DER bytes (the Gateway's `presenceKeyId(publicKey)`), `kind` `"windows_hello"`, `algorithm`
//!   `"rsa-2048-pkcs1-sha256"`. Unlike the Mac, creating the key shows one Hello prompt (Windows
//!   requires a gesture to create a Hello key); later calls never prompt.
//! - `presence.confirm {challenge, summary, code}` → `{signature, keyId}`: RSASSA-PKCS1-v1_5 /
//!   SHA-256 over `psyche.presence.helper.v1|<challenge>`, base64url. The Hello dialog cannot show
//!   the approval's summary or code (the API takes no message); the card shows them.

pub mod hello;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::node::cancel::CancelToken;
use crate::node::capability::{CapabilityError, CapabilityOutput, CapabilitySpec, ReceiptDraft, SideEffect};
use crate::node::encoding::{b64url, sha256_hex};
use crate::node::schema;
use crate::node::CapabilityRegistry;
use crate::notify::plan::{is_valid_challenge, presence_message};

pub const KEY_KIND: &str = "windows_hello";
pub const ALGORITHM: &str = "rsa-2048-pkcs1-sha256";
pub const MAX_SUMMARY: usize = 100;

/// A presence signature and the key id it was made with.
pub struct Signed {
    pub signature: String,
    pub key_id: String,
}

/// Signs `psyche.presence.helper.v1|<challenge>` with the presence key (creating it on first
/// use). Blocking; prompts.
pub fn sign_challenge(challenge: &str, cancel: &CancelToken) -> Result<Signed, CapabilityError> {
    if !is_valid_challenge(challenge) {
        return Err(CapabilityError::invalid_params("presenceChallenge must be 64 hex characters", Some("presenceChallenge")));
    }
    let key = hello::open_or_create(hello::PRESENCE_KEY, cancel)?;
    let spki = hello::public_key_spki(&key)?;
    let sig = hello::sign(&key, &presence_message(challenge), cancel)?;
    Ok(Signed { signature: b64url(&sig), key_id: sha256_hex(&spki) })
}

/// `{publicKey, keyId, kind, algorithm}` (creating the key on first use).
pub fn public_key_json(cancel: &CancelToken) -> Result<Value, CapabilityError> {
    let key = hello::open_or_create(hello::PRESENCE_KEY, cancel)?;
    let spki = hello::public_key_spki(&key)?;
    Ok(json!({ "publicKey": b64url(&spki), "keyId": sha256_hex(&spki), "kind": KEY_KIND, "algorithm": ALGORITHM }))
}

/// `--print-identity` fields; never prompts and never creates the key.
pub async fn identity_fields() -> Map<String, Value> {
    tokio::task::spawn_blocking(|| {
        crate::win::com::ensure_mta();
        let mut out = Map::new();
        match hello::open(hello::PRESENCE_KEY) {
            Ok(Some(key)) => match hello::public_key_spki(&key) {
                Ok(spki) => {
                    out.insert("presenceKeyId".into(), sha256_hex(&spki).into());
                    out.insert("presenceKeyKind".into(), KEY_KIND.into());
                    out.insert("presenceKeyAlgorithm".into(), ALGORITHM.into());
                }
                Err(e) => {
                    out.insert("presenceError".into(), e.reason.into());
                }
            },
            Ok(None) => {
                out.insert("presenceError".into(), "presence_key_not_created".into());
            }
            Err(e) => {
                out.insert("presenceError".into(), e.reason.into());
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// `xxxx-xxxx`, lower-case hex.
pub fn is_valid_code(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 2 && parts.iter().all(|p| p.len() == 4 && p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

#[derive(Deserialize)]
struct ConfirmParams {
    challenge: String,
    summary: String,
    code: String,
}

pub fn register(reg: &mut CapabilityRegistry) {
    reg.add_blocking(
        CapabilitySpec::new(
            "presence.public_key",
            "The helper's Windows Hello presence public key (TPM-backed RSA-2048, DER SubjectPublicKeyInfo, base64url), keyId (hex SHA-256 of it), kind (windows_hello) and algorithm (rsa-2048-pkcs1-sha256). Created on first use, which shows one Windows Hello prompt; never prompts afterwards.",
            SideEffect::Read,
        ),
        |ctx| public_key_json(&ctx.cancel_token()).map(CapabilityOutput::new),
    );
    reg.add_blocking(
        CapabilitySpec::new(
            "presence.confirm",
            "Runs Windows Hello for the presence key and signs one approval's presence challenge (an approval allowed in the Psyche window). Returns signature (RSASSA-PKCS1-v1_5 SHA-256, base64url) and keyId. Fails cancelled/user_cancelled when the owner cancels, unavailable/presence_key_invalidated when the Hello key is gone.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("challenge", schema::string_max(Some("Hex SHA-256 presence challenge of the approval"), 64)),
                ("summary", schema::string_max(Some("The approval's one-line summary (logged nowhere; the Hello dialog cannot show it)"), (MAX_SUMMARY * 4) as u64)),
                ("code", schema::string_max(Some("The approval code the card shows (xxxx-xxxx hex)"), 9)),
            ],
            &["challenge", "summary", "code"],
        ))
        .receipt("approval_presence"),
        |ctx| {
            let p: ConfirmParams = ctx.decode()?;
            if !is_valid_challenge(&p.challenge) {
                return Err(CapabilityError::invalid_params("challenge must be 64 hex characters", Some("challenge")));
            }
            if p.summary.trim().is_empty() {
                return Err(CapabilityError::invalid_params("summary must not be empty", Some("summary")));
            }
            if !is_valid_code(&p.code) {
                return Err(CapabilityError::invalid_params("code must be xxxx-xxxx hex", Some("code")));
            }
            let signed = sign_challenge(&p.challenge, &ctx.cancel_token())?;
            Ok(CapabilityOutput::with_receipt(
                json!({ "signature": signed.signature, "keyId": signed.key_id }),
                ReceiptDraft::ok("Confirmed an approval with Windows Hello").with_ref("approvalCode", p.code).with_ref("keyId", signed.key_id),
            ))
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes() {
        assert!(is_valid_code("0a1b-ff00"));
        assert!(!is_valid_code("0A1B-FF00"));
        assert!(!is_valid_code("0a1b-ff0"));
        assert!(!is_valid_code("0a1bff00"));
    }

    #[test]
    fn presence_message_is_domain_separated() {
        assert_eq!(presence_message("ab"), b"psyche.presence.helper.v1|ab".to_vec());
    }

    #[test]
    fn confirm_validates_before_prompting() {
        let mut reg = CapabilityRegistry::new(crate::node::Runtime::offline(Default::default()));
        register(&mut reg);
        let cap = reg.get("presence.confirm").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bad = |params: Value| {
            let ctx = crate::node::InvocationContext::detached("presence.confirm", params);
            rt.block_on((cap.handler)(ctx)).unwrap_err()
        };
        assert_eq!(bad(json!({"challenge": "x", "summary": "s", "code": "0a1b-ff00"})).details["field"], "challenge");
        assert_eq!(bad(json!({"challenge": "a".repeat(64), "summary": " ", "code": "0a1b-ff00"})).details["field"], "summary");
        assert_eq!(bad(json!({"challenge": "a".repeat(64), "summary": "s", "code": "nope"})).details["field"], "code");
    }
}
