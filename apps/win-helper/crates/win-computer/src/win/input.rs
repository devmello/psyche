//! Synthetic input through `SendInput` (port of the mac helper's `Input.swift`).
//!
//! Every event carries [`MARKER`] in `dwExtraInfo`, so the Esc hook and the attention monitor
//! never treat the helper's own input as the user's (mac: `eventSourceUserData`). Mouse positions
//! are absolute over the virtual desktop (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`) in
//! physical pixels; the process is per-monitor DPI aware, so the pixels a snapshot or screenshot
//! reports are the pixels clicked, on every monitor.

use crate::error::{CapError, CapResult};
use crate::hygiene::normalize_absolute;
use crate::keychord::{typing_chunks, vk, KeyChord, Mods};
use crate::tiers::StopSignal;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::Win32::Foundation::POINT;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, SetCursorPos, SystemParametersInfoW, SPI_GETWHEELSCROLLLINES, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// "PSYCHE" (the mac helper's `Input.marker`).
pub const MARKER: usize = 0x5053_5943_4845;
const WHEEL_DELTA: i32 = 120;

/// Set once the helper injected anything (the attention monitor's idle seed is only trusted
/// before that).
pub static INJECTED: AtomicBool = AtomicBool::new(false);

fn send(inputs: &[INPUT]) -> CapResult<()> {
    INJECTED.store(true, Ordering::SeqCst);
    let n = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if n as usize != inputs.len() {
        return Err(CapError::unavailable(
            "input_blocked",
            "Windows refused the synthetic input (another desktop or a higher-privilege window has it)",
        )
        .retryable());
    }
    Ok(())
}

fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: MARKER } },
    }
}

fn key_event(vk_code: u16, up: bool, extended: bool) -> INPUT {
    let scan = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) } as u16;
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk_code), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: MARKER } },
    }
}

fn unicode_event(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: MARKER } },
    }
}

/// Sleeps in ≤ 20 ms slices, checking the stop signal (Esc within 200 ms, J5).
pub fn pause(ms: u64, stop: &StopSignal) -> CapResult<()> {
    let mut left = ms;
    while left > 0 {
        stop.check()?;
        let slice = left.min(20);
        std::thread::sleep(std::time::Duration::from_millis(slice));
        left -= slice;
    }
    stop.check()
}

/// A press of an unassigned virtual key (0xE8): gives this process "the last input event" for
/// the foreground lock without any effect in apps (a zero-distance mouse move does not count).
pub fn nudge() {
    let _ = send(&[key_event(0xE8, false, false), key_event(0xE8, true, false)]);
}

pub fn cursor() -> (f64, f64) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x as f64, p.y as f64)
}

pub fn move_to(x: f64, y: f64) -> CapResult<()> {
    let (nx, ny) = normalize_absolute(x, y, super::apps::virtual_desktop());
    send(&[mouse(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])?;
    // Normalized coordinates can round a pixel off on very wide desktops: land exactly.
    let (cx, cy) = cursor();
    if (cx - x.round()).abs() > 0.5 || (cy - y.round()).abs() > 0.5 {
        unsafe {
            let _ = SetCursorPos(x.round() as i32, y.round() as i32);
        }
    }
    Ok(())
}

fn mods_events(m: Mods, up: bool) -> Vec<INPUT> {
    let mut keys = Vec::new();
    if m.ctrl {
        keys.push(vk::CONTROL);
    }
    if m.alt {
        keys.push(vk::MENU);
    }
    if m.shift {
        keys.push(vk::SHIFT);
    }
    if up {
        keys.reverse();
    }
    keys.into_iter().map(|k| key_event(k, up, false)).collect()
}

pub fn click(x: f64, y: f64, count: u32, right: bool, mods: Mods, stop: &StopSignal) -> CapResult<()> {
    move_to(x, y)?;
    pause(30, stop)?;
    let (down, up) = if right { (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) } else { (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
    if !mods.is_empty() {
        send(&mods_events(mods, false))?;
    }
    let result = (|| {
        for i in 1..=count.max(1) {
            send(&[mouse(0, 0, 0, down)])?;
            pause(20, stop)?;
            send(&[mouse(0, 0, 0, up)])?;
            if i < count {
                pause(40, stop)?;
            }
        }
        Ok(())
    })();
    if !mods.is_empty() {
        let _ = send(&mods_events(mods, true));
    }
    if result.is_err() {
        let _ = send(&[mouse(0, 0, 0, up)]);
    }
    result
}

pub fn drag(a: (f64, f64), b: (f64, f64), stop: &StopSignal) -> CapResult<()> {
    move_to(a.0, a.1)?;
    pause(30, stop)?;
    send(&[mouse(0, 0, 0, MOUSEEVENTF_LEFTDOWN)])?;
    let result = (|| {
        let steps = 12;
        for i in 1..=steps {
            pause(15, stop)?;
            let t = i as f64 / steps as f64;
            move_to(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)?;
        }
        pause(30, stop)
    })();
    // Never leave the button down, even when Esc stopped the drag.
    let _ = send(&[mouse(0, 0, 0, MOUSEEVENTF_LEFTUP)]);
    result
}

fn wheel_lines() -> i32 {
    let mut lines: u32 = 3;
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETWHEELSCROLLLINES,
            0,
            Some(&mut lines as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
    }
    // WHEEL_PAGESCROLL (u32::MAX) or 0: fall back to the default three lines per notch.
    if lines == 0 || lines > 100 {
        3
    } else {
        lines as i32
    }
}

/// Wheel delta for `n` lines (one notch = `WHEEL_DELTA` = the user's lines-per-notch setting).
pub fn wheel_delta(lines: i32, lines_per_notch: i32) -> i32 {
    lines * WHEEL_DELTA / lines_per_notch.max(1)
}

/// Scrolls by lines (mac semantics: dy > 0 up, dx > 0 left), in steps of ≤ 5 lines so Esc can
/// interrupt long scrolls.
pub fn scroll(x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()> {
    move_to(x, y)?;
    pause(30, stop)?;
    let per = wheel_lines();
    let (mut ry, mut rx) = (dy, dx);
    while ry != 0 || rx != 0 {
        let sy = ry.clamp(-5, 5);
        let sx = rx.clamp(-5, 5);
        if sy != 0 {
            send(&[mouse(0, 0, wheel_delta(sy, per), MOUSEEVENTF_WHEEL)])?;
        }
        if sx != 0 {
            // HWHEEL is positive to the right; the mac (and the model) use positive = left.
            send(&[mouse(0, 0, wheel_delta(-sx, per), MOUSEEVENTF_HWHEEL)])?;
        }
        ry -= sy;
        rx -= sx;
        pause(15, stop)?;
    }
    Ok(())
}

/// One chord: modifiers down, key down / up, modifiers up.
pub fn key(chord: &KeyChord, stop: &StopSignal) -> CapResult<()> {
    send(&mods_events(chord.mods, false))?;
    let r = (|| {
        send(&[key_event(chord.vk, false, chord.extended)])?;
        pause(20, stop)?;
        send(&[key_event(chord.vk, true, chord.extended)])?;
        pause(20, stop)
    })();
    let _ = send(&mods_events(chord.mods, true));
    r
}

/// Waits (≤ 250 ms) for the thread owning keyboard focus to pump its queue.
fn sync_with_focus() {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;
    if let Some(target) = focus_window() {
        let mut result = 0usize;
        unsafe {
            let _ = SendMessageTimeoutW(target, WM_NULL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG | SMTO_BLOCK, 250, Some(&mut result));
        }
    }
}

fn focus_window() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            return None;
        }
        let thread = GetWindowThreadProcessId(fg, None);
        let mut gui = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
        Some(if GetGUIThreadInfo(thread, &mut gui).is_ok() && !gui.hwndFocus.0.is_null() { gui.hwndFocus } else { fg })
    }
}

/// The keyboard layout of the foreground window's thread.
fn foreground_layout() -> HKL {
    use windows::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let fg = GetForegroundWindow();
        GetKeyboardLayout(if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) })
    }
}

/// How the layout types `c`: (virtual key, shift, AltGr). `None` when it cannot (or only with
/// Ctrl or Alt alone, which would be shortcuts).
pub fn layout_key(c: char, layout: HKL) -> Option<(u16, bool, bool)> {
    let mut buf = [0u16; 2];
    let units = c.encode_utf16(&mut buf);
    if units.len() != 1 {
        return None;
    }
    let r = unsafe { VkKeyScanExW(units[0], layout) };
    if r == -1 {
        return None;
    }
    let vk_code = (r as u16) & 0xFF;
    let state = ((r as u16) >> 8) & 0xFF;
    let shift = state & 1 != 0;
    let (ctrl, alt) = (state & 2 != 0, state & 4 != 0);
    if state & !7 != 0 || ctrl != alt {
        return None;
    }
    Some((vk_code, shift, ctrl && alt))
}

/// Per-character pacing: wait until the focus thread pumped, plus a few milliseconds.
fn pace(stop: &StopSignal) -> CapResult<()> {
    let ms: u64 = std::env::var("PSYCHE_TYPE_PACE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
    sync_with_focus();
    std::thread::sleep(std::time::Duration::from_millis(ms));
    sync_with_focus();
    stop.check()
}

fn boundary_pause(stop: &StopSignal) -> CapResult<()> {
    sync_with_focus();
    pause(20, stop)?;
    sync_with_focus();
    Ok(())
}

fn packet_pause(stop: &StopSignal) -> CapResult<()> {
    let ms: u64 = std::env::var("PSYCHE_TYPE_PACKET_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    sync_with_focus();
    pause(ms, stop)?;
    sync_with_focus();
    Ok(())
}

/// Events typing `c` on `layout`: real key strokes when the layout has the character (Caps Lock
/// accounted for), else a `VK_PACKET` pair.
fn char_events(c: char, layout: HKL, caps: bool) -> (Vec<INPUT>, bool) {
    if let Some((vk_code, mut shift, altgr)) = layout_key(c, layout) {
        if caps && c.is_alphabetic() {
            shift = !shift;
        }
        let mut ev = Vec::new();
        if altgr {
            ev.push(key_event(vk::CONTROL, false, false));
            ev.push(key_event(vk::MENU, false, false));
        }
        if shift {
            ev.push(key_event(vk::SHIFT, false, false));
        }
        ev.push(key_event(vk_code, false, false));
        ev.push(key_event(vk_code, true, false));
        if shift {
            ev.push(key_event(vk::SHIFT, true, false));
        }
        if altgr {
            ev.push(key_event(vk::MENU, true, false));
            ev.push(key_event(vk::CONTROL, true, false));
        }
        return (ev, false);
    }
    let mut buf = [0u16; 2];
    let mut ev = Vec::new();
    for u in c.encode_utf16(&mut buf).iter() {
        ev.push(unicode_event(*u, false));
        ev.push(unicode_event(*u, true));
    }
    (ev, true)
}

/// Free text (Tab and line breaks as virtual keys). Characters on the foreground keyboard layout
/// go out as key strokes; others (emoji, symbols) as `KEYEVENTF_UNICODE` (`VK_PACKET`) events, one
/// at a time and paced, since apps read a packet's character from per-thread state and a burst of
/// packets repeats one character. `guard` runs before every chunk and key, so a focus change (Tab
/// into a password field, a window stealing the foreground) stops typing.
pub fn type_text(text: &str, stop: &StopSignal, guard: &mut dyn FnMut() -> CapResult<()>) -> CapResult<()> {
    let mut segment = String::new();
    let flush = |seg: &mut String, guard: &mut dyn FnMut() -> CapResult<()>| -> CapResult<()> {
        if seg.is_empty() {
            return Ok(());
        }
        let layout = foreground_layout();
        let caps = unsafe { GetKeyState(0x14) } & 1 != 0; // VK_CAPITAL toggled
        for chunk in typing_chunks(seg, 16) {
            guard()?;
            for c in String::from_utf16_lossy(&chunk).chars() {
                if !c.is_alphanumeric() {
                    // Word boundaries trigger autocorrect / suggestions: let the word settle.
                    boundary_pause(stop)?;
                }
                let (events, packet) = char_events(c, layout, caps);
                if packet {
                    // Apps read a packet's character lazily from per-thread state: give the
                    // previous one time to land, send each UTF-16 unit on its own, then wait.
                    packet_pause(stop)?;
                    for pair in events.chunks(2) {
                        send(pair)?;
                        packet_pause(stop)?;
                    }
                } else {
                    send(&events)?;
                }
                // Paced like fast human typing: apps that post-process words (autocorrect,
                // suggestions) drop or reorder keys that arrive in one burst.
                pace(stop)?;
            }
            pause(15, stop)?;
        }
        seg.clear();
        Ok(())
    };
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\t' | '\n' | '\r' => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                flush(&mut segment, guard)?;
                guard()?;
                let chord = if c == '\t' { KeyChord::plain(vk::TAB, "tab") } else { KeyChord::plain(vk::RETURN, "return") };
                key(&chord, stop)?;
            }
            c if c.is_control() => {}
            c => segment.push(c),
        }
    }
    flush(&mut segment, guard)
}

/// Milliseconds since boot (for `GetLastInputInfo` math).
pub fn tick_ms() -> u32 {
    unsafe { GetTickCount() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wheel_delta_respects_lines_per_notch() {
        assert_eq!(wheel_delta(3, 3), 120);
        assert_eq!(wheel_delta(1, 3), 40);
        assert_eq!(wheel_delta(-5, 3), -200);
        assert_eq!(wheel_delta(1, 0), 120);
    }
}
