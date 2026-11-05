//! Folder shares (port of `Shares.swift` `ShareGrant` / `SharePolicy`) with Windows paths.
//!
//! A share is an HCS Plan9 share (`Devices.Plan9.Shares`): name = AccessName = the share name,
//! port 564, mounted by the guest at `/mnt/psyche/<name>` (`psyche-share mount <name> vsock 564
//! <ro|rw>`). Host paths follow `@psyche/hostfs` `canonicalHostPath`: drive paths only here (no
//! UNC: the service would reach the network as the machine account), no alternate data streams,
//! no names ending in a dot or space, no DOS device names, no 8.3 short names, no wildcard or
//! control characters, no device namespaces. Junctions and symlinks are resolved before the
//! sensitive-folder check. Never shared: a drive root, `C:\Users` or any profile root, the
//! owner's `AppData` (credential stores live there) and other credential folders (`.ssh`,
//! `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`), `$PSYCHE_HOME`, Windows / Program Files /
//! ProgramData, or anything containing one of them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Code, VmError, VmResult};

pub const MAX_SHARES: usize = 16;
/// HCS Plan9 server port (the 9P well-known port; one server, shares told apart by AccessName).
pub const PLAN9_PORT: u32 = 564;
/// Where the guest mounts shares.
pub const GUEST_SHARE_ROOT: &str = "/mnt/psyche";
/// System shares the service adds beside the user's (reserved names).
pub const SHARE_TRANSFER_IN: &str = "psyche-in";
pub const SHARE_TRANSFER_OUT: &str = "psyche-out";
pub const SHARE_PAYLOAD: &str = "psyche-payload";
pub const RESERVED_NAMES: [&str; 3] = [SHARE_TRANSFER_IN, SHARE_TRANSFER_OUT, SHARE_PAYLOAD];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareGrant {
    pub name: String,
    pub host_path: String,
    pub read_only: bool,
    #[serde(default = "user_tag")]
    pub tag: String,
    #[serde(default)]
    pub granted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

fn user_tag() -> String {
    "psyche".into()
}

impl ShareGrant {
    pub fn guest_path(&self) -> String {
        guest_path(&self.name)
    }
}

pub fn guest_path(name: &str) -> String {
    format!("{GUEST_SHARE_ROOT}/{name}")
}

/// `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`, no `..`, not a reserved system share.
pub fn is_valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && !s.contains("..")
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || b" ._-".contains(c))
        && !RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(s))
}

fn forbidden(what: &str, path: &str) -> VmError {
    VmError::policy_denied("share_forbidden", format!("Sharing {what} with the guest is not allowed")).detail("path", path)
}

fn bad_path(why: &str, input: &str) -> VmError {
    VmError::invalid_params(format!("{why}: {input}"), "path")
}

/// `canonicalHostPath` for drive paths: `C:\a\..\b` → `C:\b`, separators `\`, drive upper-case,
/// no trailing separator; refuses what Win32 would rewrite.
pub fn canonical_host_path(input: &str) -> VmResult<String> {
    if input.contains('\0') {
        return Err(bad_path("NUL in path", input));
    }
    let s = match input.strip_prefix(r"\\?\").or_else(|| input.strip_prefix(r"\\.\")) {
        Some(rest) if is_drive_abs(rest) => rest.to_owned(),
        Some(_) => return Err(bad_path("device paths are not folders", input)),
        None => input.to_owned(),
    }
    .replace('/', "\\");
    if s.starts_with(r"\\") {
        return Err(
            VmError::policy_denied("share_forbidden", "Network (UNC) folders cannot be shared with the guest").detail("path", input)
        );
    }
    if !is_drive_abs(&s) {
        return Err(bad_path("path must be absolute", input));
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in s[3..].split('\\') {
        match seg {
            "" | "." => continue,
            ".." => {
                out.pop();
                continue;
            }
            _ => {}
        }
        if seg.contains(':') {
            return Err(bad_path("alternate data streams are not file paths", input));
        }
        if seg.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*') || (c as u32) < 0x20) {
            return Err(bad_path("invalid character in path", input));
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(bad_path("a name may not end in a dot or a space on Windows", input));
        }
        if is_device_name(seg) {
            return Err(bad_path("DOS device names are not file paths", input));
        }
        if is_short_name(seg) {
            return Err(bad_path("use the long name, not the 8.3 short name", input));
        }
        out.push(seg);
    }
    let drive = s[..1].to_ascii_uppercase();
    Ok(if out.is_empty() { format!("{drive}:\\") } else { format!("{drive}:\\{}", out.join("\\")) })
}

fn is_drive_abs(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

fn is_device_name(seg: &str) -> bool {
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && (stem.as_bytes()[3].is_ascii_digit()))
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && ["¹", "²", "³"].iter().any(|d| stem.ends_with(d)))
}

/// `^[^~.\\/]{1,6}~[0-9]+(?:\.[^.\\/]{0,3})?$`
fn is_short_name(seg: &str) -> bool {
    let (base, ext) = match seg.split_once('.') {
        Some((b, e)) => (b, Some(e)),
        None => (seg, None),
    };
    let Some((head, digits)) = base.split_once('~') else { return false };
    let head_ok = (1..=6).contains(&head.chars().count()) && !head.contains(['~', '.']);
    let digits_ok = !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit());
    let ext_ok = ext.is_none_or(|e| e.chars().count() <= 3 && !e.contains('.'));
    head_ok && digits_ok && ext_ok
}

/// `C:\a\b` equals or lies under `C:\a` (case-insensitive, separator-aware).
pub fn is_within(p: &str, root: &str) -> bool {
    let (p, r) = (p.to_lowercase(), root.to_lowercase());
    let r = r.trim_end_matches('\\');
    p == r || p.starts_with(&format!("{r}\\"))
}

/// The folders whose sharing is refused, for one owner.
#[derive(Debug, Clone)]
pub struct SensitiveRoots {
    /// `C:\Users` (the profiles directory).
    pub profiles_dir: String,
    /// The owner's profile.
    pub profile: String,
    pub psyche_home: String,
    /// Windows, Program Files, Program Files (x86), ProgramData.
    pub system: Vec<String>,
}

impl SensitiveRoots {
    /// Profile and system folders as given (resolved by the caller where they exist).
    pub fn new(profile: &str, psyche_home: &str, system_root: &str, program_files: &[String], program_data: &str) -> SensitiveRoots {
        let profiles_dir = Path::new(profile).parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| r"C:\Users".into());
        let mut system = vec![system_root.to_owned(), program_data.to_owned()];
        system.extend(program_files.iter().cloned());
        SensitiveRoots { profiles_dir, profile: profile.to_owned(), psyche_home: psyche_home.to_owned(), system }
    }

    /// Credential stores and per-user secrets inside the profile.
    fn credential_dirs(&self) -> Vec<String> {
        ["AppData", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".psyche"]
            .iter()
            .map(|d| format!("{}\\{d}", self.profile.trim_end_matches('\\')))
            .collect()
    }

    /// `checkSensitive`: `resolved` is canonical (links resolved).
    pub fn check(&self, resolved: &str) -> VmResult<()> {
        let inside = |root: &str| is_within(resolved, root);
        let contains = |root: &str| is_within(root, resolved);
        let b = resolved.as_bytes();
        if b.len() <= 3 && b.len() >= 2 && b[1] == b':' {
            return Err(forbidden("the root of a drive", resolved));
        }
        if resolved.eq_ignore_ascii_case(self.profiles_dir.trim_end_matches('\\')) {
            return Err(forbidden("the Users folder", resolved));
        }
        if resolved.eq_ignore_ascii_case(self.profile.trim_end_matches('\\')) {
            return Err(forbidden("your whole user folder", resolved));
        }
        // Another user's profile root (C:\Users\<other>) as a whole.
        if Path::new(resolved)
            .parent()
            .map(|p| p.to_string_lossy().eq_ignore_ascii_case(self.profiles_dir.trim_end_matches('\\')))
            .unwrap_or(false)
        {
            return Err(forbidden("a user folder", resolved));
        }
        if inside(&self.psyche_home) || contains(&self.psyche_home) {
            return Err(forbidden("Psyche's own data", resolved));
        }
        for d in self.credential_dirs() {
            if inside(&d) || contains(&d) {
                return Err(forbidden("AppData or a credential folder", resolved));
            }
        }
        for s in &self.system {
            if inside(s) || contains(s) {
                return Err(forbidden("a system folder", resolved));
            }
        }
        for name in ["$Recycle.Bin", "System Volume Information", "Recovery", "Config.Msi"] {
            let root = format!("{}{name}", &resolved[..3]);
            if inside(&root) {
                return Err(forbidden("a system folder", resolved));
            }
        }
        Ok(())
    }
}

/// `std::fs::canonicalize` without the `\\?\` prefix (junctions and symlinks resolved).
pub fn resolve_existing(canonical: &str) -> Option<String> {
    let c = std::fs::canonicalize(canonical).ok()?;
    let s = c.to_string_lossy().into_owned();
    Some(match s.strip_prefix(r"\\?\") {
        Some(r) if !r.starts_with("UNC\\") => r.to_owned(),
        Some(r) => format!(r"\\{}", &r[4..]),
        None => s,
    })
}

/// `SharePolicy.validate`: an existing folder (links resolved), not sensitive; read-write needs
/// an approval; unique name; at most 16. Runs as the owner (the folder must open for them).
pub fn validate(
    name: &str,
    path: &str,
    read_only: bool,
    approval_id: Option<&str>,
    existing: &[ShareGrant],
    roots: &SensitiveRoots,
    now: &str,
) -> VmResult<ShareGrant> {
    if !is_valid_name(name) {
        return Err(VmError::invalid_params("share name must be letters, digits, space, . _ - (and not a reserved psyche-* name)", "name"));
    }
    let canonical = canonical_host_path(path)?;
    let resolved =
        resolve_existing(&canonical).ok_or_else(|| VmError::not_found("not_a_directory", format!("{path} is not an existing folder")))?;
    if resolved.starts_with(r"\\") {
        return Err(
            VmError::policy_denied("share_forbidden", "Network (UNC) folders cannot be shared with the guest").detail("path", resolved)
        );
    }
    if !Path::new(&resolved).is_dir() {
        return Err(VmError::not_found("not_a_directory", format!("{path} is not an existing folder")));
    }
    roots.check(&canonical)?;
    roots.check(&resolved)?;
    if !read_only && approval_id.is_none() {
        return Err(VmError::new(
            Code::ApprovalRequired,
            "share_rw_needs_approval",
            format!("Read-write access to {path} needs your approval"),
        )
        .detail("path", resolved.as_str())
        .detail("name", name));
    }
    if existing.iter().any(|s| s.name.eq_ignore_ascii_case(name)) {
        return Err(VmError::conflict("share_exists", format!("A share named {name} already exists")));
    }
    if existing.len() >= MAX_SHARES {
        return Err(VmError::conflict("too_many_shares", format!("At most {MAX_SHARES} folders can be shared")));
    }
    Ok(ShareGrant {
        name: name.to_owned(),
        host_path: resolved,
        read_only,
        tag: user_tag(),
        granted_at: now.to_owned(),
        approval_id: if read_only { None } else { approval_id.map(str::to_owned) },
    })
}

/// Re-checks a stored grant before boot (the owner can edit `shares.json`): the path must still
/// be a non-sensitive folder.
pub fn recheck(grant: &ShareGrant, roots: &SensitiveRoots) -> VmResult<PathBuf> {
    if !is_valid_name(&grant.name) {
        return Err(VmError::policy_denied("share_forbidden", "Invalid share name in shares.json"));
    }
    let canonical = canonical_host_path(&grant.host_path)?;
    let resolved = resolve_existing(&canonical)
        .ok_or_else(|| VmError::not_found("not_a_directory", format!("{} is not an existing folder", grant.host_path)))?;
    if resolved.starts_with(r"\\") || !Path::new(&resolved).is_dir() {
        return Err(VmError::not_found("not_a_directory", format!("{} is not an existing folder", grant.host_path)));
    }
    roots.check(&canonical)?;
    roots.check(&resolved)?;
    if !grant.read_only && grant.approval_id.is_none() {
        return Err(VmError::policy_denied("share_forbidden", "A read-write share without an approval"));
    }
    Ok(PathBuf::from(resolved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> SensitiveRoots {
        SensitiveRoots::new(
            r"C:\Users\someone",
            r"C:\Users\someone\.psyche",
            r"C:\Windows",
            &[r"C:\Program Files".into(), r"C:\Program Files (x86)".into()],
            r"C:\ProgramData",
        )
    }

    #[test]
    fn share_names() {
        assert!(is_valid_name("Projects"));
        assert!(is_valid_name("my docs.v2_x-1"));
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("_hidden"));
        assert!(!is_valid_name("a..b"));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name("psyche-out"));
        assert!(!is_valid_name("PSYCHE-IN"));
        assert!(!is_valid_name(&"a".repeat(65)));
    }

    #[test]
    fn canonicalization_follows_hostfs() {
        assert_eq!(canonical_host_path(r"c:\Users\x\..\y\").unwrap(), r"C:\Users\y");
        assert_eq!(canonical_host_path("d:/data/./x").unwrap(), r"D:\data\x");
        assert_eq!(canonical_host_path(r"\\?\C:\a").unwrap(), r"C:\a");
        assert_eq!(canonical_host_path(r"C:\..\..").unwrap(), r"C:\");
        for bad in [
            r"C:\a\b.txt:secret",
            r"C:\a\.ssh.",
            r"C:\a\b ",
            r"C:\NUL",
            r"C:\a\com1.txt",
            r"C:\PROGRA~1",
            r"C:\a\b*",
            "relative\\x",
            r"\x",
            r"C:x",
            r"\\.\GLOBALROOT\x",
        ] {
            assert!(canonical_host_path(bad).is_err(), "{bad}");
        }
        assert_eq!(canonical_host_path(r"\\server\share\x").unwrap_err().reason, "share_forbidden");
    }

    #[test]
    fn sensitive_folders_are_refused() {
        let r = roots();
        for bad in [
            r"C:\",
            r"D:\",
            r"C:\Users",
            r"C:\Users\someone",
            r"C:\Users\other",
            r"C:\Users\someone\AppData",
            r"C:\Users\someone\AppData\Roaming\Microsoft\Credentials",
            r"C:\Users\someone\.ssh",
            r"c:\users\SOMEONE\.psyche\vm",
            r"C:\Windows\System32",
            r"C:\Program Files\App",
            r"C:\ProgramData",
            r"C:\$Recycle.Bin\S-1",
        ] {
            assert_eq!(r.check(bad).unwrap_err().reason, "share_forbidden", "{bad}");
        }
        for ok in [r"C:\Users\someone\Documents", r"C:\Users\someone\src\proj", r"D:\work", r"C:\Users\other\Public\x"] {
            r.check(ok).unwrap();
        }
    }

    #[test]
    fn validate_checks_folder_approval_and_limits() {
        let base = std::env::temp_dir().join(format!("psyche-vm-share-{}", std::process::id()));
        let dir = base.join("proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(base.join("file.txt"), "x").unwrap();
        let r = roots();
        let p = dir.to_string_lossy().into_owned();
        let g = validate("proj", &p, true, None, &[], &r, "now").unwrap();
        assert!(g.read_only && g.approval_id.is_none());
        assert_eq!(g.guest_path(), "/mnt/psyche/proj");
        assert!(is_within(&g.host_path, &base.to_string_lossy()));
        let e = validate("proj", &p, false, None, &[], &r, "now").unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (Code::ApprovalRequired, "share_rw_needs_approval"));
        let rw = validate("proj", &p, false, Some("ap_1"), &[], &r, "now").unwrap();
        assert_eq!(rw.approval_id.as_deref(), Some("ap_1"));
        assert_eq!(validate("PROJ", &p, true, None, std::slice::from_ref(&g), &r, "now").unwrap_err().reason, "share_exists");
        let many: Vec<ShareGrant> = (0..MAX_SHARES).map(|i| ShareGrant { name: format!("s{i}"), ..g.clone() }).collect();
        assert_eq!(validate("new", &p, true, None, &many, &r, "now").unwrap_err().reason, "too_many_shares");
        let f = base.join("file.txt").to_string_lossy().into_owned();
        assert_eq!(validate("f", &f, true, None, &[], &r, "now").unwrap_err().reason, "not_a_directory");
        assert_eq!(
            validate("m", &base.join("missing").to_string_lossy(), true, None, &[], &r, "now").unwrap_err().reason,
            "not_a_directory"
        );
        recheck(&g, &r).unwrap();
        let tampered = ShareGrant { read_only: false, approval_id: None, ..g.clone() };
        assert_eq!(recheck(&tampered, &r).unwrap_err().reason, "share_forbidden");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn grants_serialize_like_the_mac_helper() {
        let g = ShareGrant {
            name: "a".into(),
            host_path: r"C:\x".into(),
            read_only: true,
            tag: "psyche".into(),
            granted_at: "t".into(),
            approval_id: None,
        };
        let v = serde_json::to_value(&g).unwrap();
        assert_eq!(v, serde_json::json!({"name": "a", "hostPath": r"C:\x", "readOnly": true, "tag": "psyche", "grantedAt": "t"}));
    }
}
