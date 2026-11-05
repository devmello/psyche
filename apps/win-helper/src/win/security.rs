//! Token queries: user SID, elevation, integrity level.

use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_ELEVATION, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    TOKEN_USER, TokenElevation, TokenIntegrityLevel, TokenUIAccess, TokenUser,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::core::PWSTR;

struct Token(HANDLE);

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by `open_token` and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_token(pid: Option<u32>) -> Option<Token> {
    // SAFETY: plain Win32 calls; every handle opened here is closed on every path.
    unsafe {
        let (process, owned) = match pid {
            None => (GetCurrentProcess(), false),
            Some(pid) => (OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?, true),
        };
        let mut token = HANDLE::default();
        let ok = OpenProcessToken(process, TOKEN_QUERY, &mut token).is_ok();
        if owned {
            let _ = CloseHandle(process);
        }
        ok.then_some(Token(token))
    }
}

fn token_info(token: &Token, class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Option<Vec<u8>> {
    // SAFETY: the first call sizes the buffer, the second fills it.
    unsafe {
        let mut len = 0u32;
        let _ = GetTokenInformation(token.0, class, None, 0, &mut len);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        GetTokenInformation(token.0, class, Some(buf.as_mut_ptr() as *mut _), len, &mut len).ok()?;
        Some(buf)
    }
}

fn user_sid(token: &Token) -> Option<String> {
    let buf = token_info(token, TokenUser)?;
    // SAFETY: the buffer holds a TOKEN_USER whose SID points inside it.
    unsafe {
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut s).ok()?;
        let out = s.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
        out
    }
}

/// The current process's user SID (`S-1-5-21-…`).
pub fn current_user_sid() -> Option<String> {
    user_sid(&open_token(None)?)
}

/// The user SID a process runs as, if this user may query it.
pub fn process_user_sid(pid: u32) -> Option<String> {
    user_sid(&open_token(Some(pid))?)
}

/// Whether the current process runs elevated (UAC "Run as administrator").
pub fn is_elevated() -> bool {
    open_token(None)
        .and_then(|t| token_info(&t, TokenElevation))
        // SAFETY: the buffer holds a TOKEN_ELEVATION.
        .map(|b| unsafe { (*(b.as_ptr() as *const TOKEN_ELEVATION)).TokenIsElevated != 0 })
        .unwrap_or(false)
}

/// Whether the token has UIAccess (lets it drive higher-integrity windows).
pub fn has_ui_access() -> bool {
    open_token(None)
        .and_then(|t| token_info(&t, TokenUIAccess))
        .map(|b| b.len() >= 4 && u32::from_ne_bytes([b[0], b[1], b[2], b[3]]) != 0)
        .unwrap_or(false)
}

/// Mandatory integrity level RID of a process (`0x2000` medium, `0x3000` high, `0x4000` system).
pub fn integrity_rid(pid: Option<u32>) -> Option<u32> {
    let token = open_token(pid)?;
    let buf = token_info(&token, TokenIntegrityLevel)?;
    // SAFETY: the buffer holds a TOKEN_MANDATORY_LABEL whose SID points inside it.
    unsafe {
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }
}

pub fn integrity_name(rid: u32) -> &'static str {
    match rid {
        r if r >= 0x4000 => "system",
        r if r >= 0x3000 => "high",
        r if r >= 0x2000 => "medium",
        r if r >= 0x1000 => "low",
        _ => "untrusted",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn current_user_matches_own_process() {
        let me = super::current_user_sid().unwrap();
        assert!(me.starts_with("S-1-5-"));
        assert_eq!(super::process_user_sid(std::process::id()), Some(me));
        assert!(super::integrity_rid(None).is_some());
    }
}
