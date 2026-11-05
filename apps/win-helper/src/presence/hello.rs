//! Windows Hello: TPM-backed `KeyCredentialManager` keys (RSA-2048, signatures need a user
//! gesture: PIN, face or fingerprint) and `UserConsentVerifier` for plain owner checks.
//!
//! Prompts run on a dedicated thread that owns a hidden topmost owner window and pumps
//! messages, so the Windows Security dialog opens in front even when the helper was started in
//! the background by a toast click. `UserConsentVerifier` uses the HWND interop
//! (`IUserConsentVerifierInterop`); `KeyCredential.RequestSignAsync` has no HWND overload, so the
//! helper raises the dialog itself when it shows up behind another window.

use std::time::Duration;

use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Security::Credentials::{
    KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
};
use windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType;
use windows::Security::Cryptography::CryptographicBuffer;
use windows::Storage::Streams::IBuffer;
use windows::Win32::Foundation::HWND;
use windows::core::{HSTRING, Interface, RuntimeType};
use windows_future::{AsyncStatus, IAsyncOperation};

use crate::node::cancel::CancelToken;
use crate::node::capability::{CapabilityError, ErrorCode};
use crate::win::foreground::{OwnerWindow, pump_until};
use interop::IUserConsentVerifierInterop;

/// Name of the presence key (approvals that need the owner present).
pub const PRESENCE_KEY: &str = "com.psyche.helper.presence";
/// Name of the key whose deterministic signature seals keychain items and vault keys.
pub const KEYCHAIN_KEY: &str = "com.psyche.helper.keychain";

/// How long a Hello prompt may stay up.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(180);

#[allow(non_snake_case)]
mod interop {
    use windows::Win32::Foundation::HWND;
    use windows::core::{GUID, HRESULT, IUnknown, IUnknown_Vtbl};

    /// `userconsentverifierinterop.h`. Declared over IUnknown with the three IInspectable slots
    /// spelled out, which gives the same vtable layout.
    #[windows_core::interface("39E050C3-4E74-441A-8DC0-B81104DF949C")]
    pub unsafe trait IUserConsentVerifierInterop: IUnknown {
        fn GetIids(&self, count: *mut u32, iids: *mut *mut GUID) -> HRESULT;
        fn GetRuntimeClassName(&self, name: *mut *mut core::ffi::c_void) -> HRESULT;
        fn GetTrustLevel(&self, level: *mut i32) -> HRESULT;
        fn RequestVerificationForWindowAsync(
            &self,
            app_window: HWND,
            message: *mut core::ffi::c_void,
            riid: *const GUID,
            async_operation: *mut *mut core::ffi::c_void,
        ) -> HRESULT;
    }

    /// Calls `RequestVerificationForWindowAsync`.
    ///
    /// # Safety
    /// `message` must be a valid HSTRING handle for the call; `out` receives an owned interface.
    pub unsafe fn request(
        i: &IUserConsentVerifierInterop,
        hwnd: HWND,
        message: *mut core::ffi::c_void,
        riid: *const GUID,
        out: *mut *mut core::ffi::c_void,
    ) -> HRESULT {
        // SAFETY: forwarded from the caller's contract.
        unsafe { i.RequestVerificationForWindowAsync(hwnd, message, riid, out) }
    }
}

fn hello_unavailable() -> CapabilityError {
    CapabilityError::unavailable(
        "passcode_not_set",
        "Windows Hello is not set up for this user. Set up a PIN, face or fingerprint in Settings › Accounts › Sign-in options.",
    )
}

fn os(reason: &str, e: &windows::core::Error) -> CapabilityError {
    CapabilityError::os(reason, "Windows Hello failed", e)
}

/// Whether this user can use Hello keys (never prompts).
pub fn is_supported() -> bool {
    KeyCredentialManager::IsSupportedAsync()
        .and_then(|op| op.join())
        .unwrap_or(false)
}

/// `UserConsentVerifier` availability name (never prompts).
pub fn availability() -> &'static str {
    match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()) {
        Ok(UserConsentVerifierAvailability::Available) => "available",
        Ok(UserConsentVerifierAvailability::DeviceNotPresent) => "device_not_present",
        Ok(UserConsentVerifierAvailability::NotConfiguredForUser) => "not_configured",
        Ok(UserConsentVerifierAvailability::DisabledByPolicy) => "disabled_by_policy",
        Ok(UserConsentVerifierAvailability::DeviceBusy) => "device_busy",
        _ => "error",
    }
}

fn status_error(status: KeyCredentialStatus, invalidated: bool) -> CapabilityError {
    match status {
        KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => CapabilityError::user_cancelled(),
        KeyCredentialStatus::SecurityDeviceLocked => CapabilityError::new(
            ErrorCode::Forbidden,
            "biometry_lockout",
            "Windows Hello is locked after too many failed attempts; sign in to Windows with your PIN or password first",
        ),
        KeyCredentialStatus::NotFound if invalidated => CapabilityError::unavailable(
            "presence_key_invalidated",
            "The Windows Hello key is gone (Hello was reset or the PIN removed), so it can no longer sign. Set up Windows Hello again in Settings → Devices.",
        )
        .with_detail("enrollmentChanged", true),
        KeyCredentialStatus::NotFound => CapabilityError::not_found("hello_key_not_found", "No Windows Hello key with that name"),
        _ => CapabilityError::unavailable("hello_error", "Windows Hello could not complete the request").retryable(),
    }
}

/// Opens an existing key (never prompts). `Ok(None)` when it does not exist.
pub fn open(name: &str) -> Result<Option<KeyCredential>, CapabilityError> {
    if !is_supported() {
        return Err(hello_unavailable());
    }
    let r = KeyCredentialManager::OpenAsync(&HSTRING::from(name))
        .and_then(|op| op.join())
        .map_err(|e| os("hello_error", &e))?;
    match r.Status().map_err(|e| os("hello_error", &e))? {
        KeyCredentialStatus::Success => {
            Ok(Some(r.Credential().map_err(|e| os("hello_error", &e))?))
        }
        KeyCredentialStatus::NotFound => Ok(None),
        s => Err(status_error(s, false)),
    }
}

/// Runs a prompting WinRT operation on the current (blocking) thread with an owner window and a
/// message pump, cancelling it when `cancel` fires or after `PROMPT_TIMEOUT`.
fn run_prompt<R: RuntimeType + 'static>(
    cancel: &CancelToken,
    start: impl FnOnce(HWND) -> windows::core::Result<IAsyncOperation<R>>,
) -> Result<R, CapabilityError> {
    crate::win::com::ensure_mta();
    let owner = OwnerWindow::create();
    let hwnd = owner.as_ref().map(|o| o.hwnd).unwrap_or_default();
    let op = start(hwnd).map_err(|e| os("hello_error", &e))?;
    pump_until(
        || {
            cancel.is_cancelled()
                || op
                    .Status()
                    .map(|s| s != AsyncStatus::Started)
                    .unwrap_or(true)
        },
        PROMPT_TIMEOUT,
    );
    let status = op.Status().unwrap_or(AsyncStatus::Error);
    if status == AsyncStatus::Started {
        let _ = op.Cancel();
        drop(owner);
        return Err(if cancel.is_cancelled() {
            CapabilityError::cancelled()
        } else {
            CapabilityError::new(
                ErrorCode::Timeout,
                "prompt_timeout",
                "Windows Hello was not answered in time",
            )
        });
    }
    drop(owner);
    if status == AsyncStatus::Canceled {
        return Err(CapabilityError::cancelled());
    }
    op.GetResults().map_err(|e| os("hello_error", &e))
}

/// Opens the key, creating it on first use (creating shows one Hello prompt).
pub fn open_or_create(name: &str, cancel: &CancelToken) -> Result<KeyCredential, CapabilityError> {
    if let Some(k) = open(name)? {
        return Ok(k);
    }
    let n = HSTRING::from(name);
    let r = run_prompt(cancel, |_| {
        KeyCredentialManager::RequestCreateAsync(&n, KeyCredentialCreationOption::FailIfExists)
    })?;
    match r.Status().map_err(|e| os("hello_error", &e))? {
        KeyCredentialStatus::Success => r.Credential().map_err(|e| os("hello_error", &e)),
        // Another process created it meanwhile.
        KeyCredentialStatus::CredentialAlreadyExists => {
            open(name)?.ok_or_else(|| status_error(KeyCredentialStatus::NotFound, true))
        }
        s => Err(status_error(s, false)),
    }
}

fn buffer_bytes(buf: &IBuffer) -> Result<Vec<u8>, CapabilityError> {
    let mut out = windows_core::Array::<u8>::new();
    CryptographicBuffer::CopyToByteArray(buf, &mut out).map_err(|e| os("hello_error", &e))?;
    Ok(out.to_vec())
}

/// The key's public key as DER `SubjectPublicKeyInfo`.
pub fn public_key_spki(key: &KeyCredential) -> Result<Vec<u8>, CapabilityError> {
    let buf = key
        .RetrievePublicKeyWithBlobType(CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo)
        .map_err(|e| os("hello_error", &e))?;
    buffer_bytes(&buf)
}

/// RSASSA-PKCS1-v1_5 / SHA-256 signature over `data` after a Hello gesture (deterministic for a
/// given key and message).
pub fn sign(
    key: &KeyCredential,
    data: &[u8],
    cancel: &CancelToken,
) -> Result<Vec<u8>, CapabilityError> {
    let input =
        CryptographicBuffer::CreateFromByteArray(data).map_err(|e| os("hello_error", &e))?;
    let r = run_prompt(cancel, |_| key.RequestSignAsync(&input))?;
    match r.Status().map_err(|e| os("hello_error", &e))? {
        KeyCredentialStatus::Success => {
            buffer_bytes(&r.Result().map_err(|e| os("hello_error", &e))?)
        }
        s => Err(status_error(s, true)),
    }
}

/// Owner verification (PIN, face or fingerprint) with `message` in the dialog. `Ok(())` when
/// verified; the error reason otherwise (`user_cancelled`, …).
pub fn verify_owner(message: &str, cancel: &CancelToken) -> Result<(), CapabilityError> {
    let msg = HSTRING::from(message);
    let result = run_prompt(cancel, |hwnd| {
        let verifier: IUserConsentVerifierInterop =
            windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
        let mut raw = std::ptr::null_mut();
        // SAFETY: the HSTRING is borrowed for the call (ABI: an HSTRING handle); the out pointer
        // receives an owned IAsyncOperation<UserConsentVerificationResult>.
        unsafe {
            interop::request(
                &verifier,
                hwnd,
                std::mem::transmute_copy(&msg),
                &IAsyncOperation::<UserConsentVerificationResult>::IID,
                &mut raw,
            )
            .ok()?;
            Ok(IAsyncOperation::<UserConsentVerificationResult>::from_raw(
                raw,
            ))
        }
    })?;
    match result {
        UserConsentVerificationResult::Verified => Ok(()),
        UserConsentVerificationResult::Canceled => Err(CapabilityError::user_cancelled()),
        UserConsentVerificationResult::RetriesExhausted => Err(CapabilityError::new(
            ErrorCode::Forbidden,
            "biometry_lockout",
            "Too many failed Windows Hello attempts",
        )),
        UserConsentVerificationResult::NotConfiguredForUser
        | UserConsentVerificationResult::DeviceNotPresent => Err(hello_unavailable()),
        UserConsentVerificationResult::DisabledByPolicy => Err(CapabilityError::unavailable(
            "disabled_by_policy",
            "Windows Hello is disabled by policy",
        )),
        UserConsentVerificationResult::DeviceBusy => {
            Err(CapabilityError::unavailable("device_busy", "Windows Hello is busy").retryable())
        }
        _ => Err(CapabilityError::new(
            ErrorCode::Forbidden,
            "auth_failed",
            "Authentication failed",
        )),
    }
}

/// Machine reason of a failed owner check, as the mac helper's `authErrorReason`.
pub fn auth_error_reason(e: &CapabilityError) -> String {
    match e.reason.as_str() {
        "user_cancelled" | "cancelled" => "user_cancelled".into(),
        "biometry_lockout" => "biometry_lockout".into(),
        "passcode_not_set" => "passcode_not_set".into(),
        "auth_failed" => "authentication_failed".into(),
        _ => "authentication_unavailable".into(),
    }
}
