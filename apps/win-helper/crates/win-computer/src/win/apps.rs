//! Apps, windows and processes: the Windows side of the mac helper's `NSRunningApplication` /
//! `NSWorkspace` use (`AXEngine.findApp`, `target`, `activate`) plus UIPI (integrity levels) and
//! secure-desktop detection.
//!
//! An app is a process with at least one visible top-level window. Packaged apps hosted by
//! `ApplicationFrameHost.exe` (Calculator, Settings) are attributed to the hosted process (the
//! `Windows.UI.Core.CoreWindow` child's pid); the frame host's pid is kept as `host_pid`, since the
//! frame's title bar belongs to it.

use crate::error::{code, CapError, CapResult};
use crate::hygiene::WindowRef;
use crate::snapshot::Rect;
use crate::tiers::StopSignal;
use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME,
};
use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn hwnd(h: isize) -> HWND {
    HWND(h as *mut c_void)
}

/// The app a call targets (mac `TargetApp`).
#[derive(Debug, Clone, PartialEq)]
pub struct TargetApp {
    pub pid: u32,
    /// `ApplicationFrameHost.exe` pid when the app's windows are hosted frames.
    pub host_pid: Option<u32>,
    /// Lowercase executable name: the Windows bundle id.
    pub bundle_id: Option<String>,
    pub name: String,
    pub electron: bool,
    pub exe_path: Option<String>,
}

impl TargetApp {
    /// Whether `pid` belongs to this app (its process or its frame host).
    pub fn owns(&self, pid: u32) -> bool {
        pid == self.pid || Some(pid) == self.host_pid
    }
    pub fn id(&self) -> String {
        self.bundle_id.clone().unwrap_or_else(|| self.name.clone())
    }
}

/// One top-level window.
#[derive(Debug, Clone)]
pub struct WinInfo {
    pub hwnd: isize,
    /// The app's pid (the hosted app's for frame-host windows).
    pub pid: u32,
    /// The window's own process (the frame host for hosted apps).
    pub owner_pid: u32,
    pub class: String,
    pub title: String,
    pub rect: Rect,
    pub ex_style: u32,
    pub iconic: bool,
    pub alpha: f64,
}

impl WinInfo {
    pub fn is_tool(&self) -> bool {
        self.ex_style & WS_EX_TOOLWINDOW.0 != 0
    }
    pub fn is_topmost(&self) -> bool {
        self.ex_style & WS_EX_TOPMOST.0 != 0
    }
    /// The mac window layer: 0 for normal windows, 1 for floating (topmost, tool, no-activate)
    /// windows and shell surfaces.
    pub fn layer(&self) -> i32 {
        let shell = matches!(self.class.as_str(), "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" | "Progman" | "WorkerW");
        if shell || self.is_topmost() || self.is_tool() || self.ex_style & WS_EX_NOACTIVATE.0 != 0 {
            1
        } else {
            0
        }
    }
    pub fn window_ref(&self) -> WindowRef {
        WindowRef { id: self.hwnd, pid: self.pid, layer: self.layer(), bounds: self.rect, alpha: self.alpha }
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn window_title(h: HWND) -> String {
    let len = unsafe { GetWindowTextLengthW(h) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; len as usize + 1];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn window_pid(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

fn is_cloaked(h: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok() && cloaked != 0 }
}

/// Visible bounds (DWM extended frame bounds: no invisible resize borders), physical pixels.
pub fn window_rect(h: HWND) -> Rect {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut c_void, std::mem::size_of::<RECT>() as u32)
            .is_ok()
    };
    if !ok {
        unsafe {
            let _ = GetWindowRect(h, &mut r);
        }
    }
    rect_of(r)
}

pub fn rect_of(r: RECT) -> Rect {
    Rect::new(r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64)
}

unsafe extern "system" fn collect_hwnd(h: HWND, lparam: LPARAM) -> BOOL {
    let v = &mut *(lparam.0 as *mut Vec<isize>);
    v.push(h.0 as isize);
    BOOL(1)
}

/// The hosted app's pid for an `ApplicationFrameWindow`, if its CoreWindow is attached.
fn hosted_pid(h: HWND, frame_pid: u32) -> Option<u32> {
    let mut kids: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(Some(h), Some(collect_hwnd), LPARAM(&mut kids as *mut Vec<isize> as isize));
    }
    kids.into_iter().map(hwnd).find(|k| class_name(*k) == "Windows.UI.Core.CoreWindow").map(window_pid).filter(|p| *p != frame_pid)
}

/// A top-level CoreWindow: (z-order index, title, pid).
type Core = (usize, String, u32);

fn all_top_level() -> Vec<isize> {
    let mut all: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect_hwnd), LPARAM(&mut all as *mut Vec<isize> as isize));
    }
    all
}

fn core_windows(all: &[isize]) -> Vec<Core> {
    all.iter()
        .enumerate()
        .filter(|(_, h)| class_name(hwnd(**h)) == "Windows.UI.Core.CoreWindow")
        .map(|(i, h)| (i, window_title(hwnd(*h)), window_pid(hwnd(*h))))
        .collect()
}

/// The hosted app of a frame: its child CoreWindow, else (current Windows 11) the cloaked
/// top-level CoreWindow with the frame's title nearest to it in z-order (it sits just in front).
pub fn frame_app_pid(h: HWND, frame_pid: u32, title: &str, index: usize, cores: &[Core]) -> Option<u32> {
    hosted_pid(h, frame_pid).or_else(|| {
        cores
            .iter()
            .filter(|(_, t, p)| t == title && *p != frame_pid && !title.is_empty())
            .min_by_key(|(i, _, _)| if *i < index { (index - i) * 2 } else { (i - index) * 2 + 1 })
            .map(|(_, _, p)| *p)
    })
}

fn info_for(h: HWND) -> WinInfo {
    let all = all_top_level();
    let index = all.iter().position(|x| *x == h.0 as isize).unwrap_or(0);
    info_with(h, index, &core_windows(&all))
}

fn info_with(h: HWND, index: usize, cores: &[Core]) -> WinInfo {
    let owner_pid = window_pid(h);
    let class = class_name(h);
    let pid = if class == "ApplicationFrameWindow" {
        frame_app_pid(h, owner_pid, &window_title(h), index, cores).unwrap_or(owner_pid)
    } else {
        owner_pid
    };
    let ex_style = unsafe { GetWindowLongW(h, GWL_EXSTYLE) } as u32;
    let mut alpha = 1.0;
    if ex_style & WS_EX_LAYERED.0 != 0 {
        let mut a: u8 = 255;
        let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS(0);
        if unsafe { GetLayeredWindowAttributes(h, None, Some(&mut a), Some(&mut flags)) }.is_ok() && flags.0 & LWA_ALPHA.0 != 0 {
            alpha = a as f64 / 255.0;
        }
    }
    WinInfo {
        hwnd: h.0 as isize,
        pid,
        owner_pid,
        class,
        title: window_title(h),
        rect: window_rect(h),
        ex_style,
        iconic: unsafe { IsIconic(h).as_bool() },
        alpha,
    }
}

/// Visible, uncloaked top-level windows, front to back.
pub fn top_windows() -> Vec<WinInfo> {
    let all = all_top_level();
    let cores = core_windows(&all);
    all.iter()
        .enumerate()
        .map(|(i, h)| (i, hwnd(*h)))
        .filter(|(_, h)| unsafe { IsWindowVisible(*h).as_bool() } && !is_cloaked(*h))
        .map(|(i, h)| info_with(h, i, &cores))
        .collect()
}

/// Window info for one top-level window.
pub fn window_info(h: isize) -> Option<WinInfo> {
    let w = hwnd(h);
    if !unsafe { IsWindow(Some(w)).as_bool() } {
        return None;
    }
    Some(info_for(w))
}

/// Windows that belong to `app`, front to back (minimized ones included, like `AXWindows`).
pub fn app_windows(app: &TargetApp) -> Vec<WinInfo> {
    top_windows().into_iter().filter(|w| w.pid == app.pid && (!w.title.is_empty() || !w.is_tool())).collect()
}

pub fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut size = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..size as usize]))
    }
}

/// `FileDescription` from the executable's version resource ("Notepad", "Calculator").
fn file_description(path: &str) -> Option<String> {
    unsafe {
        let wpath = wide(path);
        let mut handle = 0u32;
        let size = GetFileVersionInfoSizeW(PCWSTR(wpath.as_ptr()), Some(&mut handle));
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wpath.as_ptr()), None, size, data.as_mut_ptr() as *mut c_void).ok()?;
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let mut len = 0u32;
        let q = wide("\\VarFileInfo\\Translation");
        let mut candidates: Vec<String> = Vec::new();
        if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(q.as_ptr()), &mut ptr, &mut len).as_bool() && len >= 4 {
            let pairs = std::slice::from_raw_parts(ptr as *const u16, (len / 2) as usize);
            for c in pairs.chunks(2) {
                if c.len() == 2 {
                    candidates.push(format!("{:04x}{:04x}", c[0], c[1]));
                }
            }
        }
        candidates.extend(["040904b0".to_string(), "040904e4".to_string(), "000004b0".to_string()]);
        for lang in candidates {
            let q = wide(&format!("\\StringFileInfo\\{lang}\\FileDescription"));
            let mut p: *mut c_void = std::ptr::null_mut();
            let mut l = 0u32;
            if VerQueryValueW(data.as_ptr() as *const c_void, PCWSTR(q.as_ptr()), &mut p, &mut l).as_bool() && l > 1 {
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(p as *const u16, l as usize - 1));
                let s = s.trim_end_matches('\0').trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
        None
    }
}

/// Electron apps ship their code next to the executable in `resources\app.asar` (or `app\`).
fn is_electron(path: &str) -> bool {
    let dir = match Path::new(path).parent() {
        Some(d) => d,
        None => return false,
    };
    let res = dir.join("resources");
    res.join("app.asar").exists() || res.join("app").join("package.json").exists() || res.join("electron.asar").exists()
}

fn app_cache() -> &'static Mutex<HashMap<String, (String, bool)>> {
    static C: OnceLock<Mutex<HashMap<String, (String, bool)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The app for a pid (`None` when the process is gone or inaccessible).
pub fn app_for_pid(pid: u32, host_pid: Option<u32>) -> Option<TargetApp> {
    let path = exe_path(pid);
    let bundle_id = path.as_deref().and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().to_lowercase());
    if path.is_none() && !process_exists(pid) {
        return None;
    }
    let (name, electron) = match &path {
        Some(p) => {
            let mut cache = app_cache().lock().unwrap();
            cache
                .entry(p.clone())
                .or_insert_with(|| {
                    let stem = Path::new(p).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "app".into());
                    (file_description(p).unwrap_or(stem), is_electron(p))
                })
                .clone()
        }
        None => (format!("pid {pid}"), false),
    };
    Some(TargetApp { pid, host_pid: host_pid.filter(|h| *h != pid), bundle_id, name, electron, exe_path: path })
}

pub fn process_exists(pid: u32) -> bool {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let _ = CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    }
}

/// The app that owns a top-level window.
pub fn app_for_window(w: &WinInfo) -> Option<TargetApp> {
    app_for_pid(w.pid, (w.owner_pid != w.pid).then_some(w.owner_pid))
}

/// The foreground window, if any.
pub fn foreground_window() -> Option<WinInfo> {
    let h = unsafe { GetForegroundWindow() };
    if h.0.is_null() {
        return None;
    }
    Some(info_for(h))
}

pub fn own_pid() -> u32 {
    unsafe { GetCurrentProcessId() }
}

/// Running apps (processes with visible windows), with their windows' frame-host pids.
pub fn windowed_apps() -> Vec<TargetApp> {
    let mut seen: HashMap<u32, Option<u32>> = HashMap::new();
    let mut order = Vec::new();
    for w in top_windows() {
        if !seen.contains_key(&w.pid) {
            order.push(w.pid);
        }
        let host = (w.owner_pid != w.pid).then_some(w.owner_pid);
        let e = seen.entry(w.pid).or_insert(None);
        if e.is_none() {
            *e = host;
        }
    }
    order.into_iter().filter_map(|pid| app_for_pid(pid, seen[&pid])).collect()
}

/// `app` may be an executable name (`notepad.exe`, or `notepad`), an app name or a pid; `None`
/// means the foreground app.
pub fn find_app(query: Option<&str>, pid: Option<i64>) -> CapResult<TargetApp> {
    if let Some(p) = pid {
        let p = u32::try_from(p).map_err(|_| CapError::invalid_params("pid is invalid", Some("pid")))?;
        let host = top_windows().into_iter().find(|w| w.pid == p && w.owner_pid != p).map(|w| w.owner_pid);
        return app_for_pid(p, host)
            .ok_or_else(|| CapError::new(code::NOT_FOUND, "app_not_running", format!("No running app with pid {p}")));
    }
    let q = query.map(str::trim).unwrap_or("");
    if q.is_empty() {
        let fg = foreground_window().ok_or_else(|| CapError::new(code::NOT_FOUND, "no_frontmost_app", "No app is in the foreground"))?;
        return app_for_window(&fg).ok_or_else(|| CapError::new(code::NOT_FOUND, "no_frontmost_app", "No app is in the foreground"));
    }
    let ql = q.to_lowercase();
    let apps = windowed_apps();
    let with_exe = if ql.ends_with(".exe") { ql.clone() } else { format!("{ql}.exe") };
    if let Some(a) = apps.iter().find(|a| a.bundle_id.as_deref() == Some(ql.as_str())) {
        return Ok(a.clone());
    }
    if let Some(a) = apps.iter().find(|a| a.bundle_id.as_deref() == Some(with_exe.as_str())) {
        return Ok(a.clone());
    }
    if let Some(a) = apps.iter().find(|a| a.name.to_lowercase() == ql) {
        return Ok(a.clone());
    }
    Err(CapError::new(code::NOT_FOUND, "app_not_running", format!("{q} is not running. Open it with apps.open first.")).detail("app", q))
}

/// Whether the foreground window belongs to `app`.
pub fn is_frontmost(app: &TargetApp) -> bool {
    foreground_window().map(|w| w.pid == app.pid).unwrap_or(false)
}

/// Whether `window` (or a window it owns, such as its dialog) is the foreground window.
pub fn is_front_window(window: isize) -> bool {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return false;
        }
        fg.0 as isize == window || GetAncestor(fg, GA_ROOTOWNER).0 as isize == window
    }
}

/// Brings `app` forward and verifies it really is in the foreground: injected input goes to
/// whatever window is, so acting without this check would type into a terminal or a password
/// prompt. `prefer` (the snapshot's window) must itself be in front when given: another window
/// of the same app (another document) is not the target.
pub fn activate(app: &TargetApp, prefer: Option<isize>, stop: &StopSignal) -> CapResult<()> {
    let preferred = prefer.and_then(window_info).filter(|w| w.pid == app.pid);
    let in_front = || match &preferred {
        Some(w) => is_front_window(w.hwnd),
        None => is_frontmost(app),
    };
    if in_front() {
        return Ok(());
    }
    let target = preferred
        .clone()
        .or_else(|| app_windows(app).into_iter().find(|w| w.layer() == 0 || !w.is_tool()))
        .ok_or_else(|| CapError::new(code::NOT_FOUND, "no_window", format!("{} has no open window", app.name)))?;
    let h = hwnd(target.hwnd);
    unsafe {
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let _ = SetForegroundWindow(h);
    }
    for i in 0..30 {
        if in_front() {
            return Ok(());
        }
        match i {
            // The foreground lock refuses a process that did not get the last input event:
            // send a no-op key of our own first, then switch while attached to the foreground
            // thread (the documented workaround).
            1 | 10 => unsafe {
                crate::win::input::nudge();
                let fg = GetForegroundWindow();
                let fg_thread = GetWindowThreadProcessId(fg, None);
                let me = GetCurrentThreadId();
                let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
                let _ = BringWindowToTop(h);
                let _ = SetForegroundWindow(h);
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetActiveWindow(h);
                if attached {
                    let _ = AttachThreadInput(me, fg_thread, false);
                }
            },
            // UI Automation's SetFocus switches windows with UIA's own rights.
            4 | 14 => {
                let hw = target.hwnd;
                let _ = crate::win::com::pool().run(std::time::Duration::from_secs(3), move || {
                    let u = crate::win::uia::uia()?;
                    unsafe {
                        if let Ok(e) = u.auto.ElementFromHandle(hwnd(hw)) {
                            let _ = e.SetFocus();
                        }
                    }
                    Ok(())
                });
            }
            7 | 20 => unsafe {
                crate::win::input::nudge();
                SwitchToThisWindow(h, true);
            },
            _ => {}
        }
        crate::win::input::pause(20, stop)?;
    }
    if in_front() {
        return Ok(());
    }
    Err(CapError::new(code::CONFLICT, "not_frontmost", format!("{} could not be brought to the front; input was not sent", app.name))
        .retryable())
}

/// The window and process that keyboard input would reach right now.
pub fn keyboard_focus_pid() -> Option<u32> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None;
        }
        let thread = GetWindowThreadProcessId(fg, None);
        let mut gui = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        if GetGUIThreadInfo(thread, &mut gui).is_ok() && !gui.hwndFocus.0.is_null() {
            return Some(window_pid(gui.hwndFocus));
        }
        Some(info_for(fg).pid)
    }
}

/// The top-level window under a screen point and its app pid.
pub fn window_at(x: f64, y: f64) -> Option<WinInfo> {
    unsafe {
        let h = WindowFromPoint(POINT { x: x.round() as i32, y: y.round() as i32 });
        if h.0.is_null() {
            return None;
        }
        let root = GetAncestor(h, GA_ROOT);
        Some(info_for(if root.0.is_null() { h } else { root }))
    }
}

// MARK: - UIPI

/// Mandatory integrity level RID of a process (`0x2000` medium, `0x3000` high, `0x4000` system).
pub fn integrity_level(pid: u32) -> Option<u32> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut token = HANDLE::default();
        let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
        let _ = CloseHandle(process);
        opened.ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u8; len.max(64) as usize];
        let r = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut c_void), buf.len() as u32, &mut len);
        let _ = CloseHandle(token);
        r.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, count as u32 - 1))
    }
}

/// UIPI: input and UI Automation from this process cannot reach a process running at a higher
/// integrity level (an app run as administrator). `SendInput` fails silently there, so refuse up
/// front: `forbidden/target_elevated`. An unreadable level counts as higher (fail closed).
pub fn check_uipi(app: &TargetApp) -> CapResult<()> {
    let mine = integrity_level(own_pid()).unwrap_or(0x2000);
    for pid in std::iter::once(app.pid).chain(app.host_pid) {
        let theirs = integrity_level(pid);
        if theirs.map(|t| t > mine).unwrap_or(true) {
            return Err(CapError::new(
                code::FORBIDDEN,
                "target_elevated",
                format!("{} runs with higher privileges (as administrator); Windows does not let Psyche read or control it", app.name),
            )
            .detail("app", app.id()));
        }
    }
    Ok(())
}

/// True while the input desktop is not the user's (UAC secure desktop, lock screen, Ctrl+Alt+Del).
pub fn secure_desktop_active() -> bool {
    unsafe {
        let Ok(desk) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return true };
        let mut buf = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut c_void),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        )
        .is_ok();
        let _ = CloseDesktop(desk);
        if !ok {
            return true;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        !String::from_utf16_lossy(&buf[..end]).eq_ignore_ascii_case("Default")
    }
}

/// `unavailable/secure_desktop` while a UAC prompt or the lock screen has the input desktop.
pub fn check_desktop() -> CapResult<()> {
    if secure_desktop_active() {
        return Err(CapError::unavailable(
            "secure_desktop",
            "A secure desktop (UAC prompt or lock screen) is active; Psyche never acts there",
        )
        .retryable());
    }
    Ok(())
}

/// The virtual desktop in physical pixels.
pub fn virtual_desktop() -> Rect {
    unsafe {
        Rect::new(
            GetSystemMetrics(SM_XVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_YVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_CXVIRTUALSCREEN) as f64,
            GetSystemMetrics(SM_CYVIRTUALSCREEN) as f64,
        )
    }
}
