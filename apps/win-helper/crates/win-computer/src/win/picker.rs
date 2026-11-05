//! `computer.screenshot_pick`: the system capture picker (`GraphicsCapturePicker`, the
//! counterpart of the Mac's `SCContentSharingPicker`). The user picks a window or a display; one
//! frame is captured. The picker needs an owner window and a message loop, so it runs on its own
//! STA thread with a hidden tool window.
//!
//! Psyche's windows are refused like the Mac's `excludedBundleIDs`: the picker cannot hide them,
//! so a picked window whose title matches a Psyche window (by window enumeration) is refused.

use super::capture::{capture_item, Frame};
use crate::error::{code, CapError, CapResult};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows::core::{Interface, PCWSTR};
use windows::Graphics::Capture::GraphicsCapturePicker;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::IInitializeWithWindow;
use windows::Win32::UI::WindowsAndMessaging::*;
use windows_future::AsyncStatus;

static BUSY: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn wndproc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    DefWindowProcW(h, m, w, l)
}

fn owner_window() -> CapResult<HWND> {
    unsafe {
        let module = GetModuleHandleW(None).map_err(|_| CapError::unavailable("picker_failed", "The capture picker failed"))?;
        let class: Vec<u16> = "PsycheCapturePickerOwner".encode_utf16().chain([0]).collect();
        let wc =
            WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: module.into(), lpszClassName: PCWSTR(class.as_ptr()), ..Default::default() };
        RegisterClassW(&wc); // fails harmlessly when already registered
        CreateWindowExW(
            WS_EX_TOOLWINDOW,
            PCWSTR(class.as_ptr()),
            PCWSTR(class.as_ptr()),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(module.into()),
            None,
        )
        .map_err(|_| CapError::unavailable("picker_failed", "The capture picker failed"))
    }
}

/// Shows the picker and captures what the user picked: (frame, picked item's display name).
pub fn pick(timeout: Duration) -> CapResult<(Frame, String)> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err(CapError::new(code::CONFLICT, "picker_busy", "The capture picker is already open"));
    }
    let r = std::thread::spawn(move || run(timeout)).join().unwrap_or_else(|_| Err(CapError::internal("The capture picker failed")));
    BUSY.store(false, Ordering::SeqCst);
    r
}

fn run(timeout: Duration) -> CapResult<(Frame, String)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    super::com::ensure_dpi_awareness();
    let owner = owner_window()?;
    // The picker is modal to a visible, foreground owner (it cancels itself otherwise).
    unsafe {
        let _ = ShowWindow(owner, SW_SHOWNORMAL);
        crate::win::input::nudge();
        let _ = SetForegroundWindow(owner);
    }
    let failed = |_| CapError::unavailable("picker_failed", "The capture picker failed");
    let result = (|| {
        let picker = GraphicsCapturePicker::new().map_err(failed)?;
        unsafe { picker.cast::<IInitializeWithWindow>().map_err(failed)?.Initialize(owner).map_err(failed)? };
        let op = picker.PickSingleItemAsync().map_err(failed)?;
        let deadline = Instant::now() + timeout;
        loop {
            let mut msg = MSG::default();
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            match op.Status() {
                Ok(s) if s == AsyncStatus::Started => {}
                Ok(s) if s == AsyncStatus::Completed => break,
                Ok(s) if s == AsyncStatus::Canceled => {
                    return Err(CapError::new(code::CANCELLED, "user_cancelled", "The user closed the picker"))
                }
                _ => {
                    let hr = op.ErrorCode().map(|h| h.0 as u32).unwrap_or(0);
                    return Err(CapError::unavailable("picker_failed", format!("The capture picker failed (0x{hr:08x})")));
                }
            }
            if Instant::now() > deadline {
                let _ = op.Cancel();
                return Err(CapError::new(code::TIMEOUT, "picker_timeout", "The user did not pick anything"));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        let item = op.GetResults().map_err(|_| CapError::new(code::CANCELLED, "user_cancelled", "The user closed the picker"))?;
        let name = item.DisplayName().map(|s| s.to_string()).unwrap_or_default();
        let psyche = crate::caps::psyche_pids();
        if !name.is_empty() && super::apps::top_windows().iter().any(|w| psyche.contains(&w.pid) && w.title == name) {
            return Err(CapError::new(code::POLICY_DENIED, "app_excluded", "Psyche's own windows are never captured"));
        }
        Ok((capture_item(&item)?, name))
    })();
    unsafe {
        let _ = DestroyWindow(owner);
    }
    result
}
