//! What the helper reports about the focused process: its identifier (package family name or
//! executable file name), display name and whether it runs above our integrity level.

use super::wide;
use std::ffi::c_void;
use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenIntegrityLevel};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{PCWSTR, PWSTR};

pub(crate) struct ProcessInfo {
    pub bundle_id: Option<String>,
    pub app_name: String,
    pub elevated: bool,
}

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: a handle this module opened.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub(crate) fn info(pid: u32) -> ProcessInfo {
    let fallback = ProcessInfo { bundle_id: None, app_name: format!("pid {pid}"), elevated: false };
    // SAFETY: querying another process with the least access that answers these questions.
    let Ok(h) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else { return fallback };
    let h = Handle(h);
    let path = image_path(h.0);
    let family = package_family(h.0);
    let exe = path.as_deref().and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().to_lowercase());
    let app_name = path
        .as_deref()
        .and_then(file_description)
        .or_else(|| path.as_deref().and_then(|p| Path::new(p).file_stem()).map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or(fallback.app_name);
    let elevated = match (integrity(h.0), own_integrity()) {
        (Some(theirs), Some(ours)) => theirs > ours,
        _ => false,
    };
    ProcessInfo { bundle_id: family.or(exe), app_name, elevated }
}

fn image_path(h: HANDLE) -> Option<String> {
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: buf holds len UTF-16 units.
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

fn package_family(h: HANDLE) -> Option<String> {
    let mut len = 0u32;
    // SAFETY: first call sizes the buffer, the second fills it.
    unsafe {
        let _ = GetPackageFamilyName(h, &mut len, None);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if GetPackageFamilyName(h, &mut len, Some(PWSTR(buf.as_mut_ptr()))).is_err() {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]);
        (!s.is_empty()).then_some(s)
    }
}

/// The version resource's FileDescription ("Notepad", "Google Chrome").
fn file_description(path: &str) -> Option<String> {
    let w = wide(path);
    // SAFETY: the version-info buffer outlives every pointer VerQueryValueW returns into it.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(w.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(w.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let q = wide("\\VarFileInfo\\Translation");
        let mut langs = vec![];
        if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(q.as_ptr()), &mut ptr, &mut len).as_bool() && len >= 4 {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, len as usize / 2);
            for p in pairs.chunks(2) {
                langs.push(format!("{:04x}{:04x}", p[0], p[1]));
            }
        }
        langs.extend(["040904b0".to_string(), "040904e4".to_string()]);
        for l in langs {
            let q = wide(&format!("\\StringFileInfo\\{l}\\FileDescription"));
            if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(q.as_ptr()), &mut ptr, &mut len).as_bool() && len > 1 {
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, len as usize));
                let s = s.trim_end_matches('\0').trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }
}

fn integrity(process: HANDLE) -> Option<u32> {
    // SAFETY: token queried into a buffer sized by the first call.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let token = Handle(token);
        let mut len = 0u32;
        let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut len);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u8; len as usize];
        GetTokenInformation(token.0, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut c_void), len, &mut len).ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, count as u32 - 1))
    }
}

fn own_integrity() -> Option<u32> {
    // SAFETY: the pseudo-handle needs no closing.
    integrity(unsafe { GetCurrentProcess() })
}
