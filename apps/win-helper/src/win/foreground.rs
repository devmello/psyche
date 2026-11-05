//! Bringing windows to the front despite the foreground lock, and a hidden owner window for
//! system prompts (Windows Hello) so they open in front instead of behind other apps.

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput,
    SetActiveWindow, SetFocus, VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    FindWindowW, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, MSG, PM_REMOVE,
    PeekMessageW, RegisterClassW, SM_CXSCREEN, SM_CYSCREEN, SW_RESTORE, SW_SHOW,
    SetForegroundWindow, ShowWindow, TranslateMessage, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP,
};
use windows::core::{HSTRING, w};

use super::process::is_minimized;

fn thread_of(hwnd: HWND) -> u32 {
    // SAFETY: plain query.
    unsafe { GetWindowThreadProcessId(hwnd, None) }
}

fn tap_alt() {
    // A synthesized key press makes this process the last input source, which the foreground
    // lock honours (the documented reason SetForegroundWindow then succeeds).
    let key = |flags: KEYBD_EVENT_FLAGS| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU,
                wScan: 0,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let inputs = [key(KEYBD_EVENT_FLAGS(0)), key(KEYEVENTF_KEYUP)];
    // SAFETY: two well-formed keyboard inputs.
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Restores and raises `hwnd`, attaching to the foreground thread's input queue so the
/// foreground lock lets it through. Returns whether it is the foreground window afterwards.
pub fn force_foreground(hwnd: HWND) -> bool {
    // SAFETY: plain window-manager calls on a window handle; threads are detached on every path.
    unsafe {
        if is_minimized(hwnd) {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let me = GetCurrentThreadId();
        let fg = GetForegroundWindow();
        let fg_thread = if fg.is_invalid() { 0 } else { thread_of(fg) };
        let target_thread = thread_of(hwnd);
        let attach_fg =
            fg_thread != 0 && fg_thread != me && AttachThreadInput(me, fg_thread, true).as_bool();
        let attach_target = target_thread != 0
            && target_thread != me
            && AttachThreadInput(me, target_thread, true).as_bool();
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = BringWindowToTop(hwnd);
        let mut ok = SetForegroundWindow(hwnd).as_bool();
        if !ok {
            tap_alt();
            ok = SetForegroundWindow(hwnd).as_bool();
        }
        let _ = SetActiveWindow(hwnd);
        let _ = SetFocus(Some(hwnd));
        if attach_target {
            let _ = AttachThreadInput(me, target_thread, false);
        }
        if attach_fg {
            let _ = AttachThreadInput(me, fg_thread, false);
        }
        ok && GetForegroundWindow() == hwnd
    }
}

unsafe extern "system" fn owner_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: default handling for every message.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// A 1×1 topmost tool window at the screen centre, foreground, so a system prompt the helper
/// starts while it exists opens in front. Destroyed on drop; must stay on its creating thread.
pub struct OwnerWindow {
    pub hwnd: HWND,
}

impl OwnerWindow {
    pub fn create() -> Option<OwnerWindow> {
        // SAFETY: class registration is idempotent (a second registration fails harmlessly) and
        // the window is destroyed in Drop on this thread.
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            let class = w!("PsycheHelperOwner");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(owner_proc),
                hInstance: instance.into(),
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassW(&wc);
            let (cx, cy) = (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
            let hwnd = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                class,
                &HSTRING::from("Psyche"),
                WS_POPUP,
                cx / 2,
                cy / 2,
                1,
                1,
                None,
                None,
                Some(instance.into()),
                None,
            )
            .ok()?;
            let _ = ShowWindow(hwnd, SW_SHOW);
            force_foreground(hwnd);
            Some(OwnerWindow { hwnd })
        }
    }
}

impl Drop for OwnerWindow {
    fn drop(&mut self) {
        // SAFETY: the window was created on this thread by `create`.
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

/// Pumps this thread's messages until `done()` or the deadline, raising the Windows Security
/// (Hello) dialog to the front whenever it appears behind another window.
pub fn pump_until(mut done: impl FnMut() -> bool, deadline: Duration) {
    let start = Instant::now();
    let mut raised = false;
    while !done() && start.elapsed() < deadline {
        // SAFETY: standard message pump for windows owned by this thread.
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if !raised
                && let Ok(dialog) = FindWindowW(w!("Credential Dialog Xaml Host"), None)
                && !dialog.is_invalid()
            {
                raised = GetForegroundWindow() == dialog || force_foreground(dialog);
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}
