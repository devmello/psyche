//! Input on the virtual display through XTest. It only ever talks to the helper's own X server,
//! so nothing moves the owner's pointer or types into the owner's apps.
//!
//! Keys arrive as DOM `KeyboardEvent.key` values (the watch pane's take-over) or as text. Both are
//! turned into keysyms, then into the display's keycodes; a character the keymap lacks is bound
//! to a spare keycode for the moment it takes to type it.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION_NOTIFY: u8 = 6;

pub const XK_SHIFT_L: u32 = 0xffe1;
pub const XK_RETURN: u32 = 0xff0d;
pub const XK_TAB: u32 = 0xff09;

/// A DOM `key` value as a keysym. `None` for keys we do not know.
pub fn dom_key_to_keysym(key: &str) -> Option<u32> {
    let mut chars = key.chars();
    let first = chars.next()?;
    if chars.next().is_none() {
        return Some(char_to_keysym(first));
    }
    let named = match key {
        "Enter" => XK_RETURN,
        "Backspace" => 0xff08,
        "Tab" => XK_TAB,
        "Escape" => 0xff1b,
        "Delete" => 0xffff,
        "Insert" => 0xff63,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "Shift" => XK_SHIFT_L,
        "Control" => 0xffe3,
        "Alt" => 0xffe9,
        "AltGraph" => 0xfe03,
        "Meta" | "OS" | "Super" => 0xffeb,
        "CapsLock" => 0xffe5,
        "ContextMenu" => 0xff67,
        "Space" => 0x20,
        _ => {
            let n: u32 = key.strip_prefix('F')?.parse().ok()?;
            if !(1..=24).contains(&n) {
                return None;
            }
            0xffbe + n - 1
        }
    };
    Some(named)
}

pub fn char_to_keysym(c: char) -> u32 {
    match c {
        '\n' | '\r' => XK_RETURN,
        '\t' => XK_TAB,
        c if (c as u32) < 0x20 => 0,
        c if (c as u32) <= 0xff => c as u32,
        c => 0x0100_0000 | c as u32,
    }
}

/// The keycode table of the display.
#[derive(Debug, Clone)]
pub struct Keymap {
    pub min: u8,
    pub per_code: usize,
    pub syms: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyChoice {
    pub keycode: u8,
    pub shift: bool,
}

impl Keymap {
    /// The key that produces `sym`: in the plain column, else the shifted one.
    pub fn find(&self, sym: u32) -> Option<KeyChoice> {
        if sym == 0 {
            return None;
        }
        let rows = self.syms.len() / self.per_code.max(1);
        for column in [0usize, 1] {
            if column >= self.per_code {
                break;
            }
            for row in 0..rows {
                if self.syms[row * self.per_code + column] == sym {
                    return Some(KeyChoice {
                        keycode: self.min + row as u8,
                        shift: column == 1,
                    });
                }
            }
        }
        None
    }

    /// A keycode with no keysyms at all, to borrow for a character the map lacks.
    pub fn spare(&self) -> Option<u8> {
        let rows = self.syms.len() / self.per_code.max(1);
        (0..rows).rev().find_map(|row| {
            self.syms[row * self.per_code..(row + 1) * self.per_code]
                .iter()
                .all(|s| *s == 0)
                .then_some(self.min + row as u8)
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Middle,
    Right,
}

impl Button {
    fn code(self) -> u8 {
        match self {
            Button::Left => 1,
            Button::Middle => 2,
            Button::Right => 3,
        }
    }
}

pub struct Input {
    conn: Arc<RustConnection>,
    root: xproto::Window,
    keymap: Keymap,
    shift_code: Option<u8>,
    held: HashSet<u8>,
}

impl Input {
    pub fn new(conn: Arc<RustConnection>, screen_num: usize) -> Result<Self, String> {
        conn.xtest_get_version(2, 2)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| format!("XTEST: {e}"))?;
        let setup = conn.setup();
        let root = setup.roots[screen_num].root;
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let m = conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?;
        let keymap = Keymap {
            min,
            per_code: m.keysyms_per_keycode as usize,
            syms: m.keysyms,
        };
        let shift_code = keymap.find(XK_SHIFT_L).map(|c| c.keycode);
        Ok(Self { conn, root, keymap, shift_code, held: HashSet::new() })
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn flush(&self) -> Result<(), String> {
        self.conn.flush().map_err(|e| e.to_string())
    }

    pub fn move_to(&self, x: i32, y: i32) -> Result<(), String> {
        self.fake(MOTION_NOTIFY, 0, x.clamp(0, 32766) as i16, y.clamp(0, 32766) as i16)?;
        self.flush()
    }

    pub fn button(&self, button: Button, down: bool) -> Result<(), String> {
        self.fake(if down { BUTTON_PRESS } else { BUTTON_RELEASE }, button.code(), 0, 0)?;
        self.flush()
    }

    pub fn click(&self, x: i32, y: i32, button: Button) -> Result<(), String> {
        self.move_to(x, y)?;
        self.button(button, true)?;
        self.button(button, false)
    }

    /// Wheel notches: positive `dy` scrolls down, positive `dx` right.
    pub fn scroll(&self, x: i32, y: i32, dx: f64, dy: f64) -> Result<(), String> {
        self.move_to(x, y)?;
        let notches = |d: f64| ((d.abs() / 100.0).ceil() as u32).clamp(if d == 0.0 { 0 } else { 1 }, 20);
        for (delta, plus, minus) in [(dy, 5u8, 4u8), (dx, 7u8, 6u8)] {
            let code = if delta > 0.0 { plus } else { minus };
            for _ in 0..notches(delta) {
                self.fake(BUTTON_PRESS, code, 0, 0)?;
                self.fake(BUTTON_RELEASE, code, 0, 0)?;
            }
        }
        self.flush()
    }

    fn press_choice(&mut self, choice: KeyChoice, down: bool) -> Result<(), String> {
        let shift_needed = choice.shift
            && down
            && self.shift_code.is_some_and(|s| !self.held.contains(&s));
        if shift_needed {
            self.fake(KEY_PRESS, self.shift_code.expect("checked"), 0, 0)?;
        }
        self.fake(if down { KEY_PRESS } else { KEY_RELEASE }, choice.keycode, 0, 0)?;
        if down {
            self.held.insert(choice.keycode);
        } else {
            self.held.remove(&choice.keycode);
        }
        if choice.shift && !down && self.shift_code.is_some_and(|s| !self.held.contains(&s)) {
            // Release the shift we added on the way down.
            self.fake(KEY_RELEASE, self.shift_code.expect("checked"), 0, 0)?;
        }
        Ok(())
    }

    /// One DOM key going down or up (the take-over).
    pub fn key(&mut self, key: &str, down: bool) -> Result<(), String> {
        let sym = dom_key_to_keysym(key).ok_or_else(|| format!("unknown key {key}"))?;
        let choice = self.keymap.find(sym).ok_or_else(|| format!("no key for {key}"))?;
        // A key the owner holds is a modifier they are managing themselves: no extra shift.
        let choice = if self.held.contains(&self.shift_code.unwrap_or(0)) {
            KeyChoice { shift: false, ..choice }
        } else {
            choice
        };
        self.press_choice(choice, down)?;
        self.flush()
    }

    /// Types `text` character by character, binding a spare keycode for characters the map lacks.
    pub fn type_text(&mut self, text: &str) -> Result<(), String> {
        for c in text.chars() {
            let sym = char_to_keysym(c);
            if sym == 0 {
                continue;
            }
            if let Some(choice) = self.keymap.find(sym) {
                self.press_choice(choice, true)?;
                self.press_choice(choice, false)?;
            } else {
                self.type_borrowed(sym)?;
            }
        }
        self.flush()
    }

    fn type_borrowed(&mut self, sym: u32) -> Result<(), String> {
        let code = self.keymap.spare().ok_or("no spare keycode")?;
        let per = self.keymap.per_code as u8;
        let mut syms = vec![sym; per as usize];
        syms.resize(per as usize, sym);
        self.conn
            .change_keyboard_mapping(1, code, per, &syms)
            .map_err(|e| e.to_string())?;
        self.flush()?;
        // Give the clients a moment to read the new mapping before the key arrives.
        std::thread::sleep(Duration::from_millis(15));
        self.fake(KEY_PRESS, code, 0, 0)?;
        self.fake(KEY_RELEASE, code, 0, 0)?;
        self.flush()?;
        std::thread::sleep(Duration::from_millis(15));
        let blank = vec![0u32; per as usize];
        self.conn
            .change_keyboard_mapping(1, code, per, &blank)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Lets go of everything we are holding (the take-over ended mid-press).
    pub fn release_all(&mut self) -> Result<(), String> {
        let held: Vec<u8> = self.held.drain().collect();
        for code in held {
            self.fake(KEY_RELEASE, code, 0, 0)?;
        }
        self.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> Keymap {
        // keycodes 8.. ; per_code 2: [plain, shifted]
        Keymap {
            min: 8,
            per_code: 2,
            syms: vec![
                0x61, 0x41, // 8: a A
                0x31, 0x21, // 9: 1 !
                XK_SHIFT_L, 0, // 10
                XK_RETURN, 0, // 11
                0, 0, // 12 spare
                0, 0, // 13 spare
            ],
        }
    }

    #[test]
    fn plain_and_shifted_characters_find_their_keys() {
        let m = map();
        assert_eq!(m.find(0x61), Some(KeyChoice { keycode: 8, shift: false }));
        assert_eq!(m.find(0x41), Some(KeyChoice { keycode: 8, shift: true }));
        assert_eq!(m.find(0x21), Some(KeyChoice { keycode: 9, shift: true }));
        assert_eq!(m.find(XK_RETURN), Some(KeyChoice { keycode: 11, shift: false }));
        assert_eq!(m.find(0x20ac), None);
        assert_eq!(m.find(0), None);
    }

    #[test]
    fn the_spare_keycode_is_the_last_empty_one() {
        assert_eq!(map().spare(), Some(13));
    }

    #[test]
    fn dom_keys_become_keysyms() {
        assert_eq!(dom_key_to_keysym("a"), Some(0x61));
        assert_eq!(dom_key_to_keysym("A"), Some(0x41));
        assert_eq!(dom_key_to_keysym(" "), Some(0x20));
        assert_eq!(dom_key_to_keysym("é"), Some(0xe9));
        assert_eq!(dom_key_to_keysym("€"), Some(0x0100_20ac));
        assert_eq!(dom_key_to_keysym("Enter"), Some(XK_RETURN));
        assert_eq!(dom_key_to_keysym("ArrowDown"), Some(0xff54));
        assert_eq!(dom_key_to_keysym("F1"), Some(0xffbe));
        assert_eq!(dom_key_to_keysym("F12"), Some(0xffc9));
        assert_eq!(dom_key_to_keysym("F99"), None);
        assert_eq!(dom_key_to_keysym("Unidentified"), None);
        assert_eq!(dom_key_to_keysym(""), None);
    }

    #[test]
    fn newlines_and_tabs_in_text_are_keys() {
        assert_eq!(char_to_keysym('\n'), XK_RETURN);
        assert_eq!(char_to_keysym('\t'), XK_TAB);
        assert_eq!(char_to_keysym('\u{7}'), 0);
    }
}
