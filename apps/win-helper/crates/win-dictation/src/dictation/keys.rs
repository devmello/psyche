//! Hold-to-talk key state (pure): the Windows port of `DictationKeyTracker`, `DictationKeySet`
//! and `DictationWatchPlan`.
//!
//! The wire keys stay the mac helper's (`fn`, `rightOption`, `rightCommand`; the desktop and the
//! protocol enum send them) and map to Windows virtual keys: `rightOption` → Right Alt,
//! `rightCommand` → Right Ctrl, `fn` → a configurable key (Right Alt unless
//! `PSYCHE_DICTATION_FN_KEY` or [`set_fn_key`] names another), since a laptop's Fn key never
//! reaches Windows.
//!
//! Mac semantics kept exactly: each watched key holds independently; a non-modifier key pressed
//! while a watched key is held is a chord (fn+arrow), which ends the hold at once and swallows
//! the release that follows. Modifiers never chord (on the mac they arrive as `flagsChanged`,
//! not `keyDown`), which also covers the fake Left Ctrl that AltGr layouts synthesize with Right
//! Alt. Windows-only additions: key auto-repeat is ignored (macOS never repeats modifiers),
//! injected events are ignored (`LLKHF_INJECTED`), and a lost key-up (lock screen, secure
//! desktop) is repaired by [`KeySet::resync`].

use crate::error::CapError;
use serde::Deserialize;
use std::sync::atomic::{AtomicU16, Ordering};

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_CAPITAL: u16 = 0x14;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;
pub const VK_LSHIFT: u16 = 0xA0;
pub const VK_RSHIFT: u16 = 0xA1;
pub const VK_LCONTROL: u16 = 0xA2;
pub const VK_RCONTROL: u16 = 0xA3;
pub const VK_LMENU: u16 = 0xA4;
pub const VK_RMENU: u16 = 0xA5;
/// Scan code of the Left Ctrl that AltGr keyboard layouts synthesize before Right Alt.
pub const ALTGR_FAKE_LCTRL_SCAN: u32 = 0x21D;
/// An unassigned virtual key: pressing it while Alt or Win is held stops the bare release from
/// opening the menu bar or Start (the "menu mask"; it types nothing).
pub const VK_MENU_MASK: u16 = 0xE8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DictationKey {
    Fn,
    RightOption,
    RightCommand,
}

impl DictationKey {
    pub fn as_str(self) -> &'static str {
        match self {
            DictationKey::Fn => "fn",
            DictationKey::RightOption => "rightOption",
            DictationKey::RightCommand => "rightCommand",
        }
    }

    /// The Windows virtual key this wire key watches.
    pub fn vk(self) -> u16 {
        match self {
            DictationKey::Fn => fn_key(),
            DictationKey::RightOption => VK_RMENU,
            DictationKey::RightCommand => VK_RCONTROL,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyRole {
    Dictation,
    Voice,
}

impl KeyRole {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyRole::Dictation => "dictation",
            KeyRole::Voice => "voice",
        }
    }
}

static FN_KEY: AtomicU16 = AtomicU16::new(0);

/// The virtual key `fn` stands for: [`set_fn_key`], else `PSYCHE_DICTATION_FN_KEY`, else Right Alt.
pub fn fn_key() -> u16 {
    match FN_KEY.load(Ordering::Relaxed) {
        0 => std::env::var("PSYCHE_DICTATION_FN_KEY")
            .ok()
            .and_then(|s| parse_key_name(&s))
            .unwrap_or(VK_RMENU),
        vk => vk,
    }
}

/// Binds `fn` to `vk` (0 restores the default). Takes effect on the next `dictation.watch`.
pub fn set_fn_key(vk: u16) {
    FN_KEY.store(vk, Ordering::Relaxed);
}

/// `rightAlt`, `rightCtrl`, `rightShift`, `rightWin`, `leftWin`, `apps`, `scrollLock`, `pause`,
/// `f13`…`f24`, or a virtual-key code (`0xA5`, `165`).
pub fn parse_key_name(s: &str) -> Option<u16> {
    let s = s.trim();
    let named = match s.to_ascii_lowercase().as_str() {
        "rightalt" | "altgr" => Some(VK_RMENU),
        "rightctrl" | "rightcontrol" => Some(VK_RCONTROL),
        "rightshift" => Some(VK_RSHIFT),
        "rightwin" => Some(VK_RWIN),
        "leftwin" => Some(VK_LWIN),
        "apps" | "menu" => Some(0x5D),
        "scrolllock" => Some(0x91),
        "pause" => Some(0x13),
        other => other
            .strip_prefix('f')
            .and_then(|n| n.parse::<u16>().ok())
            .filter(|n| (13..=24).contains(n))
            .map(|n| 0x7C + n - 13),
    };
    named.or_else(|| {
        let v = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
            Some(hex) => u16::from_str_radix(hex, 16).ok(),
            None => s.parse::<u16>().ok(),
        }?;
        (0x01..=0xFE).contains(&v).then_some(v)
    })
}

/// Shift, Ctrl, Alt (generic and sided), Win and Caps Lock: keys the mac reports as
/// `flagsChanged`, which never make a chord.
pub fn is_modifier(vk: u16) -> bool {
    matches!(
        vk,
        VK_SHIFT
            | VK_CONTROL
            | VK_MENU
            | VK_CAPITAL
            | VK_LWIN
            | VK_RWIN
            | VK_LSHIFT
            | VK_RSHIFT
            | VK_LCONTROL
            | VK_RCONTROL
            | VK_LMENU
            | VK_RMENU
    )
}

/// One keyboard event as the low-level hook sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub vk: u16,
    pub scan: u32,
    pub down: bool,
    /// `LLKHF_INJECTED`: SendInput / keybd_event, ours or anyone's.
    pub injected: bool,
}

impl KeyEvent {
    pub fn down(vk: u16) -> Self {
        KeyEvent {
            vk,
            scan: 0,
            down: true,
            injected: false,
        }
    }
    pub fn up(vk: u16) -> Self {
        KeyEvent {
            vk,
            scan: 0,
            down: false,
            injected: false,
        }
    }
}

/// Hold state of one watched key (`DictationKeyTracker`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyTracker {
    pub vk: u16,
    is_down: bool,
    chorded: bool,
}

impl KeyTracker {
    pub fn new(vk: u16) -> Self {
        KeyTracker {
            vk,
            is_down: false,
            chorded: false,
        }
    }

    pub fn is_down(&self) -> bool {
        self.is_down
    }

    /// Physically held (a hold, or a chorded press whose release is still to come).
    pub fn is_pressed(&self) -> bool {
        self.is_down || self.chorded
    }

    /// Feeds a down/up of this tracker's own key; returns the new state when it changed.
    pub fn key(&mut self, down: bool) -> Option<bool> {
        if down {
            // Auto-repeat while held, or while a chorded press is still held: no change.
            if self.is_down || self.chorded {
                return None;
            }
            self.is_down = true;
            Some(true)
        } else if self.chorded {
            // The release after a chord is swallowed.
            self.chorded = false;
            self.is_down = false;
            None
        } else if self.is_down {
            self.is_down = false;
            Some(false)
        } else {
            None
        }
    }

    /// Another (non-modifier) key went down; returns false when it turned the hold into a chord.
    pub fn chord(&mut self) -> Option<bool> {
        if !self.is_down || self.chorded {
            return None;
        }
        self.chorded = true;
        self.is_down = false;
        Some(false)
    }

    /// Repairs state against the physical key: a release the hook never saw ends the hold.
    pub fn resync(&mut self, physically_down: bool) -> Option<bool> {
        if physically_down {
            return None;
        }
        self.chorded = false;
        if self.is_down {
            self.is_down = false;
            return Some(false);
        }
        None
    }
}

/// One watched key and, for a two-key watch, its role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatchedKey {
    pub key: DictationKey,
    pub role: Option<KeyRole>,
    pub vk: u16,
}

impl WatchedKey {
    pub fn new(key: DictationKey, role: Option<KeyRole>) -> Self {
        WatchedKey {
            key,
            role,
            vk: key.vk(),
        }
    }
}

/// A hold-to-talk transition of one watched key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyChange {
    pub key: DictationKey,
    pub role: Option<KeyRole>,
    pub down: bool,
}

/// Trackers for one or two watched keys (`DictationKeySet`).
#[derive(Clone, Debug)]
pub struct KeySet {
    pub watched: Vec<WatchedKey>,
    trackers: Vec<KeyTracker>,
    /// The synthesized Left Ctrl just went down (the next Right Alt is AltGr).
    fake_lctrl: bool,
    /// The current Right Alt press is AltGr (decided per press: the owner may switch layouts).
    altgr: bool,
}

impl KeySet {
    pub fn new(watched: Vec<WatchedKey>) -> Self {
        let trackers = watched.iter().map(|w| KeyTracker::new(w.vk)).collect();
        KeySet {
            watched,
            trackers,
            fake_lctrl: false,
            altgr: false,
        }
    }

    pub fn trackers(&self) -> &[KeyTracker] {
        &self.trackers
    }

    /// The current (or last) Right Alt press came with an AltGr layout's synthesized Left Ctrl.
    pub fn altgr_layout(&self) -> bool {
        self.altgr
    }

    fn change(&self, i: usize, down: bool) -> KeyChange {
        KeyChange {
            key: self.watched[i].key,
            role: self.watched[i].role,
            down,
        }
    }

    /// Feeds one hook event. Injected events are ignored (ours included).
    pub fn handle(&mut self, ev: &KeyEvent) -> Vec<KeyChange> {
        if ev.injected {
            return vec![];
        }
        if ev.vk == VK_LCONTROL && ev.scan == ALTGR_FAKE_LCTRL_SCAN {
            if ev.down {
                self.fake_lctrl = true;
            }
            return vec![];
        }
        let fake_before = std::mem::take(&mut self.fake_lctrl);
        if ev.vk == VK_RMENU
            && ev.down
            && !self
                .trackers
                .iter()
                .any(|t| t.vk == VK_RMENU && t.is_pressed())
        {
            self.altgr = fake_before;
        }
        let mut out = vec![];
        if self.watched.iter().any(|w| w.vk == ev.vk) {
            for i in 0..self.trackers.len() {
                if self.trackers[i].vk == ev.vk
                    && let Some(down) = self.trackers[i].key(ev.down)
                {
                    out.push(self.change(i, down));
                }
            }
            return out;
        }
        if ev.down && !is_modifier(ev.vk) {
            for i in 0..self.trackers.len() {
                if let Some(down) = self.trackers[i].chord() {
                    out.push(self.change(i, down));
                }
            }
        }
        out
    }

    /// Repairs every tracker against `is_down(vk)` (physical state).
    pub fn resync(&mut self, is_down: impl Fn(u16) -> bool) -> Vec<KeyChange> {
        let mut out = vec![];
        for i in 0..self.trackers.len() {
            let vk = self.trackers[i].vk;
            if let Some(down) = self.trackers[i].resync(is_down(vk)) {
                out.push(self.change(i, down));
            }
        }
        out
    }

    /// Whether a press of `vk` held this long should get the menu mask: bare Alt and Win
    /// releases open the menu bar / Start, which would steal focus from the dictation target.
    /// AltGr layouts never open menus from Right Alt.
    pub fn wants_menu_mask(&self, vk: u16) -> bool {
        let held = self.trackers.iter().any(|t| t.vk == vk && t.is_down());
        held && match vk {
            VK_RMENU => !self.altgr,
            VK_LMENU | VK_LWIN | VK_RWIN => true,
            _ => false,
        }
    }
}

/// `dictation.watch` params (`DictationWatchParams`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct WatchParams {
    #[serde(default)]
    pub key: Option<DictationKey>,
    #[serde(default)]
    pub keys: Option<Vec<WatchKeyParam>>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct WatchKeyParam {
    pub key: DictationKey,
    pub role: KeyRole,
}

/// The keys a `dictation.watch` call asks for; empty means stop (`DictationWatchPlan`). `keys`
/// wins over `key`; its keys and roles must differ, and on Windows two names must not land on
/// the same physical key (`fn` bound to Right Alt and `rightOption`).
pub fn watch_plan(p: &WatchParams) -> Result<Vec<WatchedKey>, CapError> {
    let Some(keys) = &p.keys else {
        return Ok(p
            .key
            .map(|k| vec![WatchedKey::new(k, None)])
            .unwrap_or_default());
    };
    if !(1..=2).contains(&keys.len()) {
        return Err(CapError::invalid_params(
            "keys holds one or two keys",
            Some("keys"),
        ));
    }
    let planned: Vec<WatchedKey> = keys
        .iter()
        .map(|k| WatchedKey::new(k.key, Some(k.role)))
        .collect();
    if planned.len() == 2 {
        if planned[0].key == planned[1].key || planned[0].vk == planned[1].vk {
            return Err(CapError::invalid_params(
                "each key is watched once",
                Some("keys"),
            ));
        }
        if planned[0].role == planned[1].role {
            return Err(CapError::invalid_params(
                "each role is used once",
                Some("keys"),
            ));
        }
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(keys: &[(DictationKey, Option<KeyRole>, u16)]) -> KeySet {
        KeySet::new(
            keys.iter()
                .map(|&(key, role, vk)| WatchedKey { key, role, vk })
                .collect(),
        )
    }

    fn ch(key: DictationKey, role: Option<KeyRole>, down: bool) -> KeyChange {
        KeyChange { key, role, down }
    }

    #[test]
    fn tracker_hold_repeat_and_chord() {
        let mut t = KeyTracker::new(VK_RCONTROL);
        assert_eq!(t.key(true), Some(true));
        assert_eq!(t.key(true), None); // auto-repeat
        assert_eq!(t.key(false), Some(false));
        assert_eq!(t.key(false), None);

        // Ctrl+arrow is a chord: it releases at once and the real release is swallowed.
        assert_eq!(t.key(true), Some(true));
        assert_eq!(t.chord(), Some(false));
        assert_eq!(t.chord(), None);
        assert_eq!(t.key(true), None); // repeat of the chorded, still-held key
        assert_eq!(t.key(false), None);
        assert!(!t.is_down());
        assert_eq!(t.chord(), None); // typing while not held is ignored
        assert_eq!(t.key(true), Some(true)); // a fresh press after the chord
    }

    #[test]
    fn single_key_press_hold_release() {
        let mut s = set(&[(DictationKey::RightCommand, None, VK_RCONTROL)]);
        assert_eq!(
            s.handle(&KeyEvent::down(VK_RCONTROL)),
            [ch(DictationKey::RightCommand, None, true)]
        );
        for _ in 0..5 {
            assert!(s.handle(&KeyEvent::down(VK_RCONTROL)).is_empty()); // held: repeats
        }
        assert!(s.handle(&KeyEvent::down(VK_LSHIFT)).is_empty()); // another modifier
        assert!(s.handle(&KeyEvent::up(VK_LSHIFT)).is_empty());
        assert_eq!(
            s.handle(&KeyEvent::up(VK_RCONTROL)),
            [ch(DictationKey::RightCommand, None, false)]
        );
        // Left Ctrl is a different key.
        assert!(s.handle(&KeyEvent::down(VK_LCONTROL)).is_empty());
    }

    #[test]
    fn chord_releases_and_swallows_the_release() {
        let mut s = set(&[(DictationKey::RightCommand, None, VK_RCONTROL)]);
        s.handle(&KeyEvent::down(VK_RCONTROL));
        assert_eq!(
            s.handle(&KeyEvent::down(0x43)),
            [ch(DictationKey::RightCommand, None, false)]
        ); // Ctrl+C
        assert!(s.handle(&KeyEvent::up(0x43)).is_empty());
        assert!(s.handle(&KeyEvent::up(VK_RCONTROL)).is_empty());
        assert!(s.handle(&KeyEvent::down(0x43)).is_empty());
    }

    #[test]
    fn injected_events_are_ignored() {
        let mut s = set(&[(DictationKey::RightOption, None, VK_RMENU)]);
        let inj = KeyEvent {
            vk: VK_RMENU,
            scan: 0x38,
            down: true,
            injected: true,
        };
        assert!(s.handle(&inj).is_empty());
        s.handle(&KeyEvent::down(VK_RMENU));
        // Our own typing (injected unicode packets, the menu mask) never chords the hold.
        assert!(
            s.handle(&KeyEvent {
                vk: 0xE7,
                scan: 0,
                down: true,
                injected: true
            })
            .is_empty()
        );
        assert!(
            s.handle(&KeyEvent {
                vk: VK_MENU_MASK,
                scan: 0,
                down: true,
                injected: true
            })
            .is_empty()
        );
        assert!(s.trackers()[0].is_down());
    }

    #[test]
    fn altgr_synthesized_left_ctrl_is_not_a_chord() {
        let mut s = set(&[(DictationKey::RightOption, None, VK_RMENU)]);
        // AltGr layouts: LCtrl (scan 0x21D) down, RAlt down, both repeat, both up.
        let fake = |down| KeyEvent {
            vk: VK_LCONTROL,
            scan: ALTGR_FAKE_LCTRL_SCAN,
            down,
            injected: false,
        };
        assert!(s.handle(&fake(true)).is_empty());
        assert_eq!(
            s.handle(&KeyEvent {
                vk: VK_RMENU,
                scan: 0x38,
                down: true,
                injected: false
            }),
            [ch(DictationKey::RightOption, None, true)]
        );
        assert!(s.handle(&fake(true)).is_empty());
        assert!(s.altgr_layout());
        assert!(
            !s.wants_menu_mask(VK_RMENU),
            "AltGr never opens the menu bar"
        );
        assert!(s.handle(&fake(false)).is_empty());
        assert_eq!(
            s.handle(&KeyEvent::up(VK_RMENU)),
            [ch(DictationKey::RightOption, None, false)]
        );
        // AltGr+E (€) is a chord, like Option+letter on the mac.
        s.handle(&fake(true));
        s.handle(&KeyEvent::down(VK_RMENU));
        assert_eq!(
            s.handle(&KeyEvent::down(0x45)),
            [ch(DictationKey::RightOption, None, false)]
        );
        s.handle(&KeyEvent::up(VK_RMENU));
        // After switching to a layout without AltGr, a plain Right Alt hold is masked again.
        s.handle(&KeyEvent::down(VK_RMENU));
        assert!(!s.altgr_layout());
        assert!(s.wants_menu_mask(VK_RMENU));
    }

    #[test]
    fn menu_mask_only_for_bare_alt_or_win_holds() {
        let mut s = set(&[
            (DictationKey::RightOption, None, VK_RMENU),
            (
                DictationKey::RightCommand,
                Some(KeyRole::Voice),
                VK_RCONTROL,
            ),
        ]);
        assert!(!s.wants_menu_mask(VK_RMENU));
        s.handle(&KeyEvent::down(VK_RMENU));
        assert!(s.wants_menu_mask(VK_RMENU));
        s.handle(&KeyEvent::down(VK_RCONTROL));
        assert!(!s.wants_menu_mask(VK_RCONTROL));
        s.handle(&KeyEvent::down(0x41)); // chord: no longer a hold
        assert!(!s.wants_menu_mask(VK_RMENU));
    }

    #[test]
    fn two_keys_hold_independently() {
        let mut s = set(&[
            (DictationKey::Fn, Some(KeyRole::Dictation), VK_RWIN),
            (DictationKey::RightOption, Some(KeyRole::Voice), VK_RMENU),
        ]);
        assert_eq!(
            s.handle(&KeyEvent::down(VK_RMENU)),
            [ch(DictationKey::RightOption, Some(KeyRole::Voice), true)]
        );
        assert_eq!(
            s.handle(&KeyEvent::down(VK_RWIN)),
            [ch(DictationKey::Fn, Some(KeyRole::Dictation), true)]
        );
        assert_eq!(
            s.handle(&KeyEvent::up(VK_RMENU)),
            [ch(DictationKey::RightOption, Some(KeyRole::Voice), false)]
        );
        // A key press while fn is still held chords only fn.
        assert_eq!(
            s.handle(&KeyEvent::down(0x26)),
            [ch(DictationKey::Fn, Some(KeyRole::Dictation), false)]
        );
        assert!(s.handle(&KeyEvent::up(VK_RWIN)).is_empty());
        assert!(s.handle(&KeyEvent::down(0x26)).is_empty());
    }

    #[test]
    fn chord_while_both_held_releases_both_and_a_watched_non_modifier_is_not_a_chord() {
        let mut s = set(&[
            (
                DictationKey::RightCommand,
                Some(KeyRole::Dictation),
                VK_RCONTROL,
            ),
            (DictationKey::Fn, Some(KeyRole::Voice), 0x7C),
        ]);
        s.handle(&KeyEvent::down(VK_RCONTROL));
        // fn bound to F13 (a non-modifier) pressed during the other hold: its own hold, no chord.
        assert_eq!(
            s.handle(&KeyEvent::down(0x7C)),
            [ch(DictationKey::Fn, Some(KeyRole::Voice), true)]
        );
        let both = s.handle(&KeyEvent::down(0x41));
        assert_eq!(
            both.iter().map(|c| c.down).collect::<Vec<_>>(),
            [false, false]
        );
    }

    #[test]
    fn toggle_mode_sees_one_down_per_press() {
        // The desktop's toggle mode starts/stops on each `down`; repeats must not re-toggle.
        let mut s = set(&[(DictationKey::RightCommand, None, VK_RCONTROL)]);
        let mut downs = 0;
        for _ in 0..3 {
            for _ in 0..10 {
                downs += s
                    .handle(&KeyEvent::down(VK_RCONTROL))
                    .iter()
                    .filter(|c| c.down)
                    .count();
            }
            s.handle(&KeyEvent::up(VK_RCONTROL));
        }
        assert_eq!(downs, 3);
    }

    #[test]
    fn resync_ends_a_hold_whose_release_was_lost() {
        let mut s = set(&[(DictationKey::RightCommand, None, VK_RCONTROL)]);
        s.handle(&KeyEvent::down(VK_RCONTROL));
        assert!(s.resync(|_| true).is_empty());
        assert_eq!(
            s.resync(|_| false),
            [ch(DictationKey::RightCommand, None, false)]
        );
        assert!(s.resync(|_| false).is_empty());
        // A chorded press whose release was lost is cleared too, so the next press counts.
        s.handle(&KeyEvent::down(VK_RCONTROL));
        s.handle(&KeyEvent::down(0x41));
        assert!(s.resync(|_| false).is_empty());
        assert_eq!(
            s.handle(&KeyEvent::down(VK_RCONTROL)),
            [ch(DictationKey::RightCommand, None, true)]
        );
    }

    #[test]
    fn key_mapping() {
        assert_eq!(DictationKey::RightOption.vk(), VK_RMENU);
        assert_eq!(DictationKey::RightCommand.vk(), VK_RCONTROL);
        assert_eq!(parse_key_name("rightWin"), Some(VK_RWIN));
        assert_eq!(parse_key_name("F13"), Some(0x7C));
        assert_eq!(parse_key_name("f24"), Some(0x87));
        assert_eq!(parse_key_name("0xA3"), Some(VK_RCONTROL));
        assert_eq!(parse_key_name("165"), Some(VK_RMENU));
        assert_eq!(parse_key_name("f12"), None);
        assert_eq!(parse_key_name("0x1FF"), None);
        assert_eq!(parse_key_name("nope"), None);
        assert!(is_modifier(VK_LWIN) && is_modifier(VK_CAPITAL) && !is_modifier(0x41));
    }

    #[test]
    fn plan() {
        let p =
            |v: serde_json::Value| watch_plan(&serde_json::from_value::<WatchParams>(v).unwrap());
        let rc = |k, r| WatchedKey::new(k, r);
        assert_eq!(
            p(serde_json::json!({"key": "rightCommand"})).unwrap(),
            [rc(DictationKey::RightCommand, None)]
        );
        assert!(p(serde_json::json!({"key": null})).unwrap().is_empty());
        assert!(p(serde_json::json!({})).unwrap().is_empty());
        // keys wins over key.
        let two = p(serde_json::json!({"key": "fn", "keys": [{"key": "rightCommand", "role": "voice"}, {"key": "fn", "role": "dictation"}]})).unwrap();
        assert_eq!(
            two,
            [
                rc(DictationKey::RightCommand, Some(KeyRole::Voice)),
                rc(DictationKey::Fn, Some(KeyRole::Dictation))
            ]
        );
        let err = |v| p(v).unwrap_err().details["field"].clone();
        assert_eq!(
            err(
                serde_json::json!({"keys": [{"key": "fn", "role": "voice"}, {"key": "fn", "role": "dictation"}]})
            ),
            "keys"
        );
        assert_eq!(
            err(
                serde_json::json!({"keys": [{"key": "fn", "role": "voice"}, {"key": "rightCommand", "role": "voice"}]})
            ),
            "keys"
        );
        assert_eq!(err(serde_json::json!({"keys": []})), "keys");
        // fn defaults to Right Alt, so fn + rightOption is one physical key.
        set_fn_key(0);
        if std::env::var("PSYCHE_DICTATION_FN_KEY").is_err() {
            assert!(p(serde_json::json!({"keys": [{"key": "fn", "role": "voice"}, {"key": "rightOption", "role": "dictation"}]})).is_err());
        }
    }
}
