//! The live teach input source (mac `TeachRecorder` + `LiveTeachAX`): listen-only
//! `WH_MOUSE_LL` / `WH_KEYBOARD_LL` hooks on their own message-loop thread, for the owner's real
//! clicks and key presses. Injected input (`LLMHF_INJECTED` / `LLKHF_INJECTED`) is ignored, so
//! neither the helper's own computer use or dictation nor any other program's synthetic input
//! can write steps (stricter than the Mac, which exempts only its own events).
//!
//! The hook procedures only copy the event into a channel; a worker thread resolves targets
//! through `psyche_win_computer` (the UIA element under a click, the focused element for a key)
//! in input order, so the hooks never stall input. Typing into an elevated app is not readable
//! (UIPI): its target is `None`, and the session keeps no text for it. Input on the secure
//! desktop (UAC, the lock screen) never reaches the hooks.

use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::SystemTime;

use psyche_win_computer::ElementTarget;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetDoubleClickTime, GetKeyState, GetKeyboardLayout, ToUnicodeEx, VK_CAPITAL,
    VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::session::{KeyMods, TeachInput, TeachKey, TeachTarget};
use super::{InputSource, OnInput};

enum Raw {
    Click {
        button: u8,
        x: i32,
        y: i32,
        time_ms: u32,
        at: SystemTime,
    },
    Key {
        vk: u16,
        scan: u32,
        extended: bool,
        mods: KeyMods,
        caps: bool,
        at: SystemTime,
    },
}

/// The running recorder's channel (one teach session at a time).
static SINK: Mutex<Option<Sender<Raw>>> = Mutex::new(None);
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);

fn send(raw: Raw) {
    if let Ok(g) = SINK.lock()
        && let Some(tx) = g.as_ref()
    {
        let _ = tx.send(raw);
    }
}

fn down(vk: u16) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) } as u16) & 0x8000 != 0
}

/// Modifier keys (and lock keys) produce no keyDown on the Mac either.
fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10..=0x12 | 0x14 | 0x5B | 0x5C | 0x90 | 0x91 | 0xA0..=0xA5)
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let m = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let msg = wparam.0 as u32;
        if m.flags & LLMHF_INJECTED == 0 && (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN) {
            send(Raw::Click {
                button: u8::from(msg == WM_RBUTTONDOWN),
                x: m.pt.x,
                y: m.pt.y,
                time_ms: m.time,
                at: SystemTime::now(),
            });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let msg = wparam.0 as u32;
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        if !injected && (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) && !is_modifier(k.vkCode) {
            send(Raw::Key {
                vk: k.vkCode as u16,
                scan: k.scanCode,
                extended: k.flags.0 & LLKHF_EXTENDED.0 != 0,
                mods: KeyMods {
                    ctrl: down(VK_CONTROL.0),
                    alt: down(VK_MENU.0),
                    shift: down(VK_SHIFT.0),
                    win: down(VK_LWIN.0) || down(VK_RWIN.0),
                },
                caps: unsafe { GetKeyState(VK_CAPITAL.0 as i32) } & 1 != 0,
                at: SystemTime::now(),
            });
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The characters a key press types in the foreground window's keyboard layout, without
/// touching the system's dead-key state (`ToUnicodeEx` flag 0x4).
fn characters(vk: u16, scan: u32, mods: KeyMods, caps: bool) -> String {
    let mut state = [0u8; 256];
    if mods.shift {
        state[VK_SHIFT.0 as usize] = 0x80;
        state[VK_LSHIFT.0 as usize] = 0x80;
    }
    if mods.ctrl {
        state[VK_CONTROL.0 as usize] = 0x80;
        state[VK_LCONTROL.0 as usize] = 0x80;
    }
    if mods.alt {
        state[VK_MENU.0 as usize] = 0x80;
        state[VK_LMENU.0 as usize] = 0x80;
    }
    if caps {
        state[VK_CAPITAL.0 as usize] = 0x01;
    }
    let mut buf = [0u16; 8];
    unsafe {
        let fg = GetForegroundWindow();
        let tid = GetWindowThreadProcessId(fg, None);
        let layout = GetKeyboardLayout(tid);
        let n = ToUnicodeEx(vk as u32, scan, &state, &mut buf, 0x4, Some(layout));
        if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            String::new()
        }
    }
}

/// An element lookup as the session's target (the mac `LiveTeachAX.info`).
pub fn target_of(e: &ElementTarget) -> TeachTarget {
    let mut t = TeachTarget::new(
        &e.app,
        &e.app_name,
        e.window.as_deref(),
        e.role.as_deref(),
        e.subrole.as_deref(),
        e.label.as_deref(),
        e.identifier.as_deref(),
    );
    // A password field with focus marks the target secure too (the Mac's Secure Event Input).
    if e.secure {
        t.role = Some("AXSecureTextField".into());
    }
    t
}

struct LastClick {
    button: u8,
    x: i32,
    y: i32,
    time_ms: u32,
    count: u32,
}

/// The system's double-click rule: same button, within the double-click time and rectangle.
fn click_count(last: &Option<LastClick>, button: u8, x: i32, y: i32, time_ms: u32) -> u32 {
    let (dt, cx, cy) = unsafe {
        (
            GetDoubleClickTime(),
            GetSystemMetrics(SM_CXDOUBLECLK) / 2,
            GetSystemMetrics(SM_CYDOUBLECLK) / 2,
        )
    };
    match last {
        Some(l)
            if l.button == button
                && time_ms.wrapping_sub(l.time_ms) <= dt
                && (x - l.x).abs() <= cx
                && (y - l.y).abs() <= cy =>
        {
            l.count + 1
        }
        _ => 1,
    }
}

fn worker(rx: Receiver<Raw>, on_input: OnInput) {
    crate::win::com::ensure_mta();
    let mut last: Option<LastClick> = None;
    while let Ok(raw) = rx.recv() {
        match raw {
            Raw::Click {
                button,
                x,
                y,
                time_ms,
                at,
            } => {
                let count = click_count(&last, button, x, y, time_ms);
                last = Some(LastClick {
                    button,
                    x,
                    y,
                    time_ms,
                    count,
                });
                let target = psyche_win_computer::element_at(x, y).map(|e| target_of(&e));
                on_input(
                    TeachInput::Click {
                        button,
                        click_count: count,
                        target,
                    },
                    at,
                );
            }
            Raw::Key {
                vk,
                scan,
                extended,
                mods,
                caps,
                at,
            } => {
                let key = TeachKey {
                    vk,
                    extended,
                    characters: characters(vk, scan, mods, caps),
                    mods,
                };
                let target = psyche_win_computer::focused_element().map(|e| target_of(&e));
                on_input(TeachInput::Key { key, target }, at);
            }
        }
    }
}

/// The live source: hooks plus the lookup worker. `stop` never waits for either thread (it may
/// run on the worker itself, when a step limit ends the session).
#[derive(Default)]
pub struct LiveTeachInput {
    running: bool,
}

impl InputSource for LiveTeachInput {
    fn start(&mut self, on_input: OnInput) -> bool {
        let (tx, rx) = channel::<Raw>();
        {
            let mut g = SINK.lock().unwrap_or_else(|p| p.into_inner());
            if g.is_some() {
                return false;
            }
            *g = Some(tx);
        }
        let (ready_tx, ready_rx) = channel::<bool>();
        let spawned = std::thread::Builder::new()
            .name("psyche-teach-hooks".into())
            .spawn(move || unsafe {
                let module = GetModuleHandleW(None)
                    .ok()
                    .map(|m| windows::Win32::Foundation::HINSTANCE(m.0));
                let ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0);
                let kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0);
                let ok = ms.is_ok() && kb.is_ok();
                if ok {
                    HOOK_THREAD.store(GetCurrentThreadId(), Ordering::SeqCst);
                }
                let _ = ready_tx.send(ok);
                if ok {
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                if let Ok(h) = ms {
                    let _ = UnhookWindowsHookEx(h);
                }
                if let Ok(h) = kb {
                    let _ = UnhookWindowsHookEx(h);
                }
            })
            .is_ok();
        let ok = spawned
            && ready_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap_or(false);
        if !ok {
            *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
            return false;
        }
        let _ = std::thread::Builder::new()
            .name("psyche-teach-lookup".into())
            .spawn(move || worker(rx, on_input));
        self.running = true;
        true
    }

    fn stop(&mut self) {
        if !std::mem::take(&mut self.running) {
            return;
        }
        // Dropping the sender ends the worker once it drained what was already queued.
        *SINK.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let tid = HOOK_THREAD.swap(0, Ordering::SeqCst);
        if tid != 0 {
            unsafe {
                let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
    }
}

impl Drop for LiveTeachInput {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Whether a recorder's hooks are installed (tests, diagnostics).
pub fn is_recording() -> bool {
    HOOK_THREAD.load(Ordering::SeqCst) != 0
}

/// Feeds one event into the running recorder as if a hook had seen hardware input (live tests:
/// they cannot produce hardware input, and injected input is ignored by design).
#[cfg(test)]
pub(crate) fn simulate_click(button: u8, x: i32, y: i32) {
    let time_ms = unsafe { windows::Win32::System::SystemInformation::GetTickCount() };
    send(Raw::Click {
        button,
        x,
        y,
        time_ms,
        at: SystemTime::now(),
    });
}

#[cfg(test)]
pub(crate) fn simulate_key(vk: u16, mods: KeyMods) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{MAPVK_VK_TO_VSC, MapVirtualKeyW};
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) };
    send(Raw::Key {
        vk,
        scan,
        extended: false,
        mods,
        caps: false,
        at: SystemTime::now(),
    });
}
