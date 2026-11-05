//! `keychain.*` and `vault.unlock` on Windows Credential Manager (port of `KeychainCapabilities`):
//! `keychain.set` / `vault.unlock` / `keychain.delete` (the vault's key-encryption key, S06
//! contract), `keychain.store` / `keychain.retrieve` / `keychain.delete_item` (Psyche items) and
//! `keychain.status`.
//!
//! Storage: generic credentials `Psyche/vault/<account>` and `Psyche/item/<name>` (this machine
//! only, never roaming). Where the Mac gates reads behind Touch ID (vault keys, items stored with
//! `requireAuth`), the value is sealed to Windows Hello (see `seal`): storing never prompts
//! (after a one-time Hello prompt that creates the sealing key), reading shows Windows Hello.
//! `requireAuth: false` items are stored as-is (Credential Manager encrypts them for this user)
//! and read without a prompt, as on the Mac. The Hello dialog cannot show `reason` (the API takes
//! no message); `reason` is still validated as on the Mac. If Windows Hello is reset, sealed
//! values can no longer be opened (`unavailable/hello_key_invalidated`); the vault then opens with
//! its recovery key, as after a Touch ID change on the Mac.

pub mod seal;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::node::cancel::CancelToken;
use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, ErrorCode, ReceiptDraft, SideEffect,
};
use crate::node::encoding::{b64, b64_decode, b64url, b64url_decode, sha256_hex};
use crate::node::{CapabilityRegistry, schema};
use crate::presence::hello;
use crate::win::credman::{self, CredError};
use seal::{ItemRecord, SealError, WrapRecord};

pub const SERVICE: &str = "com.psyche.vault";
pub const ACCESS_CONTROL: [&str; 3] = ["biometryCurrentSet", "or", "devicePasscode"];
pub const MAX_NAME: usize = 64;
pub const REASON_MAX: usize = 120;
pub const MAX_ITEM_BYTES: usize = 16 * 1024;
const WRAP_TARGET: &str = "Psyche/keychain/wrap-key";
const COMMENT: &str = "Psyche Helper";
/// Longest an unwrapped secret stays in memory for `reuseDurationSeconds`.
const MAX_REUSE: Duration = Duration::from_secs(300);

pub fn is_valid_name(name: &str) -> bool {
    (1..=MAX_NAME).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn validate_name(name: &str, field: &str) -> Result<(), CapabilityError> {
    if is_valid_name(name) {
        Ok(())
    } else {
        Err(CapabilityError::invalid_params(
            format!("{field} must match ^[A-Za-z0-9._-]{{1,64}}$"),
            Some(field),
        ))
    }
}

/// 1…120 characters on one line; `None` when absent and optional.
pub fn validate_reason(
    reason: Option<&str>,
    required: bool,
) -> Result<Option<String>, CapabilityError> {
    let Some(r) = reason else {
        return if required {
            Err(CapabilityError::invalid_params(
                "missing parameter reason",
                Some("reason"),
            ))
        } else {
            Ok(None)
        };
    };
    let t = r.trim();
    if t.is_empty() || t.chars().count() > REASON_MAX || t.contains(['\n', '\r']) {
        return Err(CapabilityError::invalid_params(
            format!("reason must be 1–{REASON_MAX} characters on one line"),
            Some("reason"),
        ));
    }
    Ok(Some(t.to_owned()))
}

pub fn vault_target(account: &str) -> String {
    format!("Psyche/vault/{account}")
}

pub fn item_target(name: &str) -> String {
    format!("Psyche/item/{name}")
}

fn cred_error(e: CredError, what: &str) -> CapabilityError {
    match e {
        CredError::NotFound => {
            CapabilityError::not_found("item_not_found", format!("No keychain {what}"))
        }
        CredError::TooLarge => CapabilityError::invalid_params("value is too large", Some("value")),
        CredError::Malformed => CapabilityError::internal(
            "keychain_malformed",
            format!("The keychain {what} is malformed"),
        ),
        CredError::Os(code) => CapabilityError::internal(
            "keychain_error",
            format!("Credential Manager error 0x{code:08X}"),
        )
        .with_detail("status", code),
    }
}

fn invalidated() -> CapabilityError {
    CapabilityError::unavailable(
        "hello_key_invalidated",
        "The Windows Hello key that sealed this value is gone (Windows Hello was reset), so it can no longer be opened.",
    )
}

fn seal_error(e: SealError, what: &str) -> CapabilityError {
    match e {
        SealError::WrongKey => invalidated(),
        SealError::Malformed => CapabilityError::internal(
            "keychain_malformed",
            format!("The keychain {what} is malformed"),
        ),
        SealError::Decrypt => CapabilityError::new(
            ErrorCode::Forbidden,
            "auth_failed",
            "The keychain value could not be opened",
        ),
    }
}

/// Sealed storage over Credential Manager and Windows Hello. All methods block (some prompt).
#[derive(Default)]
pub struct KeychainVault {
    unlocked: Mutex<Option<(StaticSecret, Instant)>>,
}

impl KeychainVault {
    fn hello_key(
        &self,
        cancel: &CancelToken,
        create: bool,
    ) -> Result<(windows::Security::Credentials::KeyCredential, String), CapabilityError> {
        let key = if create {
            hello::open_or_create(hello::KEYCHAIN_KEY, cancel)?
        } else {
            hello::open(hello::KEYCHAIN_KEY)?.ok_or_else(invalidated)?
        };
        let kid = sha256_hex(&hello::public_key_spki(&key)?);
        Ok((key, kid))
    }

    fn read_wrap(&self) -> Result<Option<WrapRecord>, CapabilityError> {
        match credman::read(WRAP_TARGET) {
            Ok(b) => serde_json::from_slice(&b)
                .map(Some)
                .map_err(|_| seal_error(SealError::Malformed, "sealing key")),
            Err(CredError::NotFound) => Ok(None),
            Err(e) => Err(cred_error(e, "sealing key")),
        }
    }

    /// The sealing public key, creating the Hello key and the wrap record on first use (one prompt).
    fn sealing_key(&self, cancel: &CancelToken) -> Result<(PublicKey, String), CapabilityError> {
        if let Some(rec) = self.read_wrap()?
            && let Ok(Some(key)) = hello::open(hello::KEYCHAIN_KEY)
            && sha256_hex(&hello::public_key_spki(&key)?) == rec.kid
        {
            return Ok((
                seal::wrap_public(&rec).map_err(|e| seal_error(e, "sealing key"))?,
                rec.kid,
            ));
        }
        let (key, kid) = self.hello_key(cancel, true)?;
        let sig = Zeroizing::new(hello::sign(&key, seal::WRAP_MESSAGE, cancel)?);
        let (rec, secret) = seal::new_wrap_record(&sig, &kid);
        credman::write(
            WRAP_TARGET,
            &serde_json::to_vec(&rec).unwrap_or_default(),
            COMMENT,
        )
        .map_err(|e| cred_error(e, "sealing key"))?;
        *self.unlocked.lock().unwrap_or_else(|p| p.into_inner()) = Some((secret, Instant::now()));
        Ok((
            seal::wrap_public(&rec).map_err(|e| seal_error(e, "sealing key"))?,
            kid,
        ))
    }

    /// The unwrapped secret: Windows Hello, unless the owner passed it within `reuse`.
    fn unwrap(
        &self,
        cancel: &CancelToken,
        reuse: Duration,
    ) -> Result<StaticSecret, CapabilityError> {
        {
            let mut cache = self.unlocked.lock().unwrap_or_else(|p| p.into_inner());
            if let Some((secret, at)) = cache.as_ref() {
                let age = at.elapsed();
                if age > MAX_REUSE {
                    *cache = None;
                } else if !reuse.is_zero() && age <= reuse {
                    return Ok(secret.clone());
                }
            }
        }
        let rec = self.read_wrap()?.ok_or_else(invalidated)?;
        let (key, kid) = self.hello_key(cancel, false)?;
        let sig = Zeroizing::new(hello::sign(&key, seal::WRAP_MESSAGE, cancel)?);
        let secret =
            seal::open_wrap_record(&rec, &sig, &kid).map_err(|e| seal_error(e, "sealing key"))?;
        *self.unlocked.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((secret.clone(), Instant::now()));
        Ok(secret)
    }

    fn put(
        &self,
        target: &str,
        value: &[u8],
        require_auth: bool,
        cancel: &CancelToken,
    ) -> Result<(), CapabilityError> {
        let record = if require_auth {
            let (public, kid) = self.sealing_key(cancel)?;
            seal::seal(&public, &kid, target, value)
        } else {
            seal::plain(value)
        };
        credman::write(target, &record.to_bytes(), COMMENT).map_err(|e| cred_error(e, "item"))
    }

    fn get(
        &self,
        target: &str,
        what: &str,
        reuse: Duration,
        cancel: &CancelToken,
    ) -> Result<Zeroizing<Vec<u8>>, CapabilityError> {
        let bytes = credman::read(target).map_err(|e| cred_error(e, what))?;
        let record = ItemRecord::from_bytes(&bytes).map_err(|e| seal_error(e, what))?;
        if !record.requires_auth() {
            return seal::open_plain(&record).map_err(|e| seal_error(e, what));
        }
        if record
            .kid
            .as_deref()
            .is_some_and(|k| self.read_wrap().ok().flatten().is_some_and(|w| w.kid != k))
        {
            return Err(invalidated());
        }
        let secret = self.unwrap(cancel, reuse)?;
        seal::open(&secret, target, &record).map_err(|e| seal_error(e, what))
    }

    /// Stores the Gateway's KEK for vault `account`, replacing any. No prompt (after first use).
    pub fn set_vault_key(
        &self,
        account: &str,
        value: &[u8],
        cancel: &CancelToken,
    ) -> Result<bool, CapabilityError> {
        validate_name(account, "account")?;
        if !(16..=64).contains(&value.len()) {
            return Err(CapabilityError::invalid_params(
                "value must be a 16–64 byte key",
                Some("value"),
            ));
        }
        let target = vault_target(account);
        let replaced = credman::exists(&target).map_err(|e| cred_error(e, "vault key"))?;
        self.put(&target, value, true, cancel)?;
        Ok(replaced)
    }

    pub fn unlock_vault_key(
        &self,
        account: &str,
        reuse: Duration,
        cancel: &CancelToken,
    ) -> Result<Zeroizing<Vec<u8>>, CapabilityError> {
        validate_name(account, "account")?;
        self.get(
            &vault_target(account),
            &format!("vault key {account}"),
            reuse,
            cancel,
        )
    }

    pub fn store(
        &self,
        name: &str,
        value: &[u8],
        require_auth: bool,
        replace: bool,
        cancel: &CancelToken,
    ) -> Result<bool, CapabilityError> {
        validate_name(name, "name")?;
        if value.is_empty() || value.len() > MAX_ITEM_BYTES {
            return Err(CapabilityError::invalid_params(
                format!("value must be 1–{MAX_ITEM_BYTES} bytes"),
                Some("value"),
            ));
        }
        let target = item_target(name);
        let exists = credman::exists(&target).map_err(|e| cred_error(e, "item"))?;
        if exists && !replace {
            return Err(CapabilityError::new(
                ErrorCode::Conflict,
                "duplicate_item",
                "A keychain item with that name already exists",
            ));
        }
        self.put(&target, value, require_auth, cancel)?;
        Ok(exists)
    }

    pub fn retrieve(
        &self,
        name: &str,
        cancel: &CancelToken,
    ) -> Result<Zeroizing<Vec<u8>>, CapabilityError> {
        validate_name(name, "name")?;
        self.get(
            &item_target(name),
            &format!("item {name}"),
            Duration::ZERO,
            cancel,
        )
    }

    pub fn delete(&self, target: &str, what: &str) -> Result<(), CapabilityError> {
        credman::delete(target).map_err(|e| cred_error(e, what))
    }

    /// Never prompts and never creates anything.
    pub fn status(&self) -> Value {
        let probe = credman::exists("Psyche/keychain/probe");
        let supported = hello::is_supported();
        let availability = hello::availability();
        let sealing = match (self.read_wrap(), hello::open(hello::KEYCHAIN_KEY)) {
            (Ok(Some(w)), Ok(Some(k)))
                if hello::public_key_spki(&k)
                    .map(|s| sha256_hex(&s) == w.kid)
                    .unwrap_or(false) =>
            {
                "ready"
            }
            (Ok(Some(_)), _) => "invalidated",
            _ => "not_created",
        };
        status_value(probe, supported, availability, sealing)
    }
}

/// `keychain.status` in the Mac helper's shape (`KeychainVault.status`), which the Gateway's vault
/// reads (`packages/vault/src/slots/helper.ts`): `dataProtectionKeychain` is `"available"` when
/// Credential Manager answers (on the Mac: the data-protection keychain is usable), else `"error"`
/// with the Win32 status in `probeStatus` (Windows has no entitlement to miss). As on the Mac it
/// says nothing about the user-presence check: items stored with `requireAuth: false` (the
/// Gateway's derived keys) work without Windows Hello, and `biometry` tells whether reads that
/// need it can be answered. `store` and `sealingKey` (`ready` | `invalidated` | `not_created`)
/// are Windows extras.
pub fn status_value(
    probe: Result<bool, CredError>,
    hello_supported: bool,
    hello_availability: &str,
    sealing: &str,
) -> Value {
    let (state, probe) = match probe {
        Ok(_) => ("available", Value::Null),
        Err(CredError::Os(code)) => ("error", json!(code)),
        Err(_) => ("error", Value::Null),
    };
    let unavailable_reason = match (hello_supported, hello_availability) {
        (true, _) => Value::Null,
        (false, "not_configured") => "not_enrolled".into(),
        (false, "device_not_present") => "not_available".into(),
        (false, other) => other.into(),
    };
    json!({
        "dataProtectionKeychain": state,
        "probeStatus": probe,
        "accessGroup": Value::Null,
        "biometry": {
            "available": hello_supported,
            "type": if hello_supported { "windows_hello" } else { "none" },
            "unavailableReason": unavailable_reason,
            "devicePasscode": hello_supported,
        },
        "store": "credential_manager",
        "sealingKey": sealing,
    })
}

#[derive(Deserialize)]
struct SetParams {
    service: String,
    account: String,
    value: String,
    #[serde(rename = "accessControl")]
    access_control: Vec<String>,
    accessible: String,
    synchronizable: bool,
    #[serde(rename = "dataProtection")]
    data_protection: bool,
}

#[derive(Deserialize)]
struct UnlockParams {
    service: String,
    account: String,
    reason: String,
    #[serde(rename = "reuseDurationSeconds")]
    reuse_duration_seconds: Option<f64>,
}

#[derive(Deserialize)]
struct DeleteKeyParams {
    service: String,
    account: String,
}

#[derive(Deserialize)]
struct StoreParams {
    name: String,
    value: String,
    #[serde(rename = "requireAuth")]
    require_auth: Option<bool>,
    replace: Option<bool>,
    reason: Option<String>,
}

#[derive(Deserialize)]
struct RetrieveParams {
    name: String,
    reason: String,
}

#[derive(Deserialize)]
struct DeleteItemParams {
    name: String,
    reason: Option<String>,
}

fn check_service(s: &str) -> Result<(), CapabilityError> {
    if s == SERVICE {
        Ok(())
    } else {
        Err(CapabilityError::invalid_params(
            format!("service must be {SERVICE}"),
            Some("service"),
        ))
    }
}

fn account_schema() -> Value {
    schema::string_max(
        Some("Vault account (one key item per vault), ^[A-Za-z0-9._-]{1,64}$"),
        MAX_NAME as u64,
    )
}

fn name_schema() -> Value {
    schema::string_max(Some("Item name, ^[a-z0-9._-]{1,64}$"), MAX_NAME as u64)
}

fn reason_schema(prompts: bool) -> Value {
    schema::string_max(
        Some(if prompts {
            "Why the value is read (1–120 characters, one line); Windows Hello's dialog shows its own wording"
        } else {
            "Why this is happening (1–120 characters); no prompt is shown for this operation"
        }),
        REASON_MAX as u64,
    )
}

pub fn register(reg: &mut CapabilityRegistry) {
    let vault = reg.runtime().service(KeychainVault::default);

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.set",
            "Store the vault's key-encryption key in Windows Credential Manager, sealed to Windows Hello (this device only, not roaming). Replaces an existing key for the account. No prompt (the first use ever shows one Windows Hello prompt to create the sealing key). Gateway-internal: never reachable from agent tools.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("service", schema::string_enum(None, &[SERVICE])),
                ("account", account_schema()),
                ("value", schema::string_max(Some("base64 key bytes"), 128)),
                ("accessControl", schema::array(schema::string_enum(None, &ACCESS_CONTROL), None, None)),
                ("accessible", schema::string_enum(None, &["whenPasscodeSetThisDeviceOnly"])),
                ("synchronizable", schema::boolean(None)),
                ("dataProtection", schema::boolean(None)),
            ],
            &["service", "account", "value", "accessControl", "accessible", "synchronizable", "dataProtection"],
        ))
        .receipt("vault_key"),
        move |ctx| {
            let p: SetParams = ctx.decode()?;
            check_service(&p.service)?;
            // The protection is fixed by security §4.2; refuse anything else rather than weaken it.
            if p.access_control != ACCESS_CONTROL || p.accessible != "whenPasscodeSetThisDeviceOnly" || p.synchronizable || !p.data_protection {
                return Err(CapabilityError::invalid_params(
                    "only [biometryCurrentSet, or, devicePasscode], whenPasscodeSetThisDeviceOnly, non-synchronizable, data protection keychain is supported",
                    None,
                ));
            }
            let value = Zeroizing::new(b64_decode(&p.value).ok_or_else(|| CapabilityError::invalid_params("value must be base64", Some("value")))?);
            let replaced = v.set_vault_key(&p.account, &value, &ctx.cancel_token())?;
            Ok(CapabilityOutput::with_receipt(
                json!({}),
                ReceiptDraft::ok(if replaced { "Replaced the vault key" } else { "Stored the vault key" }).with_ref("account", p.account),
            ))
        },
    );

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "vault.unlock",
            "Read the vault's key-encryption key: shows Windows Hello. Returns {value} (base64), a secret: never in model-visible text, logs or notifications. Cancel → cancelled. Gateway-internal.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("service", schema::string_enum(None, &[SERVICE])),
                ("account", account_schema()),
                ("reason", schema::string_max(Some("Prompt text (1–120 characters)"), REASON_MAX as u64)),
                ("reuseDurationSeconds", schema::number(Some("Windows Hello reuse window, 0–300 (0 for per-fill items)"), Some(0.0), Some(300.0))),
            ],
            &["service", "account", "reason"],
        )),
        move |ctx| {
            let p: UnlockParams = ctx.decode()?;
            check_service(&p.service)?;
            validate_reason(Some(&p.reason), true)?;
            let reuse = Duration::from_secs_f64(p.reuse_duration_seconds.unwrap_or(0.0).clamp(0.0, 300.0));
            let value = v.unlock_vault_key(&p.account, reuse, &ctx.cancel_token())?;
            Ok(CapabilityOutput::new(json!({ "value": b64(&value) })))
        },
    );

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.delete",
            "Delete the vault's key-encryption key (the vault then opens only with the recovery key). Gateway-internal.",
            SideEffect::Destructive,
        )
        .input(schema::object(vec![("service", schema::string_enum(None, &[SERVICE])), ("account", account_schema())], &["service", "account"]))
        .receipt("vault_key"),
        move |ctx| {
            let p: DeleteKeyParams = ctx.decode()?;
            check_service(&p.service)?;
            validate_name(&p.account, "account")?;
            v.delete(&vault_target(&p.account), &format!("vault key slot {}", p.account))?;
            Ok(CapabilityOutput::with_receipt(json!({}), ReceiptDraft::ok("Deleted the vault key").with_ref("account", p.account)))
        },
    );

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.store",
            "Store a value (base64url, up to 16 KiB) as a Psyche item in Windows Credential Manager, this device only. requireAuth (default true) seals it to Windows Hello so reads need Windows Hello; false makes it readable without a prompt while the user is signed in. Fails with conflict/duplicate_item if the name exists unless replace is true. The value is never echoed.",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("name", name_schema()),
                ("value", schema::string_max(Some("The value, base64url"), 21_848)),
                ("requireAuth", schema::boolean(Some("Require Windows Hello to read (default true)"))),
                ("replace", schema::boolean(Some("Replace an existing item (default false)"))),
                ("reason", reason_schema(false)),
            ],
            &["name", "value"],
        ))
        .receipt("keychain_item"),
        move |ctx| {
            let p: StoreParams = ctx.decode()?;
            validate_reason(p.reason.as_deref(), false)?;
            let value = Zeroizing::new(b64url_decode(&p.value).ok_or_else(|| CapabilityError::invalid_params("value must be base64url", Some("value")))?);
            let require_auth = p.require_auth.unwrap_or(true);
            let replaced = v.store(&p.name, &value, require_auth, p.replace.unwrap_or(false), &ctx.cancel_token())?;
            Ok(CapabilityOutput::with_receipt(
                json!({ "name": p.name, "stored": true, "requireAuth": require_auth, "replaced": replaced }),
                ReceiptDraft::ok(format!("{} keychain item {}", if replaced { "Replaced" } else { "Stored" }, p.name)).with_ref("name", p.name),
            ))
        },
    );

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.retrieve",
            "Read a Psyche keychain item (shows Windows Hello when it was stored with requireAuth) and return its value, base64url. SECRET RESULT: never put `value` in model-visible text.",
            SideEffect::Read,
        )
        .input(schema::object(vec![("name", name_schema()), ("reason", reason_schema(true))], &["name", "reason"])),
        move |ctx| {
            let p: RetrieveParams = ctx.decode()?;
            validate_reason(Some(&p.reason), true)?;
            let value = v.retrieve(&p.name, &ctx.cancel_token())?;
            Ok(CapabilityOutput::new(json!({ "name": p.name, "value": b64url(&value) })))
        },
    );

    let v = vault.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.delete_item",
            "Delete a Psyche item stored with keychain.store (system keychain mode). No prompt. A missing item is not_found/item_not_found. Gateway-internal.",
            SideEffect::Destructive,
        )
        .input(schema::object(vec![("name", name_schema()), ("reason", reason_schema(false))], &["name"]))
        .receipt("keychain_item"),
        move |ctx| {
            let p: DeleteItemParams = ctx.decode()?;
            validate_reason(p.reason.as_deref(), false)?;
            validate_name(&p.name, "name")?;
            v.delete(&item_target(&p.name), &format!("item {}", p.name))?;
            Ok(CapabilityOutput::with_receipt(
                json!({ "deleted": true, "name": p.name }),
                ReceiptDraft::ok(format!("Deleted keychain item {}", p.name)).with_ref("name", p.name),
            ))
        },
    );

    let v = vault;
    reg.add_blocking(
        CapabilitySpec::new(
            "keychain.status",
            "Whether the keychain is usable (Windows Credential Manager: available | error) and whether Windows Hello is set up (biometry.available, type windows_hello). Never prompts.",
            SideEffect::Read,
        )
        .input(schema::empty()),
        move |_| Ok(CapabilityOutput::new(v.status())),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_reasons() {
        assert!(is_valid_name("vault-main_1.x"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name(&"a".repeat(65)));
        assert_eq!(
            validate_reason(Some("  unlock your vault "), true)
                .unwrap()
                .as_deref(),
            Some("unlock your vault")
        );
        assert!(validate_reason(Some("two\nlines"), true).is_err());
        assert!(validate_reason(None, true).is_err());
        assert!(validate_reason(None, false).unwrap().is_none());
    }

    #[test]
    fn status_matches_what_the_gateway_vault_reads() {
        // Credential Manager answers: the vault's helper slots may use the keychain
        // (`helperUnavailable` requires exactly "available").
        let ok = status_value(Ok(false), true, "available", "ready");
        assert_eq!(ok["dataProtectionKeychain"], "available");
        assert_eq!(ok["probeStatus"], Value::Null);
        assert_eq!(ok["accessGroup"], Value::Null);
        assert_eq!(ok["biometry"]["available"], true);
        assert_eq!(ok["biometry"]["type"], "windows_hello");
        assert_eq!(ok["biometry"]["unavailableReason"], Value::Null);
        assert_eq!(ok["store"], "credential_manager");
        assert_eq!(ok["sealingKey"], "ready");
        let fresh = status_value(Ok(true), true, "available", "not_created");
        assert_eq!(fresh["dataProtectionKeychain"], "available");

        // No Windows Hello: plain items still work, so the keychain stays available (as the
        // Mac's does without Touch ID); biometry says why sealed reads cannot be answered.
        let no_hello = status_value(Ok(false), false, "not_configured", "not_created");
        assert_eq!(no_hello["dataProtectionKeychain"], "available");
        assert_eq!(no_hello["biometry"]["available"], false);
        assert_eq!(no_hello["biometry"]["type"], "none");
        assert_eq!(no_hello["biometry"]["unavailableReason"], "not_enrolled");
        let absent = status_value(Ok(false), false, "device_not_present", "not_created");
        assert_eq!(absent["biometry"]["unavailableReason"], "not_available");
        let policy = status_value(Ok(false), false, "disabled_by_policy", "invalidated");
        assert_eq!(
            policy["biometry"]["unavailableReason"],
            "disabled_by_policy"
        );
        assert_eq!(policy["sealingKey"], "invalidated");

        // Credential Manager fails: never "available"; the Win32 status travels.
        let broken = status_value(Err(CredError::Os(0x8007_0005)), true, "available", "ready");
        assert_eq!(broken["dataProtectionKeychain"], "error");
        assert_eq!(broken["probeStatus"], 0x8007_0005_u32);
        let malformed = status_value(Err(CredError::Malformed), true, "available", "ready");
        assert_eq!(malformed["dataProtectionKeychain"], "error");
    }

    #[test]
    fn a_reset_hello_key_is_the_reason_the_vault_recovers_from() {
        // `packages/vault` (`helperKeyInvalidated`) maps exactly this to "the key is gone".
        for e in [invalidated(), seal_error(SealError::WrongKey, "vault key")] {
            let w = e.wire();
            assert_eq!(w.code, "unavailable");
            assert_eq!(w.details.unwrap()["reason"], "hello_key_invalidated");
        }
    }

    #[test]
    fn plain_items_round_trip_through_credential_manager() {
        let vault = KeychainVault::default();
        let cancel = CancelToken::new();
        // Unique per run: worktrees and CI jobs share the user's Credential Manager.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let name = format!("test-{}-{nanos}", std::process::id());
        assert!(!vault.store(&name, b"hello", false, false, &cancel).unwrap());
        assert_eq!(
            vault
                .store(&name, b"x", false, false, &cancel)
                .unwrap_err()
                .reason,
            "duplicate_item"
        );
        assert!(vault.store(&name, b"again", false, true, &cancel).unwrap());
        assert_eq!(vault.retrieve(&name, &cancel).unwrap().as_slice(), b"again");
        vault.delete(&item_target(&name), "item").unwrap();
        assert_eq!(
            vault.retrieve(&name, &cancel).unwrap_err().reason,
            "item_not_found"
        );
        assert_eq!(
            vault.delete(&item_target(&name), "item").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn set_validates_protection_before_touching_storage() {
        let mut reg = CapabilityRegistry::new(crate::node::Runtime::offline(Default::default()));
        register(&mut reg);
        let cap = reg.get("keychain.set").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let ctx = crate::node::InvocationContext::detached(
            "keychain.set",
            json!({"service": SERVICE, "account": "main", "value": "AAAA", "accessControl": ["devicePasscode"],
                   "accessible": "whenPasscodeSetThisDeviceOnly", "synchronizable": false, "dataProtection": true}),
        );
        assert_eq!(
            rt.block_on((cap.handler)(ctx)).unwrap_err().code,
            ErrorCode::InvalidParams
        );
        let ctx =
            crate::node::InvocationContext::detached("keychain.set", json!({"service": "other"}));
        assert_eq!(
            rt.block_on((cap.handler)(ctx)).unwrap_err().code,
            ErrorCode::InvalidParams
        );
    }
}
