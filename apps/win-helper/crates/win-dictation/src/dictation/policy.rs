//! The pure half of `dictation.target` and `dictation.insert` (`DictationPolicy`,
//! `DictationInserter`), tested without a desktop.
//!
//! Inserted text is keystrokes into another app, never owner input to the agent. The helper
//! refuses password fields and Psyche's own windows, and collapses control characters (newlines
//! and tabs included) to spaces so dictation can never press Enter or Tab.

use crate::error::{CapError, ErrorCode};
use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_CHARS: usize = 4000;
/// Longest text typed as unicode keystrokes; longer text is pasted (UTF-16 units, ~16 SendInput
/// chunks).
pub const TYPE_MAX_UNITS: usize = 256;
/// The UIA write reads and rewrites the whole value: only for fields up to this size.
pub const UIA_MAX_VALUE_UNITS: usize = 100_000;

/// Psyche's own processes (the desktop dictates through its composer).
pub const OWN_EXES: &[&str] = &["psyche.exe", "psyche-helper.exe", "psyche-win-helper.exe"];

/// UI Automation control type ids (UIA_*ControlTypeId) and their programmatic names.
const CONTROL_TYPES: &[(i32, &str)] = &[
    (50000, "Button"),
    (50001, "Calendar"),
    (50002, "CheckBox"),
    (50003, "ComboBox"),
    (50004, "Edit"),
    (50005, "Hyperlink"),
    (50006, "Image"),
    (50007, "ListItem"),
    (50008, "List"),
    (50009, "Menu"),
    (50010, "MenuBar"),
    (50011, "MenuItem"),
    (50012, "ProgressBar"),
    (50013, "RadioButton"),
    (50014, "ScrollBar"),
    (50015, "Slider"),
    (50016, "Spinner"),
    (50017, "StatusBar"),
    (50018, "Tab"),
    (50019, "TabItem"),
    (50020, "Text"),
    (50021, "ToolBar"),
    (50022, "ToolTip"),
    (50023, "Tree"),
    (50024, "TreeItem"),
    (50025, "Custom"),
    (50026, "Group"),
    (50027, "Thumb"),
    (50028, "DataGrid"),
    (50029, "DataItem"),
    (50030, "Document"),
    (50031, "SplitButton"),
    (50032, "Window"),
    (50033, "Pane"),
    (50034, "Header"),
    (50035, "HeaderItem"),
    (50036, "Table"),
    (50037, "TitleBar"),
    (50038, "Separator"),
    (50039, "SemanticZoom"),
    (50040, "AppBar"),
];

pub fn control_type_name(id: i32) -> Option<&'static str> {
    CONTROL_TYPES
        .iter()
        .find(|(i, _)| *i == id)
        .map(|(_, n)| *n)
}

/// Control types that never take typed text: a focused button, list or menu would treat the
/// keystrokes as shortcuts (the mac's "no caret, not a text role"). Unknown surfaces (Pane,
/// Custom, Window, Group, Document) are allowed, like a missing AX role.
const NON_TEXT_TYPES: &[&str] = &[
    "Button",
    "Calendar",
    "CheckBox",
    "Hyperlink",
    "Image",
    "ListItem",
    "List",
    "Menu",
    "MenuBar",
    "MenuItem",
    "ProgressBar",
    "RadioButton",
    "ScrollBar",
    "Slider",
    "StatusBar",
    "Tab",
    "TabItem",
    "ToolBar",
    "ToolTip",
    "Tree",
    "TreeItem",
    "Thumb",
    "DataGrid",
    "SplitButton",
    "Header",
    "HeaderItem",
    "Table",
    "TitleBar",
    "Separator",
    "AppBar",
];

/// UI frameworks whose ValuePattern writes behave like typing into a native edit control.
/// Browsers and Electron ("Chrome") are excluded: a value write there bypasses the page's input
/// events (React state), so they are typed into, as the mac does when Chromium ignores AX writes.
const UIA_WRITE_FRAMEWORKS: &[&str] = &["Win32", "WinForm", "WPF", "XAML"];

/// What UIA says the focused element accepts (never its contents).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ElementInfo {
    pub control_type: i32,
    pub framework_id: String,
    /// ValuePattern present and not read-only.
    pub value_settable: bool,
    pub has_text_pattern: bool,
}

impl ElementInfo {
    pub fn role(&self) -> Option<&'static str> {
        control_type_name(self.control_type)
    }

    pub fn can_take_text(&self) -> bool {
        self.value_settable
    }

    /// The UIA write keeps the caret only on single native edit controls: it rewrites the value
    /// with the selection replaced, then puts the caret after the inserted text with TextPattern.
    pub fn uia_writable(&self) -> bool {
        self.value_settable
            && self.has_text_pattern
            && self.role() == Some("Edit")
            && UIA_WRITE_FRAMEWORKS.contains(&self.framework_id.as_str())
    }
}

/// The focused app and, when UIA exposes one, its focused element.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Focus {
    pub pid: u32,
    /// The helper-wide app id (`psyche_win_computer::app_id`): the lowercase executable file
    /// name, the same id `apps.list` and `computer.*` report.
    pub bundle_id: Option<String>,
    /// Full executable path.
    pub exe: Option<String>,
    /// Package family name, for packaged apps.
    pub package_family_name: Option<String>,
    pub app_name: String,
    pub role: Option<String>,
    /// UIA `IsPassword`.
    pub secure: bool,
    pub element: Option<ElementInfo>,
    /// The process runs at a higher integrity level (elevated): Windows drops our input there.
    pub elevated: bool,
}

impl Focus {
    pub fn app(pid: u32, bundle_id: Option<&str>, app_name: &str) -> Self {
        Focus {
            pid,
            bundle_id: bundle_id.map(str::to_string),
            exe: None,
            package_family_name: None,
            app_name: app_name.to_string(),
            role: None,
            secure: false,
            element: None,
            elevated: false,
        }
    }
}

/// Why the focused element cannot take dictated text (`DictationRefusal`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NoFocus,
    SecureField,
    OwnWindow,
    NotEditable,
    FocusChanged,
}

impl Refusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Refusal::NoFocus => "no_focus",
            Refusal::SecureField => "secure_field",
            Refusal::OwnWindow => "own_window",
            Refusal::NotEditable => "not_editable",
            Refusal::FocusChanged => "focus_changed",
        }
    }
}

/// Control characters (Unicode Cc and Cf: newlines, tabs, NUL, bidi overrides, zero-width
/// spaces …) become one space; runs of spaces they create collapse; the ends are trimmed. A
/// grapheme is a control only when all of it is (an emoji ZWJ sequence or a ZWNJ inside a word
/// is text).
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for g in text.graphemes(true) {
        let control = g.chars().all(is_control_char);
        if control || g == " " {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
        }
        pending_space = false;
        out.push_str(g);
    }
    out
}

/// Characters (graphemes) as the mac counts them (`String.count`).
pub fn char_count(s: &str) -> usize {
    s.graphemes(true).count()
}

fn is_control_char(c: char) -> bool {
    c.is_control() || is_format_char(c) || matches!(c, '\u{2028}' | '\u{2029}' | '\u{85}')
}

/// Unicode general category Cf.
fn is_format_char(c: char) -> bool {
    matches!(c as u32,
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB
        | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3 | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

pub fn is_own(focus: &Focus) -> bool {
    focus.pid == std::process::id()
        || focus
            .bundle_id
            .as_deref()
            .is_some_and(|b| OWN_EXES.contains(&b.to_ascii_lowercase().as_str()))
}

/// Why `focus` cannot take dictated text, or None when it can.
pub fn refusal(focus: Option<&Focus>, expect_pid: Option<u32>) -> Option<Refusal> {
    let focus = focus?;
    if is_own(focus) {
        return Some(Refusal::OwnWindow);
    }
    if expect_pid.is_some_and(|p| p != focus.pid) {
        return Some(Refusal::FocusChanged);
    }
    // Only the focused element decides.
    if focus.secure {
        return Some(Refusal::SecureField);
    }
    if let Some(el) = &focus.element
        && !el.can_take_text()
        && el.role().is_some_and(|r| NON_TEXT_TYPES.contains(&r))
    {
        return Some(Refusal::NotEditable);
    }
    None
}

/// `refusal` with the no-focus case spelled out.
fn refusal_or_no_focus(focus: Option<&Focus>, expect_pid: Option<u32>) -> Option<Refusal> {
    match focus {
        None => Some(Refusal::NoFocus),
        Some(_) => refusal(focus, expect_pid),
    }
}

/// `DictationTarget`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub exe: Option<String>,
    pub package_family_name: Option<String>,
    pub insertable: bool,
    pub pid: u32,
    pub refusal: Option<Refusal>,
    pub role: Option<String>,
}

impl Target {
    /// Wire form: `bundleId` and `role` present as null rather than omitted; the Windows extras
    /// `exe` and `packageFamilyName` only when known.
    pub fn wire(&self) -> Value {
        let mut o = json!({
            "pid": self.pid,
            "bundleId": self.bundle_id,
            "appName": self.app_name,
            "role": self.role,
            "insertable": self.insertable,
        });
        if let Some(e) = &self.exe {
            o["exe"] = json!(e);
        }
        if let Some(f) = &self.package_family_name {
            o["packageFamilyName"] = json!(f);
        }
        if let Some(r) = self.refusal {
            o["refusal"] = json!(r.as_str());
        }
        o
    }
}

pub fn target(focus: Option<&Focus>, expect_pid: Option<u32>) -> Option<Target> {
    let f = focus?;
    let r = refusal(focus, expect_pid);
    Some(Target {
        app_name: f.app_name.clone(),
        bundle_id: f.bundle_id.clone(),
        exe: f.exe.clone(),
        package_family_name: f.package_family_name.clone(),
        insertable: r.is_none(),
        pid: f.pid,
        refusal: r,
        role: f.role.clone(),
    })
}

pub fn refusal_error(r: Refusal, target: Option<&Target>) -> CapError {
    let message = match r {
        Refusal::NoFocus => "No app has keyboard focus.".to_string(),
        Refusal::OwnWindow => "Psyche's own windows dictate through the composer.".to_string(),
        Refusal::SecureField => {
            let app = target
                .map(|t| t.app_name.as_str())
                .filter(|a| !a.is_empty())
                .unwrap_or("this app");
            format!(
                "The focused field in {app} is a password field. Psyche never types into password fields."
            )
        }
        Refusal::NotEditable => "The focused element does not take text.".to_string(),
        Refusal::FocusChanged => {
            "Focus moved to another app while you were dictating; nothing was inserted.".to_string()
        }
    };
    let mut e = CapError::new(ErrorCode::PolicyDenied, r.as_str(), message)
        .with_detail("refusal", r.as_str());
    if let Some(b) = target.and_then(|t| t.bundle_id.as_deref()) {
        e = e.with_detail("bundleId", b);
    }
    e
}

/// How the text went in. Wire `method` (`DictationInsertMethod`) has only `ax` and `typed`:
/// the UIA write reports `ax`; a clipboard paste is synthesized input and reports `typed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Strategy {
    Uia,
    Typed,
    Paste,
}

impl Strategy {
    pub fn wire_method(self) -> &'static str {
        match self {
            Strategy::Uia => "ax",
            Strategy::Typed | Strategy::Paste => "typed",
        }
    }
}

/// Insertion order: the UIA write where it keeps the caret exactly, then unicode typing for short
/// text, or a clipboard paste (falling back to typing) for long text.
pub fn strategies(element: Option<&ElementInfo>, utf16_units: usize) -> Vec<Strategy> {
    let mut out = vec![];
    if element.is_some_and(ElementInfo::uia_writable) {
        out.push(Strategy::Uia);
    }
    if utf16_units > TYPE_MAX_UNITS {
        out.push(Strategy::Paste);
    }
    out.push(Strategy::Typed);
    out
}

/// UTF-16 chunks of at most `max_units` for unicode SendInput, never splitting a grapheme
/// (emoji, combining marks) across chunks (`TypingChunks.split`).
pub fn typing_chunks(text: &str, max_units: usize) -> Vec<Vec<u16>> {
    let mut out = vec![];
    let mut current: Vec<u16> = vec![];
    for g in text.graphemes(true) {
        let units: Vec<u16> = g.encode_utf16().collect();
        if current.len() + units.len() > max_units && !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
        current.extend(units);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// What a paste attempt did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasteOutcome {
    /// The target read the clipboard; the original contents are back.
    Pasted,
    /// Nothing was inserted (clipboard busy or too large to save, a modifier still held, or the
    /// target never read it); the clipboard is unchanged or restored.
    NotPasted,
}

/// The live side the inserter drives (a fake in tests). Methods take `&self` so the per-chunk
/// focus guard can read focus while typing is under way.
pub trait InsertBackend {
    fn focus(&self) -> Option<Focus>;
    /// Replaces the selection in the focused element's value and puts the caret after the text;
    /// true when the value changed.
    fn uia_replace_selection(&self, text: &str) -> bool;
    /// Unicode typing; `guard` runs before every chunk and errors to stop.
    fn type_text(
        &self,
        text: &str,
        guard: &mut dyn FnMut() -> Result<(), CapError>,
    ) -> Result<(), CapError>;
    /// Clipboard paste with save and restore; `guard` runs right before Ctrl+V.
    fn paste(
        &self,
        text: &str,
        guard: &mut dyn FnMut() -> Result<(), CapError>,
    ) -> Result<PasteOutcome, CapError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InsertOutcome {
    pub strategy: Strategy,
    pub chars: usize,
    pub target: Target,
}

impl InsertOutcome {
    /// `DictationInsertResult`.
    pub fn wire(&self) -> Value {
        json!({ "method": self.strategy.wire_method(), "chars": self.chars, "target": self.target.wire() })
    }
}

fn elevated_error(target: &Target) -> CapError {
    CapError::new(
        ErrorCode::Forbidden,
        "elevated_target",
        format!(
            "{} runs as administrator; Windows blocks input from Psyche there. Nothing was inserted.",
            target.app_name
        ),
    )
}

/// Inserts `raw` into the focused element. Every step re-checks the policy.
pub fn insert(
    raw: &str,
    expect_pid: Option<u32>,
    backend: &dyn InsertBackend,
) -> Result<InsertOutcome, CapError> {
    let text = sanitize(raw);
    if text.is_empty() {
        return Err(CapError::invalid_params(
            "nothing to insert after removing control characters",
            Some("text"),
        ));
    }
    let chars = char_count(&text);
    if chars > MAX_CHARS {
        return Err(CapError::invalid_params(
            format!("text is longer than {MAX_CHARS} characters"),
            Some("text"),
        ));
    }
    let focus = backend.focus();
    let tgt = target(focus.as_ref(), expect_pid);
    if let Some(r) = refusal_or_no_focus(focus.as_ref(), expect_pid) {
        return Err(refusal_error(r, tgt.as_ref()));
    }
    let (Some(focus), Some(tgt)) = (focus, tgt) else {
        return Err(refusal_error(Refusal::NoFocus, None));
    };
    if focus.elevated {
        return Err(elevated_error(&tgt));
    }
    let pid = focus.pid;
    // Focus must stay in the same app and out of password fields for every chunk.
    let mut guard = || -> Result<(), CapError> {
        let now = backend.focus();
        match refusal_or_no_focus(now.as_ref(), Some(pid)) {
            Some(r) => Err(refusal_error(r, target(now.as_ref(), None).as_ref())),
            None => Ok(()),
        }
    };
    let units = text.encode_utf16().count();
    for strategy in strategies(focus.element.as_ref(), units) {
        let done = match strategy {
            Strategy::Uia => backend.uia_replace_selection(&text),
            Strategy::Paste => backend.paste(&text, &mut guard)? == PasteOutcome::Pasted,
            Strategy::Typed => {
                backend.type_text(&text, &mut guard)?;
                true
            }
        };
        if done {
            return Ok(InsertOutcome {
                strategy,
                chars,
                target: tgt,
            });
        }
    }
    unreachable!("strategies always end with Typed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn edit(framework: &str) -> ElementInfo {
        ElementInfo {
            control_type: 50004,
            framework_id: framework.into(),
            value_settable: true,
            has_text_pattern: true,
        }
    }

    fn notepad() -> Focus {
        Focus {
            role: Some("Document".into()),
            element: Some(ElementInfo { control_type: 50030, framework_id: "Win32".into(), value_settable: false, has_text_pattern: true }),
            exe: Some(r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad_11.2_x64__8wekyb3d8bbwe\Notepad\Notepad.exe".into()),
            package_family_name: Some("Microsoft.WindowsNotepad_8wekyb3d8bbwe".into()),
            ..Focus::app(4242, Some("notepad.exe"), "Notepad")
        }
    }

    #[derive(Default)]
    struct Fake {
        focus: RefCell<Vec<Option<Focus>>>, // successive focus() answers; the last one repeats
        uia_ok: bool,
        paste_ok: bool,
        calls: RefCell<Vec<String>>,
    }

    impl Fake {
        fn with(focus: Focus) -> Self {
            Fake {
                focus: RefCell::new(vec![Some(focus)]),
                ..Default::default()
            }
        }
    }

    impl InsertBackend for Fake {
        fn focus(&self) -> Option<Focus> {
            let mut f = self.focus.borrow_mut();
            if f.len() > 1 {
                f.remove(0)
            } else {
                f[0].clone()
            }
        }
        fn uia_replace_selection(&self, text: &str) -> bool {
            self.calls.borrow_mut().push(format!("uia:{text}"));
            self.uia_ok
        }
        fn type_text(
            &self,
            text: &str,
            guard: &mut dyn FnMut() -> Result<(), CapError>,
        ) -> Result<(), CapError> {
            for chunk in text.as_bytes().chunks(4) {
                guard()?;
                self.calls
                    .borrow_mut()
                    .push(format!("type:{}", String::from_utf8_lossy(chunk)));
            }
            Ok(())
        }
        fn paste(
            &self,
            text: &str,
            guard: &mut dyn FnMut() -> Result<(), CapError>,
        ) -> Result<PasteOutcome, CapError> {
            guard()?;
            self.calls
                .borrow_mut()
                .push(format!("paste:{}", text.len()));
            Ok(if self.paste_ok {
                PasteOutcome::Pasted
            } else {
                PasteOutcome::NotPasted
            })
        }
    }

    #[test]
    fn sanitize_collapses_control_characters() {
        assert_eq!(
            sanitize("  hello\nworld\t\tagain \r\n "),
            "hello world again"
        );
        assert_eq!(sanitize("a\u{0}b\u{202E}c\u{200B}d"), "a b c d");
        assert_eq!(sanitize("\n\n"), "");
        // Graphemes that are partly format characters are text.
        assert_eq!(
            sanitize("family 👨\u{200D}👩\u{200D}👧!"),
            "family 👨\u{200D}👩\u{200D}👧!"
        );
        assert_eq!(sanitize("می\u{200C}خواهم"), "می\u{200C}خواهم");
        assert_eq!(char_count("e\u{301}🇫🇷"), 2);
    }

    #[test]
    fn refusals() {
        assert_eq!(refusal(None, None), None);
        assert_eq!(refusal_or_no_focus(None, None), Some(Refusal::NoFocus));
        let own = Focus::app(1, Some("Psyche.exe"), "Psyche");
        assert_eq!(refusal(Some(&own), None), Some(Refusal::OwnWindow));
        let me = Focus::app(std::process::id(), Some("cargo-test.exe"), "tests");
        assert_eq!(refusal(Some(&me), None), Some(Refusal::OwnWindow));
        assert_eq!(
            refusal(Some(&notepad()), Some(1)),
            Some(Refusal::FocusChanged)
        );
        assert_eq!(refusal(Some(&notepad()), Some(4242)), None);
        let password = Focus {
            secure: true,
            element: Some(edit("Chrome")),
            ..Focus::app(7, Some("chrome.exe"), "Google Chrome")
        };
        assert_eq!(refusal(Some(&password), None), Some(Refusal::SecureField));
        let button = Focus {
            element: Some(ElementInfo {
                control_type: 50000,
                ..Default::default()
            }),
            role: Some("Button".into()),
            ..Focus::app(7, Some("app.exe"), "App")
        };
        assert_eq!(refusal(Some(&button), None), Some(Refusal::NotEditable));
        // Unknown surfaces (custom-drawn panes, web documents) and app-only focus are allowed.
        for ct in [50033, 50025, 50030, 50032] {
            let pane = Focus {
                element: Some(ElementInfo {
                    control_type: ct,
                    ..Default::default()
                }),
                ..Focus::app(7, Some("app.exe"), "App")
            };
            assert_eq!(refusal(Some(&pane), None), None, "control type {ct}");
        }
        assert_eq!(refusal(Some(&Focus::app(7, None, "pid 7")), None), None);
        // An editable data item (a grid cell editor) takes text.
        let cell = Focus {
            element: Some(ElementInfo {
                control_type: 50029,
                value_settable: true,
                ..Default::default()
            }),
            ..Focus::app(7, Some("excel.exe"), "Excel")
        };
        assert_eq!(refusal(Some(&cell), None), None);
    }

    #[test]
    fn target_wire_keeps_nulls_and_never_carries_contents() {
        let t = target(Some(&Focus::app(9, None, "pid 9")), None).unwrap();
        assert_eq!(
            t.wire(),
            json!({"pid": 9, "bundleId": null, "appName": "pid 9", "role": null, "insertable": true})
        );
        let s = target(
            Some(&Focus {
                secure: true,
                ..notepad()
            }),
            None,
        )
        .unwrap();
        assert_eq!(s.wire()["refusal"], "secure_field");
        assert_eq!(s.wire()["insertable"], false);
        assert_eq!(s.wire()["role"], "Document");
        // Packaged apps: the id is the executable name; the family name is an extra.
        assert_eq!(s.wire()["bundleId"], "notepad.exe");
        assert_eq!(
            s.wire()["packageFamilyName"],
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe"
        );
        assert!(s.wire()["exe"].as_str().unwrap().ends_with(r"\Notepad.exe"));
    }

    #[test]
    fn strategy_selection() {
        let short = 10;
        let long = TYPE_MAX_UNITS + 1;
        assert_eq!(
            strategies(Some(&edit("Win32")), short),
            [Strategy::Uia, Strategy::Typed]
        );
        assert_eq!(
            strategies(Some(&edit("WinForm")), long),
            [Strategy::Uia, Strategy::Paste, Strategy::Typed]
        );
        assert_eq!(strategies(Some(&edit("WPF")), short)[0], Strategy::Uia);
        // Browsers / Electron, documents, read-only fields and no element: no UIA write.
        assert_eq!(strategies(Some(&edit("Chrome")), short), [Strategy::Typed]);
        assert_eq!(
            strategies(notepad().element.as_ref(), long),
            [Strategy::Paste, Strategy::Typed]
        );
        assert_eq!(
            strategies(
                Some(&ElementInfo {
                    value_settable: false,
                    ..edit("Win32")
                }),
                short
            ),
            [Strategy::Typed]
        );
        assert_eq!(
            strategies(
                Some(&ElementInfo {
                    has_text_pattern: false,
                    ..edit("Win32")
                }),
                short
            ),
            [Strategy::Typed]
        );
        assert_eq!(strategies(None, TYPE_MAX_UNITS), [Strategy::Typed]);
        assert_eq!(Strategy::Paste.wire_method(), "typed");
        assert_eq!(Strategy::Uia.wire_method(), "ax");
    }

    #[test]
    fn inserts_through_uia_first() {
        let f = Fake {
            uia_ok: true,
            ..Fake::with(Focus {
                element: Some(edit("Win32")),
                role: Some("Edit".into()),
                ..Focus::app(5, Some("app.exe"), "App")
            })
        };
        let o = insert("hello\nthere", None, &f).unwrap();
        assert_eq!(o.strategy, Strategy::Uia);
        assert_eq!(o.chars, 11);
        assert_eq!(*f.calls.borrow(), ["uia:hello there"]);
        assert_eq!(o.wire()["method"], "ax");
        assert_eq!(o.wire()["target"]["role"], "Edit");
    }

    #[test]
    fn falls_back_from_uia_to_typing_and_from_paste_to_typing() {
        let f = Fake::with(Focus {
            element: Some(edit("Win32")),
            ..Focus::app(5, Some("app.exe"), "App")
        });
        let o = insert("abcdefgh", Some(5), &f).unwrap();
        assert_eq!(o.strategy, Strategy::Typed);
        assert_eq!(
            *f.calls.borrow(),
            ["uia:abcdefgh", "type:abcd", "type:efgh"]
        );

        let long = "word ".repeat(80);
        let f = Fake::with(notepad());
        let o = insert(&long, None, &f).unwrap();
        assert_eq!(o.strategy, Strategy::Typed);
        assert_eq!(f.calls.borrow()[0], "paste:399");
        let f = Fake {
            paste_ok: true,
            ..Fake::with(notepad())
        };
        let o = insert(&long, None, &f).unwrap();
        assert_eq!(
            (o.strategy, o.wire()["method"].clone()),
            (Strategy::Paste, json!("typed"))
        );
        assert_eq!(f.calls.borrow().len(), 1);
    }

    #[test]
    fn refuses_before_touching_anything() {
        for (focus, reason) in [
            (None, "no_focus"),
            (
                Some(Focus {
                    secure: true,
                    ..notepad()
                }),
                "secure_field",
            ),
            (
                Some(Focus::app(1, Some("psyche.exe"), "Psyche")),
                "own_window",
            ),
        ] {
            let f = Fake {
                focus: RefCell::new(vec![focus]),
                ..Default::default()
            };
            let e = insert("hi", None, &f).unwrap_err();
            assert_eq!(
                (e.code, e.reason.as_str()),
                (ErrorCode::PolicyDenied, reason)
            );
            assert_eq!(e.details["refusal"], reason);
            assert!(f.calls.borrow().is_empty());
        }
        let f = Fake::with(notepad());
        let e = insert("hi", Some(77), &f).unwrap_err();
        assert_eq!(e.reason, "focus_changed");
        assert_eq!(e.details["bundleId"], "notepad.exe");
        let f = Fake::with(Focus {
            elevated: true,
            ..notepad()
        });
        assert_eq!(
            insert("hi", None, &f).unwrap_err().reason,
            "elevated_target"
        );
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn typing_stops_when_focus_moves_into_a_password_field() {
        let pw = Focus {
            secure: true,
            ..notepad()
        };
        // First answer: the target; then the guard sees the target once, then the password field.
        let f = Fake {
            focus: RefCell::new(vec![Some(notepad()), Some(notepad()), Some(pw)]),
            ..Default::default()
        };
        let e = insert("abcdefgh", None, &f).unwrap_err();
        assert_eq!(e.reason, "secure_field");
        assert_eq!(*f.calls.borrow(), ["type:abcd"]);
        // Focus moved to another app.
        let other = Focus::app(99, Some("other.exe"), "Other");
        let f = Fake {
            focus: RefCell::new(vec![Some(notepad()), Some(other)]),
            ..Default::default()
        };
        assert_eq!(
            insert("abcdefgh", None, &f).unwrap_err().reason,
            "focus_changed"
        );
        assert!(f.calls.borrow().is_empty());
    }

    #[test]
    fn typing_chunks_keep_graphemes_whole() {
        let chunks = typing_chunks("abcdefghijklmno👍🏽x", 16);
        assert_eq!(chunks.len(), 2);
        assert_eq!(
            chunks[0].len(),
            15,
            "the 4-unit emoji does not fit after 15 units"
        );
        assert_eq!(String::from_utf16(&chunks[1]).unwrap(), "👍🏽x");
        assert!(typing_chunks("", 16).is_empty());
        // A grapheme longer than a chunk still goes out whole.
        let family = "👨\u{200D}👩\u{200D}👧\u{200D}👦";
        assert_eq!(
            typing_chunks(family, 4),
            [family.encode_utf16().collect::<Vec<_>>()]
        );
    }

    #[test]
    fn rejects_empty_and_oversized_text() {
        let f = Fake::with(notepad());
        let e = insert(" \n\t ", None, &f).unwrap_err();
        assert_eq!(
            (e.code, e.details["field"].clone()),
            (ErrorCode::InvalidParams, json!("text"))
        );
        assert!(insert(&"a".repeat(MAX_CHARS + 1), None, &f).is_err());
        // 4000 graphemes of multi-scalar text are allowed.
        let flags = "🇫🇷".repeat(MAX_CHARS);
        let f = Fake {
            paste_ok: true,
            ..Fake::with(notepad())
        };
        assert_eq!(insert(&flags, None, &f).unwrap().chars, MAX_CHARS);
    }
}
