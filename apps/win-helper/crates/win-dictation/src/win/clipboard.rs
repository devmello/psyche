//! The Win32 clipboard behind [`crate::dictation::clipboard::Clipboard`], owned by the dictation
//! thread's message-only window, and the paste driver (Ctrl+V plus the WM_RENDERFORMAT wait).

use super::{input, wide};
use crate::dictation::clipboard::{CF_ENHMETAFILE, CF_UNICODETEXT, ClipData, Clipboard, PasteDriver};
use std::cell::RefCell;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{GetEnhMetaFileBits, HENHMETAFILE, SetEnhMetaFileBits};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardFormatNameW, GetClipboardOwner, OpenClipboard,
    RegisterClipboardFormatW,
    SetClipboardData,
};
use windows::Win32::Foundation::GlobalFree;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, MWMO_INPUTAVAILABLE, MsgWaitForMultipleObjectsEx, PM_REMOVE, PeekMessageW, QS_ALLINPUT, TranslateMessage,
};
use windows::core::PCWSTR;

thread_local! {
    /// Text the owner window renders on WM_RENDERFORMAT, and whether a target asked for it.
    static RENDER: RefCell<(Option<Vec<u16>>, bool)> = const { RefCell::new((None, false)) };
}

pub(crate) struct Win32Clipboard {
    pub hwnd: HWND,
}

fn global_from(bytes: &[u8]) -> Option<HANDLE> {
    // SAFETY: allocate, copy, unlock; ownership passes to the clipboard on success.
    unsafe {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).ok()?;
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() {
            let _ = GlobalFree(Some(h));
            return None;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        Some(HANDLE(h.0))
    }
}

/// Renders the staged text into the open clipboard (called from the owner window procedure).
pub(crate) fn render_staged() {
    RENDER.with(|r| {
        let mut r = r.borrow_mut();
        let Some(text) = r.0.as_ref() else { return };
        let mut units = text.clone();
        units.push(0);
        let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
        if let Some(h) = global_from(&bytes) {
            // SAFETY: the requester holds the clipboard open while WM_RENDERFORMAT is handled.
            unsafe {
                if SetClipboardData(CF_UNICODETEXT, Some(h)).is_err() {
                    let _ = GlobalFree(Some(HGLOBAL(h.0)));
                }
            }
        }
        r.1 = true;
    });
}

impl Clipboard for Win32Clipboard {
    fn open(&mut self) -> bool {
        for _ in 0..10 {
            // SAFETY: opened by our window, closed in close().
            if unsafe { OpenClipboard(Some(self.hwnd)) }.is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        false
    }

    fn close(&mut self) {
        // SAFETY: balances open().
        unsafe {
            let _ = CloseClipboard();
        }
    }

    fn formats(&mut self) -> Vec<u32> {
        let mut out = vec![];
        let mut f = 0;
        loop {
            // SAFETY: enumeration while the clipboard is open.
            f = unsafe { EnumClipboardFormats(f) };
            if f == 0 {
                break;
            }
            out.push(f);
        }
        out
    }

    fn get(&mut self, format: u32) -> Option<ClipData> {
        // SAFETY: data handles stay owned by the clipboard; only copied here.
        unsafe {
            let h = GetClipboardData(format).ok()?;
            if h.is_invalid() {
                return None;
            }
            if format == CF_ENHMETAFILE {
                let emf = HENHMETAFILE(h.0);
                let n = GetEnhMetaFileBits(emf, None);
                if n == 0 {
                    return None;
                }
                let mut buf = vec![0u8; n as usize];
                GetEnhMetaFileBits(emf, Some(&mut buf));
                return Some(ClipData::EnhMetafile(buf));
            }
            let g = HGLOBAL(h.0);
            let size = GlobalSize(g);
            if size == 0 {
                return None;
            }
            let p = GlobalLock(g) as *const u8;
            if p.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(p, size).to_vec();
            let _ = GlobalUnlock(g);
            Some(ClipData::Memory(bytes))
        }
    }

    fn empty(&mut self) -> bool {
        // SAFETY: while open.
        unsafe { EmptyClipboard() }.is_ok()
    }

    fn set(&mut self, format: u32, data: &ClipData) -> bool {
        // SAFETY: the clipboard takes ownership of the handle on success.
        unsafe {
            match data {
                ClipData::Memory(b) => {
                    let Some(h) = global_from(b) else { return false };
                    if SetClipboardData(format, Some(h)).is_ok() {
                        return true;
                    }
                    let _ = GlobalFree(Some(HGLOBAL(h.0)));
                    false
                }
                ClipData::EnhMetafile(b) => {
                    let emf = SetEnhMetaFileBits(b);
                    !emf.is_invalid() && SetClipboardData(format, Some(HANDLE(emf.0))).is_ok()
                }
            }
        }
    }

    fn set_delayed(&mut self, format: u32) -> bool {
        // SAFETY: a null handle requests delayed rendering.
        unsafe { SetClipboardData(format, None) }.is_ok()
    }

    fn register(&mut self, name: &str) -> u32 {
        let w = wide(name);
        // SAFETY: NUL-terminated name.
        unsafe { RegisterClipboardFormatW(PCWSTR(w.as_ptr())) }
    }

    fn name(&mut self, format: u32) -> Option<String> {
        let mut buf = [0u16; 256];
        // SAFETY: fixed buffer.
        let n = unsafe { GetClipboardFormatNameW(format, &mut buf) };
        (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
    }

    fn owned_by_us(&mut self) -> bool {
        // SAFETY: plain query.
        unsafe { GetClipboardOwner() }.is_ok_and(|h| h == self.hwnd)
    }
}

/// Pumps this thread's messages (sent WM_RENDERFORMAT included) for up to `limit`, until `done`.
pub(crate) fn pump_until(limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    loop {
        // SAFETY: standard message pump on the owning thread.
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if done() {
            return true;
        }
        let left = limit.saturating_sub(start.elapsed());
        if left.is_zero() {
            return false;
        }
        // SAFETY: waits for any message (sent messages are delivered during the wait).
        unsafe { MsgWaitForMultipleObjectsEx(None, left.as_millis().min(50) as u32, QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
    }
}

pub(crate) struct Win32PasteDriver;

impl PasteDriver for Win32PasteDriver {
    fn modifiers_held(&mut self) -> bool {
        !input::wait_for_modifiers_released(Duration::from_millis(500))
    }

    fn stage(&mut self, text: &str) {
        RENDER.with(|r| *r.borrow_mut() = (Some(text.encode_utf16().collect()), false));
    }

    fn send_paste(&mut self) -> bool {
        input::send_ctrl_v()
    }

    fn wait_for_render(&mut self, timeout: Duration) -> bool {
        pump_until(timeout, || RENDER.with(|r| r.borrow().1))
    }

    fn settle(&mut self) {
        pump_until(Duration::from_millis(150), || false);
    }
}

impl Drop for Win32PasteDriver {
    fn drop(&mut self) {
        RENDER.with(|r| *r.borrow_mut() = (None, false));
    }
}
