//! Protected paths (design §5.1, §5.2): what the contained shell hides and what `fs.*` always
//! refuses, whatever the ceiling's roots say.
//!
//! - [`HOME_HIDDEN`]: secrets and the helper's own files. The contained shell mounts an empty
//!   tmpfs over each one that exists, and `fs.*` refuses them.
//! - [`HOME_PERSIST`]: places where a write runs code later (rc files, user units, autostart,
//!   the user's own `bin`). `fs.*` refuses them, and a read-write folder of the contained shell
//!   may not hold any of them, so a command cannot plant persistence.
//! - [`ABSOLUTE`]: system places `fs.*` never touches.

use std::path::{Component, Path, PathBuf};

pub const HOME_HIDDEN: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".local/share/keyrings",
    ".password-store",
    ".mozilla",
    ".config/chromium",
    ".config/google-chrome",
    ".config/BraveSoftware",
    ".config/psyche-helper",
    ".local/state/psyche-helper",
    ".config/systemd",
    ".config/autostart",
];

pub const HOME_PERSIST: &[&str] = &[
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".zshrc",
    ".zprofile",
    ".zshenv",
    ".zlogin",
    ".zlogout",
    ".pam_environment",
    ".xprofile",
    ".xsessionrc",
    ".xinitrc",
    ".config/environment.d",
    ".config/fish",
    ".local/share/systemd",
    ".local/bin",
    "bin",
];

pub const ABSOLUTE: &[&str] = &[
    "/etc/psyche-helper",
    "/proc",
    "/sys",
    "/dev",
    "/boot",
    "/root",
    "/run",
];

/// `path` with `.` dropped; `None` for a relative path, a `..`, a NUL or an empty one.
pub fn lexical(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 4096 || path.contains('\0') || !path.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::from("/");
    for part in Path::new(path).components() {
        match part {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(p) => out.push(p),
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// The home folder as written and as it resolves (both spellings are judged).
fn homes(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![home.to_path_buf()];
    if let Ok(real) = std::fs::canonicalize(home) {
        if real != home {
            out.push(real);
        }
    }
    out
}

/// Every protected path for this home, home-relative entries under both spellings of home.
pub fn protected_paths(home: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = ABSOLUTE.iter().map(PathBuf::from).collect();
    for h in homes(home) {
        for rel in HOME_HIDDEN.iter().chain(HOME_PERSIST) {
            out.push(h.join(rel));
        }
    }
    out
}

/// The hidden secrets only, for the contained shell's mounts.
pub fn hidden_paths(home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for h in homes(home) {
        for rel in HOME_HIDDEN {
            out.push(h.join(rel));
        }
    }
    out
}

/// Whether `path` is a protected path or inside one.
pub fn is_protected(path: &Path, home: &Path) -> bool {
    protected_paths(home).iter().any(|p| path.starts_with(p))
}

/// Whether a protected path lies inside `path` (or is it): removing or writing all of `path`
/// would reach it.
pub fn holds_protected(path: &Path, home: &Path) -> bool {
    protected_paths(home).iter().any(|p| p.starts_with(path))
        || homes(home).iter().any(|h| h.starts_with(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_paths_refuse_relative_dotdot_and_nul() {
        // (input, accepted)
        let table: [(&str, Option<&str>); 9] = [
            ("/home/dev/a", Some("/home/dev/a")),
            ("/home/dev/./a/", Some("/home/dev/a")),
            ("/", Some("/")),
            ("home/dev", None),
            ("", None),
            ("~/a", None),
            ("/home/dev/../root", None),
            ("/home/dev/a\0b", None),
            ("/a/..", None),
        ];
        for (input, want) in table {
            assert_eq!(lexical(input), want.map(PathBuf::from), "{input:?}");
        }
    }

    #[test]
    fn protected_paths_must_refuse_and_ordinary_paths_must_not() {
        let home = Path::new("/home/dev");
        let must_refuse = [
            "/home/dev/.ssh",
            "/home/dev/.ssh/id_ed25519",
            "/home/dev/.gnupg/private-keys-v1.d/x",
            "/home/dev/.local/share/keyrings/login.keyring",
            "/home/dev/.password-store/bank.gpg",
            "/home/dev/.mozilla/firefox/profiles.ini",
            "/home/dev/.config/chromium/Default/Cookies",
            "/home/dev/.config/google-chrome/Default",
            "/home/dev/.config/BraveSoftware/Brave-Browser",
            "/home/dev/.config/psyche-helper/policy.json",
            "/home/dev/.local/state/psyche-helper/remote-identity.json",
            "/home/dev/.config/systemd/user/x.service",
            "/home/dev/.config/autostart/x.desktop",
            "/home/dev/.bashrc",
            "/home/dev/.bash_profile",
            "/home/dev/.profile",
            "/home/dev/.zshrc",
            "/home/dev/.local/bin/ls",
            "/home/dev/bin/git",
            "/etc/psyche-helper/policy.json",
            "/proc/self/environ",
            "/sys/kernel",
            "/dev/sda",
            "/boot/vmlinuz",
            "/root/.bashrc",
            "/run/user/1000/bus",
        ];
        for p in must_refuse {
            assert!(is_protected(Path::new(p), home), "{p} must be refused");
        }
        let must_allow = [
            "/home/dev/projects/app/src/main.rs",
            "/home/dev/.sshx",
            "/home/dev/.bashrc.bak",
            "/home/dev/.config/Code/User/settings.json",
            "/home/dev/.local/share/recently-used.xbel",
            "/home/dev/binaries/tool",
            "/home/dev/Documents/.profile-notes",
            "/etc/hosts",
            "/srv/data",
            "/home/devx/.ssh",
            "/devices",
            "/runner/x",
        ];
        for p in must_allow {
            assert!(!is_protected(Path::new(p), home), "{p} must be allowed");
        }
    }

    #[test]
    fn a_folder_that_holds_a_protected_path_or_home_is_known() {
        let home = Path::new("/home/dev");
        for p in [
            "/home/dev",
            "/home",
            "/",
            "/home/dev/.config",
            "/home/dev/.local",
        ] {
            assert!(holds_protected(Path::new(p), home), "{p}");
        }
        for p in [
            "/home/dev/projects",
            "/home/dev/.config/Code",
            "/srv/data",
            "/home/dev/.local/share/fonts",
        ] {
            assert!(!holds_protected(Path::new(p), home), "{p}");
        }
    }
}
