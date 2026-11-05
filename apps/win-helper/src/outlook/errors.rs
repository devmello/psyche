//! What an Outlook COM failure means, as a capability error the Gateway and Settings can explain
//! (the counterpart of `AppleScriptFailure.map`). Pure, so every mapping is unit-tested. Messages
//! are content-free: the HRESULT goes in `details.hresult`, never Outlook's exception text (it
//! can quote folder or item names).

use crate::node::capability::{CapabilityError, ErrorCode};

pub const RPC_E_CALL_REJECTED: u32 = 0x8001_0001;
pub const RPC_E_SERVERCALL_RETRYLATER: u32 = 0x8001_010A;
pub const RPC_E_CALL_CANCELED: u32 = 0x8001_011F;
pub const RPC_E_DISCONNECTED: u32 = 0x8001_0108;
pub const RPC_S_SERVER_UNAVAILABLE: u32 = 0x8007_06BA;
pub const RPC_S_CALL_FAILED: u32 = 0x8007_06BE;
pub const CO_E_SERVER_EXEC_FAILURE: u32 = 0x8008_0005;
pub const REGDB_E_CLASSNOTREG: u32 = 0x8004_0154;
pub const CO_E_CLASSSTRING: u32 = 0x8004_01F3;
pub const E_ACCESSDENIED: u32 = 0x8007_0005;
pub const E_ABORT: u32 = 0x8000_4004;
pub const E_INVALIDARG: u32 = 0x8007_0057;
pub const DISP_E_EXCEPTION: u32 = 0x8002_0009;
pub const DISP_E_UNKNOWNNAME: u32 = 0x8002_0006;
pub const DISP_E_MEMBERNOTFOUND: u32 = 0x8002_0003;
pub const MAPI_E_NOT_FOUND: u32 = 0x8004_010F;
pub const MAPI_E_INVALID_ENTRYID: u32 = 0x8004_0107;
pub const MAPI_E_NO_ACCESS: u32 = 0x8007_0005;
pub const MK_E_UNAVAILABLE: u32 = 0x8004_01E3;

/// What the helper says while Outlook does not answer: a security prompt, a sign-in, a profile
/// picker or another modal dialog is the usual reason.
pub const NOT_RESPONDING: &str = "Outlook did not answer in time. It may be showing a dialog: a security prompt (\"A program is trying to access e-mail address information\"), a sign-in or a profile picker. Answer it in Outlook and try again.";

pub fn hresult_hex(hr: u32) -> String {
    format!("0x{hr:08X}")
}

/// Maps an HRESULT (for `DISP_E_EXCEPTION`, the exception's `scode` when there is one).
pub fn map(hr: u32, scode: Option<u32>) -> CapabilityError {
    let code = match (hr, scode) {
        (DISP_E_EXCEPTION, Some(s)) if s != 0 => s,
        _ => hr,
    };
    let e = match code {
        RPC_E_CALL_REJECTED | RPC_E_SERVERCALL_RETRYLATER => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_busy",
            "Outlook is busy (a dialog may be open in it). Try again in a moment.",
        )
        .retryable(),
        RPC_E_CALL_CANCELED => {
            CapabilityError::new(ErrorCode::Timeout, "outlook_not_responding", NOT_RESPONDING)
                .retryable()
        }
        RPC_E_DISCONNECTED | RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_disconnected",
            "Outlook quit or restarted while Psyche was using it. Try again.",
        )
        .retryable(),
        CO_E_SERVER_EXEC_FAILURE => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_start_failed",
            "Outlook could not be started for Psyche. If Outlook runs as administrator, run it normally; if it asks for a profile, set one up in Outlook first.",
        ),
        REGDB_E_CLASSNOTREG | CO_E_CLASSSTRING => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_not_installed",
            "Classic Outlook is not installed. The new Outlook for Windows cannot be automated.",
        ),
        E_ACCESSDENIED | E_ABORT => CapabilityError::new(
            ErrorCode::Forbidden,
            "outlook_access_denied",
            "Outlook refused programmatic access (the security prompt was denied, or a policy blocks it).",
        ),
        MAPI_E_NOT_FOUND | MAPI_E_INVALID_ENTRYID | E_INVALIDARG => {
            CapabilityError::not_found("not_found", "The item was not found in Outlook")
        }
        DISP_E_UNKNOWNNAME | DISP_E_MEMBERNOTFOUND => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_object_model",
            "This version of Outlook lacks a feature Psyche needs.",
        ),
        _ => CapabilityError::new(
            ErrorCode::Unavailable,
            "outlook_error",
            "Outlook could not complete the request",
        ),
    };
    e.with_detail("hresult", hresult_hex(code))
}

/// The refusal for guarded operations when Outlook does not trust external programs.
pub fn object_model_guard() -> CapabilityError {
    CapabilityError::new(
        ErrorCode::Forbidden,
        "outlook_object_model_guard",
        "Outlook would show \"A program is trying to access e-mail address information\" for this, because Windows reports no up-to-date antivirus (or a policy asks Outlook to warn). Psyche does not trigger that prompt. Turn on Windows Security (or update your antivirus), or set Outlook › File › Options › Trust Center › Programmatic Access to \"Never warn me\" (needs Outlook as administrator), then try again.",
    )
    .with_detail("permission", "automation")
}

/// Whether a failure means the Outlook connection is gone (the session is rebuilt).
pub fn is_disconnect(hr: u32) -> bool {
    matches!(
        hr,
        RPC_E_DISCONNECTED | RPC_S_SERVER_UNAVAILABLE | RPC_S_CALL_FAILED
    )
}

/// Whether Outlook asked to be called again (`RPC_E_CALL_REJECTED` while it is busy).
pub fn is_retry_later(hr: u32) -> bool {
    matches!(hr, RPC_E_CALL_REJECTED | RPC_E_SERVERCALL_RETRYLATER)
}

/// The deadline of one Outlook call passed.
pub fn timed_out() -> CapabilityError {
    CapabilityError::new(ErrorCode::Timeout, "outlook_not_responding", NOT_RESPONDING).retryable()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_hresults_to_reasons() {
        let r = |hr, s| map(hr, s).reason.clone();
        assert_eq!(r(RPC_E_CALL_REJECTED, None), "outlook_busy");
        assert!(map(RPC_E_CALL_REJECTED, None).retryable);
        assert_eq!(r(RPC_E_CALL_CANCELED, None), "outlook_not_responding");
        assert_eq!(map(RPC_E_CALL_CANCELED, None).code, ErrorCode::Timeout);
        assert_eq!(r(RPC_S_SERVER_UNAVAILABLE, None), "outlook_disconnected");
        assert_eq!(r(CO_E_SERVER_EXEC_FAILURE, None), "outlook_start_failed");
        assert_eq!(r(REGDB_E_CLASSNOTREG, None), "outlook_not_installed");
        assert_eq!(map(E_ABORT, None).code, ErrorCode::Forbidden);
        assert_eq!(r(DISP_E_EXCEPTION, Some(MAPI_E_NOT_FOUND)), "not_found");
        assert_eq!(
            map(DISP_E_EXCEPTION, Some(MAPI_E_NOT_FOUND)).code,
            ErrorCode::NotFound
        );
        assert_eq!(r(DISP_E_EXCEPTION, None), "outlook_error");
        assert_eq!(r(DISP_E_UNKNOWNNAME, None), "outlook_object_model");
        assert_eq!(map(0x8000_FFFF, None).details["hresult"], "0x8000FFFF");
        assert_eq!(
            map(DISP_E_EXCEPTION, Some(E_ACCESSDENIED)).details["hresult"],
            "0x80070005"
        );
    }

    #[test]
    fn guard_and_classification() {
        let g = object_model_guard();
        assert_eq!(g.code, ErrorCode::Forbidden);
        assert_eq!(g.reason, "outlook_object_model_guard");
        assert!(is_disconnect(RPC_E_DISCONNECTED) && !is_disconnect(E_ABORT));
        assert!(is_retry_later(RPC_E_CALL_REJECTED) && !is_retry_later(RPC_E_CALL_CANCELED));
        assert_eq!(timed_out().code, ErrorCode::Timeout);
    }
}
