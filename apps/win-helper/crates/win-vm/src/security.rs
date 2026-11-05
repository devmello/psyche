//! Who may talk to the service and as whom it touches files.
//!
//! - The control pipe's DACL grants the owner SID and LocalSystem only (network logons denied);
//!   every connection is also checked: the client's impersonation token and its process token
//!   must both carry the owner SID.
//! - Requests run while impersonating the owner's token (`Token::scope`): every file in the
//!   owner's profile is read and written with the owner's own rights, so planted junctions or
//!   links cannot make LocalSystem write elsewhere. HCS calls switch back to LocalSystem
//!   (`as_service`); paths handed to HCS are checked first (`check_plain_path`: no reparse
//!   point below `$PSYCHE_HOME`, no hard-linked file).

use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows::Win32::Security::{
    ACL, DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, RevertToSelf, SECURITY_ATTRIBUTES, SecurityImpersonation, TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY,
    TOKEN_USER, TokenImpersonationLevel, TokenUser,
};
use windows::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, ImpersonateNamedPipeClient};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcess, OpenProcessToken, OpenThreadToken, PROCESS_QUERY_LIMITED_INFORMATION, SetThreadToken,
};
use windows::core::{HSTRING, PWSTR};

use crate::error::{Code, VmError, VmResult};

/// An owned token handle.
pub struct Token(pub HANDLE);

// SAFETY: a token handle may be used from any thread.
unsafe impl Send for Token {}
// SAFETY: as above; the handle is only read.
unsafe impl Sync for Token {}

impl Drop for Token {
    fn drop(&mut self) {
        // SAFETY: the handle was opened here and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn token_info(token: HANDLE, class: windows::Win32::Security::TOKEN_INFORMATION_CLASS) -> Option<Vec<u64>> {
    // SAFETY: the first call sizes the buffer (8-aligned), the second fills it.
    unsafe {
        let mut len = 0u32;
        let _ = GetTokenInformation(token, class, None, 0, &mut len);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        GetTokenInformation(token, class, Some(buf.as_mut_ptr() as *mut _), len, &mut len).ok()?;
        Some(buf)
    }
}

fn sid_string(sid: windows::Win32::Security::PSID) -> Option<String> {
    // SAFETY: `sid` is valid for the call; the string is freed with LocalFree.
    unsafe {
        let mut s = PWSTR::null();
        ConvertSidToStringSidW(sid, &mut s).ok()?;
        let out = s.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(s.0 as *mut _)));
        out
    }
}

impl Token {
    pub fn user_sid(&self) -> Option<String> {
        let buf = token_info(self.0, TokenUser)?;
        // SAFETY: the buffer holds a TOKEN_USER whose SID points inside it.
        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        sid_string(user.User.Sid)
    }

    /// `SECURITY_IMPERSONATION_LEVEL` of an impersonation token (2 = impersonation).
    pub fn impersonation_level(&self) -> Option<i32> {
        let buf = token_info(self.0, TokenImpersonationLevel)?;
        Some(buf[0] as u32 as i32)
    }

    /// The current process token (tests and console runs).
    pub fn current_process() -> Option<Token> {
        let mut t = HANDLE::default();
        // SAFETY: plain call; the handle is owned by the result.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut t).ok()? };
        let primary = Token(t);
        let mut dup = HANDLE::default();
        // SAFETY: an impersonation copy of our own token.
        unsafe {
            windows::Win32::Security::DuplicateTokenEx(
                primary.0,
                TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_DUPLICATE,
                None,
                SecurityImpersonation,
                windows::Win32::Security::TokenImpersonation,
                &mut dup,
            )
            .ok()?
        };
        Some(Token(dup))
    }

    /// Runs `f` with this token on the current thread, then restores the previous one.
    pub fn scope<T>(&self, f: impl FnOnce() -> T) -> T {
        let _guard = ThreadTokenGuard::save();
        // SAFETY: `self.0` is an impersonation token with TOKEN_IMPERSONATE.
        let set = unsafe { SetThreadToken(None, Some(self.0)) };
        if set.is_err() {
            crate::log::warn("impersonation failed; running without the owner token");
        }
        f()
    }
}

/// Restores the thread's token (or none) on drop.
struct ThreadTokenGuard(Option<Token>);

impl ThreadTokenGuard {
    fn save() -> ThreadTokenGuard {
        ThreadTokenGuard(current_thread_token())
    }
}

impl Drop for ThreadTokenGuard {
    fn drop(&mut self) {
        // SAFETY: restoring a token this thread had (or reverting).
        unsafe {
            match &self.0 {
                Some(t) => {
                    let _ = SetThreadToken(None, Some(t.0));
                }
                None => {
                    let _ = RevertToSelf();
                }
            }
        }
    }
}

fn current_thread_token() -> Option<Token> {
    let mut t = HANDLE::default();
    // SAFETY: opened as self so the check uses the process identity.
    unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_DUPLICATE, true, &mut t).ok()? };
    Some(Token(t))
}

/// Runs `f` as the service's own identity (LocalSystem), even inside an owner scope.
pub fn as_service<T>(f: impl FnOnce() -> T) -> T {
    let guard = ThreadTokenGuard::save();
    if guard.0.is_some() {
        // SAFETY: drops the impersonation token; the guard puts it back.
        unsafe {
            let _ = RevertToSelf();
        }
    }
    f()
}

/// The process's user SID.
pub fn current_user_sid() -> Option<String> {
    let mut t = HANDLE::default();
    // SAFETY: plain call; the handle is owned by `Token`.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t).ok()? };
    Token(t).user_sid()
}

pub fn process_user_sid(pid: u32) -> Option<String> {
    // SAFETY: handles opened here are closed on every path.
    unsafe {
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut t = HANDLE::default();
        let ok = OpenProcessToken(p, TOKEN_QUERY, &mut t).is_ok();
        let _ = CloseHandle(p);
        if !ok {
            return None;
        }
        Token(t).user_sid()
    }
}

/// Impersonates the client of a connected pipe just long enough to take its token.
pub fn pipe_client_token(pipe: HANDLE) -> VmResult<Token> {
    let _guard = ThreadTokenGuard::save();
    // SAFETY: `pipe` is a connected server end; the guard reverts.
    unsafe { ImpersonateNamedPipeClient(pipe) }
        .map_err(|_| VmError::new(Code::Forbidden, "client_identity", "Could not identify the pipe client"))?;
    let mut t = HANDLE::default();
    // SAFETY: the thread now carries the client's token.
    unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY | TOKEN_IMPERSONATE | TOKEN_DUPLICATE, true, &mut t) }
        .map_err(|_| VmError::new(Code::Forbidden, "client_identity", "Could not read the pipe client's token"))?;
    Ok(Token(t))
}

pub fn pipe_client_pid(pipe: HANDLE) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: plain call.
    unsafe { GetNamedPipeClientProcessId(pipe, &mut pid).ok()? };
    Some(pid)
}

pub fn pipe_server_pid(pipe: HANDLE) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: plain call.
    unsafe { GetNamedPipeServerProcessId(pipe, &mut pid).ok()? };
    Some(pid)
}

/// The per-connection check: the client's token user and its process user are the owner, and
/// the token allows impersonation (the service works with the owner's rights).
pub fn check_client(token_sid: Option<&str>, process_sid: Option<&str>, level: Option<i32>, owner: &str) -> VmResult<()> {
    let denied = |why: &str| VmError::new(Code::Forbidden, "not_owner", format!("Only the owner may control this sandbox PC ({why})"));
    match token_sid {
        Some(s) if s.eq_ignore_ascii_case(owner) => {}
        _ => return Err(denied("client user")),
    }
    match process_sid {
        Some(s) if s.eq_ignore_ascii_case(owner) => {}
        _ => return Err(denied("client process")),
    }
    if level.unwrap_or(0) < SecurityImpersonation.0 {
        return Err(VmError::new(
            Code::Forbidden,
            "impersonation_required",
            "Connect with SECURITY_IMPERSONATION (the default) so the service can act with your rights",
        ));
    }
    Ok(())
}

/// `D:P(A;;GA;;;<owner>)(A;;GA;;;SY)(D;;GA;;;NU)`: the control pipe.
pub fn pipe_sddl(owner_sid: &str) -> String {
    format!("D:P(D;;GA;;;NU)(A;;GA;;;{owner_sid})(A;;GA;;;SY)")
}

/// `D:P(A;OICI;FA;;;<owner>)(A;OICI;FA;;;SY)`: owner-only folders.
pub fn owner_dir_sddl(owner_sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;{owner_sid})(A;OICI;FA;;;SY)")
}

/// A self-relative security descriptor from SDDL (freed on drop).
pub struct SecurityDescriptor(pub PSECURITY_DESCRIPTOR);

// SAFETY: the descriptor is immutable once built.
unsafe impl Send for SecurityDescriptor {}
// SAFETY: as above.
unsafe impl Sync for SecurityDescriptor {}

impl SecurityDescriptor {
    pub fn from_sddl(sddl: &str) -> VmResult<SecurityDescriptor> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the descriptor is allocated by the call and freed on drop.
        unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None) }
            .map_err(|e| VmError::internal(format!("bad security descriptor: {e}")))?;
        Ok(SecurityDescriptor(sd))
    }

    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }

    fn dacl(&self) -> Option<*const ACL> {
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut acl: *mut ACL = std::ptr::null_mut();
        // SAFETY: reads the DACL pointer out of our own descriptor.
        unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut acl, &mut defaulted).ok()? };
        (present.as_bool() && !acl.is_null()).then_some(acl as *const ACL)
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0.0)));
        }
    }
}

/// Sets a protected owner + SYSTEM DACL on a folder (best effort; runs as the owner, who owns it).
pub fn protect_owner_dir(path: &Path, owner_sid: &str) -> bool {
    let Ok(sd) = SecurityDescriptor::from_sddl(&owner_dir_sddl(owner_sid)) else { return false };
    let Some(dacl) = sd.dacl() else { return false };
    // SAFETY: the DACL lives in `sd` for the call.
    let e = unsafe {
        SetNamedSecurityInfoW(
            &HSTRING::from(path.as_os_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl),
            None,
        )
    };
    e.0 == 0
}

/// The service log folder: LocalSystem and Administrators write, signed-in users read
/// (the logs are content-free).
pub fn protect_admin_dir(path: &Path, _owner_sid: &str) -> bool {
    let Ok(sd) = SecurityDescriptor::from_sddl("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;AU)") else { return false };
    let Some(dacl) = sd.dacl() else { return false };
    // SAFETY: the DACL lives in `sd` for the call.
    let e = unsafe {
        SetNamedSecurityInfoW(
            &HSTRING::from(path.as_os_str()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(dacl),
            None,
        )
    };
    e.0 == 0
}

/// Whether this process runs elevated (or as LocalSystem).
pub fn is_elevated() -> bool {
    let mut t = HANDLE::default();
    // SAFETY: plain call; the handle is owned by `Token`.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t) }.is_err() {
        return false;
    }
    let token = Token(t);
    token_info(token.0, windows::Win32::Security::TokenElevation).map(|b| b[0] as u32 != 0).unwrap_or(false)
}

fn open_no_follow(path: &Path) -> Option<HANDLE> {
    // SAFETY: plain call; the caller closes the handle.
    unsafe {
        CreateFileW(
            &HSTRING::from(path.as_os_str()),
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        .ok()
    }
}

/// Refuses a path HCS (running as LocalSystem) will open when any component below `root` is a
/// reparse point (junction, symlink, mount point) or the file has more than one hard link.
pub fn check_plain_path(root: &Path, path: &Path) -> VmResult<()> {
    let refuse = |why: &str| {
        VmError::policy_denied("unsafe_path", format!("{} {why}", path.display())).detail("path", path.to_string_lossy().into_owned())
    };
    let rel = path.strip_prefix(root).map_err(|_| refuse("is outside Psyche's folder"))?;
    let mut cur = root.to_path_buf();
    for c in rel.components() {
        cur.push(c);
        let Ok(meta) = std::fs::symlink_metadata(&cur) else { continue };
        if crate::fsx::is_link(&cur) {
            return Err(refuse("goes through a link or junction"));
        }
        if meta.is_file() {
            let Some(h) = open_no_follow(&cur) else { return Err(refuse("cannot be opened")) };
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: `h` is a valid handle, closed right after.
            let ok = unsafe { GetFileInformationByHandle(h, &mut info) }.is_ok();
            // SAFETY: closes the handle opened above.
            unsafe {
                let _ = CloseHandle(h);
            }
            if !ok || info.nNumberOfLinks != 1 {
                return Err(refuse("has other hard links"));
            }
        }
    }
    Ok(())
}

/// Opens a folder for listing (and adding, when `write`) with the current thread's token: the
/// owner must be able to use the folder themselves before the guest gets it.
pub fn check_dir_access(path: &Path, write: bool) -> VmResult<()> {
    let mut access = FILE_LIST_DIRECTORY.0 | FILE_READ_ATTRIBUTES.0;
    if write {
        access |= FILE_ADD_FILE.0 | FILE_ADD_SUBDIRECTORY.0;
    }
    // SAFETY: plain call; the handle is closed right after.
    let h = unsafe {
        CreateFileW(
            &HSTRING::from(path.as_os_str()),
            access,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    };
    match h {
        Ok(h) => {
            // SAFETY: closes the handle opened above.
            unsafe {
                let _ = CloseHandle(h);
            }
            Ok(())
        }
        Err(_) => Err(VmError::new(
            Code::Forbidden,
            "share_access_denied",
            format!("You cannot {} {}", if write { "write to" } else { "read" }, path.display()),
        )),
    }
}

/// `GENERIC_ALL`, for pipe instances (re-exported for the server).
pub const PIPE_ACCESS: u32 = GENERIC_ALL.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_check_requires_both_sids_and_impersonation() {
        let owner = "S-1-5-21-1-2-3-1001";
        check_client(Some(owner), Some(owner), Some(2), owner).unwrap();
        check_client(Some(&owner.to_lowercase()), Some(owner), Some(3), owner).unwrap();
        assert_eq!(check_client(Some("S-1-5-21-1-2-3-1002"), Some(owner), Some(2), owner).unwrap_err().reason, "not_owner");
        assert_eq!(check_client(Some(owner), Some("S-1-5-18"), Some(2), owner).unwrap_err().reason, "not_owner");
        assert_eq!(check_client(None, Some(owner), Some(2), owner).unwrap_err().reason, "not_owner");
        assert_eq!(check_client(Some(owner), Some(owner), Some(1), owner).unwrap_err().reason, "impersonation_required");
    }

    #[test]
    fn sddl_strings_parse_and_name_only_owner_and_system() {
        let me = current_user_sid().unwrap();
        let p = pipe_sddl(&me);
        assert!(p.starts_with("D:P") && p.contains(&me) && p.contains(";;;SY)") && p.contains("(D;;GA;;;NU)"));
        assert!(!p.contains(";;;WD)") && !p.contains(";;;BA)"));
        SecurityDescriptor::from_sddl(&p).unwrap();
        SecurityDescriptor::from_sddl(&owner_dir_sddl(&me)).unwrap().dacl().unwrap();
        assert!(SecurityDescriptor::from_sddl("D:P(A;;GA;;;not-a-sid)").is_err());
    }

    #[test]
    fn plain_path_refuses_junctions_and_hard_links() {
        let root = std::env::temp_dir().join(format!("psyche-vm-sec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("vm").join("a")).unwrap();
        std::fs::write(root.join("vm").join("a").join("disk.vhdx"), "x").unwrap();
        check_plain_path(&root, &root.join("vm").join("a").join("disk.vhdx")).unwrap();
        check_plain_path(&root, &root.join("vm").join("a").join("missing.vhdx")).unwrap();
        std::fs::hard_link(root.join("vm").join("a").join("disk.vhdx"), root.join("vm").join("link.vhdx")).unwrap();
        assert_eq!(check_plain_path(&root, &root.join("vm").join("a").join("disk.vhdx")).unwrap_err().reason, "unsafe_path");
        // A junction (no privilege needed) in the middle of the path.
        let target = root.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let st = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J", &root.join("vm").join("j").to_string_lossy(), &target.to_string_lossy()])
            .output()
            .unwrap();
        assert!(st.status.success());
        assert_eq!(check_plain_path(&root, &root.join("vm").join("j").join("x.vhdx")).unwrap_err().reason, "unsafe_path");
        assert_eq!(check_plain_path(&root, Path::new(r"C:\Windows\x")).unwrap_err().reason, "unsafe_path");
        check_dir_access(&root, true).unwrap();
        let _ = std::fs::remove_dir(root.join("vm").join("j"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn impersonation_scope_restores_the_thread() {
        let t = Token::current_process().unwrap();
        assert_eq!(t.impersonation_level(), Some(SecurityImpersonation.0));
        let me = current_user_sid().unwrap();
        let inside = t.scope(|| {
            let during = current_thread_token().and_then(|x| x.user_sid());
            let svc = as_service(|| current_thread_token().is_none());
            (during, svc, current_thread_token().is_some())
        });
        assert_eq!(inside.0.as_deref(), Some(me.as_str()));
        assert!(inside.1, "as_service drops the impersonation token");
        assert!(inside.2, "and puts it back");
        assert!(current_thread_token().is_none(), "scope reverted");
    }
}
