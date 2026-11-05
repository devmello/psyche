//! Whether the keyboard layout in use has AltGr: on such a layout (German, French, Polish…)
//! Right Alt is AltGr and types characters, so it makes a poor hold-to-talk key.
//!
//! No layout flag is exposed to user mode, so it is measured: a layout has AltGr when Ctrl+Alt
//! with some character key types a character (`ToUnicodeEx` with Ctrl and Alt down, flag 4 so
//! the kernel's dead-key state is left alone), as AltGr+E types € on a German keyboard.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, HKL, MAPVK_VK_TO_VSC_EX, MapVirtualKeyExW, ToUnicodeEx,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

const VK_CONTROL: usize = 0x11;
const VK_MENU: usize = 0x12;
const VK_LCONTROL: usize = 0xA2;
const VK_RMENU: usize = 0xA5;
/// `ToUnicodeEx` flag: do not change the keyboard state (Windows 10 1607 and later).
const NO_STATE_CHANGE: u32 = 0x4;

/// Character keys: digits, letters and the OEM punctuation keys.
fn character_keys() -> impl Iterator<Item = u32> {
    (0x30..=0x39)
        .chain(0x41..=0x5A)
        .chain(0xBA..=0xC0)
        .chain(0xDB..=0xDF)
        .chain(std::iter::once(0xE2))
}

/// The layout of the foreground window's thread (each thread can have its own); the process's
/// own when nothing has focus.
pub(crate) fn current_layout() -> HKL {
    // SAFETY: plain queries; a zero thread id means this thread.
    unsafe {
        let hwnd = GetForegroundWindow();
        let tid = if hwnd.is_invalid() {
            0
        } else {
            GetWindowThreadProcessId(hwnd, None)
        };
        GetKeyboardLayout(tid)
    }
}

/// Whether `layout` types characters with AltGr (Ctrl+Alt).
pub(crate) fn has_altgr(layout: HKL) -> bool {
    let mut state = [0u8; 256];
    for vk in [VK_CONTROL, VK_MENU, VK_LCONTROL, VK_RMENU] {
        state[vk] = 0x80;
    }
    character_keys().any(|vk| {
        let mut buf = [0u16; 8];
        // SAFETY: a stack key-state table and buffer, a layout handle Windows gave us.
        let n = unsafe {
            let scan = MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, Some(layout));
            ToUnicodeEx(vk, scan, &state, &mut buf, NO_STATE_CHANGE, Some(layout))
        };
        // A dead key (-1) on the AltGr level counts; control characters (Ctrl+letter) do not.
        n < 0 || (n > 0 && buf[..n as usize].iter().any(|&c| c >= 0x20 && c != 0x7F))
    })
}

/// The foreground layout's id (`0x04070407`) and whether it has AltGr.
pub(crate) fn layout_info() -> (String, bool) {
    let layout = current_layout();
    (
        format!("{:#010x}", layout.0 as usize as u32),
        has_altgr(layout),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_layout_in_use() {
        let (id, _alt_gr) = layout_info();
        assert!(id.starts_with("0x") && id.len() == 10, "{id}");
        // The low word is the language id, never zero for a real layout.
        assert_ne!(u32::from_str_radix(&id[2..], 16).unwrap() & 0xFFFF, 0);
    }

    #[test]
    fn character_keys_cover_letters_digits_and_oem_keys() {
        let keys: Vec<u32> = character_keys().collect();
        assert!(
            keys.contains(&0x45)
                && keys.contains(&0x37)
                && keys.contains(&0xDB)
                && keys.contains(&0xE2)
        );
        assert!(!keys.contains(&0x11) && !keys.contains(&0x20));
    }
}
