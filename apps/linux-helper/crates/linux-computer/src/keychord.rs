//! Key chords (`cmd+shift+t`, `return`): the Mac helper's `KeyChord` vocabulary mapped to X11
//! keysyms, which every Linux input path takes (XTest after a keysym-to-keycode lookup, the
//! portal's `NotifyKeyboardKeysym`, libei through the compositor keymap, wlroots virtual
//! keyboard). The Gateway and the model write chords in the Mac vocabulary; on Linux:
//!
//! | Chord token | Linux |
//! | --- | --- |
//! | `cmd` / `command` / `⌘`, `ctrl` / `control` / `⌃` | Ctrl (Linux shortcuts put Ctrl where the Mac puts ⌘) |
//! | `opt` / `option` / `alt` / `⌥` | Alt |
//! | `shift` / `⇧` | Shift |
//! | `fn`, `super`, `meta`, `win` | refused: the Super key is never injected |
//! | `delete` / `backspace` | BackSpace (the Mac "delete" key) |
//! | `forwarddelete` / `fwddelete` | Delete |
//! | `help` | Insert |
//! | `keypadenter` | KP_Enter |
//! | `print` / `printscreen` / `prtsc`, `sysrq` | Print, Sys_Req: parsed only to be refused ([`KeyChord::is_shell_chord`]) |

use crate::error::CapError;
use unicode_segmentation::UnicodeSegmentation;

/// X11 keysyms (`X11/keysymdef.h`) the chord table needs.
pub mod keysym {
    pub const BACKSPACE: u32 = 0xff08;
    pub const TAB: u32 = 0xff09;
    pub const RETURN: u32 = 0xff0d;
    pub const ESCAPE: u32 = 0xff1b;
    pub const HOME: u32 = 0xff50;
    pub const LEFT: u32 = 0xff51;
    pub const UP: u32 = 0xff52;
    pub const RIGHT: u32 = 0xff53;
    pub const DOWN: u32 = 0xff54;
    pub const PAGE_UP: u32 = 0xff55;
    pub const PAGE_DOWN: u32 = 0xff56;
    pub const END: u32 = 0xff57;
    pub const INSERT: u32 = 0xff63;
    pub const KP_ENTER: u32 = 0xff8d;
    pub const SYS_REQ: u32 = 0xff15;
    pub const PRINT: u32 = 0xff61;
    pub const F1: u32 = 0xffbe;
    pub const F2: u32 = 0xffbf;
    pub const F3: u32 = 0xffc0;
    pub const F4: u32 = 0xffc1;
    pub const SHIFT_L: u32 = 0xffe1;
    pub const CONTROL_L: u32 = 0xffe3;
    pub const ALT_L: u32 = 0xffe9;
    pub const DELETE: u32 = 0xffff;
    pub const SPACE: u32 = 0x20;
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

    /// The modifier keysyms to hold, in press order.
    pub fn keysyms(&self) -> Vec<u32> {
        let mut v = Vec::new();
        if self.ctrl {
            v.push(keysym::CONTROL_L);
        }
        if self.alt {
            v.push(keysym::ALT_L);
        }
        if self.shift {
            v.push(keysym::SHIFT_L);
        }
        v
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
    pub keysym: u32,
    pub mods: Mods,
    /// The key token (`return`, `q`, `f4`).
    pub key: String,
    /// The chord as written, lowercased.
    pub name: String,
}

fn code(key: &str) -> Option<u32> {
    use keysym::*;
    let k = match key {
        "return" | "enter" => RETURN,
        "keypadenter" => KP_ENTER,
        "tab" => TAB,
        "space" => SPACE,
        "delete" | "backspace" => BACKSPACE,
        "escape" | "esc" => ESCAPE,
        "forwarddelete" | "fwddelete" => DELETE,
        "home" => HOME,
        "end" => END,
        "pageup" => PAGE_UP,
        "pagedown" => PAGE_DOWN,
        "left" => LEFT,
        "right" => RIGHT,
        "down" => DOWN,
        "up" => UP,
        "help" => INSERT,
        "print" | "printscreen" | "prtsc" => PRINT,
        "sysrq" => SYS_REQ,
        "=" | "-" | "]" | "[" | "'" | ";" | "\\" | "," | "/" | "." | "`" => {
            key.chars().next()? as u32
        }
        _ => {
            let mut chars = key.chars();
            let (c, rest) = (chars.next()?, chars.as_str());
            if rest.is_empty() && (c.is_ascii_lowercase() || c.is_ascii_digit()) {
                return Some(c as u32);
            }
            if c == 'f' {
                let n: u32 = rest.parse().ok()?;
                if (1..=20).contains(&n) && !rest.starts_with('0') {
                    return Some(F1 + n - 1);
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
                "fn" | "super" | "meta" | "win" | "windows" => {
                    return Err(CapError::invalid_params(
                        "that modifier is not available on Linux",
                        Some("keys"),
                    ));
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
        let keysym = code(key)
            .ok_or_else(|| CapError::invalid_params("unknown key in the chord", Some("keys")))?;
        Ok(KeyChord {
            keysym,
            mods,
            key: key.to_string(),
            name: lower,
        })
    }

    /// Plain Esc (the stop key is never injectable while a session runs).
    pub fn is_bare_escape(&self) -> bool {
        self.keysym == keysym::ESCAPE && self.mods.is_empty()
    }

    pub fn is_escape_or_tab(&self) -> bool {
        self.keysym == keysym::ESCAPE || self.keysym == keysym::TAB
    }

    /// Chords that close or quit apps, log out, delete: refused unless the call is approved.
    /// The Mac rules (`cmd+q`, `cmd+w`, `cmd+delete`, with cmd = Ctrl) plus the Linux ones:
    /// Alt+F4 and Ctrl+F4 close windows, Shift+Delete deletes for good, Ctrl+Alt+Delete and
    /// Ctrl+Alt+Backspace end the session, Ctrl+Shift+Q logs out in GNOME apps.
    pub fn is_high_risk(&self) -> bool {
        let m = self.mods;
        if m.ctrl && matches!(self.key.as_str(), "q" | "w" | "delete" | "backspace") {
            return true;
        }
        if (m.alt || m.ctrl) && self.keysym == keysym::F4 {
            return true;
        }
        if m.shift && self.keysym == keysym::DELETE {
            return true;
        }
        m.ctrl && m.alt && matches!(self.keysym, keysym::DELETE | keysym::BACKSPACE)
    }

    /// Shortcuts that belong to the desktop, not to the app: refused on Linux whatever was
    /// approved. XTest and portal input is global (the Mac helper posts per process, so Spotlight
    /// is out of its reach), so these would open a run dialog, a terminal or a launcher, switch to
    /// a text console, or take a screenshot outside the app the tier and the card were for:
    ///
    /// - Ctrl+Alt+anything: Ctrl+Alt+T (terminal), Ctrl+Alt+F1..F12 (console switch),
    ///   Ctrl+Alt+Delete (log out / power dialog), Ctrl+Alt+Backspace, Ctrl+Alt+L (lock) and the
    ///   desktops' other Ctrl+Alt bindings;
    /// - Alt+F1 (GNOME Activities, KDE launcher), Alt+F2 (GNOME, Xfce and KRunner run dialogs),
    ///   Alt+F3 (Xfce app finder, KRunner), Alt+Space (KRunner, the window menu), with or without
    ///   Shift;
    /// - Ctrl+Esc (Xfce and LXQt app menus, KDE System Activity);
    /// - Print and Sys Req with any modifiers (screenshot tools, Alt+SysRq kernel keys).
    ///
    /// Not matched: Alt+F4 and Ctrl+F4 (close: asked, see [`Self::is_high_risk`]), Alt+Tab (a
    /// window switch; the next keystroke's focus check stops input that is not in the app),
    /// Alt+<letter> (menu mnemonics), Ctrl+<letter>, Ctrl+Shift+<letter>, F-keys alone.
    pub fn is_shell_chord(&self) -> bool {
        let m = self.mods;
        if matches!(self.keysym, keysym::PRINT | keysym::SYS_REQ) {
            return true;
        }
        if m.ctrl && m.alt {
            return true;
        }
        if m.alt
            && !m.ctrl
            && matches!(
                self.keysym,
                keysym::F1 | keysym::F2 | keysym::F3 | keysym::SPACE
            )
        {
            return true;
        }
        m.ctrl && !m.alt && self.keysym == keysym::ESCAPE
    }

    /// App-specific risk: in file managers, Delete and Ctrl+D move files to the trash.
    pub fn is_high_risk_in(&self, app_id: Option<&str>) -> bool {
        if self.is_high_risk() {
            return true;
        }
        let files = app_id.map(is_file_manager).unwrap_or(false);
        files && (self.keysym == keysym::DELETE || (self.mods.ctrl && self.key == "d"))
    }
}

/// Desktop ids of file managers (lowercase compare).
pub fn is_file_manager(id: &str) -> bool {
    matches!(
        id.to_ascii_lowercase().as_str(),
        "org.gnome.nautilus"
            | "nautilus"
            | "org.kde.dolphin"
            | "dolphin"
            | "thunar"
            | "nemo"
            | "pcmanfm"
            | "pcmanfm-qt"
            | "caja"
            | "org.gnome.files"
    )
}

/// Keys that send in messaging and mail apps (#270): an interact grant must not let Return send
/// a message as an ordinary write (docs/05 §3.1 classes third-party sends as destructive).
pub mod send_keys {
    use super::KeyChord;

    /// Desktop ids (lowercase) of messaging and mail apps on Linux.
    pub const APPS: &[&str] = &[
        "thunderbird",
        "org.mozilla.thunderbird",
        "evolution",
        "org.gnome.evolution",
        "geary",
        "org.gnome.geary",
        "kmail",
        "org.kde.kmail2",
        "mailspring",
        "slack",
        "discord",
        "signal-desktop",
        "org.signal.signal",
        "telegram-desktop",
        "org.telegram.desktop",
        "element-desktop",
        "im.riot.riot",
        "whatsapp-for-linux",
        "teams-for-linux",
        "zoom",
        "us.zoom.zoom",
        "skype",
        "viber",
        "org.gnome.fractal",
        "org.kde.neochat",
        "org.gnome.polari",
        "hexchat",
        "pidgin",
        "org.gnome.empathy",
        // Flatpak ids (mirrors the Gateway's SEND_LINUX_IDS).
        "com.slack.slack",
        "com.discordapp.discord",
        "eu.betterbird.betterbird",
        "betterbird",
        "io.element.element",
        "com.github.eneshecan.whatsappforlinux",
        "claws-mail",
        "org.claws_mail.claws-mail",
        "com.getmailspring.mailspring",
        "com.github.ientuaneb.teams-for-linux",
        "dino",
        "im.dino.dino",
        "io.github.hexchat",
    ];

    /// Whether the send rule covers `app_id`: any [`crate::app_id::aliases`] form of it (so the
    /// snap's `thunderbird_thunderbird` is Thunderbird) is in [`APPS`], ignoring case.
    pub fn is_messaging_app(app_id: Option<&str>) -> bool {
        let Some(id) = app_id else {
            return false;
        };
        crate::app_id::aliases(id)
            .iter()
            .any(|id| APPS.iter().any(|a| a.eq_ignore_ascii_case(id)))
    }

    /// Return / KP_Enter with any modifiers, Ctrl+Shift+D, and Alt+S.
    pub fn is_send_chord(c: &KeyChord) -> bool {
        if c.keysym == super::keysym::RETURN || c.keysym == super::keysym::KP_ENTER {
            return true;
        }
        (c.key == "d" && c.mods.ctrl && c.mods.shift)
            || (c.key == "s" && c.mods.alt && !c.mods.ctrl)
    }

    /// Typed text that contains a line break presses Return on the way.
    pub fn text_sends(text: &str) -> bool {
        text.chars()
            .any(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
    }
}

/// Splits text into chunks of at most `max` characters, never splitting a grapheme (emoji,
/// combining marks) across chunks; a single grapheme longer than `max` stays whole.
pub fn typing_chunks(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut n = 0usize;
    for g in text.graphemes(true) {
        let len = g.chars().count();
        if n + len > max && n > 0 {
            out.push(std::mem::take(&mut cur));
            n = 0;
        }
        cur.push_str(g);
        n += len;
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
    fn parses_mac_chords_to_keysyms() {
        let c = KeyChord::parse("cmd+shift+t").unwrap();
        assert_eq!(
            (c.keysym, c.mods),
            (
                b't' as u32,
                Mods {
                    ctrl: true,
                    alt: false,
                    shift: true
                }
            )
        );
        assert_eq!(c.name, "cmd+shift+t");
        assert_eq!(KeyChord::parse("Return").unwrap().keysym, keysym::RETURN);
        assert_eq!(
            KeyChord::parse("keypadenter").unwrap().keysym,
            keysym::KP_ENTER
        );
        assert_eq!(
            KeyChord::parse("opt+left").unwrap().mods,
            Mods {
                ctrl: false,
                alt: true,
                shift: false
            }
        );
        assert_eq!(KeyChord::parse("f5").unwrap().keysym, 0xffc2);
        assert_eq!(KeyChord::parse("f20").unwrap().keysym, keysym::F1 + 19);
        assert_eq!(KeyChord::parse("delete").unwrap().keysym, keysym::BACKSPACE);
        assert_eq!(
            KeyChord::parse("forwarddelete").unwrap().keysym,
            keysym::DELETE
        );
        assert_eq!(KeyChord::parse("ctrl+=").unwrap().keysym, b'=' as u32);
        assert_eq!(KeyChord::parse("⌘+c").unwrap().keysym, b'c' as u32);
        assert_eq!(KeyChord::parse("cmd + 1").unwrap().keysym, b'1' as u32);
    }

    #[test]
    fn rejects_bad_chords_and_the_super_key() {
        for bad in [
            "cmd++", "", "cmd+", "q+cmd", "a+b", "f21", "f0", "hyper+a", "fn+left", "f05",
            "super+l", "meta+a", "win+d",
        ] {
            let e = KeyChord::parse(bad).unwrap_err();
            assert_eq!(e.code, "invalid_params", "{bad}");
            assert_eq!(e.details["field"], "keys");
        }
    }

    #[test]
    fn risk_and_escape() {
        assert!(KeyChord::parse("escape").unwrap().is_bare_escape());
        assert!(!KeyChord::parse("shift+escape").unwrap().is_bare_escape());
        for risky in [
            "cmd+q",
            "cmd+w",
            "ctrl+w",
            "cmd+delete",
            "alt+f4",
            "ctrl+f4",
            "shift+forwarddelete",
            "ctrl+alt+forwarddelete",
            "ctrl+alt+backspace",
        ] {
            assert!(KeyChord::parse(risky).unwrap().is_high_risk(), "{risky}");
        }
        for safe in [
            "cmd+s",
            "return",
            "forwarddelete",
            "cmd+shift+t",
            "f4",
            "alt+tab",
        ] {
            assert!(!KeyChord::parse(safe).unwrap().is_high_risk(), "{safe}");
        }
        let del = KeyChord::parse("forwarddelete").unwrap();
        assert!(del.is_high_risk_in(Some("org.gnome.Nautilus")));
        assert!(!del.is_high_risk_in(Some("org.gnome.TextEditor")));
    }

    #[test]
    fn desktop_shortcuts_are_shell_chords_and_near_misses_are_not() {
        for shell in [
            "alt+f2",
            "opt+f2",
            "alt+shift+f2",
            "alt+space",
            "alt+f1",
            "alt+f3",
            "ctrl+alt+t",
            "cmd+opt+t",
            "ctrl+alt+f1",
            "ctrl+alt+f7",
            "ctrl+alt+f12",
            "ctrl+alt+forwarddelete",
            "ctrl+alt+backspace",
            "ctrl+alt+l",
            "ctrl+alt+shift+a",
            "ctrl+escape",
            "print",
            "printscreen",
            "shift+print",
            "alt+print",
            "ctrl+prtsc",
            "sysrq",
            "alt+sysrq",
        ] {
            assert!(KeyChord::parse(shell).unwrap().is_shell_chord(), "{shell}");
        }
        for app in [
            "alt+f4",
            "ctrl+f4",
            "ctrl+t",
            "cmd+t",
            "alt+tab",
            "ctrl+shift+t",
            "f2",
            "f1",
            "alt+f",
            "ctrl+p",
            "ctrl+space",
            "shift+space",
            "space",
            "escape",
            "shift+escape",
            "alt+f5",
            "ctrl+f2",
            "shift+f10",
            "return",
            "cmd+q",
        ] {
            assert!(!KeyChord::parse(app).unwrap().is_shell_chord(), "{app}");
        }
        // Alt+F4 stays an approval, not a refusal.
        assert!(KeyChord::parse("alt+f4").unwrap().is_high_risk());
    }

    #[test]
    fn send_keys() {
        assert!(send_keys::is_messaging_app(Some("Thunderbird")));
        assert!(!send_keys::is_messaging_app(Some("org.gnome.TextEditor")));
        // Snap desktop ids (`<snap>_<app>`) and Flatpak ids, any case.
        for id in [
            "thunderbird_thunderbird",
            "Slack_Slack",
            "discord_discord",
            "signal-desktop_signal-desktop",
            "telegram-desktop_telegram-desktop",
            "com.slack.Slack",
            "com.discordapp.Discord",
            "eu.betterbird.Betterbird",
            "io.element.Element",
            "com.github.eneshecan.WhatsAppForLinux",
        ] {
            assert!(send_keys::is_messaging_app(Some(id)), "{id}");
        }
        for id in ["thunderbirdx", "spotify_spotify", "com.slack.slackx"] {
            assert!(!send_keys::is_messaging_app(Some(id)), "{id}");
        }
        assert!(send_keys::is_send_chord(
            &KeyChord::parse("return").unwrap()
        ));
        assert!(send_keys::is_send_chord(
            &KeyChord::parse("cmd+return").unwrap()
        ));
        assert!(send_keys::is_send_chord(
            &KeyChord::parse("cmd+shift+d").unwrap()
        ));
        assert!(send_keys::is_send_chord(&KeyChord::parse("alt+s").unwrap()));
        assert!(!send_keys::is_send_chord(
            &KeyChord::parse("cmd+s").unwrap()
        ));
        assert!(
            send_keys::text_sends("hi\nthere")
                && send_keys::text_sends("a\u{2029}")
                && !send_keys::text_sends("hi")
        );
    }

    #[test]
    fn chunks_keep_graphemes_whole() {
        assert_eq!(
            typing_chunks("abc", 2),
            vec!["ab".to_string(), "c".to_string()]
        );
        let fam = "👨‍👩‍👧‍👦";
        let chunks = typing_chunks(&format!("a{fam}b"), 4);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[1], fam);
        let e = "e\u{301}";
        assert_eq!(typing_chunks(&format!("{e}{e}"), 3).len(), 2);
    }
}
