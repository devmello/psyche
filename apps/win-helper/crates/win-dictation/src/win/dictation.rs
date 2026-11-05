//! The dictation thread: UI Automation focus, the UIA write, unicode typing and the clipboard
//! paste, serialized on one MTA thread that owns a message-only window (the clipboard owner and
//! WM_RENDERFORMAT receiver).

use super::clipboard::{Win32Clipboard, Win32PasteDriver, render_staged};
use super::{Com, input, process};
use crate::dictation::clipboard::{CF_UNICODETEXT, paste_with_restore};
use crate::dictation::policy::{ElementInfo, Focus, InsertBackend, PasteOutcome, UIA_MAX_VALUE_UNITS};
use crate::error::CapError;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardOwner, OpenClipboard};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTextRange, IUIAutomationValuePattern, TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    UIA_ControlTypePropertyId, UIA_FrameworkIdPropertyId, UIA_IsPasswordPropertyId, UIA_IsTextPatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId, UIA_ProcessIdPropertyId, UIA_TextPatternId, UIA_ValueIsReadOnlyPropertyId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetForegroundWindow, GetWindowThreadProcessId, HWND_MESSAGE, RegisterClassW, WINDOW_EX_STYLE,
    WM_RENDERALLFORMATS, WM_RENDERFORMAT, WNDCLASSW, WS_OVERLAPPED,
};
use windows::Win32::System::Variant::VARIANT;
use windows::core::{BSTR, Interface, w};

type Job = Box<dyn FnOnce(&Backend) + Send>;

static WORKER: OnceLock<Mutex<Sender<Job>>> = OnceLock::new();

/// Runs `f` on the dictation thread and waits for it.
pub(crate) fn run<T: Send + 'static>(f: impl FnOnce(&Backend) -> T + Send + 'static) -> Result<T, CapError> {
    let tx = WORKER.get_or_init(|| Mutex::new(spawn())).lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (rtx, rrx) = channel();
    tx.send(Box::new(move |b: &Backend| {
        let _ = rtx.send(f(b));
    }))
    .map_err(|_| CapError::internal("the dictation thread is gone"))?;
    rrx.recv().map_err(|_| CapError::internal("the dictation thread failed"))
}

fn spawn() -> Sender<Job> {
    let (tx, rx) = channel::<Job>();
    std::thread::Builder::new()
        .name("psyche-dictation".into())
        .spawn(move || {
            let _com = Com::init();
            let backend = Backend::new();
            for job in rx {
                job(&backend);
            }
        })
        .expect("spawn the dictation thread");
    tx
}

unsafe extern "system" fn owner_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_RENDERFORMAT if wparam.0 as u32 == CF_UNICODETEXT => {
            render_staged();
            LRESULT(0)
        }
        WM_RENDERALLFORMATS => {
            // The window is going away while still owning delayed text: render it for good.
            // SAFETY: open/close around the render, only while we still own the clipboard.
            unsafe {
                if OpenClipboard(Some(hwnd)).is_ok() {
                    if GetClipboardOwner().is_ok_and(|h| h == hwnd) {
                        render_staged();
                    }
                    let _ = CloseClipboard();
                }
            }
            LRESULT(0)
        }
        // SAFETY: default handling.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn owner_window() -> HWND {
    // SAFETY: registers the class (idempotent) and creates a message-only window on this thread.
    unsafe {
        let instance = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSW { lpfnWndProc: Some(owner_proc), hInstance: instance.into(), lpszClassName: w!("PsycheDictationOwner"), ..Default::default() };
        RegisterClassW(&class);
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("PsycheDictationOwner"),
            w!("Psyche dictation"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance.into()),
            None,
        )
        .unwrap_or_default()
    }
}

/// The live `InsertBackend` (only ever used on the dictation thread).
pub(crate) struct Backend {
    uia: Option<IUIAutomation>,
    cache: Option<IUIAutomationCacheRequest>,
    hwnd: HWND,
}

impl Backend {
    fn new() -> Self {
        // SAFETY: COM is initialized on this thread.
        let uia: Option<IUIAutomation> = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.ok();
        if let Some(u2) = uia.as_ref().and_then(|u| u.cast::<IUIAutomation2>().ok()) {
            // A hung target must not stall dictation (the mac's 0.25 s AX messaging timeout).
            // SAFETY: plain setters.
            unsafe {
                let _ = u2.SetConnectionTimeout(500);
                let _ = u2.SetTransactionTimeout(1000);
            }
        }
        let cache = uia.as_ref().and_then(|u| cache_request(u).ok());
        Backend { uia, cache, hwnd: owner_window() }
    }

    /// Where keyboard input goes now (the `focus()` the capabilities call).
    pub fn focus_now(&self) -> Option<Focus> {
        InsertBackend::focus(self)
    }

    /// Test support: the clipboard as `save` captures it.
    pub fn clipboard_snapshot(&self) -> Option<Vec<(u32, Vec<u8>)>> {
        let mut cb = Win32Clipboard { hwnd: self.hwnd };
        let snap = crate::dictation::clipboard::save(&mut cb).ok()?;
        Some(
            snap.items
                .into_iter()
                .map(|(f, d)| match d {
                    crate::dictation::clipboard::ClipData::Memory(b) | crate::dictation::clipboard::ClipData::EnhMetafile(b) => (f, b),
                })
                .collect(),
        )
    }

    fn focused(&self) -> Option<IUIAutomationElement> {
        // SAFETY: UIA client call on this MTA thread.
        unsafe { self.uia.as_ref()?.GetFocusedElement().ok() }
    }
}

fn cache_request(u: &IUIAutomation) -> windows::core::Result<IUIAutomationCacheRequest> {
    // SAFETY: building a cache request.
    unsafe {
        let r = u.CreateCacheRequest()?;
        for p in [
            UIA_ProcessIdPropertyId,
            UIA_ControlTypePropertyId,
            UIA_IsPasswordPropertyId,
            UIA_FrameworkIdPropertyId,
            UIA_IsValuePatternAvailablePropertyId,
            UIA_ValueIsReadOnlyPropertyId,
            UIA_IsTextPatternAvailablePropertyId,
        ] {
            r.AddProperty(p)?;
        }
        Ok(r)
    }
}

fn cached_bool(el: &IUIAutomationElement, prop: windows::Win32::UI::Accessibility::UIA_PROPERTY_ID) -> bool {
    // SAFETY: reading a cached property.
    unsafe { el.GetCachedPropertyValue(prop) }.ok().and_then(|v: VARIANT| bool::try_from(&v).ok()).unwrap_or(false)
}

fn foreground_pid() -> Option<u32> {
    // SAFETY: plain window queries.
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(fg, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

fn utf16(b: &BSTR) -> Vec<u16> {
    b.to_vec()
}

impl InsertBackend for Backend {
    fn focus(&self) -> Option<Focus> {
        // No foreground window: the lock screen, a secure desktop, or nothing at all.
        let fg_pid = foreground_pid()?;
        let el = match (&self.uia, &self.cache) {
            // SAFETY: UIA client call on this MTA thread.
            (Some(u), Some(c)) => unsafe { u.GetFocusedElementBuildCache(c) }.ok(),
            _ => None,
        };
        let Some(el) = el else {
            // No UIA focus (an app without a UIA tree): the foreground app gets the keystrokes.
            let p = process::info(fg_pid);
            return Some(Focus { elevated: p.elevated, ..Focus::app(fg_pid, p.bundle_id.as_deref(), &p.app_name) });
        };
        // SAFETY: cached property reads.
        let (pid, control_type, secure, framework) = unsafe {
            (
                el.CachedProcessId().unwrap_or(fg_pid as i32) as u32,
                el.CachedControlType().map(|c| c.0).unwrap_or(0),
                el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false),
                el.CachedFrameworkId().map(|s| s.to_string()).unwrap_or_default(),
            )
        };
        let value = cached_bool(&el, UIA_IsValuePatternAvailablePropertyId);
        let read_only = cached_bool(&el, UIA_ValueIsReadOnlyPropertyId);
        let info = ElementInfo {
            control_type,
            framework_id: framework,
            value_settable: value && !read_only,
            has_text_pattern: cached_bool(&el, UIA_IsTextPatternAvailablePropertyId),
        };
        let p = process::info(pid);
        Some(Focus {
            pid,
            bundle_id: p.bundle_id,
            app_name: p.app_name,
            role: info.role().map(str::to_string),
            secure,
            element: Some(info),
            elevated: p.elevated,
        })
    }

    fn uia_replace_selection(&self, text: &str) -> bool {
        // Any UIA failure (a pattern the control lacks, a timeout) means "type it instead".
        self.uia_write(text).unwrap_or(false)
    }

    fn type_text(&self, text: &str, guard: &mut dyn FnMut() -> Result<(), CapError>) -> Result<(), CapError> {
        input::type_text(text, guard)
    }

    fn paste(&self, text: &str, guard: &mut dyn FnMut() -> Result<(), CapError>) -> Result<PasteOutcome, CapError> {
        let mut cb = Win32Clipboard { hwnd: self.hwnd };
        let mut driver = Win32PasteDriver;
        paste_with_restore(&mut cb, &mut driver, text, guard)
    }
}

impl Backend {
    /// ValuePattern write with the selection replaced, then the caret placed after the text with
    /// TextPattern. Refuses (Ok(false)) unless the value and the document text agree, so offsets
    /// are exact; Ok(false) too when the control ignored the write.
    fn uia_write(&self, text: &str) -> windows::core::Result<bool> {
        let Some(el) = self.focused() else { return Ok(false) };
        // SAFETY: UIA client calls on this MTA thread.
        unsafe {
            let vp: IUIAutomationValuePattern = el.GetCurrentPatternAs(UIA_ValuePatternId)?;
            if vp.CurrentIsReadOnly()?.as_bool() || el.CurrentIsPassword()?.as_bool() {
                return Ok(false);
            }
            let tp: IUIAutomationTextPattern = el.GetCurrentPatternAs(UIA_TextPatternId)?;
            let value = utf16(&vp.CurrentValue()?);
            if value.len() > UIA_MAX_VALUE_UNITS {
                return Ok(false);
            }
            let doc = tp.DocumentRange()?;
            if utf16(&doc.GetText(-1)?) != value {
                return Ok(false);
            }
            let sels = tp.GetSelection()?;
            if sels.Length()? != 1 {
                return Ok(false);
            }
            let sel = sels.GetElement(0)?;
            let start = prefix_len(&doc, &sel)?;
            let sel_len = utf16(&sel.GetText(-1)?).len();
            if start + sel_len > value.len() {
                return Ok(false);
            }
            let ins: Vec<u16> = text.encode_utf16().collect();
            let mut updated = value[..start].to_vec();
            updated.extend_from_slice(&ins);
            updated.extend_from_slice(&value[start + sel_len..]);
            vp.SetValue(&BSTR::from_wide(&updated))?;
            let after = utf16(&vp.CurrentValue()?);
            if after == value {
                return Ok(false);
            }
            place_caret(&tp, start + ins.len(), &updated);
            Ok(true)
        }
    }
}

/// UTF-16 length of the document text before `at`'s start.
unsafe fn prefix_len(doc: &IUIAutomationTextRange, at: &IUIAutomationTextRange) -> windows::core::Result<usize> {
    // SAFETY: range arithmetic on live UIA ranges.
    unsafe {
        let prefix = doc.Clone()?;
        prefix.MoveEndpointByRange(TextPatternRangeEndpoint_End, at, TextPatternRangeEndpoint_Start)?;
        Ok(prefix.GetText(-1)?.len())
    }
}

/// Selects an empty range at UTF-16 offset `offset` (UIA characters count CRLF as one in some
/// controls, so both counts are tried and checked).
unsafe fn place_caret(tp: &IUIAutomationTextPattern, offset: usize, text: &[u16]) {
    // SAFETY: range arithmetic on live UIA ranges.
    unsafe {
        let Ok(doc) = tp.DocumentRange() else { return };
        let crlfs = text[..offset.min(text.len())].windows(2).filter(|w| w == &[13, 10]).count();
        for n in [offset, offset - crlfs] {
            let Ok(r) = doc.Clone() else { return };
            if r.MoveEndpointByRange(TextPatternRangeEndpoint_End, &doc, TextPatternRangeEndpoint_Start).is_err() {
                return;
            }
            if r.Move(TextUnit_Character, n as i32).is_err() {
                continue;
            }
            if prefix_len(&doc, &r).ok() == Some(offset) {
                let _ = r.Select();
                return;
            }
            if crlfs == 0 {
                return;
            }
        }
    }
}

/// Test support: the UIA focus as `dictation.target` sees it, and the focused element's value.
pub(crate) fn focused_value() -> Option<String> {
    run(|b| {
        let el = b.focused()?;
        // SAFETY: UIA client calls on this MTA thread.
        unsafe {
            if let Ok(vp) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                return vp.CurrentValue().ok().map(|s| s.to_string());
            }
            let tp: IUIAutomationTextPattern = el.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
            tp.DocumentRange().ok()?.GetText(-1).ok().map(|s| s.to_string())
        }
    })
    .ok()
    .flatten()
}
