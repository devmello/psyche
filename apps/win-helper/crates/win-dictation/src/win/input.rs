//! Synthesized input (SendInput). Every event carries `MARKER` in `dwExtraInfo` (the mac's
//! `eventSourceUserData` marker) and arrives at hooks flagged `LLKHF_INJECTED`.

use crate::dictation::keys::{VK_CONTROL, VK_LWIN, VK_MENU, VK_MENU_MASK, VK_RWIN, VK_SHIFT};
use crate::dictation::policy::typing_chunks;
use crate::error::CapError;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MapVirtualKeyW, SendInput, VIRTUAL_KEY,
};

/// "PSYCHE".
pub(crate) const MARKER: usize = 0x5053_5943_4845;
const CHUNK_UNITS: usize = 16;
const CHUNK_PAUSE: Duration = Duration::from_millis(15);

fn key(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: MARKER } },
    }
}

fn send(inputs: &[INPUT]) -> bool {
    // SAFETY: a slice of fully initialized INPUT structs.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

fn vk_down(vk: u16) -> bool {
    // SAFETY: plain key-state query.
    (unsafe { GetAsyncKeyState(vk as i32) }) < 0
}

/// Shift, Ctrl, Alt or Win physically held.
pub(crate) fn modifiers_held() -> bool {
    [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN].into_iter().any(vk_down)
}

/// Waits up to `limit` for the owner to let go of the modifiers (the hold-to-talk key may still
/// be down when the desktop inserts): with Alt held, typed characters become menu accelerators.
pub(crate) fn wait_for_modifiers_released(limit: Duration) -> bool {
    let start = Instant::now();
    while modifiers_held() {
        if start.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

fn blocked() -> CapError {
    CapError::unavailable("input_blocked", "Windows did not accept the synthesized keystrokes (another desktop or a higher-privilege app is in front).")
        .retryable()
}

/// Unicode typing (`KEYEVENTF_UNICODE`), 16 UTF-16 units per chunk with a short pause; `guard`
/// runs before every chunk.
pub(crate) fn type_text(text: &str, guard: &mut dyn FnMut() -> Result<(), CapError>) -> Result<(), CapError> {
    if !wait_for_modifiers_released(Duration::from_millis(1000)) {
        return Err(CapError::unavailable("modifier_held", "Release Shift, Ctrl, Alt and Windows keys, then try again; nothing was typed.").retryable());
    }
    for chunk in typing_chunks(text, CHUNK_UNITS) {
        guard()?;
        let mut inputs = Vec::with_capacity(chunk.len() * 2);
        for &u in &chunk {
            inputs.push(key(0, u, KEYEVENTF_UNICODE));
            inputs.push(key(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
        }
        if !send(&inputs) {
            return Err(blocked());
        }
        std::thread::sleep(CHUNK_PAUSE);
    }
    Ok(())
}

fn scan(vk: u16) -> u16 {
    // SAFETY: pure table lookup.
    unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) as u16 }
}

/// Ctrl+V.
pub(crate) fn send_ctrl_v() -> bool {
    const VK_V: u16 = 0x56;
    let none = KEYBD_EVENT_FLAGS(0);
    send(&[
        key(VK_CONTROL, scan(VK_CONTROL), none),
        key(VK_V, scan(VK_V), none),
        key(VK_V, scan(VK_V), KEYEVENTF_KEYUP),
        key(VK_CONTROL, scan(VK_CONTROL), KEYEVENTF_KEYUP),
    ])
}

/// An unassigned key tapped while Alt or Win is held, so their release opens no menu.
pub(crate) fn send_menu_mask() -> bool {
    send(&[key(VK_MENU_MASK, 0, KEYBD_EVENT_FLAGS(0)), key(VK_MENU_MASK, 0, KEYEVENTF_KEYUP)])
}

/// Test support: a real-looking key press (scan code, no unicode flag).
pub fn send_vk(vk: u16, down: bool) -> bool {
    let flags = if down { KEYBD_EVENT_FLAGS(0) } else { KEYEVENTF_KEYUP };
    send(&[key(vk, scan(vk), flags)])
}
