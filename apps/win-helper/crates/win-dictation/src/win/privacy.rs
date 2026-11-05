//! Windows privacy settings that gate speech (read-only; the owner changes them in Settings).

use super::wide;
use std::ffi::c_void;
use windows::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};
use windows::core::PCWSTR;

const CONSENT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

fn reg_sz(key: HKEY, sub: &str, value: &str) -> Option<String> {
    let (sub, value) = (wide(sub), wide(value));
    let mut buf = vec![0u16; 256];
    let mut len = (buf.len() * 2) as u32;
    // SAFETY: buf holds len bytes.
    unsafe { RegGetValueW(key, PCWSTR(sub.as_ptr()), PCWSTR(value.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut c_void), Some(&mut len)) }
        .ok()
        .ok()?;
    Some(String::from_utf16_lossy(&buf[..(len as usize / 2).saturating_sub(1)]))
}

fn reg_dword(key: HKEY, sub: &str, value: &str) -> Option<u32> {
    let (sub, value) = (wide(sub), wide(value));
    let mut v = 0u32;
    let mut len = 4u32;
    // SAFETY: a DWORD out-parameter.
    unsafe { RegGetValueW(key, PCWSTR(sub.as_ptr()), PCWSTR(value.as_ptr()), RRF_RT_REG_DWORD, None, Some(&mut v as *mut u32 as *mut c_void), Some(&mut len)) }
        .ok()
        .ok()?;
    Some(v)
}

/// The values that decide microphone access for a desktop (unpackaged) app.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct MicrophoneSettings {
    /// Group policy `LetAppsAccessMicrophone` (2 = force deny).
    pub policy: Option<u32>,
    /// HKLM consent: "Deny" when an administrator turned microphone access off for the device.
    pub device: Option<String>,
    /// HKCU consent: Settings › Privacy › Microphone › Microphone access.
    pub user: Option<String>,
    /// HKCU NonPackaged consent: "Let desktop apps access your microphone".
    pub desktop_apps: Option<String>,
}

/// `granted` / `denied` (the owner can turn it on) / `restricted` (policy or the device-wide
/// switch, which needs an administrator), as the mac reports TCC state.
pub(crate) fn microphone_status_of(s: &MicrophoneSettings) -> &'static str {
    let deny = |v: &Option<String>| v.as_deref().is_some_and(|x| x.eq_ignore_ascii_case("deny"));
    if s.policy == Some(2) || deny(&s.device) {
        "restricted"
    } else if deny(&s.user) || deny(&s.desktop_apps) {
        "denied"
    } else {
        "granted"
    }
}

pub(crate) fn microphone_settings() -> MicrophoneSettings {
    MicrophoneSettings {
        policy: reg_dword(HKEY_LOCAL_MACHINE, r"SOFTWARE\Policies\Microsoft\Windows\AppPrivacy", "LetAppsAccessMicrophone"),
        device: reg_sz(HKEY_LOCAL_MACHINE, CONSENT, "Value"),
        user: reg_sz(HKEY_CURRENT_USER, CONSENT, "Value"),
        desktop_apps: reg_sz(HKEY_CURRENT_USER, &format!(r"{CONSENT}\NonPackaged"), "Value"),
    }
}

pub(crate) fn microphone_status() -> &'static str {
    microphone_status_of(&microphone_settings())
}

/// Settings › Privacy › Speech › Online speech recognition, and the policy that can force it off.
pub(crate) fn online_speech_status() -> &'static str {
    let policy = reg_dword(HKEY_LOCAL_MACHINE, r"SOFTWARE\Policies\Microsoft\InputPersonalization", "AllowInputPersonalization");
    if policy == Some(0) {
        return "restricted";
    }
    match reg_dword(HKEY_CURRENT_USER, r"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy", "HasAccepted") {
        Some(1) => "granted",
        Some(_) => "denied",
        None => "notDetermined",
    }
}

/// `10.0.26200.6899`.
pub(crate) fn os_version() -> String {
    let k = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let major = reg_dword(HKEY_LOCAL_MACHINE, k, "CurrentMajorVersionNumber").unwrap_or(10);
    let minor = reg_dword(HKEY_LOCAL_MACHINE, k, "CurrentMinorVersionNumber").unwrap_or(0);
    let build = reg_sz(HKEY_LOCAL_MACHINE, k, "CurrentBuildNumber").unwrap_or_default();
    let ubr = reg_dword(HKEY_LOCAL_MACHINE, k, "UBR").unwrap_or(0);
    format!("{major}.{minor}.{build}.{ubr}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_status_mapping() {
        let s = |policy, device: Option<&str>, user: Option<&str>, apps: Option<&str>| MicrophoneSettings {
            policy,
            device: device.map(str::to_string),
            user: user.map(str::to_string),
            desktop_apps: apps.map(str::to_string),
        };
        assert_eq!(microphone_status_of(&MicrophoneSettings::default()), "granted");
        assert_eq!(microphone_status_of(&s(None, Some("Allow"), Some("Allow"), Some("Allow"))), "granted");
        assert_eq!(microphone_status_of(&s(None, Some("Allow"), Some("Deny"), Some("Allow"))), "denied");
        assert_eq!(microphone_status_of(&s(None, Some("Allow"), Some("Allow"), Some("Deny"))), "denied");
        assert_eq!(microphone_status_of(&s(None, Some("Deny"), Some("Allow"), Some("Allow"))), "restricted");
        assert_eq!(microphone_status_of(&s(Some(2), None, None, None)), "restricted");
        assert_eq!(microphone_status_of(&s(Some(1), None, None, None)), "granted");
    }
}
