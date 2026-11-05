//! The Esc stop and the attention monitor: `WH_KEYBOARD_LL` / `WH_MOUSE_LL` hooks on a dedicated
//! message-loop thread (the mac helper's `EscStopTap` and `AttentionMonitor` event taps).
//!
//! - **Esc stop.** A bare Esc key-down that is not the helper's own (`dwExtraInfo` ≠ `MARKER`)
//!   while a computer-use session is active trips the stop signal (every in-flight invocation
//!   fails with `cancelled/user_stopped` within one 20 ms step), ends the session for good and is
//!   *consumed*, with its key-up, so injected content cannot use it to dismiss a dialog. As on the
//!   Mac, other software's synthetic Esc also stops (only the helper's own events are exempt).
//! - **Attention.** The last keyboard or mouse event that is real hardware input
//!   (`LLKHF_INJECTED` / `LLMHF_INJECTED` clear) is the owner's last input, for
//!   pause-when-unwatched. Stricter than the Mac (which exempts only its own events): another
//!   program's synthetic input never counts as the owner being present. Until the hooks run, the
//!   seed is `GetLastInputInfo`, read before the helper injected anything.
//!
//! The hook procedures only touch atomics and one short mutex; slow work (session bookkeeping,
//! the `on_stop` callback) runs on a notifier thread, so Windows never times the hooks out.

use super::input::{tick_ms, INJECTED, MARKER};
use crate::keychord::vk;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::*;

pub type ActiveFn = Box<dyn Fn() -> bool + Send + Sync>;
pub type StopFn = Box<dyn Fn() + Send + Sync>;

struct Shared {
    is_active: ActiveFn,
    /// Called on the hook thread itself: must be quick (trips the stop signal).
    trip: StopFn,
    notify: Mutex<Sender<()>>,
    /// Owner's last real input, ms since the Unix epoch (0: none on record).
    last_input_ms: AtomicU64,
    swallow_esc_up: AtomicBool,
    esc_stops: AtomicU64,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn note_owner_input(s: &Shared) {
    s.last_input_ms.store(now_ms(), Ordering::Relaxed);
}

fn modifier_down() -> bool {
    [vk::CONTROL, vk::MENU, vk::SHIFT, vk::LWIN, vk::RWIN].iter().any(|k| unsafe { GetAsyncKeyState(*k as i32) } as u16 & 0x8000 != 0)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        if let Some(s) = SHARED.get() {
            let k = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
            let ours = injected && k.dwExtraInfo == MARKER;
            if !injected {
                note_owner_input(s);
            }
            if k.vkCode == vk::ESCAPE as u32 && !ours {
                let msg = wparam.0 as u32;
                let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                if down && !modifier_down() && (s.is_active)() {
                    (s.trip)();
                    s.esc_stops.fetch_add(1, Ordering::SeqCst);
                    s.swallow_esc_up.store(true, Ordering::SeqCst);
                    if let Ok(tx) = s.notify.lock() {
                        let _ = tx.send(());
                    }
                    return LRESULT(1); // consumed
                }
                if up && s.swallow_esc_up.swap(false, Ordering::SeqCst) {
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        if let Some(s) = SHARED.get() {
            let m = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            if m.flags & LLMHF_INJECTED == 0 {
                note_owner_input(s);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Installs both hooks once, on their own thread. `is_active`: a session is running; `trip`:
/// stop in-flight invocations (hook thread, quick); `on_stop`: end the session and tell the app
/// (notifier thread). Returns whether the hooks run.
pub fn start(is_active: ActiveFn, trip: StopFn, on_stop: StopFn) -> bool {
    if RUNNING.load(Ordering::SeqCst) {
        return true;
    }
    let (tx, rx) = channel::<()>();
    if SHARED
        .set(Shared {
            is_active,
            trip,
            notify: Mutex::new(tx),
            last_input_ms: AtomicU64::new(seed_last_input()),
            swallow_esc_up: AtomicBool::new(false),
            esc_stops: AtomicU64::new(0),
        })
        .is_err()
    {
        return RUNNING.load(Ordering::SeqCst);
    }
    let _ = std::thread::Builder::new().name("psyche-esc-notify".into()).spawn(move || {
        while rx.recv().is_ok() {
            on_stop();
        }
    });
    let (ready_tx, ready_rx) = channel::<bool>();
    let _ = std::thread::Builder::new().name("psyche-input-hooks".into()).spawn(move || unsafe {
        let module = GetModuleHandleW(None).ok().map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
        let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
        let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
        let ok = kb.is_ok();
        RUNNING.store(ok, Ordering::SeqCst);
        let _ = ready_tx.send(ok);
        if !ok {
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Ok(h) = kb {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Ok(h) = ms {
            let _ = UnhookWindowsHookEx(h);
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
    ready_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or(false)
}

/// Input before the hooks existed: the system's idle time, trusted only while the helper has
/// injected nothing (its own events reset it too).
fn seed_last_input() -> u64 {
    if INJECTED.load(Ordering::SeqCst) {
        return 0;
    }
    let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    if !unsafe { GetLastInputInfo(&mut lii) }.as_bool() {
        return 0;
    }
    let idle = tick_ms().wrapping_sub(lii.dwTime) as u64;
    now_ms().saturating_sub(idle)
}

pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// The owner's last real input, seconds since the Unix epoch.
pub fn last_owner_input() -> Option<f64> {
    let ms = SHARED.get()?.last_input_ms.load(Ordering::Relaxed);
    (ms > 0).then(|| ms as f64 / 1000.0)
}

/// How many times Esc stopped a session (diagnostics and tests).
pub fn esc_stop_count() -> u64 {
    SHARED.get().map(|s| s.esc_stops.load(Ordering::SeqCst)).unwrap_or(0)
}
