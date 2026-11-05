//! "Record in an app" rules, pure: a port of the mac helper's `PsycheHelperCore/Teach/
//! AppRecording.swift` (docs/design/teach-by-showing-2026.md §13). Everything that decides what
//! may be kept lives here, so it is tested against recorded UI Automation event fixtures without
//! a window:
//!   - which apps may be recorded at all ([`refusal`], [`never_recorded`]),
//!   - which fields are secret ([`sensitive_reason`], [`value_reason`]),
//!   - how events become steps ([`Mapper`]).
//!
//! The live source (`live.rs`) and the indicator only feed events in.
//!
//! The Windows element vocabulary is the one `computer.ax_tree` uses (UI Automation control types
//! mapped to `AX*` roles, `psyche_win_computer::roles`), so the role tables are the Mac's.
//! Differences from the Mac: an app is its lowercase executable name; the never-recorded list is
//! `never_apps.generated.rs` (from `TEACH_NEVER_APPS_WINDOWS` in the protocol package) plus the
//! helper's own fixed caps (Psyche, system authority, password managers).

use std::sync::{Arc, Mutex, OnceLock};

use psyche_win_computer::snapshot::text as ax_text;
use psyche_win_computer::tiers::{SettingValue, Tier, TierSettings, cap_for, fixed_caps};
use regex::{Regex, RegexBuilder};
use serde::Serialize;

use super::never_apps;

/// What the source read from the UI Automation tree for one event. Never contains a field's
/// contents except `ValueChanged`'s value, which the source only reads for a field that passed
/// [`is_secret`] and which the mapper checks again.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Element {
    pub bundle_id: String,
    pub app_name: String,
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub identifier: Option<String>,
    pub placeholder: Option<String>,
    /// The name of the element a field is labelled by (UIA `LabeledBy`).
    pub label_text: Option<String>,
    /// Titles from the window down to the element's parent, outermost first. Empty titles dropped.
    pub path: Vec<String>,
    /// For a menu item: the menu titles down to the item, e.g. ["File", "Export"].
    pub menu_path: Vec<String>,
    /// A password field has keyboard focus somewhere (the Mac's Secure Event Input).
    pub secure_input: bool,
    /// Titles of linked or neighbouring label elements.
    pub nearby: Vec<String>,
    /// The window's title and the few static texts just before the field. Read only to judge
    /// whether the field is a secret; never put in a step, a path or anything that leaves the
    /// helper.
    pub context: Vec<String>,
    /// The process the element belongs to; 0 when the source did not say.
    pub pid: u32,
}

impl Element {
    /// The name a person would give the element.
    pub fn name(&self) -> Option<String> {
        [
            &self.title,
            &self.label_text,
            &self.description,
            &self.placeholder,
        ]
        .into_iter()
        .find_map(|c| clean(c.as_deref(), 120))
    }

    /// Same field for typing purposes (a field's title may change as the owner types).
    pub fn same_field(&self, o: &Element) -> bool {
        self.bundle_id == o.bundle_id
            && self.role == o.role
            && self.identifier == o.identifier
            && (self.identifier.is_some() || (self.name() == o.name() && self.path == o.path))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// `initial` is the field's value when it got focus (read only for a field that is not
    /// secret): what was already there is not what the owner typed.
    Focus(Element, Option<String>),
    /// Focus left every field we may watch: the app went to the background, or the new element is
    /// outside the recorded process or not one we describe.
    FocusCleared,
    /// The field's whole value after the change (`None` when the source did not read it).
    ValueChanged(Element, Option<String>),
    /// A mouse press on a control.
    Press(Element),
    /// A menu item was chosen (not just highlighted).
    MenuChosen(Element),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRef {
    pub bundle_id: String,
    pub name: String,
}

/// One recorded step; the wire shape is `TeachAppCapturedStep` in the protocol.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    /// `app_click` | `app_type` | `app_menu`.
    pub kind: String,
    pub app: AppRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
    /// What the owner typed, for review only. Never set on a sensitive step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<String>,
}

/// One line of app text: control characters flattened, trimmed, capped. `None` when empty.
pub fn clean(s: Option<&str>, max: usize) -> Option<String> {
    let s = s?;
    let flat = ax_text::single_line(s).replace('⏎', " ");
    let trimmed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > max {
        let head: String = trimmed.chars().take(max.saturating_sub(1)).collect();
        return Some(format!("{head}…"));
    }
    Some(trimmed)
}

/// Why a field's contents are never recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitive {
    Password,
    Payment,
    OneTimeCode,
    Identity,
    Secret,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The owner has not granted this app (Settings → Computer use), or it is on Off / Ask.
    NotGranted,
    Psyche,
    SecurityPrompt,
    PasswordManager,
    /// Finance apps, browsers and terminals: computer use cannot act there, so a recording would
    /// be useless, and typing in a terminal is a command.
    OffLimits,
}

impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Refusal::NotGranted => "app_not_granted",
            Refusal::Psyche => "psyche_app",
            Refusal::SecurityPrompt => "security_prompt",
            Refusal::PasswordManager => "password_manager",
            Refusal::OffLimits => "app_off_limits",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Refusal::NotGranted => {
                "Psyche can only record in an app you already allowed for computer use."
            }
            Refusal::Psyche => "Psyche never records its own windows.",
            Refusal::SecurityPrompt => "Sign-in and security prompts are never recorded.",
            Refusal::PasswordManager => "Password managers are never recorded.",
            Refusal::OffLimits => {
                "This kind of app cannot be recorded (banking, browsers, terminals and settings are off limits)."
            }
        }
    }
}

/// Whether `bundle_id` (the lowercase executable name) may be recorded given the owner's tiers.
/// Order matters: a security UI is refused as a security UI even when someone listed it as granted.
pub fn refusal(bundle_id: &str, settings: &TierSettings) -> Option<Refusal> {
    if let Some(r) = never_recorded(bundle_id) {
        return Some(r);
    }
    if cap_for(Some(bundle_id), settings) != Tier::Interact {
        return Some(Refusal::OffLimits);
    }
    // Read alone is not enough: a recording is only worth keeping where the agent may act.
    match settings.value(Some(bundle_id)) {
        SettingValue::Click | SettingValue::Interact => None,
        SettingValue::Read | SettingValue::Off | SettingValue::Ask => Some(Refusal::NotGranted),
    }
}

/// The apps no setting can unlock: Psyche, security prompts, password managers, and the shared
/// list (generated from `TEACH_NEVER_APPS_WINDOWS` in the protocol package).
pub fn never_recorded(bundle_id: &str) -> Option<Refusal> {
    let id = bundle_id.to_lowercase();
    match fixed_caps::category(Some(&id)) {
        Some(fixed_caps::Category::Psyche) => return Some(Refusal::Psyche),
        Some(fixed_caps::Category::PasswordManager) => return Some(Refusal::PasswordManager),
        Some(fixed_caps::Category::SystemAuthority) => return Some(Refusal::SecurityPrompt),
        _ => {}
    }
    never_apps::PATTERNS
        .iter()
        .any(|p| matches(&p.to_lowercase(), &id))
        .then_some(Refusal::OffLimits)
}

/// A trailing `*` is a prefix; otherwise the whole name (both already lowercase).
pub fn matches(pattern: &str, id: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => id.starts_with(prefix),
        None => id == pattern,
    }
}

// MARK: Sensitive fields

fn words() -> &'static [(Sensitive, Regex)] {
    static WORDS: OnceLock<Vec<(Sensitive, Regex)>> = OnceLock::new();
    WORDS.get_or_init(|| {
        // The same words as `TEACH_SENSITIVE_WORDS` in `packages/protocol/src/browser-teach.ts`
        // (and the mac helper's table). Matched case-insensitively against a field's title,
        // description, identifier, placeholder and label.
        let table: [(Sensitive, &str); 5] = [
            (
                Sensitive::Password,
                "pass(?:word|code|phrase)|passwd|\\bpwd\\b|\\bpass\\b|\\bpw\\b|contrase\u{00F1}a|\\bclave\\b|mot[- ]?de[- ]?passe|passwort|kennwort|\\bsenha\\b|\\bparola\\b|\\bpassord\\b|\u{043F}\u{0430}\u{0440}\u{043E}\u{043B}\u{044C}|\u{5BC6}\u{7801}|\u{5BC6}\u{78BC}|\u{30D1}\u{30B9}\u{30EF}\u{30FC}\u{30C9}|\u{BE44}\u{BC00}\u{BC88}\u{D638}|\u{0E23}\u{0E2B}\u{0E31}\u{0E2A}\u{0E1C}\u{0E48}\u{0E32}\u{0E19}|\u{092A}\u{093E}\u{0938}\u{0935}\u{0930}\u{094D}\u{0921}|\u{0643}\u{0644}\u{0645}\u{0629} \u{0627}\u{0644}\u{0645}\u{0631}\u{0648}\u{0631}",
            ),
            (
                Sensitive::OneTimeCode,
                "\\b(?:otp|2fa|mfa|totp|one[- ]?time|verification[- ]code|security[- ]code|auth(?:entication)?[- ]code|sms[- ]code)\\b|(?:recovery|backup|reset)[- ]?(?:code|key)s?\\b",
            ),
            (
                Sensitive::Payment,
                "card[- _]?(?:number|no|num)|\\bcc[-_ ]?(?:num|number|exp|csc|cvc|cvv)|\\bcv[vc]2?\\b|\\bcsc\\b|expir(?:y|ation)|\\biban\\b|routing[- ]number|account[- ]number|sort[- ]code|\\bswift\\b",
            ),
            (
                Sensitive::Identity,
                "\\bssn\\b|social[- ]security|passport|national[- ]id|tax[- ]id|\\btin\\b|driver'?s?[- ]licen[cs]e",
            ),
            (
                Sensitive::Secret,
                "\\bsecret\\b|api[- ]?key|(?:access|auth)[- ]token|private[- ]key|\\bpin\\b|seed[- ]?phrase|mnemonic|recovery[- ]phrase|secret[- ]recovery",
            ),
        ];
        table
            .into_iter()
            .filter_map(|(reason, src)| RegexBuilder::new(src).case_insensitive(true).build().ok().map(|re| (reason, re)))
            .collect()
    })
}

/// Why an element's contents are secret, or `None`. Decided from the element alone, before any
/// value is read: a password field, a password field with focus, or words in its labels.
pub fn sensitive_reason(e: &Element) -> Option<Sensitive> {
    if e.secure_input
        || e.role == "AXSecureTextField"
        || e.subrole.as_deref() == Some("AXSecureTextField")
    {
        return Some(Sensitive::Password);
    }
    let mut parts: Vec<&str> = [
        &e.title,
        &e.description,
        &e.identifier,
        &e.placeholder,
        &e.label_text,
    ]
    .into_iter()
    .filter_map(|s| s.as_deref())
    .collect();
    parts.extend(e.path.iter().map(String::as_str));
    parts.extend(e.nearby.iter().map(String::as_str));
    parts.extend(e.context.iter().map(String::as_str));
    let text = parts.join(" ");
    if text.is_empty() {
        return None;
    }
    words()
        .iter()
        .find(|(_, re)| re.is_match(&text))
        .map(|(reason, _)| *reason)
}

pub fn is_secret(e: &Element) -> bool {
    sensitive_reason(e).is_some()
}

struct ValueShapes {
    card: Regex,
    ssn: Regex,
    token: Regex,
    jwt: Regex,
    key: Regex,
    url_credentials: Regex,
    short_number: Regex,
}

fn shapes() -> &'static ValueShapes {
    static SHAPES: OnceLock<ValueShapes> = OnceLock::new();
    SHAPES.get_or_init(|| {
        let re = |s: &str| Regex::new(s).expect("static pattern");
        ValueShapes {
            card: re(r"(?:[0-9][ -]?){13,19}"),
            ssn: re(r"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b"),
            token: re(r"^[A-Za-z0-9_-]{32,}$"),
            jwt: re(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\."),
            key: re(r"\b(?:sk|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{16,}"),
            // Credentials in a URL: a scheme, then user and password before an @ and the host.
            url_credentials: re(r"[A-Za-z][A-Za-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@"),
            short_number: re(r"^[0-9]{4,8}$"),
        }
    })
}

/// A value that is a secret whatever field it was typed into (a card number, an ID number, a
/// token). Mirrors `classifyTeachValue` in browser-teach.ts.
pub fn value_reason(value: &str, _label: &str) -> Option<Sensitive> {
    let s = shapes();
    for m in s.card.find_iter(value) {
        let digits: String = m.as_str().chars().filter(char::is_ascii_digit).collect();
        if (13..=19).contains(&digits.len()) && luhn(&digits) {
            return Some(Sensitive::Payment);
        }
    }
    if s.ssn.is_match(value) {
        return Some(Sensitive::Identity);
    }
    let trimmed = value.trim();
    if s.token.is_match(trimmed)
        || s.jwt.is_match(value)
        || s.key.is_match(value)
        || s.url_credentials.is_match(value)
    {
        return Some(Sensitive::Secret);
    }
    // A recovery phrase: 12, 15, 18, 21 or 24 short lowercase words (BIP39 shapes).
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if [12, 15, 18, 21, 24].contains(&words.len())
        && words.iter().all(|w| {
            (3..=8).contains(&w.chars().count()) && w.chars().all(|c| c.is_ascii_lowercase())
        })
    {
        return Some(Sensitive::Secret);
    }
    // A bare 4 to 8 digit number typed into an app: a code or a PIN far more often than not, and
    // one click on "Keep this value" is too easy.
    if s.short_number.is_match(trimmed) {
        return Some(Sensitive::OneTimeCode);
    }
    None
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    let mut dbl = false;
    for ch in digits.chars().rev() {
        let Some(mut n) = ch.to_digit(10) else {
            return false;
        };
        if dbl {
            n *= 2;
            if n > 9 {
                n -= 9;
            }
        }
        sum += n;
        dbl = !dbl;
    }
    sum % 10 == 0
}

// MARK: Roles

/// AX roles as the recording keeps them: a fixed list shared with the protocol (`TEACH_ROLES`).
pub mod roles {
    pub fn map(role: &str, subrole: Option<&str>) -> &'static str {
        match role {
            "AXButton" | "AXMenuButton" | "AXDisclosureTriangle" => "button",
            // A search box is a text field with a search subrole on Windows.
            "AXTextField" if subrole == Some("AXSearchField") => "searchbox",
            "AXTextField" | "AXTextArea" | "AXSecureTextField" => "textbox",
            "AXSearchField" => "searchbox",
            "AXComboBox" | "AXPopUpButton" => "combobox",
            "AXCheckBox" => {
                if subrole == Some("AXSwitch") {
                    "switch"
                } else {
                    "checkbox"
                }
            }
            "AXRadioButton" => "radio",
            "AXMenuItem" | "AXMenuBarItem" => "menuitem",
            "AXLink" => "link",
            "AXSlider" => "slider",
            "AXRow" => "row",
            "AXCell" => "cell",
            "AXTabGroup" => "tablist",
            "AXTable" | "AXOutline" => "table",
            "AXToolbar" => "toolbar",
            "AXList" => "list",
            "AXImage" => "img",
            _ => "generic",
        }
    }

    /// Rows, cells and list items hold the user's data (a message subject, a file name), not the
    /// app's controls: they are recorded by role, never by what they contain.
    pub const DATA_ROLES: [&str; 5] = [
        "AXRow",
        "AXCell",
        "AXOutlineRow",
        "AXStaticText",
        "AXPopUpButton",
    ];

    /// Ancestors whose title is the user's data (a row's text, a page's title, the open tabs).
    pub const DATA_ANCESTORS: [&str; 9] = [
        "AXRow",
        "AXCell",
        "AXOutlineRow",
        "AXStaticText",
        "AXWebArea",
        "AXTabGroup",
        "AXList",
        "AXTable",
        "AXOutline",
    ];

    /// The title an ancestor may add to a path, or `None` when it is the user's data or only a window.
    pub fn path_title(role: &str, title: Option<&str>) -> Option<String> {
        if role == "AXWindow" || role == "AXApplication" || DATA_ANCESTORS.contains(&role) {
            return None;
        }
        super::clean(title, 120)
    }

    /// Menus whose items are the user's data (recent documents, history, bookmarks, the window list).
    pub fn is_dynamic_menu(title: &str) -> bool {
        let t = title.to_lowercase();
        [
            "recent",
            "history",
            "bookmarks",
            "window",
            "documents",
            "favorites",
            "open with",
        ]
        .iter()
        .any(|w| t.contains(w))
    }

    /// Roles whose press means "the owner moved into a field", not an action.
    pub const TEXT_INPUTS: [&str; 5] = [
        "AXTextField",
        "AXTextArea",
        "AXSecureTextField",
        "AXSearchField",
        "AXComboBox",
    ];
    pub const MENU_ITEMS: [&str; 2] = ["AXMenuItem", "AXMenuBarItem"];
}

// MARK: Mapper

pub const MAX_STEPS: usize = 200;
pub const MAX_SAMPLE: usize = 500;

struct Pending {
    element: Element,
    text: String,
    baseline: Option<String>,
}

#[derive(Default)]
struct MapperState {
    steps: Vec<Step>,
    /// Input left out: a secret field's contents, a control with no usable name, a never-recorded app.
    skipped: usize,
    pending: Option<Pending>,
    /// The value the focused field had when it got focus.
    focus_baseline: Option<String>,
    /// The field that has focus: value changes are accepted from it and from nowhere else.
    focused: Option<Element>,
    /// The processes the recording is bound to (set at start); events from any other pid are dropped.
    owns: Option<Arc<dyn Fn(u32) -> bool + Send + Sync>>,
    /// Fields already recorded as sensitive, so retyping into one does not add a step each time.
    sensitive_fields: Vec<Element>,
}

/// Turns events into steps. One mapper per recording; events from other apps are ignored, and
/// events from apps that are never recorded are counted and dropped.
pub struct Mapper {
    pub app: AppRef,
    max_steps: usize,
    state: Mutex<MapperState>,
}

impl Mapper {
    pub fn new(bundle_id: &str, app_name: &str, max_steps: usize) -> Mapper {
        Mapper {
            app: AppRef {
                bundle_id: bundle_id.to_owned(),
                name: clean(Some(app_name), 120).unwrap_or_else(|| bundle_id.to_owned()),
            },
            max_steps: max_steps.clamp(1, MAX_STEPS),
            state: Mutex::new(MapperState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MapperState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn limit_reached(&self) -> bool {
        self.lock().steps.len() >= self.max_steps
    }

    pub fn step_count(&self) -> usize {
        self.lock().steps.len()
    }

    pub fn skipped(&self) -> usize {
        self.lock().skipped
    }

    /// Binds the recording to one process. The app id is a string anyone can claim; the pid is
    /// what the OS handed the source.
    pub fn bind(&self, pid: u32) {
        self.bind_scope(Arc::new(move |p| p == pid));
    }

    /// Binds the recording to the processes `owns` accepts (an app's own, its frame host).
    pub fn bind_scope(&self, owns: Arc<dyn Fn(u32) -> bool + Send + Sync>) {
        self.lock().owns = Some(owns);
    }

    /// Feeds one event; returns the steps it finalized.
    pub fn handle(&self, event: &Event) -> Vec<Step> {
        let mut st = self.lock();
        if matches!(event, Event::FocusCleared) {
            let out = self.flush(&mut st);
            st.focused = None;
            st.focus_baseline = None;
            return out;
        }
        let e = element_of(event);
        if let Some(owns) = st.owns.clone()
            && !owns(e.pid)
        {
            // A foreign element means focus is no longer in the recorded process.
            if matches!(event, Event::Focus(..)) {
                let out = self.flush(&mut st);
                st.focused = None;
                st.focus_baseline = None;
                return out;
            }
            return Vec::new();
        }
        if e.bundle_id.to_lowercase() != self.app.bundle_id.to_lowercase() {
            // Another app: never recorded. A security prompt or Psyche is counted so the review can say so.
            if never_recorded(&e.bundle_id).is_some() {
                st.skipped += 1;
            }
            return Vec::new();
        }
        if never_recorded(&self.app.bundle_id).is_some() {
            st.skipped += 1;
            return Vec::new();
        }
        if st.steps.len() >= self.max_steps {
            return Vec::new();
        }
        let mut out = Vec::new();
        match event {
            Event::FocusCleared => {}
            Event::Focus(el, initial) => {
                if let Some(p) = &st.pending
                    && !p.element.same_field(el)
                {
                    out.extend(self.flush(&mut st));
                }
                if !st.focused.as_ref().is_some_and(|f| f.same_field(el)) {
                    st.focus_baseline = initial.clone();
                }
                st.focused = Some(el.clone());
            }
            Event::ValueChanged(el, value) => {
                out.extend(self.value_changed(&mut st, el, value.as_deref()))
            }
            Event::Press(el) => {
                out.extend(self.flush(&mut st));
                out.extend(self.press(&mut st, el));
            }
            Event::MenuChosen(el) => {
                out.extend(self.flush(&mut st));
                out.extend(self.menu(&mut st, el));
            }
        }
        out
    }

    /// Ends the recording: flushes typing and returns everything recorded.
    pub fn finish(&self) -> Vec<Step> {
        let mut st = self.lock();
        let _ = self.flush(&mut st);
        st.steps.clone()
    }

    // MARK: Typing

    fn value_changed(&self, st: &mut MapperState, el: &Element, value: Option<&str>) -> Vec<Step> {
        let mut out = Vec::new();
        // Only text fields are typed into: a label or a progress bar whose value changes is not input.
        if !roles::TEXT_INPUTS.contains(&el.role.as_str())
            && el.subrole.as_deref() != Some("AXSecureTextField")
        {
            return out;
        }
        // And only the field that has focus: a value changing elsewhere in the app is not the owner typing.
        if !st.focused.as_ref().is_some_and(|f| f.same_field(el)) {
            return out;
        }
        // A secret field: one sensitive step, no value, and the value is not even looked at.
        if is_secret(el) {
            if st.pending.is_some() {
                out.extend(self.flush(st));
            }
            if !st.sensitive_fields.iter().any(|f| f.same_field(el)) {
                st.sensitive_fields.push(el.clone());
                out.push(self.append(st, "app_type", el, true, None, None));
            }
            return out;
        }
        let Some(value) = value else { return out };
        if let Some(p) = &st.pending
            && !p.element.same_field(el)
        {
            out.extend(self.flush(st));
        }
        let baseline = st
            .pending
            .as_ref()
            .map(|p| p.baseline.clone())
            .unwrap_or_else(|| st.focus_baseline.clone());
        st.pending = Some(Pending {
            element: el.clone(),
            text: value.to_owned(),
            baseline,
        });
        out
    }

    fn flush(&self, st: &mut MapperState) -> Vec<Step> {
        let Some(p) = st.pending.take() else {
            return Vec::new();
        };
        if st.steps.len() >= self.max_steps {
            return Vec::new();
        }
        // The value is checked once more, whatever the source decided: a card number or token
        // typed into an unlabelled field makes the step sensitive and drops the value.
        let mut label = vec![p.element.name().unwrap_or_default()];
        label.extend(p.element.context.iter().cloned());
        let label = label.join(" ");
        if is_secret(&p.element) || value_reason(&p.text, &label).is_some() {
            st.skipped += 1;
            return vec![self.append(st, "app_type", &p.element, true, None, None)];
        }
        // Only what the owner typed after the field got focus: a value that was already there
        // (pre-filled, autofilled) is not recorded, and an append keeps just the appended part.
        let mut typed = p.text.clone();
        if let Some(base) = &p.baseline
            && !base.is_empty()
        {
            if typed == *base {
                return Vec::new();
            }
            if let Some(rest) = typed.strip_prefix(base.as_str()) {
                typed = rest.to_owned();
            }
        }
        if typed != p.text && value_reason(&typed, &label).is_some() {
            st.skipped += 1;
            return vec![self.append(st, "app_type", &p.element, true, None, None)];
        }
        let text = typed.trim().to_owned();
        // Emptied fields are not a step: the owner typed and deleted.
        if text.is_empty() {
            return Vec::new();
        }
        let sample = clean(Some(&text), MAX_SAMPLE);
        vec![self.append(st, "app_type", &p.element, false, sample, None)]
    }

    // MARK: Presses and menus

    fn press(&self, st: &mut MapperState, el: &Element) -> Vec<Step> {
        // Moving into a field is a focus, not an action; the typing that follows is the step.
        if roles::TEXT_INPUTS.contains(&el.role.as_str()) {
            return Vec::new();
        }
        if roles::MENU_ITEMS.contains(&el.role.as_str()) {
            return self.menu(st, el);
        }
        // A secret control (a "Show password" button) is not described either.
        if is_secret(el) {
            st.skipped += 1;
            return Vec::new();
        }
        // A row or cell is the user's data: recorded as "a row", never by its contents.
        if roles::DATA_ROLES.contains(&el.role.as_str()) {
            if let Some(last) = st.steps.last()
                && last.kind == "app_click"
                && last.role.as_deref() == Some(roles::map(&el.role, el.subrole.as_deref()))
                && last.name.is_none()
            {
                return Vec::new();
            }
            return vec![self.append(st, "app_click", el, false, None, None)];
        }
        if el.name().is_none() && clean(el.identifier.as_deref(), 200).is_none() {
            st.skipped += 1; // not replayable: nothing a person or the next run could find it by
            return Vec::new();
        }
        if let Some(last) = st.steps.last()
            && last.kind == "app_click"
            && same_target(last, el)
        {
            return Vec::new(); // double press
        }
        vec![self.append(st, "app_click", el, false, None, None)]
    }

    fn menu(&self, st: &mut MapperState, el: &Element) -> Vec<Step> {
        let mut path: Vec<String> = el
            .menu_path
            .iter()
            .filter_map(|t| clean(Some(t), 120))
            .collect();
        if path.is_empty()
            && let Some(name) = el.name()
        {
            path = vec![name];
        }
        if path.is_empty() {
            st.skipped += 1;
            return Vec::new();
        }
        // Open Recent, History, the Window list: the items are the user's data, so the step stops at the menu.
        let head = &path[..path.len() - 1];
        if let Some(i) = head.iter().position(|t| roles::is_dynamic_menu(t)) {
            path.truncate(i + 1);
        } else if path.len() == 1 && roles::is_dynamic_menu(&path[0]) {
            path = vec![path[0].clone()];
        }
        vec![self.append(st, "app_menu", el, false, None, Some(path))]
    }

    /// A second way to find the element: its automation id, else a description that differs from
    /// its name.
    pub fn fallback(e: &Element) -> Option<String> {
        if let Some(id) =
            ax_text::clean_identifier(e.identifier.as_deref()).and_then(|i| clean(Some(&i), 200))
        {
            return Some(format!("identifier:{id}"));
        }
        if let Some(d) = clean(e.description.as_deref(), 200)
            && Some(&d) != e.name().as_ref()
        {
            return Some(format!("description:{d}"));
        }
        None
    }

    fn append(
        &self,
        st: &mut MapperState,
        kind: &str,
        el: &Element,
        sensitive: bool,
        sample: Option<String>,
        menu_path: Option<Vec<String>>,
    ) -> Step {
        let id = format!("a{}", st.steps.len() + 1);
        if roles::DATA_ROLES.contains(&el.role.as_str()) {
            // By role only: no title, description, identifier or path from the user's data.
            let role = roles::map(&el.role, el.subrole.as_deref());
            let step = Step {
                id,
                kind: kind.to_owned(),
                app: self.app.clone(),
                role: Some(role.to_owned()),
                name: None,
                path: Some(vec![
                    if role == "generic" { "item" } else { role }.to_owned(),
                ]),
                fallback: None,
                sensitive: None,
                sample: None,
            };
            st.steps.push(step.clone());
            return step;
        }
        let path = if let Some(menu) = &menu_path {
            Some(menu.iter().take(8).cloned().collect::<Vec<_>>())
        } else {
            let mut p: Vec<String> = el.path.iter().filter_map(|t| clean(Some(t), 120)).collect();
            if let Some(n) = el.name()
                && p.last() != Some(&n)
            {
                p.push(n);
            }
            if p.is_empty() {
                None
            } else {
                let skip = p.len().saturating_sub(8);
                Some(p.split_off(skip))
            }
        };
        let is_menu = kind == "app_menu";
        let step = Step {
            id,
            kind: kind.to_owned(),
            app: self.app.clone(),
            role: Some(
                if is_menu {
                    "menuitem"
                } else {
                    roles::map(&el.role, el.subrole.as_deref())
                }
                .to_owned(),
            ),
            name: if is_menu {
                menu_path.as_ref().and_then(|m| m.last().cloned())
            } else {
                el.name()
            },
            path,
            fallback: Self::fallback(el),
            sensitive: sensitive.then_some(true),
            sample: if sensitive { None } else { sample },
        };
        st.steps.push(step.clone());
        step
    }
}

fn element_of(event: &Event) -> &Element {
    static EMPTY: OnceLock<Element> = OnceLock::new();
    match event {
        Event::Focus(e, _) | Event::ValueChanged(e, _) | Event::Press(e) | Event::MenuChosen(e) => {
            e
        }
        Event::FocusCleared => EMPTY.get_or_init(Element::default),
    }
}

fn same_target(s: &Step, e: &Element) -> bool {
    s.name == e.name()
        && s.fallback == Mapper::fallback(e)
        && s.role.as_deref() == Some(roles::map(&e.role, e.subrole.as_deref()))
}
