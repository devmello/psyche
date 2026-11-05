//! Per-app computer-use tiers (feature F6/J5; port of `Core/Computer/Tiers.swift`). Shared by
//! `apps.*` here and by the wave-2 `computer.*` group.
//!
//! **App identity on Windows** (what the mac helper calls a bundle id): the window's or process's
//! AppUserModelID when it has one (packaged apps, `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`,
//! or Win32 apps that set one), else the full executable path (`C:\Program Files\…\app.exe`).
//! Settings keys in `computer-use.json` match an identity exactly (case-insensitive) or by
//! executable file name (`"notepad.exe": "interact"`). Fixed caps match executable file names
//! and AppUserModelID prefixes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use super::capability::{CapabilityError, CapabilitySpec, ErrorCode, InvocationContext};
use super::paths::{Env, psyche_home};
use super::schema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ComputerTier {
    Off,
    Read,
    Click,
    Interact,
}

impl ComputerTier {
    pub fn as_str(self) -> &'static str {
        match self {
            ComputerTier::Off => "off",
            ComputerTier::Read => "read",
            ComputerTier::Click => "click",
            ComputerTier::Interact => "interact",
        }
    }

    pub fn parse(s: &str) -> Option<ComputerTier> {
        match s {
            "off" => Some(ComputerTier::Off),
            "read" => Some(ComputerTier::Read),
            "click" => Some(ComputerTier::Click),
            "interact" => Some(ComputerTier::Interact),
            _ => None,
        }
    }
}

/// What a call needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerIntent {
    Read,
    Click,
    Scroll,
    RightClick,
    ModifierClick,
    Type,
    Key,
    Drag,
    SetValue,
    Press,
    Menu,
}

impl ComputerIntent {
    pub fn required_tier(self) -> ComputerTier {
        match self {
            ComputerIntent::Read => ComputerTier::Read,
            ComputerIntent::Click | ComputerIntent::Scroll | ComputerIntent::Press => {
                ComputerTier::Click
            }
            _ => ComputerTier::Interact,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Psyche,
    Browser,
    TerminalOrIde,
    PasswordManager,
    Finance,
    SystemAuthority,
}

/// One fixed-cap rule: an executable file name, or an AppUserModelID prefix.
enum Rule {
    Exe(&'static str),
    Aumid(&'static str),
}
use Rule::{Aumid, Exe};

const PSYCHE: &[Rule] = &[
    Exe("psyche.exe"),
    Exe("psyche-helper.exe"),
    Aumid("com.psyche."),
];

/// Settings, UAC, the lock screen, notification surfaces and security prompts: computer use must
/// never press Approve on its own toasts or answer a security dialog.
const SYSTEM_AUTHORITY: &[Rule] = &[
    Exe("systemsettings.exe"),
    Exe("consent.exe"),
    Exe("credentialuibroker.exe"),
    Exe("logonui.exe"),
    Exe("lockapp.exe"),
    Exe("shellexperiencehost.exe"),
    Exe("shellhost.exe"),
    Exe("securityhealthsystray.exe"),
    Exe("securityhealthhost.exe"),
    Exe("taskmgr.exe"),
    Exe("mmc.exe"),
    Exe("regedit.exe"),
    Exe("control.exe"),
    Exe("useraccountcontrolsettings.exe"),
    Aumid("windows.immersivecontrolpanel"),
    Aumid("microsoft.windows.sechealthui"),
    Aumid("microsoft.windows.shellexperiencehost"),
];

const BROWSERS: &[Rule] = &[
    Exe("chrome.exe"),
    Exe("msedge.exe"),
    Exe("firefox.exe"),
    Exe("brave.exe"),
    Exe("opera.exe"),
    Exe("opera_gx.exe"),
    Exe("vivaldi.exe"),
    Exe("arc.exe"),
    Exe("iexplore.exe"),
    Exe("zen.exe"),
    Exe("librewolf.exe"),
    Exe("waterfox.exe"),
    Exe("chromium.exe"),
    Exe("dia.exe"),
    Aumid("microsoft.microsoftedge"),
    Aumid("thebrowsercompany.arc"),
];

const TERMINALS_AND_IDES: &[Rule] = &[
    Exe("windowsterminal.exe"),
    Exe("wt.exe"),
    Exe("cmd.exe"),
    Exe("powershell.exe"),
    Exe("powershell_ise.exe"),
    Exe("pwsh.exe"),
    Exe("conhost.exe"),
    Exe("openconsole.exe"),
    Exe("wsl.exe"),
    Exe("wslhost.exe"),
    Exe("bash.exe"),
    Exe("mintty.exe"),
    Exe("putty.exe"),
    Exe("wezterm-gui.exe"),
    Exe("alacritty.exe"),
    Exe("hyper.exe"),
    Exe("warp.exe"),
    Exe("tabby.exe"),
    Exe("code.exe"),
    Exe("code - insiders.exe"),
    Exe("codium.exe"),
    Exe("cursor.exe"),
    Exe("windsurf.exe"),
    Exe("devenv.exe"),
    Exe("idea64.exe"),
    Exe("pycharm64.exe"),
    Exe("webstorm64.exe"),
    Exe("rider64.exe"),
    Exe("clion64.exe"),
    Exe("goland64.exe"),
    Exe("phpstorm64.exe"),
    Exe("rubymine64.exe"),
    Exe("datagrip64.exe"),
    Exe("studio64.exe"),
    Exe("sublime_text.exe"),
    Exe("zed.exe"),
    Aumid("microsoft.windowsterminal"),
    Aumid("microsoft.powershell"),
    Aumid("microsoft.visualstudiocode"),
];

const PASSWORD_MANAGERS: &[Rule] = &[
    Exe("1password.exe"),
    Exe("bitwarden.exe"),
    Exe("keepass.exe"),
    Exe("keepassxc.exe"),
    Exe("lastpass.exe"),
    Exe("dashlane.exe"),
    Exe("enpass.exe"),
    Exe("nordpass.exe"),
    Exe("proton pass.exe"),
    Exe("keeperpasswordmanager.exe"),
    Exe("roboform.exe"),
    Aumid("agilebits.1password"),
    Aumid("8bitsolutionsllc.bitwardendesktop"),
];

/// Banking, trading and crypto apps.
const FINANCE: &[Rule] = &[
    Exe("robinhood.exe"),
    Exe("webull desktop.exe"),
    Exe("webull.exe"),
    Exe("tws.exe"),
    Exe("ibgateway.exe"),
    Exe("thinkorswim.exe"),
    Exe("ledger live.exe"),
    Exe("exodus.exe"),
    Exe("coinbase.exe"),
    Exe("binance.exe"),
    Exe("kraken.exe"),
    Exe("tradingview.exe"),
    Exe("terminal64.exe"),
    Exe("metatrader.exe"),
    Exe("trezor suite.exe"),
    Aumid("tradingview."),
    Aumid("revolut."),
    Aumid("paypal."),
];

/// The executable file name (lowercase) an identity refers to, when it is a path or bare name.
pub fn exe_name(identity: &str) -> Option<String> {
    let l = identity.to_lowercase();
    if l.contains('!') {
        return None;
    }
    let name = Path::new(&l).file_name()?.to_string_lossy().into_owned();
    name.ends_with(".exe").then_some(name)
}

fn matches(identity: &str, rules: &[Rule]) -> bool {
    let lower = identity.to_lowercase();
    let exe = exe_name(identity);
    rules.iter().any(|r| match r {
        Exe(e) => exe.as_deref() == Some(*e),
        Aumid(prefix) => !lower.contains('\\') && lower.starts_with(prefix),
    })
}

pub mod fixed_caps {
    use super::*;

    pub fn category(identity: Option<&str>) -> Option<Category> {
        let id = identity?;
        if matches(id, PSYCHE) {
            Some(Category::Psyche)
        } else if matches(id, SYSTEM_AUTHORITY) {
            Some(Category::SystemAuthority)
        } else if matches(id, PASSWORD_MANAGERS) {
            Some(Category::PasswordManager)
        } else if matches(id, FINANCE) {
            Some(Category::Finance)
        } else if matches(id, BROWSERS) {
            Some(Category::Browser)
        } else if matches(id, TERMINALS_AND_IDES) {
            Some(Category::TerminalOrIde)
        } else {
            None
        }
    }

    /// The highest tier an app can ever get.
    pub fn cap(identity: Option<&str>) -> ComputerTier {
        match category(identity) {
            Some(
                Category::Psyche
                | Category::PasswordManager
                | Category::Finance
                | Category::SystemAuthority,
            ) => ComputerTier::Off,
            Some(Category::Browser) => ComputerTier::Read,
            Some(Category::TerminalOrIde) => ComputerTier::Click,
            None => ComputerTier::Interact,
        }
    }
}

/// `off`, `read`, `click`, `interact`, or `ask`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TierValue {
    Off,
    Read,
    Click,
    Interact,
    Ask,
}

/// `$PSYCHE_HOME\config\computer-use.json`: `{ "version": 1, "default": "ask", "apps": {…},
/// "sensitive": […] }`, written by the Gateway / desktop settings, never through `node.invoke`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TierSettings {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default = "ask", rename = "default")]
    pub default_value: TierValue,
    #[serde(default)]
    pub apps: HashMap<String, TierValue>,
    #[serde(default)]
    pub sensitive: Vec<String>,
}

fn one() -> u32 {
    1
}
fn ask() -> TierValue {
    TierValue::Ask
}

impl Default for TierSettings {
    fn default() -> Self {
        TierSettings {
            version: 1,
            default_value: TierValue::Ask,
            apps: HashMap::new(),
            sensitive: Vec::new(),
        }
    }
}

impl TierSettings {
    pub fn value(&self, identity: Option<&str>) -> TierValue {
        let Some(id) = identity else {
            return self.default_value;
        };
        if let Some(v) = self.apps.get(id) {
            return *v;
        }
        if let Some((_, v)) = self.apps.iter().find(|(k, _)| k.eq_ignore_ascii_case(id)) {
            return *v;
        }
        if let Some(exe) = exe_name(id)
            && let Some((_, v)) = self.apps.iter().find(|(k, _)| k.eq_ignore_ascii_case(&exe))
        {
            return *v;
        }
        self.default_value
    }

    pub fn path(env: &Env) -> std::path::PathBuf {
        psyche_home(env).join("config").join("computer-use.json")
    }

    pub fn load(env: &Env) -> TierSettings {
        std::fs::read(Self::path(env))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
}

/// What the Gateway's approval covered (#267): the app the card named and the tier it asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalBinding {
    pub id: String,
    pub app: String,
    pub tier: ComputerTier,
}

impl ApprovalBinding {
    /// From `params.approval {app, tier}` next to the invocation's `approvalId`.
    pub fn from_context(ctx: &InvocationContext) -> Option<ApprovalBinding> {
        let id = ctx.approval_id.clone()?;
        let a = ctx.params.get("approval")?;
        let app = a.get("app")?.as_str().filter(|s| !s.is_empty())?.to_owned();
        let tier = ComputerTier::parse(a.get("tier")?.as_str()?)?;
        Some(ApprovalBinding { id, app, tier })
    }
}

/// Adds the `approval {app, tier}` parameter every computer-use call may carry.
pub fn with_approval_param(mut spec: CapabilitySpec) -> CapabilitySpec {
    if let Some(props) = spec
        .input_schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
    {
        props.insert(
            "approval".into(),
            schema::object_with(
                vec![
                    ("app", schema::string(Some("App identity the approval card named (AppUserModelID or executable path)"))),
                    ("tier", schema::string_enum(None, &["read", "click", "interact"])),
                ],
                &["app", "tier"],
                Some("Set by the Gateway with approvalId; the helper honours the approval only for this app and tier"),
                false,
            ),
        );
    }
    spec
}

/// Fixed cap ∧ user tier ∧ "Allow for this session" allowances (30 minutes).
pub struct TierPolicy {
    inner: Mutex<PolicyState>,
}

struct PolicyState {
    settings: TierSettings,
    allowances: HashMap<String, (ComputerTier, Instant)>,
}

pub const SESSION_ALLOWANCE: Duration = Duration::from_secs(30 * 60);

impl TierPolicy {
    pub fn new(settings: TierSettings) -> Self {
        TierPolicy {
            inner: Mutex::new(PolicyState {
                settings,
                allowances: HashMap::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PolicyState> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn update(&self, settings: TierSettings) {
        self.lock().settings = settings;
    }

    pub fn reload(&self, env: &Env) {
        self.update(TierSettings::load(env));
    }

    fn effective(state: &PolicyState, identity: Option<&str>) -> ComputerTier {
        let cap = fixed_caps::cap(identity);
        let user = match state.settings.value(identity) {
            TierValue::Off => ComputerTier::Off,
            TierValue::Read => ComputerTier::Read,
            TierValue::Click => ComputerTier::Click,
            TierValue::Interact => ComputerTier::Interact,
            TierValue::Ask => identity
                .and_then(|id| state.allowances.get(&id.to_lowercase()))
                .filter(|(_, until)| *until > Instant::now())
                .map(|(t, _)| *t)
                .unwrap_or(ComputerTier::Off),
        };
        cap.min(user)
    }

    /// The tier in effect now, without an approval on the current call.
    pub fn effective_tier(&self, identity: Option<&str>) -> ComputerTier {
        Self::effective(&self.lock(), identity)
    }

    /// Checks `intent` on an app. An approval counts only for this exact app and at least the
    /// needed tier; with the user setting `ask` it records a 30-minute allowance for that tier.
    pub fn authorize(
        &self,
        intent: ComputerIntent,
        identity: Option<&str>,
        app_name: &str,
        approval: Option<&ApprovalBinding>,
    ) -> Result<(), CapabilityError> {
        let mut state = self.lock();
        let needed = intent.required_tier();
        let cap = fixed_caps::cap(identity);
        if cap < needed {
            return Err(refusal(needed, cap, app_name, identity, true));
        }
        if let Some(a) = approval {
            let same = identity.is_some_and(|id| a.app.eq_ignore_ascii_case(id));
            if !same {
                return Err(CapabilityError::new(
                    ErrorCode::PolicyDenied,
                    "approval_app_mismatch",
                    format!(
                        "The approval was for {}, but the action would reach {app_name}",
                        a.app
                    ),
                )
                .with_detail("approvedApp", a.app.clone())
                .with_detail("app", identity.unwrap_or(app_name)));
            }
        }
        let mut have = Self::effective(&state, identity);
        let asks = state.settings.value(identity) == TierValue::Ask;
        if have < needed && !asks {
            return Err(refusal(needed, have, app_name, identity, false));
        }
        if have < needed
            && asks
            && let (Some(a), Some(id)) = (approval, identity)
            && a.tier >= needed
        {
            let granted = cap.min(a.tier);
            state.allowances.insert(
                id.to_lowercase(),
                (granted, Instant::now() + SESSION_ALLOWANCE),
            );
            have = granted;
        }
        if have < needed {
            return Err(CapabilityError::new(
                ErrorCode::ApprovalRequired,
                if approval.is_none() { "tier_ask" } else { "approval_tier_too_low" },
                format!("{app_name} needs your permission for computer use. Approve it once to allow it for 30 minutes."),
            )
            .with_detail("app", identity.unwrap_or(app_name))
            .with_detail("tierRequired", needed.as_str()));
        }
        Ok(())
    }

    pub fn clear_allowances(&self) {
        self.lock().allowances.clear();
    }
}

fn refusal(
    needed: ComputerTier,
    have: ComputerTier,
    app_name: &str,
    identity: Option<&str>,
    fixed: bool,
) -> CapabilityError {
    let why = match (have, fixed_caps::category(identity)) {
        (ComputerTier::Off, Some(Category::Psyche)) => "Psyche never drives its own windows.",
        (ComputerTier::Off, Some(Category::PasswordManager)) => {
            "Password managers are off limits for computer use."
        }
        (ComputerTier::Off, Some(Category::Finance)) => {
            "Banking, trading and crypto apps are off limits for computer use."
        }
        (ComputerTier::Off, Some(Category::SystemAuthority)) => {
            "Settings, notifications and security prompts are off limits for computer use."
        }
        (ComputerTier::Read, Some(Category::Browser)) => {
            "Browsers are read only; use the agent browser to act on the web."
        }
        (ComputerTier::Click, Some(Category::TerminalOrIde)) => {
            "Terminals and IDEs are click only (equivalent to shell access)."
        }
        (ComputerTier::Off, _) => "Computer use is off for this app.",
        (ComputerTier::Read, _) => "This app is set to Read only.",
        _ => "This app is limited to plain clicks.",
    };
    CapabilityError::new(
        ErrorCode::PolicyDenied,
        format!("tier_{}", have.as_str()),
        format!("{app_name}: {why}"),
    )
    .with_detail("app", identity.unwrap_or(app_name))
    .with_detail("tier", have.as_str())
    .with_detail("tierRequired", needed.as_str())
    .with_detail("fixedCap", fixed)
}

/// The process-wide policy (shared by `apps.*` and `computer.*`), loaded from
/// `computer-use.json`; callers `reload` it before each decision, as the mac helper does.
pub fn shared_policy(rt: &super::registry::Runtime) -> std::sync::Arc<TierPolicy> {
    rt.service(|| TierPolicy::new(TierSettings::load(&rt.env)))
}

/// `{tier, fixedCap}` for an app.
pub fn describe(identity: Option<&str>, policy: &TierPolicy) -> Value {
    json!({ "tier": policy.effective_tier(identity).as_str(), "fixedCap": fixed_caps::cap(identity).as_str() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fixed_caps_by_exe_and_aumid() {
        assert_eq!(
            fixed_caps::cap(Some(
                r"C:\Program Files\Google\Chrome\Application\chrome.exe"
            )),
            ComputerTier::Read
        );
        assert_eq!(
            fixed_caps::cap(Some("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")),
            ComputerTier::Click
        );
        assert_eq!(
            fixed_caps::cap(Some(r"C:\Windows\System32\consent.exe")),
            ComputerTier::Off
        );
        assert_eq!(
            fixed_caps::cap(Some(
                "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel"
            )),
            ComputerTier::Off
        );
        assert_eq!(
            fixed_caps::cap(Some(
                r"C:\Users\x\AppData\Local\1Password\app\8\1Password.exe"
            )),
            ComputerTier::Off
        );
        assert_eq!(
            fixed_caps::cap(Some("com.psyche.helper")),
            ComputerTier::Off
        );
        assert_eq!(
            fixed_caps::cap(Some(r"C:\Windows\notepad.exe")),
            ComputerTier::Interact
        );
        assert_eq!(fixed_caps::cap(None), ComputerTier::Interact);
        // A path segment that merely contains a browser name is not the browser.
        assert_eq!(
            fixed_caps::cap(Some(r"C:\chrome.exe.d\tool.exe")),
            ComputerTier::Interact
        );
    }

    #[test]
    fn settings_match_identity_or_exe_name() {
        let s: TierSettings = serde_json::from_value(
            json!({"default": "off", "apps": {"notepad.exe": "interact", "Foo!App": "read"}}),
        )
        .unwrap();
        assert_eq!(
            s.value(Some(r"C:\Windows\System32\NOTEPAD.EXE")),
            TierValue::Interact
        );
        assert_eq!(s.value(Some("foo!app")), TierValue::Read);
        assert_eq!(s.value(Some("other.exe")), TierValue::Off);
        assert_eq!(TierSettings::default().value(None), TierValue::Ask);
    }

    #[test]
    fn authorize_caps_asks_and_binds_approvals() {
        let s: TierSettings = serde_json::from_value(
            json!({"default": "ask", "apps": {"chrome.exe": "interact", "calc.exe": "read"}}),
        )
        .unwrap();
        let p = Arc::new(TierPolicy::new(s));
        let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
        assert!(
            p.authorize(ComputerIntent::Read, Some(chrome), "Chrome", None)
                .is_ok()
        );
        let e = p
            .authorize(ComputerIntent::Type, Some(chrome), "Chrome", None)
            .unwrap_err();
        assert_eq!(e.reason, "tier_read");
        assert_eq!(e.details["fixedCap"], true);
        let e = p
            .authorize(ComputerIntent::Click, Some(r"C:\x\calc.exe"), "Calc", None)
            .unwrap_err();
        assert_eq!(e.reason, "tier_read");
        let notes = r"C:\x\notes.exe";
        assert_eq!(
            p.authorize(ComputerIntent::Read, Some(notes), "Notes", None)
                .unwrap_err()
                .reason,
            "tier_ask"
        );
        let other = ApprovalBinding {
            id: "a".into(),
            app: "other.exe".into(),
            tier: ComputerTier::Interact,
        };
        assert_eq!(
            p.authorize(ComputerIntent::Read, Some(notes), "Notes", Some(&other))
                .unwrap_err()
                .reason,
            "approval_app_mismatch"
        );
        let ok = ApprovalBinding {
            id: "a".into(),
            app: notes.into(),
            tier: ComputerTier::Click,
        };
        assert!(
            p.authorize(ComputerIntent::Click, Some(notes), "Notes", Some(&ok))
                .is_ok()
        );
        assert_eq!(p.effective_tier(Some(notes)), ComputerTier::Click);
        assert_eq!(
            p.authorize(ComputerIntent::Type, Some(notes), "Notes", None)
                .unwrap_err()
                .reason,
            "tier_ask"
        );
        p.clear_allowances();
        assert_eq!(p.effective_tier(Some(notes)), ComputerTier::Off);
    }

    #[test]
    fn approval_param_is_added() {
        let spec = with_approval_param(
            CapabilitySpec::new("apps.focus", "", crate::node::SideEffect::Write)
                .input(schema::object(vec![], &[])),
        );
        assert_eq!(
            spec.input_schema["properties"]["approval"]["required"],
            json!(["app", "tier"])
        );
    }
}
