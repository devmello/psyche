//! Processes and top-level windows: image paths, AppUserModelIDs, display names, the Alt-Tab
//! window list.

use std::collections::HashMap;
use std::path::Path;

use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WIN32_ERROR};
use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GWL_EXSTYLE, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::core::{BOOL, HSTRING, PCWSTR, PWSTR};

struct ProcHandle(HANDLE);

impl Drop for ProcHandle {
    fn drop(&mut self) {
        // SAFETY: opened by `open`, closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open(pid: u32) -> Option<ProcHandle> {
    // SAFETY: plain Win32 call; the handle is owned by the guard.
    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok().map(ProcHandle) }
}

/// Full Win32 path of a process's executable.
pub fn image_path(pid: u32) -> Option<String> {
    let h = open(pid)?;
    let mut buf = vec![0u16; 32_768];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer is `len` UTF-16 units.
    unsafe { QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()? };
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// A packaged process's AppUserModelID.
pub fn process_aumid(pid: u32) -> Option<String> {
    let h = open(pid)?;
    let mut len = 0u32;
    // SAFETY: size query, then fill.
    unsafe {
        let _ = GetApplicationUserModelId(h.0, &mut len, None);
        if len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if GetApplicationUserModelId(h.0, &mut len, Some(PWSTR(buf.as_mut_ptr()))) != WIN32_ERROR(0) {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]);
        (!s.is_empty()).then_some(s)
    }
}

/// A window's explicit AppUserModelID (set by the app or, for packaged apps, by the system).
pub fn window_aumid(hwnd: HWND) -> Option<String> {
    // SAFETY: COM call on a window handle; the store is released on drop.
    unsafe {
        let store: IPropertyStore = SHGetPropertyStoreForWindow(hwnd).ok()?;
        let v = store.GetValue(&PKEY_AppUserModel_ID).ok()?;
        let s = v.to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// `FileDescription` from an executable's version resource (the name Task Manager shows).
pub fn file_description(path: &str) -> Option<String> {
    let wide = HSTRING::from(path);
    // SAFETY: version-info calls on a buffer sized by GetFileVersionInfoSizeW.
    unsafe {
        let size = GetFileVersionInfoSizeW(&wide, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&wide, None, size, data.as_mut_ptr() as *mut _).ok()?;
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let pair = std::slice::from_raw_parts(ptr as *const u16, 2);
        let key = format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", pair[0], pair[1]);
        if !VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from(key), &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let s = PCWSTR(ptr as *const u16).to_string().ok()?;
        let t = s.trim().to_owned();
        (!t.is_empty()).then_some(t)
    }
}

pub fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    // SAFETY: plain query.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

pub fn window_title(hwnd: HWND) -> String {
    // SAFETY: the buffer is sized from GetWindowTextLengthW.
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: the out buffer is a u32 as DWMWA_CLOAKED requires.
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok() && cloaked != 0
    }
}

/// Whether a top-level window appears in Alt-Tab / the taskbar (the Windows "Dock presence").
pub fn is_app_window(hwnd: HWND) -> bool {
    // SAFETY: plain window queries.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || is_cloaked(hwnd) {
            return false;
        }
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let owner = GetWindow(hwnd, GW_OWNER).unwrap_or_default();
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        (owner.is_invalid() || ex & WS_EX_APPWINDOW.0 != 0) && GetWindowTextLengthW(hwnd) > 0
    }
}

pub fn is_minimized(hwnd: HWND) -> bool {
    // SAFETY: plain query.
    unsafe { IsIconic(hwnd).as_bool() }
}

pub fn foreground_window() -> Option<HWND> {
    // SAFETY: plain query.
    let h = unsafe { GetForegroundWindow() };
    (!h.is_invalid()).then_some(h)
}

/// Every top-level window, in z-order (front first).
pub fn top_level_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the Vec passed below, alive for the EnumWindows call.
        let v = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        v.push(hwnd);
        BOOL(1)
    }
    let mut v: Vec<HWND> = Vec::new();
    // SAFETY: the callback only pushes into `v`.
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut v as *mut _ as isize));
    }
    v
}

/// `pid → [app windows]`, front-most first.
pub fn app_windows_by_pid() -> HashMap<u32, Vec<HWND>> {
    let mut map: HashMap<u32, Vec<HWND>> = HashMap::new();
    for h in top_level_windows() {
        if is_app_window(h) {
            map.entry(window_pid(h)).or_default().push(h);
        }
    }
    map
}

/// Every process: `(pid, exe file name)`.
pub fn all_processes() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    // SAFETY: Toolhelp snapshot iteration; the handle is closed at the end.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                out.push((entry.th32ProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// What the helper reports as an app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    pub pid: u32,
    /// AppUserModelID or executable path (see `node::tiers`).
    pub identity: Option<String>,
    pub exe: Option<String>,
    pub aumid: Option<String>,
    pub name: String,
}

/// Identity and display name for a process, using `hwnd` (its front window) when known.
pub fn app_info(pid: u32, hwnd: Option<HWND>) -> AppInfo {
    let exe = image_path(pid);
    let aumid = hwnd.and_then(window_aumid).or_else(|| process_aumid(pid));
    let identity = aumid.clone().or_else(|| exe.clone());
    let name = exe
        .as_deref()
        .and_then(file_description)
        .or_else(|| hwnd.map(window_title).filter(|t| !t.is_empty()))
        .or_else(|| exe.as_deref().and_then(|p| Path::new(p).file_stem()).map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| format!("pid {pid}"));
    AppInfo { pid, identity, exe, aumid, name }
}

#[cfg(test)]
mod tests {
    #[test]
    fn own_process_has_an_image_path() {
        let me = super::image_path(std::process::id()).unwrap();
        assert!(me.to_lowercase().ends_with(".exe"));
        assert!(super::all_processes().iter().any(|(pid, _)| *pid == std::process::id()));
    }
}
