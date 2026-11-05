//! Authenticode check of the helper's own executable (`permissions.status.bundle.signing`).

use windows::Win32::Foundation::HWND;
use windows::Win32::Security::WinTrust::{
    WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO,
    WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
    WinVerifyTrust,
};
use windows::core::{GUID, HSTRING, PCWSTR};

const TRUST_E_NOSIGNATURE: i32 = 0x800B0100u32 as i32;

/// `authenticode` (valid, trusted signature), `unsigned`, or `untrusted` (signed but not valid or
/// not trusted). Offline: no revocation check.
pub fn authenticode(path: &str) -> &'static str {
    let wide = HSTRING::from(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(wide.as_ptr()),
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
        dwStateAction: WTD_STATEACTION_VERIFY,
        ..Default::default()
    };
    let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: the structures point at live locals; the state is closed right after.
    let status = unsafe {
        let s = WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut _);
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(HWND::default(), &mut action, &mut data as *mut _ as *mut _);
        s
    };
    match status {
        0 => "authenticode",
        TRUST_E_NOSIGNATURE => "unsigned",
        _ => "untrusted",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn system_binaries_are_signed() {
        // notepad.exe is catalog-signed; explorer.exe embeds a signature on every release.
        let r = super::authenticode(r"C:\Windows\explorer.exe");
        assert!(matches!(r, "authenticode" | "unsigned" | "untrusted"));
        assert_eq!(
            super::authenticode(&std::env::current_exe().unwrap().display().to_string()),
            "unsigned"
        );
    }
}
