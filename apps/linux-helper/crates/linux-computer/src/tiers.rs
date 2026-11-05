//! Per-app tiers, fixed caps, approvals, pause-when-unwatched, the session lock and the stop
//! signal: a port of `PsycheHelperCore/Computer/Tiers.swift` with Linux app identities.
//!
//! **App identity on Linux.** The Mac helper keys everything on bundle ids. The Linux "bundle id"
//! is the desktop file id of the app (`org.gnome.TextEditor`, `firefox`, `libreoffice-writer`),
//! compared case-insensitively; [`crate::app_id`] computes it for every capability of the helper.

use crate::error::{code, CapError, CapResult};
use crate::keychord::send_keys;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Per-app computer-use tier. Ordered: a higher tier includes everything below it. `click` is the
/// terminals/IDEs cap: plain clicks and scrolling, no typing, keys, right-clicks, modifier-clicks,
/// drags or value writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Tier {
    Off,
    Read,
    Click,
    Interact,
}

impl Tier {
    pub fn as_str(&self) -> &'static str {
        match self {
            Tier::Off => "off",
            Tier::Read => "read",
            Tier::Click => "click",
            Tier::Interact => "interact",
        }
    }
    pub fn parse(s: &str) -> Option<Tier> {
        Some(match s {
            "off" => Tier::Off,
            "read" => Tier::Read,
            "click" => Tier::Click,
            "interact" => Tier::Interact,
            _ => return None,
        })
    }
}

/// What a `computer.*` call needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Read,
    Click,
    Scroll,
    RightClick,
    ModifierClick,
    Type,
    Key,
    Drag,
    SetValue,
    /// Semantic press on a non-menu control.
    Press,
    /// Menu items, menu-bar commands, other semantic actions: can run any app command.
    Menu,
}

/// Roles whose press runs an app command (#266).
pub const MENU_LIKE_ROLES: &[&str] = &["AXMenuItem", "AXMenuBarItem", "AXMenuButton", "AXPopUpButton", "AXMenu", "AXMenuBar"];

impl Intent {
    pub fn escalated(self, role: Option<&str>) -> Intent {
        match (self, role) {
            (Intent::Click | Intent::Press, Some(r)) if MENU_LIKE_ROLES.contains(&r) => Intent::Menu,
            _ => self,
        }
    }

    pub fn required_tier(self) -> Tier {
        match self {
            Intent::Read => Tier::Read,
            Intent::Click | Intent::Scroll | Intent::Press => Tier::Click,
            _ => Tier::Interact,
        }
    }
}

/// Fixed caps that no user setting or chat instruction can raise (architecture §6). Desktop file
/// ids, lowercase; a trailing `*` matches a prefix. Mirrors `@psyche/permissions` apps.ts.
pub mod fixed_caps {
    use super::Tier;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Category {
        Psyche,
        Browser,
        TerminalOrIde,
        PasswordManager,
        Finance,
        SystemAuthority,
    }

    /// Psyche's own UI: the agent must never click its own approval cards or settings.
    pub const PSYCHE: &[&str] = &["psyche", "psyche-desktop", "psyche-helper", "com.psyche.desktop", "com.psyche.helper", "electron-psyche"];

    /// The shell, settings, polkit and keyring prompts, greeters and lock screens (#269): the
    /// password dialog of a presence check is drawn by one of these, and computer use must never
    /// answer a security prompt or press Approve on its own notification.
    pub const SYSTEM_AUTHORITY: &[&str] = &[
        "gnome-shell",
        "org.gnome.shell",
        "plasmashell",
        "org.kde.plasmashell",
        "gnome-control-center",
        "org.gnome.settings",
        "org.gnome.controlcenter",
        "systemsettings",
        "org.kde.systemsettings",
        "polkit-gnome-authentication-agent-1",
        "polkit-kde-authentication-agent-1",
        "org.kde.polkit-kde-authentication-agent-1",
        "polkit-mate-authentication-agent-1",
        "lxqt-policykit-agent",
        "xfce-polkit",
        "gcr-prompter",
        "gcr-viewer",
        "pinentry-gnome3",
        "pinentry-qt",
        "pinentry-gtk-2",
        "org.gnome.initialsetup",
        "gnome-initial-setup",
        "gdm",
        "sddm",
        "lightdm",
        "gnome-screensaver",
        "org.gnome.screensaver",
        "xscreensaver",
        "swaylock",
        "hyprlock",
    ];

    pub const BROWSERS: &[&str] = &[
        "firefox",
        "firefox-esr",
        "org.mozilla.firefox",
        "chromium",
        "chromium-browser",
        "org.chromium.chromium",
        "google-chrome",
        "google-chrome-stable",
        "google-chrome-beta",
        "com.google.chrome",
        "brave-browser",
        "com.brave.browser",
        "vivaldi",
        "vivaldi-stable",
        "com.vivaldi.vivaldi",
        "epiphany",
        "org.gnome.epiphany",
        "microsoft-edge",
        "microsoft-edge-stable",
        "com.microsoft.edge",
        "librewolf",
        "io.gitlab.librewolf-community",
        "opera",
        "falkon",
        "org.kde.falkon",
        "zen-browser",
        "waterfox",
        "floorp",
        "tor-browser",
    ];

    pub const TERMINALS_AND_IDES: &[&str] = &[
        "gnome-terminal",
        "org.gnome.terminal",
        "ptyxis",
        "org.gnome.ptyxis",
        "konsole",
        "org.kde.konsole",
        "kitty",
        "alacritty",
        "org.alacritty.alacritty",
        "wezterm",
        "org.wezfurlong.wezterm",
        "foot",
        "xterm",
        "uxterm",
        "xfce4-terminal",
        "tilix",
        "com.gexperts.tilix",
        "terminator",
        "lxterminal",
        "qterminal",
        "kgx",
        "org.gnome.console",
        "code",
        "code-oss",
        "codium",
        "vscodium",
        "com.visualstudio.code",
        "com.vscodium.codium",
        "cursor",
        "zed",
        "dev.zed.zed",
        "sublime_text",
        "sublime-text",
        "emacs",
        "gvim",
        "jetbrains-*",
        "idea",
        "pycharm",
        "webstorm",
        "clion",
        "goland",
        "rider",
        "android-studio",
        "org.gnome.builder",
        "org.kde.kate",
        "org.kde.kdevelop",
    ];

    pub const PASSWORD_MANAGERS: &[&str] = &[
        "keepassxc",
        "org.keepassxc.keepassxc",
        "keepass2",
        "bitwarden",
        "com.bitwarden.desktop",
        "1password",
        "enpass",
        "seahorse",
        "org.gnome.seahorse.application",
        "kwalletmanager5",
        "kwalletmanager6",
        "org.kde.kwalletmanager5",
        "org.kde.kwalletmanager6",
        "gnome-keyring",
        "proton-pass",
        "nordpass",
        "lastpass",
        "dashlane",
    ];

    /// Banking, trading and crypto apps.
    pub const FINANCE: &[&str] = &[
        "electrum",
        "org.electrum.electrum",
        "exodus",
        "ledger-live-desktop",
        "trezor-suite",
        "bitcoin-qt",
        "org.bitcoin.bitcoin-qt",
        "sparrow",
        "tradingview",
        "coinbase*",
        "robinhood*",
        "revolut*",
        "com.coinbase.*",
        "com.robinhood.*",
    ];

    pub fn matches(list: &[&str], id: &str) -> bool {
        list.iter().any(|p| match p.strip_suffix('*') {
            Some(prefix) => id.starts_with(prefix),
            None => id == *p,
        })
    }

    pub fn category(app_id: Option<&str>) -> Option<Category> {
        let id = app_id?.to_lowercase();
        // `foo.desktop` and `foo` are the same app.
        let id = id.strip_suffix(".desktop").unwrap_or(&id);
        if matches(PSYCHE, id) {
            return Some(Category::Psyche);
        }
        if matches(SYSTEM_AUTHORITY, id) {
            return Some(Category::SystemAuthority);
        }
        if matches(PASSWORD_MANAGERS, id) {
            return Some(Category::PasswordManager);
        }
        if matches(FINANCE, id) {
            return Some(Category::Finance);
        }
        if matches(BROWSERS, id) {
            return Some(Category::Browser);
        }
        if matches(TERMINALS_AND_IDES, id) {
            return Some(Category::TerminalOrIde);
        }
        None
    }

    /// The highest tier an app can ever get.
    pub fn cap(app_id: Option<&str>) -> Tier {
        match category(app_id) {
            Some(Category::Psyche | Category::PasswordManager | Category::Finance | Category::SystemAuthority) => Tier::Off,
            Some(Category::Browser) => Tier::Read,
            Some(Category::TerminalOrIde) => Tier::Click,
            None => Tier::Interact,
        }
    }
}

/// The user's value for one app in `computer-use.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingValue {
    Off,
    Read,
    Click,
    Interact,
    Ask,
}

/// User tiers from Settings → Computer use, read from `$PSYCHE_HOME/config/computer-use.json`
/// (default `%USERPROFILE%\.psyche`), written by the Gateway (`compose/computer-settings.ts`):
/// `{ "version": 1, "default": "ask", "apps": {"org.gnome.TextEditor": "interact"}, "caps": {...}, "sensitive": [...] }`.
/// `caps` (the Gateway's fixed caps, `prefix.*` patterns allowed) further lowers the built-in caps.
#[derive(Debug, Clone, PartialEq)]
pub struct TierSettings {
    pub default_value: SettingValue,
    pub apps: HashMap<String, SettingValue>,
    pub caps: HashMap<String, Tier>,
    pub sensitive: Vec<String>,
}

impl Default for TierSettings {
    fn default() -> Self {
        TierSettings { default_value: SettingValue::Ask, apps: HashMap::new(), caps: HashMap::new(), sensitive: Vec::new() }
    }
}

impl TierSettings {
    pub fn from_json(v: &Value) -> TierSettings {
        let mut s = TierSettings::default();
        if let Some(d) = v.get("default").and_then(|d| serde_json::from_value::<SettingValue>(d.clone()).ok()) {
            s.default_value = d;
        }
        if let Some(apps) = v.get("apps").and_then(Value::as_object) {
            for (k, val) in apps {
                if let Ok(t) = serde_json::from_value::<SettingValue>(val.clone()) {
                    s.apps.insert(k.clone(), t);
                }
            }
        }
        if let Some(caps) = v.get("caps").and_then(Value::as_object) {
            for (k, val) in caps {
                if let Some(t) = val.as_str().and_then(Tier::parse) {
                    s.caps.insert(k.to_lowercase(), t);
                }
            }
        }
        if let Some(list) = v.get("sensitive").and_then(Value::as_array) {
            s.sensitive = list.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
        }
        s
    }

    pub fn value(&self, bundle_id: Option<&str>) -> SettingValue {
        let Some(id) = bundle_id else { return self.default_value };
        if let Some(v) = self.apps.get(id) {
            return *v;
        }
        self.apps.iter().find(|(k, _)| k.eq_ignore_ascii_case(id)).map(|(_, v)| *v).unwrap_or(self.default_value)
    }

    /// The explicit value for `bundle_id` (no default).
    pub fn explicit(&self, bundle_id: &str) -> Option<SettingValue> {
        self.apps.get(bundle_id).copied().or_else(|| self.apps.iter().find(|(k, _)| k.eq_ignore_ascii_case(bundle_id)).map(|(_, v)| *v))
    }

    /// Cap from the file's `caps` (exact ids, or `prefix.*`).
    pub fn file_cap(&self, bundle_id: Option<&str>) -> Tier {
        let Some(id) = bundle_id.map(str::to_lowercase) else { return Tier::Interact };
        let mut cap = Tier::Interact;
        for (pattern, t) in &self.caps {
            let hit = match pattern.strip_suffix('*') {
                Some(prefix) => id.starts_with(prefix),
                None => &id == pattern,
            };
            if hit {
                cap = cap.min(*t);
            }
        }
        cap
    }

    pub fn load(path: &std::path::Path) -> TierSettings {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|v| TierSettings::from_json(&v))
            .unwrap_or_default()
    }

    /// `$PSYCHE_HOME/config/computer-use.json`.
    pub fn path() -> PathBuf {
        psyche_home().join("config").join("computer-use.json")
    }
}

/// `PSYCHE_HOME`, else `~/.psyche` (the Mac helper's location).
pub fn psyche_home() -> PathBuf {
    if let Ok(h) = std::env::var("PSYCHE_HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    let base = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".psyche")
}

/// The effective cap: built-in fixed caps ∧ the Gateway's caps from the settings file.
pub fn cap_for(bundle_id: Option<&str>, settings: &TierSettings) -> Tier {
    fixed_caps::cap(bundle_id).min(settings.file_cap(bundle_id))
}

/// Pause-when-unwatched (docs/05 §7.2 item 5, #272): in sensitive apps, actions that change
/// something need owner input on this computer within the last five minutes.
pub mod attention {
    use super::*;
    pub const WINDOW_SECS: f64 = 5.0 * 60.0;

    /// Terminals and IDEs (click is shell-adjacent), messaging and mail apps, and the owner's list.
    pub fn is_sensitive(bundle_id: Option<&str>, settings: &TierSettings) -> bool {
        let Some(id) = bundle_id.map(str::to_lowercase) else { return false };
        if fixed_caps::category(Some(&id)) == Some(fixed_caps::Category::TerminalOrIde) || send_keys::is_messaging_app(Some(&id)) {
            return true;
        }
        settings.sensitive.iter().any(|s| s.eq_ignore_ascii_case(&id))
    }

    /// Reading and scrolling never wait.
    pub fn applies(intent: Intent) -> bool {
        intent != Intent::Read && intent != Intent::Scroll
    }
}

/// What the Gateway's approval covered (#267): the app the card named and the tier it asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalBinding {
    pub id: String,
    pub app: String,
    pub tier: Tier,
}

impl ApprovalBinding {
    /// From `params.approval {app, tier}` next to the invocation's `approvalId`.
    pub fn from(approval_id: Option<&str>, params: &Value) -> Option<ApprovalBinding> {
        let id = approval_id?;
        let a = params.get("approval")?;
        let app = a.get("app")?.as_str().filter(|s| !s.is_empty())?;
        let tier = a.get("tier")?.as_str().and_then(Tier::parse)?;
        Some(ApprovalBinding { id: id.to_string(), app: app.to_string(), tier })
    }
}

/// Seconds since the Unix epoch.
pub fn now_secs() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

type Clock = Box<dyn Fn() -> f64 + Send + Sync>;
type OwnerInput = Box<dyn Fn() -> Option<f64> + Send + Sync>;
/// Settings and "Allow for this session" allowances (app → tier, expiry).
type PolicyState = (TierSettings, HashMap<String, (Tier, f64)>);
/// The holder (session id, last use) and sessions stopped by Esc.
type SessionState = (Option<(String, f64)>, Vec<String>);

/// Decides whether a `computer.*` call may touch an app: fixed cap ∧ user tier ∧ "Allow for this
/// session" allowances (30 minutes). Thread-safe.
pub struct TierPolicy {
    state: Mutex<PolicyState>,
    now: Clock,
    /// When the owner last used the keyboard or mouse (not the helper's own events). `None`
    /// turns the attention check off (unit tests of other rules); the helper always sets it.
    owner_input: Option<OwnerInput>,
}

pub const SESSION_ALLOWANCE_SECS: f64 = 30.0 * 60.0;

impl TierPolicy {
    pub fn new(settings: TierSettings, now: Option<Clock>, owner_input: Option<OwnerInput>) -> TierPolicy {
        TierPolicy { state: Mutex::new((settings, HashMap::new())), now: now.unwrap_or_else(|| Box::new(now_secs)), owner_input }
    }

    pub fn update(&self, settings: TierSettings) {
        self.state.lock().unwrap().0 = settings;
    }

    pub fn settings(&self) -> TierSettings {
        self.state.lock().unwrap().0.clone()
    }

    pub fn effective_tier(&self, bundle_id: Option<&str>) -> Tier {
        let st = self.state.lock().unwrap();
        self.effective_locked(&st.0, &st.1, bundle_id)
    }

    fn effective_locked(&self, settings: &TierSettings, allowances: &HashMap<String, (Tier, f64)>, bundle_id: Option<&str>) -> Tier {
        let cap = cap_for(bundle_id, settings);
        let user = match settings.value(bundle_id) {
            SettingValue::Off => Tier::Off,
            SettingValue::Read => Tier::Read,
            SettingValue::Click => Tier::Click,
            SettingValue::Interact => Tier::Interact,
            SettingValue::Ask => match bundle_id.map(str::to_lowercase).and_then(|k| allowances.get(&k).copied()) {
                Some((t, until)) if until > (self.now)() => t,
                _ => Tier::Off,
            },
        };
        cap.min(user)
    }

    /// Checks `intent` on `bundle_id`. An approval counts only when it was granted for this exact
    /// app (#267) and for at least the tier needed; when the user setting is `ask`, it records an
    /// "Allow for this session" allowance for the approved tier only (never more).
    pub fn authorize(&self, intent: Intent, bundle_id: Option<&str>, app_name: &str, approval: Option<&ApprovalBinding>) -> CapResult<()> {
        let mut guard = self.state.lock().unwrap();
        let (settings, allowances) = &mut *guard;
        let needed = intent.required_tier();
        let cap = cap_for(bundle_id, settings);
        if cap < needed {
            return Err(refusal(needed, cap, app_name, bundle_id, true));
        }
        if let Some(a) = approval {
            match bundle_id {
                Some(id) if a.app.eq_ignore_ascii_case(id) => {}
                _ => {
                    return Err(CapError::new(
                        code::POLICY_DENIED,
                        "approval_app_mismatch",
                        format!("The approval was for {}, but the action would reach {app_name}", a.app),
                    )
                    .detail("approvedApp", a.app.clone())
                    .detail("app", bundle_id.unwrap_or(app_name)));
                }
            }
        }
        let mut have = self.effective_locked(settings, allowances, bundle_id);
        let asks = settings.value(bundle_id) == SettingValue::Ask;
        if have < needed && !asks {
            return Err(refusal(needed, have, app_name, bundle_id, false));
        }
        // Before any card: an approval from a phone is not someone watching this PC.
        self.check_attention(intent, bundle_id, app_name, settings)?;
        if have < needed && asks {
            if let (Some(a), Some(key)) = (approval, bundle_id.map(str::to_lowercase)) {
                if a.tier >= needed {
                    let granted = cap.min(a.tier);
                    allowances.insert(key, (granted, (self.now)() + SESSION_ALLOWANCE_SECS));
                    have = granted;
                }
            }
        }
        if have < needed {
            return Err(CapError::new(
                code::APPROVAL_REQUIRED,
                if approval.is_none() { "tier_ask" } else { "approval_tier_too_low" },
                format!("{app_name} needs your permission for computer use. Approve it once to allow it for 30 minutes."),
            )
            .detail("app", bundle_id.unwrap_or(app_name))
            .detail("tierRequired", needed.as_str()));
        }
        Ok(())
    }

    fn check_attention(&self, intent: Intent, bundle_id: Option<&str>, app_name: &str, settings: &TierSettings) -> CapResult<()> {
        let Some(owner) = &self.owner_input else { return Ok(()) };
        if !attention::applies(intent) || !attention::is_sensitive(bundle_id, settings) {
            return Ok(());
        }
        let idle = owner().map(|t| ((self.now)() - t).max(0.0));
        if let Some(i) = idle {
            if i <= attention::WINDOW_SECS {
                return Ok(());
            }
        }
        let mut e = CapError::new(
            code::PRESENCE_REQUIRED,
            "awaiting_attention",
            format!(
                "{app_name} is a sensitive app: Psyche acts in it only while you are at this PC. Use the keyboard or mouse to continue."
            ),
        )
        .detail("app", bundle_id.unwrap_or(app_name))
        .detail("windowSeconds", attention::WINDOW_SECS)
        .retryable();
        if let Some(i) = idle {
            e = e.detail("idleSeconds", i.round());
        }
        Err(e)
    }

    pub fn clear_allowances(&self) {
        self.state.lock().unwrap().1.clear();
    }
}

pub fn refusal(needed: Tier, have: Tier, app_name: &str, bundle_id: Option<&str>, fixed: bool) -> CapError {
    use fixed_caps::Category::*;
    let why = match (have, fixed_caps::category(bundle_id)) {
        (Tier::Off, Some(Psyche)) => "Psyche never drives its own windows.",
        (Tier::Off, Some(PasswordManager)) => "Password managers are off limits for computer use.",
        (Tier::Off, Some(Finance)) => "Banking, trading and crypto apps are off limits for computer use.",
        (Tier::Off, Some(SystemAuthority)) => "Settings, notifications and security prompts are off limits for computer use.",
        (Tier::Read, Some(Browser)) => "Browsers are read only; use the agent browser to act on the web.",
        (Tier::Click, Some(TerminalOrIde)) => "Terminals and IDEs are click only (equivalent to shell access).",
        (Tier::Off, _) => "Computer use is off for this app.",
        (Tier::Read, _) => "This app is set to Read only.",
        _ => "This app is limited to plain clicks.",
    };
    CapError::new(code::POLICY_DENIED, format!("tier_{}", have.as_str()), format!("{app_name}: {why}"))
        .detail("app", bundle_id.unwrap_or(app_name))
        .detail("tier", have.as_str())
        .detail("tierRequired", needed.as_str())
        .detail("fixedCap", fixed)
}

/// One computer-use session at a time (J5). A session is identified by the Gateway-supplied
/// `session` param (run id); it lapses after `idle_timeout` seconds without actions.
pub struct SessionLock {
    state: Mutex<SessionState>,
    pub idle_timeout: f64,
    now: Clock,
}

impl SessionLock {
    pub fn new(idle_timeout: f64, now: Option<Clock>) -> SessionLock {
        SessionLock { state: Mutex::new((None, Vec::new())), idle_timeout, now: now.unwrap_or_else(|| Box::new(now_secs)) }
    }

    /// Takes or refreshes the lock for `session`; `conflict/computer_busy` if another holds it.
    pub fn acquire(&self, session: &str) -> CapResult<()> {
        let mut st = self.state.lock().unwrap();
        if st.1.iter().any(|s| s == session) {
            return Err(CapError::stopped());
        }
        let t = (self.now)();
        if let Some((id, last)) = &st.0 {
            if id != session && t - last < self.idle_timeout {
                return Err(CapError::new(
                    code::CONFLICT,
                    "computer_busy",
                    "Another task is using the computer. Try again when it finishes.",
                )
                .retryable());
            }
        }
        st.0 = Some((session.to_string(), t));
        Ok(())
    }

    /// Esc: ends the active session for good. Later calls from it fail with `user_stopped`.
    pub fn stop_active(&self) -> Option<String> {
        let mut st = self.state.lock().unwrap();
        let (id, _) = st.0.take()?;
        st.1.push(id.clone());
        if st.1.len() > 64 {
            let extra = st.1.len() - 64;
            st.1.drain(..extra);
        }
        Some(id)
    }

    pub fn release(&self, session: &str) {
        let mut st = self.state.lock().unwrap();
        if st.0.as_ref().map(|(id, _)| id == session).unwrap_or(false) {
            st.0 = None;
        }
    }

    pub fn active_session(&self) -> Option<String> {
        let st = self.state.lock().unwrap();
        match &st.0 {
            Some((id, last)) if (self.now)() - last < self.idle_timeout => Some(id.clone()),
            _ => None,
        }
    }
}

thread_local! {
    static TOKEN: Cell<Option<u64>> = const { Cell::new(None) };
    static CANCEL: std::cell::RefCell<Option<Arc<AtomicBool>>> = const { std::cell::RefCell::new(None) };
}

/// Global Esc stop (J5: "Esc stops an in-flight action within 200 ms"). Each computer-use
/// invocation runs under a token; `trip()` stops every invocation issued before the press, and
/// later invocations start clean. Long-running actions poll `check()` between steps (≤ 20 ms).
#[derive(Default)]
pub struct StopSignal {
    state: Mutex<(u64, u64)>, // (issued, stopped_through)
}

impl StopSignal {
    pub fn new() -> StopSignal {
        StopSignal::default()
    }

    /// Runs `body` as one stoppable invocation on this thread. `cancel`, when given, is the
    /// node protocol's cancellation of this invocation.
    pub fn run<T>(&self, cancel: Option<Arc<AtomicBool>>, body: impl FnOnce() -> T) -> T {
        let token = {
            let mut st = self.state.lock().unwrap();
            st.0 += 1;
            st.0
        };
        let prev = TOKEN.with(|t| t.replace(Some(token)));
        let prev_cancel = CANCEL.with(|c| c.replace(cancel));
        let r = body();
        TOKEN.with(|t| t.set(prev));
        CANCEL.with(|c| *c.borrow_mut() = prev_cancel);
        r
    }

    /// Stops every invocation issued so far.
    pub fn trip(&self) {
        let mut st = self.state.lock().unwrap();
        st.1 = st.0;
    }

    pub fn is_tripped(&self) -> bool {
        let st = self.state.lock().unwrap();
        match TOKEN.with(|t| t.get()) {
            Some(t) => t <= st.1,
            None => st.1 > 0 && st.1 == st.0,
        }
    }

    /// `cancelled/user_stopped` once the user pressed Esc during this invocation.
    pub fn check(&self) -> CapResult<()> {
        if self.is_tripped() {
            return Err(CapError::stopped());
        }
        if CANCEL.with(|c| c.borrow().as_ref().map(|f| f.load(Ordering::SeqCst)).unwrap_or(false)) {
            return Err(CapError::cancelled());
        }
        Ok(())
    }
}

/// Labels and custom actions that create, send or destroy data while looking like ordinary
/// buttons (spike 04 guidance 6). Pressing one needs an approved invocation even when the app's
/// tier allows interaction. Same words as the Gateway's `RISKY_WORDS`.
pub mod risk_labels {
    pub const WORDS: &[&str] = &[
        "delete",
        "trash",
        "remove",
        "erase",
        "clear",
        "discard",
        "empty",
        "send",
        "submit",
        "purchase",
        "buy",
        "pay",
        "transfer",
        "unsubscribe",
        "sign out",
        "log out",
        "reset",
        "uninstall",
        "format",
        "quit",
        "move to trash",
        "add list",
    ];

    /// True when `label` or `custom_action` contains a risky word as a whole word or phrase.
    pub fn is_risky(label: Option<&str>, custom_action: Option<&str>) -> bool {
        for text in [label, custom_action].into_iter().flatten() {
            let tokens: String = text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
            let tokens = format!(" {tokens} ");
            if WORDS.iter().any(|w| tokens.contains(&format!(" {w} "))) {
                return true;
            }
        }
        false
    }
}

/// A JSON object helper for results.
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

/// `{app, tier}` approval schema property, added to every computer-use input schema.
pub fn approval_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "app": {"type": "string", "description": "Desktop file id (bundle id) the approval card named"},
            "tier": {"type": "string", "enum": ["read", "click", "interact"]}
        },
        "additionalProperties": false,
        "required": ["app", "tier"],
        "description": "Set by the Gateway with approvalId; the helper honours the approval only for this app and tier"
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn clock(t: Arc<AtomicU64>) -> Clock {
        Box::new(move || t.load(Ordering::SeqCst) as f64)
    }

    const EDITOR: &str = "org.gnome.TextEditor";

    #[test]
    fn caps_by_category() {
        assert_eq!(fixed_caps::cap(Some("firefox")), Tier::Read);
        assert_eq!(fixed_caps::cap(Some("Firefox.desktop")), Tier::Read);
        assert_eq!(fixed_caps::cap(Some("org.gnome.Ptyxis")), Tier::Click);
        assert_eq!(fixed_caps::cap(Some("jetbrains-idea")), Tier::Click);
        assert_eq!(fixed_caps::cap(Some("jetbrainsx")), Tier::Interact);
        assert_eq!(fixed_caps::cap(Some("KeePassXC")), Tier::Off);
        assert_eq!(fixed_caps::cap(Some("org.gnome.Shell")), Tier::Off);
        assert_eq!(fixed_caps::cap(Some("polkit-gnome-authentication-agent-1")), Tier::Off);
        assert_eq!(fixed_caps::cap(Some("coinbase-desktop")), Tier::Off);
        assert_eq!(fixed_caps::cap(Some("psyche")), Tier::Off);
        assert_eq!(fixed_caps::cap(Some(EDITOR)), Tier::Interact);
        assert_eq!(fixed_caps::cap(None), Tier::Interact);
    }

    #[test]
    fn settings_parse_and_file_caps() {
        let s = TierSettings::from_json(&json!({
            "version": 1, "default": "ask",
            "apps": {"org.gnome.TextEditor": "interact", "gnome-calculator": "read", "bad": "nope"},
            "caps": {"org.gnome.texteditor": "click", "com.jetbrains.*": "click"},
            "sensitive": ["gimp"]
        }));
        assert_eq!(s.value(Some("org.gnome.texteditor")), SettingValue::Interact);
        assert_eq!(s.value(Some("gnome-calculator")), SettingValue::Read);
        assert_eq!(s.value(Some("other")), SettingValue::Ask);
        assert_eq!(cap_for(Some(EDITOR), &s), Tier::Click);
        assert_eq!(s.file_cap(Some("com.jetbrains.rider")), Tier::Click);
        assert!(attention::is_sensitive(Some("GIMP"), &s));
        assert!(attention::is_sensitive(Some("gnome-terminal"), &s));
        assert!(attention::is_sensitive(Some("slack"), &s));
    }

    #[test]
    fn tiers_and_fixed_caps_refuse() {
        let s = TierSettings::from_json(&json!({"default": "interact"}));
        let p = TierPolicy::new(s, None, None);
        p.authorize(Intent::Type, Some(EDITOR), "Text Editor", None).unwrap();
        let e = p.authorize(Intent::Type, Some("firefox"), "Firefox", None).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), ("policy_denied", "tier_read"));
        assert_eq!(e.details["fixedCap"], true);
        p.authorize(Intent::Read, Some("firefox"), "Firefox", None).unwrap();
        let e = p.authorize(Intent::Key, Some("gnome-terminal"), "Terminal", None).unwrap_err();
        assert_eq!(e.reason, "tier_click");
        p.authorize(Intent::Click, Some("gnome-terminal"), "Terminal", None).unwrap();
        // A click on a menu escalates to interact.
        assert_eq!(Intent::Click.escalated(Some("AXMenuItem")), Intent::Menu);
        assert!(p.authorize(Intent::Click.escalated(Some("AXMenuItem")), Some("gnome-terminal"), "Terminal", None).is_err());
        let e = p.authorize(Intent::Read, Some("keepassxc"), "KeePassXC", None).unwrap_err();
        assert_eq!(e.reason, "tier_off");
        let e = p.authorize(Intent::Click, Some("gnome-shell"), "Shell", None).unwrap_err();
        assert_eq!(e.reason, "tier_off");
    }

    #[test]
    fn ask_needs_an_approval_for_the_same_app_and_records_an_allowance() {
        let t = Arc::new(AtomicU64::new(1000));
        let p = TierPolicy::new(TierSettings::default(), Some(clock(t.clone())), None);
        let e = p.authorize(Intent::Click, Some(EDITOR), "Text Editor", None).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), ("approval_required", "tier_ask"));
        assert_eq!(e.details["tierRequired"], "click");
        let other = ApprovalBinding { id: "a1".into(), app: "gnome-calculator".into(), tier: Tier::Interact };
        let e = p.authorize(Intent::Click, Some(EDITOR), "Text Editor", Some(&other)).unwrap_err();
        assert_eq!(e.reason, "approval_app_mismatch");
        let low = ApprovalBinding { id: "a2".into(), app: EDITOR.into(), tier: Tier::Click };
        let e = p.authorize(Intent::Type, Some(EDITOR), "Text Editor", Some(&low)).unwrap_err();
        assert_eq!(e.reason, "approval_tier_too_low");
        p.authorize(Intent::Click, Some(EDITOR), "Text Editor", Some(&low)).unwrap();
        // The allowance holds for 30 minutes, for the approved tier only.
        p.authorize(Intent::Click, Some("org.gnome.texteditor"), "Text Editor", None).unwrap();
        assert!(p.authorize(Intent::Type, Some(EDITOR), "Text Editor", None).is_err());
        t.store(1000 + 31 * 60, Ordering::SeqCst);
        assert!(p.authorize(Intent::Click, Some(EDITOR), "Text Editor", None).is_err());
    }

    #[test]
    fn sensitive_apps_wait_for_the_owner() {
        let t = Arc::new(AtomicU64::new(10_000));
        let last = Arc::new(AtomicU64::new(0));
        let l2 = last.clone();
        let p = TierPolicy::new(
            TierSettings::from_json(&json!({"default": "interact"})),
            Some(clock(t.clone())),
            Some(Box::new(move || {
                let v = l2.load(Ordering::SeqCst);
                (v > 0).then_some(v as f64)
            })),
        );
        let e = p.authorize(Intent::Type, Some("slack"), "Slack", None).unwrap_err();
        assert_eq!((e.code, e.reason.as_str(), e.retryable), ("presence_required", "awaiting_attention", true));
        assert!(e.details.get("idleSeconds").is_none());
        p.authorize(Intent::Read, Some("slack"), "Slack", None).unwrap();
        p.authorize(Intent::Scroll, Some("slack"), "Slack", None).unwrap();
        last.store(10_000 - 60, Ordering::SeqCst);
        p.authorize(Intent::Type, Some("slack"), "Slack", None).unwrap();
        last.store(10_000 - 600, Ordering::SeqCst);
        let e = p.authorize(Intent::Type, Some("slack"), "Slack", None).unwrap_err();
        assert_eq!(e.details["idleSeconds"], 600.0);
        p.authorize(Intent::Type, Some(EDITOR), "Text Editor", None).unwrap();
    }

    #[test]
    fn approval_binding_from_params() {
        let p = json!({"approval": {"app": EDITOR, "tier": "interact"}});
        assert_eq!(ApprovalBinding::from(Some("ap1"), &p).unwrap().tier, Tier::Interact);
        assert!(ApprovalBinding::from(None, &p).is_none());
        assert!(ApprovalBinding::from(Some("ap1"), &json!({})).is_none());
        assert!(ApprovalBinding::from(Some("ap1"), &json!({"approval": {"app": "x", "tier": "god"}})).is_none());
    }

    #[test]
    fn session_lock_and_stop() {
        let t = Arc::new(AtomicU64::new(0));
        let s = SessionLock::new(120.0, Some(clock(t.clone())));
        s.acquire("run1").unwrap();
        let e = s.acquire("run2").unwrap_err();
        assert_eq!((e.reason.as_str(), e.retryable), ("computer_busy", true));
        t.store(121, Ordering::SeqCst);
        s.acquire("run2").unwrap();
        assert_eq!(s.stop_active().as_deref(), Some("run2"));
        assert_eq!(s.acquire("run2").unwrap_err().reason, "user_stopped");
        s.acquire("run3").unwrap();
        s.release("run3");
        assert!(s.active_session().is_none());
    }

    #[test]
    fn stop_signal_stops_only_earlier_invocations() {
        let stop = StopSignal::new();
        stop.run(None, || {
            stop.check().unwrap();
            stop.trip();
            assert_eq!(stop.check().unwrap_err().reason, "user_stopped");
        });
        stop.run(None, || stop.check().unwrap());
        let flag = Arc::new(AtomicBool::new(true));
        stop.run(Some(flag), || assert_eq!(stop.check().unwrap_err().reason, "cancelled"));
    }

    #[test]
    fn risky_labels() {
        assert!(risk_labels::is_risky(Some("Delete"), None));
        assert!(risk_labels::is_risky(Some("Move to Trash"), None));
        assert!(risk_labels::is_risky(Some("Add List: Groceries"), None));
        assert!(risk_labels::is_risky(None, Some("send")));
        assert!(!risk_labels::is_risky(Some("Deleted items"), None));
        assert!(!risk_labels::is_risky(Some("Save"), None));
    }
}
