//! Key chords (`cmd+shift+t`, `return`): the mac helper's `KeyChord` vocabulary
//! (`PsycheHelperCore/Computer/KeyChord.swift`) mapped to Windows virtual keys. The Gateway and the
//! model write chords in the mac vocabulary; on Windows:
//!
//! | Chord token | Windows |
//! | --- | --- |
//! | `cmd` / `command` / `⌘` | Ctrl (Windows shortcuts put Ctrl where the Mac puts ⌘: copy, save, quit) |
//! | `ctrl` / `control` / `⌃` | Ctrl |
//! | `opt` / `option` / `alt` / `⌥` | Alt |
//! | `shift` / `⇧` | Shift |
//! | `fn` | refused (`invalid_params`): no Windows equivalent; the Win key is never injected |
//! | `delete` / `backspace` | Backspace (the Mac "delete" key) |
//! | `forwarddelete` / `fwddelete` | Delete |
//! | `help` | Insert (the key in the Mac Help key's position) |
//! | `keypadenter` | numpad Enter (extended Enter) |
//! | punctuation `= - ] [ ' ; \ , / . \`` | the US-layout OEM keys at the same positions |
//!
//! Keys are always sent as virtual-key events with scan codes (spike 04: typeahead ignores
//! unicode-string events); free text goes through `KEYEVENTF_UNICODE` (`input.rs`).

use crate::error::CapError;
use unicode_segmentation::UnicodeSegmentation;

pub mod vk {
    pub const BACK: u16 = 0x08;
    pub const TAB: u16 = 0x09;
    pub const RETURN: u16 = 0x0D;
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const MENU: u16 = 0x12;
    pub const ESCAPE: u16 = 0x1B;
    pub const SPACE: u16 = 0x20;
    pub const PRIOR: u16 = 0x21;
    pub const NEXT: u16 = 0x22;
    pub const END: u16 = 0x23;
    pub const HOME: u16 = 0x24;
    pub const LEFT: u16 = 0x25;
    pub const UP: u16 = 0x26;
    pub const RIGHT: u16 = 0x27;
    pub const DOWN: u16 = 0x28;
    pub const INSERT: u16 = 0x2D;
    pub const DELETE: u16 = 0x2E;
    pub const F1: u16 = 0x70;
    pub const F4: u16 = 0x73;
    pub const LWIN: u16 = 0x5B;
    pub const RWIN: u16 = 0x5C;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Mods {
    pub fn is_empty(&self) -> bool {
        !self.ctrl && !self.alt && !self.shift
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub vk: u16,
    /// Needs `KEYEVENTF_EXTENDEDKEY` (arrows, navigation block, numpad Enter).
    pub extended: bool,
    pub mods: Mods,
    /// The key token (`return`, `q`, `f4`).
    pub key: String,
    /// The chord as written, lowercased.
    pub name: String,
}

fn code(key: &str) -> Option<(u16, bool)> {
    use vk::*;
    let k = match key {
        "return" | "enter" => (RETURN, false),
        "keypadenter" => (RETURN, true),
        "tab" => (TAB, false),
        "space" => (SPACE, false),
        "delete" | "backspace" => (BACK, false),
        "escape" | "esc" => (ESCAPE, false),
        "forwarddelete" | "fwddelete" => (DELETE, true),
        "home" => (HOME, true),
        "end" => (END, true),
        "pageup" => (PRIOR, true),
        "pagedown" => (NEXT, true),
        "left" => (LEFT, true),
        "right" => (RIGHT, true),
        "down" => (DOWN, true),
        "up" => (UP, true),
        "help" => (INSERT, true),
        "=" => (0xBB, false),
        "-" => (0xBD, false),
        "]" => (0xDD, false),
        "[" => (0xDB, false),
        "'" => (0xDE, false),
        ";" => (0xBA, false),
        "\\" => (0xDC, false),
        "," => (0xBC, false),
        "/" => (0xBF, false),
        "." => (0xBE, false),
        "`" => (0xC0, false),
        _ => {
            let mut chars = key.chars();
            let (c, rest) = (chars.next()?, chars.as_str());
            if rest.is_empty() && c.is_ascii_lowercase() {
                return Some((c.to_ascii_uppercase() as u16, false));
            }
            if rest.is_empty() && c.is_ascii_digit() {
                return Some((c as u16, false));
            }
            if c == 'f' {
                let n: u16 = rest.parse().ok()?;
                if (1..=20).contains(&n) && !rest.starts_with('0') {
                    return Some((F1 + n - 1, false));
                }
            }
            return None;
        }
    };
    Some(k)
}

impl KeyChord {
    /// Parses `mod+mod+key`.
    pub fn parse(text: &str) -> Result<KeyChord, CapError> {
        let lower = text.to_lowercase();
        let parts: Vec<&str> = lower.split('+').map(|p| p.trim()).collect();
        let mut mods = Mods::default();
        let mut key: Option<&str> = None;
        let n = parts.len();
        for (i, part) in parts.iter().enumerate() {
            match *part {
                "cmd" | "command" | "⌘" | "ctrl" | "control" | "⌃" => mods.ctrl = true,
                "shift" | "⇧" => mods.shift = true,
                "opt" | "option" | "alt" | "⌥" => mods.alt = true,
                "fn" => {
                    return Err(CapError::invalid_params("fn has no Windows equivalent", Some("keys")));
                }
                _ => {
                    if key.is_some() || i != n - 1 || part.is_empty() {
                        return Err(CapError::invalid_params("invalid key chord", Some("keys")));
                    }
                    key = Some(part);
                }
            }
        }
        let key = key.ok_or_else(|| CapError::invalid_params("invalid key chord", Some("keys")))?;
        let (vk, extended) = code(key).ok_or_else(|| CapError::invalid_params("unknown key in the chord", Some("keys")))?;
        Ok(KeyChord { vk, extended, mods, key: key.to_string(), name: lower })
    }

    pub fn plain(vk: u16, name: &str) -> KeyChord {
        KeyChord { vk, extended: false, mods: Mods::default(), key: name.into(), name: name.into() }
    }

    /// Plain Esc (the stop key is never injectable while a session runs).
    pub fn is_bare_escape(&self) -> bool {
        self.vk == vk::ESCAPE && self.mods.is_empty()
    }

    pub fn is_escape_or_tab(&self) -> bool {
        self.vk == vk::ESCAPE || self.vk == vk::TAB
    }

    /// Chords that close or quit apps, log out, delete: refused unless the call is approved. The
    /// mac rules (`cmd+q`, `cmd+w`, `cmd+delete`, with cmd → Ctrl) plus the Windows ones: Alt+F4
    /// and Ctrl+F4 close windows, Shift+Delete deletes for good, Ctrl+Shift+Esc opens Task Manager.
    pub fn is_high_risk(&self) -> bool {
        let m = self.mods;
        if m.ctrl && matches!(self.key.as_str(), "q" | "w" | "delete" | "backspace") {
            return true;
        }
        if (m.alt || m.ctrl) && self.vk == vk::F4 {
            return true;
        }
        if m.shift && self.vk == vk::DELETE {
            return true;
        }
        m.ctrl && m.shift && self.vk == vk::ESCAPE
    }

    /// App-specific risk: in File Explorer, Delete and Ctrl+D move files to the Recycle Bin.
    pub fn is_high_risk_in(&self, bundle_id: Option<&str>) -> bool {
        if self.is_high_risk() {
            return true;
        }
        let explorer = bundle_id.map(|b| b.eq_ignore_ascii_case("explorer.exe")).unwrap_or(false);
        explorer && (self.vk == vk::DELETE || (self.mods.ctrl && self.key == "d"))
    }
}

/// Keys that send in messaging and mail apps (#270): an interact grant must not let Return send
/// a message as an ordinary write (docs/05 §3.1 classes third-party sends as destructive).
pub mod send_keys {
    use super::KeyChord;

    /// Executable names (lowercase) of messaging and mail apps on Windows.
    pub const APPS: &[&str] = &[
        "outlook.exe",
        "olk.exe",
        "hxoutlook.exe",
        "thunderbird.exe",
        "mailbird.exe",
        "mailclient.exe",
        "spark.exe",
        "superhuman.exe",
        "slack.exe",
        "discord.exe",
        "whatsapp.exe",
        "whatsapp.root.exe",
        "telegram.exe",
        "signal.exe",
        "ms-teams.exe",
        "teams.exe",
        "skype.exe",
        "messenger.exe",
        "element.exe",
        "wechat.exe",
        "weixin.exe",
        "line.exe",
        "viber.exe",
        "zoom.exe",
    ];

    pub fn is_messaging_app(bundle_id: Option<&str>) -> bool {
        match bundle_id {
            Some(id) => APPS.iter().any(|a| a.eq_ignore_ascii_case(id)),
            None => false,
        }
    }

    /// Return / numpad Enter with any modifiers, cmd+shift+D (→ Ctrl+Shift+D), and Alt+S
    /// (Outlook's send).
    pub fn is_send_chord(c: &KeyChord) -> bool {
        if c.vk == super::vk::RETURN {
            return true;
        }
        (c.key == "d" && c.mods.ctrl && c.mods.shift) || (c.key == "s" && c.mods.alt && !c.mods.ctrl)
    }

    /// Typed text that contains a line break presses Return on the way.
    pub fn text_sends(text: &str) -> bool {
        text.chars().any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    }
}

/// Splits text into UTF-16 chunks for `KEYEVENTF_UNICODE` events, never splitting a grapheme
/// (emoji, combining marks) across chunks.
pub fn typing_chunks(text: &str, max_units: usize) -> Vec<Vec<u16>> {
    let mut out = Vec::new();
    let mut cur: Vec<u16> = Vec::new();
    for g in text.graphemes(true) {
        let units: Vec<u16> = g.encode_utf16().collect();
        if cur.len() + units.len() > max_units && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.extend(units);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mac_chords_to_windows_keys() {
        let c = KeyChord::parse("cmd+shift+t").unwrap();
        assert_eq!((c.vk, c.mods), (0x54, Mods { ctrl: true, alt: false, shift: true }));
        assert_eq!(c.name, "cmd+shift+t");
        let c = KeyChord::parse("Return").unwrap();
        assert_eq!((c.vk, c.mods.is_empty(), c.extended), (vk::RETURN, true, false));
        assert!(KeyChord::parse("keypadenter").unwrap().extended);
        assert_eq!(KeyChord::parse("opt+left").unwrap().mods, Mods { ctrl: false, alt: true, shift: false });
        assert!(KeyChord::parse("left").unwrap().extended);
        assert_eq!(KeyChord::parse("f5").unwrap().vk, 0x74);
        assert_eq!(KeyChord::parse("f20").unwrap().vk, 0x83);
        assert_eq!(KeyChord::parse("delete").unwrap().vk, vk::BACK);
        assert_eq!(KeyChord::parse("forwarddelete").unwrap().vk, vk::DELETE);
        assert_eq!(KeyChord::parse("ctrl+=").unwrap().vk, 0xBB);
        assert_eq!(KeyChord::parse("⌘+c").unwrap().vk, 0x43);
        assert_eq!(KeyChord::parse("cmd + 1").unwrap().vk, 0x31);
    }

    #[test]
    fn rejects_bad_chords() {
        for bad in ["cmd++", "", "cmd+", "q+cmd", "a+b", "f21", "f0", "hyper+a", "fn+left", "f05"] {
            let e = KeyChord::parse(bad).unwrap_err();
            assert_eq!(e.code, "invalid_params", "{bad}");
            assert_eq!(e.details["field"], "keys");
        }
    }

    #[test]
    fn risk_and_escape() {
        assert!(KeyChord::parse("escape").unwrap().is_bare_escape());
        assert!(!KeyChord::parse("shift+escape").unwrap().is_bare_escape());
        for risky in ["cmd+q", "cmd+w", "ctrl+w", "cmd+delete", "alt+f4", "ctrl+f4", "shift+forwarddelete", "ctrl+shift+escape"] {
            assert!(KeyChord::parse(risky).unwrap().is_high_risk(), "{risky}");
        }
        for safe in ["cmd+s", "return", "forwarddelete", "cmd+shift+t", "f4"] {
            assert!(!KeyChord::parse(safe).unwrap().is_high_risk(), "{safe}");
        }
        let del = KeyChord::parse("forwarddelete").unwrap();
        assert!(del.is_high_risk_in(Some("Explorer.EXE")));
        assert!(!del.is_high_risk_in(Some("notepad.exe")));
    }

    #[test]
    fn send_keys() {
        assert!(send_keys::is_messaging_app(Some("Slack.exe")));
        assert!(!send_keys::is_messaging_app(Some("notepad.exe")));
        assert!(send_keys::is_send_chord(&KeyChord::parse("return").unwrap()));
        assert!(send_keys::is_send_chord(&KeyChord::parse("cmd+return").unwrap()));
        assert!(send_keys::is_send_chord(&KeyChord::parse("cmd+shift+d").unwrap()));
        assert!(send_keys::is_send_chord(&KeyChord::parse("alt+s").unwrap()));
        assert!(!send_keys::is_send_chord(&KeyChord::parse("cmd+s").unwrap()));
        assert!(send_keys::text_sends("hi\nthere") && send_keys::text_sends("a\u{2029}") && !send_keys::text_sends("hi"));
    }

    #[test]
    fn chunks_keep_graphemes_whole() {
        let chunks = typing_chunks("abc", 2);
        assert_eq!(chunks, vec![vec![97, 98], vec![99]]);
        // A family emoji is 11 UTF-16 units: never split, even past the limit.
        let fam = "👨‍👩‍👧‍👦";
        let chunks = typing_chunks(&format!("a{fam}b"), 4);
        assert_eq!(chunks.len(), 3);
        assert_eq!(String::from_utf16(&chunks[1]).unwrap(), fam);
        let e = "e\u{301}";
        assert_eq!(typing_chunks(&format!("{e}{e}"), 3).len(), 2);
    }
}
