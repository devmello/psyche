//! Whether classic Outlook can be automated here, from the registry only (never starts Outlook,
//! never prompts). The capabilities are advertised only when it can, so the Gateway hides the
//! connector otherwise; `health` and `permissions.status` say why.
//!
//! - Classic Outlook registers the `Outlook.Application` COM class (a `LocalServer32` under
//!   `CLSID`, in the 64-bit or the 32-bit view).
//! - The new Outlook for Windows (`olk.exe`, a packaged app) has no COM object model at all: with
//!   only it installed nothing can be offered. With both, classic Outlook is still automatable
//!   even when the user switched to the new one (`UseNewOutlook`), but its mail is then whatever
//!   classic Outlook's own profile syncs.

use serde_json::{Value, json};

use crate::node::paths::Env;
use crate::win::registry::{Hive, key_exists, read_dword, read_string, subkey_names};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Availability {
    /// Classic Outlook's COM server is registered.
    pub classic: bool,
    /// Its major version (`16` for Microsoft 365 / 2016–2024).
    pub version: Option<String>,
    /// The new Outlook for Windows is installed.
    pub new_outlook: bool,
    /// The user switched classic Outlook to the new one.
    pub new_outlook_default: bool,
    /// Outlook mail profiles (classic Outlook prompts for one on first start when there is none).
    pub profiles: usize,
    /// Trust Center › Programmatic Access (`ObjectModelGuard`): `warnWhenAntivirusInactive`
    /// (the default), `alwaysWarn` or `neverWarn`.
    pub programmatic_access: &'static str,
}

impl Availability {
    pub fn available(&self) -> bool {
        self.classic
    }

    /// The machine reason when the capabilities are not offered.
    pub fn reason(&self) -> Option<&'static str> {
        match (self.classic, self.new_outlook) {
            (true, _) => None,
            (false, true) => Some("new_outlook_only"),
            (false, false) => Some("outlook_not_installed"),
        }
    }

    pub fn message(&self) -> &'static str {
        match self.reason() {
            None if self.profiles == 0 => {
                "Classic Outlook is installed but has no mail profile yet. Open Outlook once and add your account."
            }
            None => {
                "Classic Outlook is installed: mail, calendar, contacts and tasks are available."
            }
            Some("new_outlook_only") => {
                "Only the new Outlook for Windows is installed. It cannot be automated (it has no COM object model); install classic Outlook (Microsoft 365 apps) to use mail, calendar, contacts and tasks here."
            }
            Some(_) => {
                "Classic Outlook is not installed, so mail, calendar, contacts and tasks are not available on this PC."
            }
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "available": self.available(),
            "reason": self.reason(),
            "message": self.message(),
            "classic": self.classic,
            "version": self.version,
            "newOutlook": self.new_outlook,
            "newOutlookDefault": self.new_outlook_default,
            "profiles": self.profiles,
            "programmaticAccess": self.programmatic_access,
        })
    }
}

/// `ObjectModelGuard` (0 warn when antivirus is inactive, 1 always warn, 2 never warn).
pub fn guard_name(v: Option<u32>) -> &'static str {
    match v {
        Some(1) => "alwaysWarn",
        Some(2) => "neverWarn",
        _ => "warnWhenAntivirusInactive",
    }
}

/// `Outlook.Application.16` → `16`.
pub fn major_version(cur_ver: &str) -> Option<String> {
    let v = cur_ver.rsplit('.').next()?;
    (!v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())).then(|| v.to_owned())
}

/// Reads the registry (and the new Outlook's app execution alias).
pub fn detect(env: &Env) -> Availability {
    let clsid = read_string(Hive::ClassesRoot, r"Outlook.Application\CLSID", "");
    let classic = clsid.as_deref().is_some_and(|c| {
        key_exists(Hive::ClassesRoot, &format!(r"CLSID\{c}\LocalServer32"))
            || key_exists(
                Hive::ClassesRoot,
                &format!(r"WOW6432Node\CLSID\{c}\LocalServer32"),
            )
            || key_exists(
                Hive::LocalMachine,
                &format!(r"SOFTWARE\WOW6432Node\Classes\CLSID\{c}\LocalServer32"),
            )
    });
    let version = read_string(Hive::ClassesRoot, r"Outlook.Application\CurVer", "")
        .as_deref()
        .and_then(major_version)
        .or_else(|| classic.then(|| "16".to_owned()));
    let office = format!("{}.0", version.as_deref().unwrap_or("16"));
    let new_outlook = env.get("LOCALAPPDATA").is_some_and(|l| {
        std::path::Path::new(l)
            .join(r"Microsoft\WindowsApps\olk.exe")
            .exists()
    });
    let new_outlook_default = read_dword(
        Hive::CurrentUser,
        &format!(r"Software\Microsoft\Office\{office}\Outlook\Preferences"),
        "UseNewOutlook",
    ) == Some(1);
    let profiles = subkey_names(
        Hive::CurrentUser,
        &format!(r"Software\Microsoft\Office\{office}\Outlook\Profiles"),
        64,
    )
    .len();
    let guard = read_dword(
        Hive::LocalMachine,
        &format!(r"SOFTWARE\Microsoft\Office\{office}\Outlook\Security"),
        "ObjectModelGuard",
    )
    .or_else(|| {
        read_dword(
            Hive::LocalMachine,
            &format!(r"SOFTWARE\WOW6432Node\Microsoft\Office\{office}\Outlook\Security"),
            "ObjectModelGuard",
        )
    });
    Availability {
        classic,
        version: if classic { version } else { None },
        new_outlook,
        new_outlook_default,
        profiles,
        programmatic_access: guard_name(guard),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(classic: bool, new_outlook: bool) -> Availability {
        Availability {
            classic,
            version: classic.then(|| "16".into()),
            new_outlook,
            new_outlook_default: false,
            profiles: 1,
            programmatic_access: "warnWhenAntivirusInactive",
        }
    }

    #[test]
    fn reasons() {
        assert_eq!(a(true, true).reason(), None);
        assert!(a(true, false).available());
        assert_eq!(a(false, true).reason(), Some("new_outlook_only"));
        assert_eq!(a(false, false).reason(), Some("outlook_not_installed"));
        assert!(!a(false, true).available());
        let j = a(false, true).to_json();
        assert_eq!(j["available"], false);
        assert_eq!(j["reason"], "new_outlook_only");
        assert!(j["message"].as_str().unwrap().contains("no COM"));
        let mut none = a(true, false);
        none.profiles = 0;
        assert!(none.message().contains("no mail profile"));
    }

    #[test]
    fn versions_and_guard_names() {
        assert_eq!(
            major_version("Outlook.Application.16").as_deref(),
            Some("16")
        );
        assert_eq!(major_version("Outlook.Application"), None);
        assert_eq!(guard_name(None), "warnWhenAntivirusInactive");
        assert_eq!(guard_name(Some(2)), "neverWarn");
        assert_eq!(guard_name(Some(1)), "alwaysWarn");
    }

    #[test]
    fn detect_runs_without_outlook_and_never_fails() {
        let d = detect(&Env::current());
        // Consistent with itself whatever is installed here.
        assert_eq!(d.available(), d.reason().is_none());
    }
}
