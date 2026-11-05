//! `permissions.status`, `permissions.request`, `permissions.open_settings` (feature A9) with the
//! mac helper's permission names mapped to their Windows equivalents, reported honestly:
//!
//! | name | Windows |
//! |---|---|
//! | `microphone`, `camera` | privacy consent store (`CapabilityAccessManager\ConsentStore`): device, user and "desktop apps" toggles, plus the AppPrivacy policy |
//! | `notifications` | the toast setting for AUMID `com.psyche.helper` |
//! | `accessibility`, `inputMonitoring` | no grant exists: UI Automation and input are available, limited by UIPI (an unelevated helper cannot drive elevated windows); `details` reports integrity / elevation / UIAccess |
//! | `screenRecording` | no grant exists for desktop apps: always available (`granted`) |
//! | `speechRecognition` | the "Online speech recognition" privacy switch |
//! | `automation`, `fullDiskAccess`, `calendars`, `reminders`, `contacts` | no Windows equivalent used by this helper: `notApplicable` |
//!
//! Windows has no programmatic consent prompt for unpackaged apps, so `permissions.request`
//! opens the matching `ms-settings:` page when something is off and reports the state.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::node::capability::{CapabilityError, CapabilityOutput, CapabilitySpec, OsPermission, ReceiptDraft, SideEffect};
use crate::node::registry::PermissionPreflight;
use crate::node::{CapabilityRegistry, schema};
use crate::win::registry::{Hive, read_dword, read_string};
use crate::win::security;

pub struct Entry {
    pub title: &'static str,
    pub explanation: &'static str,
    pub when_requested: &'static str,
    pub settings_url: &'static str,
    /// `prompt` | `settingsOnly` | `perTarget` | `none`.
    pub style: &'static str,
    pub applicable: bool,
}

/// Request order (security §12): Accessibility first, notifications at onboarding, the rest on use.
pub const ORDER: [OsPermission; 12] = [
    OsPermission::Accessibility,
    OsPermission::Notifications,
    OsPermission::Microphone,
    OsPermission::SpeechRecognition,
    OsPermission::Automation,
    OsPermission::Calendars,
    OsPermission::Reminders,
    OsPermission::Contacts,
    OsPermission::ScreenRecording,
    OsPermission::FullDiskAccess,
    OsPermission::InputMonitoring,
    OsPermission::Camera,
];

pub fn entry(p: OsPermission) -> Entry {
    let na = |title, url| Entry {
        title,
        explanation: "Not used on Windows: no Psyche Helper capability needs this permission here.",
        when_requested: "never",
        settings_url: url,
        style: "none",
        applicable: false,
    };
    match p {
        OsPermission::Accessibility => Entry {
            title: "UI Automation",
            explanation: "Windows lets Psyche Helper read and drive the apps you allow without a separate grant. Each app also has its own tier (Off, Read only, Read and interact). Windows never lets it drive apps running as administrator unless the helper runs as administrator too.",
            when_requested: "first computer-use tier above Off",
            settings_url: "ms-settings:easeofaccess",
            style: "none",
            applicable: true,
        },
        OsPermission::ScreenRecording => Entry {
            title: "Screen capture",
            explanation: "Only needed when an app's controls cannot be read and Psyche must look at the screen. Desktop apps need no grant on Windows; Psyche's windows and apps set to Off are never captured.",
            when_requested: "first screenshot fallback",
            settings_url: "ms-settings:privacy-graphicsCaptureProgrammatic",
            style: "none",
            applicable: true,
        },
        OsPermission::Microphone => Entry {
            title: "Microphone",
            explanation: "Used only while you dictate. Windows controls it with Settings › Privacy & security › Microphone (including “Let desktop apps access your microphone”).",
            when_requested: "first dictation",
            settings_url: "ms-settings:privacy-microphone",
            style: "settingsOnly",
            applicable: true,
        },
        OsPermission::Camera => Entry {
            title: "Camera",
            explanation: "Not used today. Windows controls it with Settings › Privacy & security › Camera (including “Let desktop apps access your camera”).",
            when_requested: "never",
            settings_url: "ms-settings:privacy-webcam",
            style: "settingsOnly",
            applicable: true,
        },
        OsPermission::SpeechRecognition => Entry {
            title: "Online speech recognition",
            explanation: "Windows' own speech service needs Settings › Privacy & security › Speech › Online speech recognition. Local transcription does not.",
            when_requested: "first dictation with the Windows speech engine",
            settings_url: "ms-settings:privacy-speech",
            style: "settingsOnly",
            applicable: true,
        },
        OsPermission::Notifications => Entry {
            title: "Notifications",
            explanation: "Shows approvals, questions and finished tasks with action buttons. On until you turn Psyche off in Settings › System › Notifications.",
            when_requested: "onboarding",
            settings_url: "ms-settings:notifications",
            style: "settingsOnly",
            applicable: true,
        },
        OsPermission::InputMonitoring => Entry {
            title: "Keyboard monitoring",
            explanation: "Used for the global Esc key that stops computer use and for hold-to-talk. Windows needs no grant; keys typed into apps running as administrator are not seen.",
            when_requested: "with UI Automation",
            settings_url: "ms-settings:easeofaccess-keyboard",
            style: "none",
            applicable: true,
        },
        OsPermission::Automation => na("Automation", "ms-settings:privacy"),
        OsPermission::FullDiskAccess => na("Full Disk Access", "ms-settings:privacy-broadfilesystemaccess"),
        OsPermission::Calendars => na("Calendars", "ms-settings:privacy-calendar"),
        OsPermission::Reminders => na("Reminders", "ms-settings:privacy-calendar"),
        OsPermission::Contacts => na("Contacts", "ms-settings:privacy-contacts"),
    }
}

const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const CONSENT_LM: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";
const APP_PRIVACY: &str = r"SOFTWARE\Policies\Microsoft\Windows\AppPrivacy";

/// Pure consent-store evaluation: any `Deny` (device, user, desktop apps) wins; a policy that
/// forces deny (2) is `restricted`; absent values mean Windows' default (allowed).
pub fn consent_state(policy: Option<u32>, device: Option<&str>, user: Option<&str>, desktop: Option<&str>) -> &'static str {
    if policy == Some(2) {
        return "restricted";
    }
    if policy == Some(1) {
        return "granted";
    }
    let deny = |v: Option<&str>| v.is_some_and(|s| s.eq_ignore_ascii_case("deny"));
    if deny(device) || deny(user) || deny(desktop) { "denied" } else { "granted" }
}

fn consent(capability: &str, policy_value: &str) -> &'static str {
    consent_state(
        read_dword(Hive::LocalMachine, APP_PRIVACY, policy_value),
        read_string(Hive::LocalMachine, &format!(r"{CONSENT_LM}\{capability}"), "Value").as_deref(),
        read_string(Hive::CurrentUser, &format!(r"{CONSENT}\{capability}"), "Value").as_deref(),
        read_string(Hive::CurrentUser, &format!(r"{CONSENT}\{capability}\NonPackaged"), "Value").as_deref(),
    )
}

fn online_speech() -> &'static str {
    match read_dword(Hive::CurrentUser, r"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy", "HasAccepted") {
        Some(1) => "granted",
        Some(_) => "denied",
        None => "notDetermined",
    }
}

/// Permission state from registry / API reads only (never prompts).
pub struct LivePreflight;

impl LivePreflight {
    pub fn new() -> Self {
        LivePreflight
    }

    pub fn state(&self, p: OsPermission) -> &'static str {
        match p {
            OsPermission::Accessibility | OsPermission::InputMonitoring | OsPermission::ScreenRecording => "granted",
            OsPermission::Microphone => consent("microphone", "LetAppsAccessMicrophone"),
            OsPermission::Camera => consent("webcam", "LetAppsAccessCamera"),
            OsPermission::SpeechRecognition => online_speech(),
            OsPermission::Notifications => crate::notify::toast::permission_state(),
            _ => "notApplicable",
        }
    }
}

impl PermissionPreflight for LivePreflight {
    fn is_granted(&self, p: OsPermission) -> bool {
        match p {
            // Checked by the capabilities themselves (as on the Mac).
            OsPermission::Notifications | OsPermission::Automation => true,
            _ => matches!(self.state(p), "granted" | "notApplicable"),
        }
    }
}

fn ui_details() -> Value {
    let rid = security::integrity_rid(None);
    json!({
        "integrityLevel": rid.map(security::integrity_name),
        "elevated": security::is_elevated(),
        "uiAccess": security::has_ui_access(),
        "limitation": "Windows (UIPI) blocks reading and input into apps running at a higher integrity level (as administrator) unless the helper runs elevated or has UIAccess.",
    })
}

fn row(p: OsPermission, state: &str) -> Value {
    let e = entry(p);
    let mut r = json!({
        "permission": p.as_str(),
        "status": state,
        "title": e.title,
        "explanation": e.explanation,
        "whenRequested": e.when_requested,
        "settingsURL": e.settings_url,
        "requestStyle": e.style,
        "applicable": e.applicable,
    });
    if matches!(p, OsPermission::Accessibility | OsPermission::InputMonitoring) {
        r["details"] = ui_details();
    }
    r
}

/// The next permission to ask for, given what is granted and wanted.
pub fn next(granted: &[OsPermission], wanted: &[OsPermission]) -> Option<OsPermission> {
    ORDER.iter().copied().find(|p| wanted.contains(p) && !granted.contains(p))
}

fn signing_kind(path: &str) -> &'static str {
    crate::win::trust::authenticode(path)
}

fn bundle_json() -> Value {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let lower = exe.to_lowercase();
    json!({
        "path": exe,
        "version": crate::node::registry::HELPER_VERSION,
        "build": "",
        // Inside the installed Psyche app (resources folder of the desktop install).
        "insideApp": lower.contains(r"\resources\") || lower.contains(r"\programs\psyche\"),
        "signing": signing_kind(&exe),
    })
}

#[derive(Deserialize)]
struct StatusParams {
    #[serde(rename = "automationTargets")]
    automation_targets: Option<Vec<String>>,
    wanted: Option<Vec<OsPermission>>,
}

#[derive(Deserialize)]
struct RequestParams {
    permission: OsPermission,
    purpose: Option<String>,
    #[allow(dead_code)]
    target: Option<String>,
}

#[derive(Deserialize)]
struct OpenParams {
    permission: OsPermission,
}

fn open_uri(uri: &str) -> bool {
    crate::win::shell::shell_open(uri, None).is_ok()
}

pub fn register(reg: &mut CapabilityRegistry) {
    let names = OsPermission::names();

    reg.add_blocking(
        CapabilitySpec::new(
            "permissions.status",
            "Status of every OS permission the helper uses, mapped to Windows (privacy consent store, toast setting, UIPI limits), with explanations, Settings links and the next one to ask for.",
            SideEffect::Read,
        )
        .input(schema::object(
            vec![
                ("automationTargets", schema::array(schema::string(None), Some("Ignored on Windows (no per-app Automation grant)"), Some(20))),
                ("wanted", schema::array(schema::string_enum(None, &names), Some("Features the user turned on"), None)),
            ],
            &[],
        )),
        move |ctx| {
            let p: StatusParams = ctx.decode()?;
            let preflight = LivePreflight::new();
            let mut granted = Vec::new();
            let mut rows = Vec::new();
            for perm in ORDER {
                let state = preflight.state(perm);
                if state == "granted" || state == "notApplicable" {
                    granted.push(perm);
                }
                rows.push(row(perm, state));
            }
            let automation: serde_json::Map<String, Value> =
                p.automation_targets.unwrap_or_default().into_iter().take(20).map(|t| (t, "notApplicable".into())).collect();
            let wanted = p.wanted.unwrap_or_else(|| vec![OsPermission::Accessibility, OsPermission::Notifications]);
            Ok(CapabilityOutput::new(json!({
                "permissions": rows,
                "automation": automation,
                "next": next(&granted, &wanted).map(|p| p.as_str()),
                "bundled": crate::notify::toast::current_setting().is_some(),
                "bundle": bundle_json(),
                "attribution": Value::Null,
                "disclaimSupported": false,
                "platform": "windows",
            })))
        },
    );

    reg.add_blocking(
        CapabilitySpec::new(
            "permissions.request",
            "Ask Windows for one permission. Windows has no consent prompt for desktop apps: when it is off, this opens the Settings page for it and reports the state (granted, denied, restricted, notApplicable). Screen capture needs purpose \"vision_fallback\".",
            SideEffect::Write,
        )
        .input(schema::object(
            vec![
                ("permission", schema::string_enum(None, &names)),
                ("purpose", schema::string(Some("vision_fallback (Screen capture only)"))),
                ("target", schema::string(Some("Ignored on Windows"))),
            ],
            &["permission"],
        ))
        .receipt("permission_request"),
        move |ctx| {
            let p: RequestParams = ctx.decode()?;
            let preflight = LivePreflight::new();
            if p.permission == OsPermission::Notifications {
                return Err(CapabilityError::invalid_params("Use notify.request_authorization (provisional first)", Some("permission")));
            }
            if p.permission == OsPermission::ScreenRecording && p.purpose.as_deref() != Some("vision_fallback") {
                return Err(CapabilityError::invalid_params(
                    "Screen Recording is requested only with purpose \"vision_fallback\"",
                    Some("purpose"),
                ));
            }
            let state = preflight.state(p.permission);
            let mut opened = false;
            if matches!(state, "denied" | "notDetermined" | "restricted") {
                opened = open_uri(entry(p.permission).settings_url);
            }
            Ok(CapabilityOutput::with_receipt(
                json!({ "permission": p.permission.as_str(), "status": state, "openedSettings": opened, "launched": false }),
                ReceiptDraft::ok(format!("Requested {}: {state}", p.permission.as_str())),
            ))
        },
    );

    reg.add_blocking(
        CapabilitySpec::new("permissions.open_settings", "Open Windows Settings at the page for one permission.", SideEffect::None)
            .input(schema::object(vec![("permission", schema::string_enum(None, &OsPermission::names()))], &["permission"])),
        |ctx| {
            let p: OpenParams = ctx.decode()?;
            Ok(CapabilityOutput::new(json!({ "opened": open_uri(entry(p.permission).settings_url) })))
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_rules() {
        assert_eq!(consent_state(None, None, None, None), "granted");
        assert_eq!(consent_state(None, Some("Allow"), Some("Allow"), Some("Deny")), "denied");
        assert_eq!(consent_state(None, Some("Deny"), Some("Allow"), None), "denied");
        assert_eq!(consent_state(Some(2), None, None, None), "restricted");
        assert_eq!(consent_state(Some(1), Some("Deny"), None, None), "granted");
    }

    #[test]
    fn next_follows_the_order() {
        let all = [OsPermission::Microphone, OsPermission::Notifications];
        assert_eq!(next(&[], &all), Some(OsPermission::Notifications));
        assert_eq!(next(&[OsPermission::Notifications], &all), Some(OsPermission::Microphone));
        assert_eq!(next(&all, &all), None);
    }

    #[test]
    fn every_permission_has_an_ms_settings_page() {
        for p in OsPermission::ALL {
            assert!(entry(p).settings_url.starts_with("ms-settings:"), "{}", p.as_str());
        }
    }

    #[test]
    fn preflight_treats_not_applicable_as_granted() {
        let pf = LivePreflight::new();
        assert!(pf.is_granted(OsPermission::FullDiskAccess));
        assert!(pf.is_granted(OsPermission::Accessibility));
    }
}
