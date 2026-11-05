//! What the helper checks on the user's side before a host path reaches the SYSTEM service: the
//! mac helper's `SharePolicy`, for Windows paths. The service validates again; this is the layer
//! that runs as the owner and sees the owner's folders as the owner does.
//!
//! Refused for shares and copies into the guest: a drive root, the profile folder itself,
//! `C:\Users`, Windows and Program Files, ProgramData, `AppData` (and anything containing it),
//! credential folders (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.azure`) and `$PSYCHE_HOME`, or any
//! folder that contains one of those. Read-write shares need an approval.

use std::path::{Path, PathBuf};

use crate::node::capability::{CapabilityError, ErrorCode};
use crate::node::paths::{Env, psyche_home, user_profile};
use crate::node::roots::{canonical, is_absolute, is_within};

/// `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, no `..`.
pub fn is_valid_share_name(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    s.len() <= 64
        && !s.contains("..")
        && first.is_ascii_alphanumeric()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

fn is_drive_root(p: &Path) -> bool {
    let s = p.to_string_lossy().replace('/', "\\");
    let s = s.trim_end_matches('\\');
    let b = s.as_bytes();
    (b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':') || s.is_empty()
}

fn env_path(env: &Env, key: &str, default: &str) -> PathBuf {
    PathBuf::from(env.get(key).unwrap_or(default))
}

/// Why `resolved` (already canonical) may not be shared, if it may not.
pub fn sensitive_reason(resolved: &Path, env: &Env) -> Option<&'static str> {
    let profile = canonical(&user_profile(env).to_string_lossy(), env);
    let home = canonical(&psyche_home(env).to_string_lossy(), env);
    let system_root = canonical(&env_path(env, "SystemRoot", r"C:\Windows").to_string_lossy(), env);
    let app_data = [
        env.get("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| profile.join("AppData").join("Local")),
        env.get("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| profile.join("AppData").join("Roaming")),
        profile.join("AppData"),
    ]
    .map(|p| canonical(&p.to_string_lossy(), env));
    let program_files = [
        env_path(env, "ProgramFiles", r"C:\Program Files"),
        env_path(env, "ProgramFiles(x86)", r"C:\Program Files (x86)"),
        env_path(env, "ProgramData", r"C:\ProgramData"),
    ]
    .map(|p| canonical(&p.to_string_lossy(), env));
    let secret_dirs: Vec<PathBuf> = [".ssh", ".aws", ".gnupg", ".kube", ".azure"]
        .iter()
        .map(|d| profile.join(d))
        .collect();

    if is_drive_root(resolved) {
        return Some("the root of a drive");
    }
    if is_within(&profile, resolved) {
        // The profile itself, or a folder holding it (`C:\Users`).
        return Some("your whole user folder");
    }
    if is_within(resolved, &home) || is_within(&home, resolved) {
        return Some("Psyche's own data");
    }
    for a in &app_data {
        if is_within(resolved, a) || is_within(a, resolved) {
            return Some("AppData");
        }
    }
    if is_within(resolved, &system_root) || is_within(&system_root, resolved) {
        return Some("a system folder");
    }
    for p in &program_files {
        if is_within(resolved, p) {
            return Some("a system folder");
        }
    }
    for s in &secret_dirs {
        if is_within(resolved, s) || is_within(s, resolved) {
            return Some("a credentials folder");
        }
    }
    None
}

pub fn check_sensitive(resolved: &Path, env: &Env) -> Result<(), CapabilityError> {
    match sensitive_reason(resolved, env) {
        None => Ok(()),
        Some(why) => Err(CapabilityError::new(
            ErrorCode::PolicyDenied,
            "share_forbidden",
            format!("Sharing {why} with the guest is not allowed"),
        )
        .with_detail("path", resolved.to_string_lossy().into_owned())),
    }
}

/// A folder to share: absolute, an existing directory (links resolved), not sensitive; a
/// read-write share needs the approval that allowed it. Returns the canonical path the service is
/// handed.
pub fn validate_share(
    share: &str,
    path: &str,
    read_only: bool,
    approval_id: Option<&str>,
    env: &Env,
) -> Result<PathBuf, CapabilityError> {
    if !is_valid_share_name(share) {
        return Err(CapabilityError::invalid_params(
            "share name must be letters, digits, space, . _ -",
            Some("share"),
        ));
    }
    if !is_absolute(path) {
        return Err(CapabilityError::invalid_params(
            "path must be absolute",
            Some("path"),
        ));
    }
    let resolved = canonical(path, env);
    if !resolved.is_dir() {
        return Err(CapabilityError::not_found(
            "not_a_directory",
            format!("{path} is not an existing folder"),
        ));
    }
    check_sensitive(&resolved, env)?;
    if !read_only && approval_id.is_none() {
        return Err(CapabilityError::new(
            ErrorCode::ApprovalRequired,
            "share_rw_needs_approval",
            format!("Read-write access to {path} needs your approval"),
        )
        .with_detail("path", resolved.to_string_lossy().into_owned())
        .with_detail("name", share));
    }
    Ok(resolved)
}

/// A host file or folder to copy into the guest: absolute, existing, not sensitive.
pub fn validate_copy_in(host_path: &str, env: &Env) -> Result<PathBuf, CapabilityError> {
    if !is_absolute(host_path) {
        return Err(CapabilityError::invalid_params(
            "hostPath must be absolute",
            Some("hostPath"),
        ));
    }
    let resolved = canonical(host_path, env);
    if !resolved.exists() {
        return Err(CapabilityError::not_found(
            "not_found",
            format!("{host_path} does not exist"),
        ));
    }
    check_sensitive(&resolved, env)?;
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::default()
            .with("USERPROFILE", r"C:\Users\owner")
            .with("PSYCHE_HOME", r"C:\Users\owner\.psyche")
            .with("SystemRoot", r"C:\Windows")
            .with("LOCALAPPDATA", r"C:\Users\owner\AppData\Local")
            .with("APPDATA", r"C:\Users\owner\AppData\Roaming")
    }

    #[test]
    fn share_names() {
        assert!(is_valid_share_name("work"));
        assert!(is_valid_share_name("My Docs 2"));
        assert!(!is_valid_share_name(""));
        assert!(!is_valid_share_name(".hidden"));
        assert!(!is_valid_share_name("a..b"));
        assert!(!is_valid_share_name("a/b"));
        assert!(!is_valid_share_name(&"x".repeat(65)));
    }

    #[test]
    fn sensitive_places_are_refused() {
        let e = env();
        for p in [
            r"C:\",
            r"C:\Users",
            r"C:\Users\owner",
            r"C:\Users\owner\AppData",
            r"C:\Users\owner\AppData\Local\Psyche",
            r"C:\Users\owner\.psyche",
            r"C:\Users\owner\.psyche\vm",
            r"C:\Users\owner\.ssh",
            r"C:\Windows",
            r"C:\Windows\System32",
            r"C:\Program Files\Psyche",
            r"C:\ProgramData",
        ] {
            assert!(
                sensitive_reason(Path::new(p), &e).is_some(),
                "{p} should be refused"
            );
        }
        for p in [
            r"C:\Users\owner\Documents",
            r"C:\Users\owner\Projects\site",
            r"D:\work",
            r"E:\",
        ] {
            let ok = sensitive_reason(Path::new(p), &e).is_none();
            // A bare drive root is refused; everything else is fine.
            assert_eq!(ok, !is_drive_root(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn read_write_shares_need_an_approval() {
        let dir = std::env::temp_dir().join("psyche-vm-policy-test");
        std::fs::create_dir_all(&dir).unwrap();
        let e = Env::default()
            .with("USERPROFILE", r"C:\Users\nobody-here")
            .with("PSYCHE_HOME", r"C:\Users\nobody-here\.psyche");
        let path = dir.to_string_lossy().into_owned();
        let err = validate_share("work", &path, false, None, &e).unwrap_err();
        assert_eq!(err.reason, "share_rw_needs_approval");
        assert_eq!(err.code, ErrorCode::ApprovalRequired);
        assert!(validate_share("work", &path, false, Some("apr_1"), &e).is_ok());
        assert!(validate_share("work", &path, true, None, &e).is_ok());
        assert_eq!(
            validate_share("bad/name", &path, true, None, &e)
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        assert_eq!(
            validate_share("work", "relative", true, None, &e)
                .unwrap_err()
                .code,
            ErrorCode::InvalidParams
        );
        assert_eq!(
            validate_share("work", r"C:\definitely\not\here", true, None, &e)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
