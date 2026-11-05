//! Granted folders (Settings → Permissions → Folders): `permissions.folders[].path` in
//! `$PSYCHE_HOME\config.json`, read-only for the helper. `files.*`, `finder.*` and the OCR backstop
//! only touch paths inside them. Port of `FinderRoots` for Windows paths: drive (`C:\…`) or UNC
//! (`\\server\share\…`) absolute paths, `~` for the profile, symlinks / junctions resolved for
//! paths that exist, and case-insensitive comparison (NTFS).

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

use super::capability::CapabilityError;
use super::paths::{Env, psyche_home, user_profile};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinderRoots {
    pub roots: Vec<PathBuf>,
}

/// Strips the `\\?\` verbatim prefix `canonicalize` adds (`\\?\UNC\x` → `\\x`).
pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// Lexical normalization: `.` and `..` removed, separators unified.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether `path` is absolute in the Windows sense (drive + root, or UNC), after `~` expansion.
pub fn is_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || path.starts_with(r"\\")
        || path.starts_with("//")
}

pub fn expand_tilde(path: &str, env: &Env) -> String {
    if path == "~" {
        return user_profile(env).to_string_lossy().into_owned();
    }
    if let Some(rest) = path.strip_prefix("~\\").or_else(|| path.strip_prefix("~/")) {
        return user_profile(env).join(rest).to_string_lossy().into_owned();
    }
    path.to_owned()
}

/// Canonical form: symlinks resolved when the path (or its deepest existing ancestor) exists,
/// otherwise lexically normalized.
pub fn canonical(path: &str, env: &Env) -> PathBuf {
    let expanded = normalize(Path::new(&expand_tilde(path, env)));
    if let Ok(c) = std::fs::canonicalize(&expanded) {
        return strip_verbatim(c);
    }
    // Resolve the deepest existing ancestor, then re-append the missing tail.
    let mut tail = Vec::new();
    let mut cur = expanded.clone();
    while let Some(name) = cur.file_name().map(|n| n.to_owned()) {
        cur.pop();
        tail.push(name);
        if let Ok(c) = std::fs::canonicalize(&cur) {
            let mut base = strip_verbatim(c);
            for n in tail.iter().rev() {
                base.push(n);
            }
            return base;
        }
    }
    expanded
}

fn lower(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").to_lowercase()
}

/// Whether `p` equals `root` or lies under it (case-insensitive, separator-aware).
pub fn is_within(p: &Path, root: &Path) -> bool {
    let (p, r) = (lower(p), lower(root));
    let r = r.trim_end_matches('\\');
    p == r || p.starts_with(&format!("{r}\\"))
}

impl FinderRoots {
    pub fn new(roots: Vec<String>, env: &Env) -> Self {
        FinderRoots {
            roots: roots
                .iter()
                .filter(|r| is_absolute(&expand_tilde(r, env)))
                .map(|r| canonical(r, env))
                .collect(),
        }
    }

    /// Reads `permissions.folders[].path` from the Gateway's config.
    pub fn load(env: &Env) -> Self {
        let path = psyche_home(env).join("config.json");
        let folders = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.get("permissions")?.get("folders")?.as_array().cloned())
            .unwrap_or_default();
        let paths = folders
            .iter()
            .filter_map(|f| f.get("path")?.as_str().map(str::to_owned))
            .collect();
        FinderRoots::new(paths, env)
    }

    pub fn contains_root(&self, p: &Path) -> bool {
        self.roots
            .iter()
            .any(|r| lower(r).trim_end_matches('\\') == lower(p).trim_end_matches('\\'))
    }

    /// The canonical path when it lies inside a granted root, else `policy_denied`.
    pub fn resolve(&self, path: &str, env: &Env) -> Result<PathBuf, CapabilityError> {
        let expanded = expand_tilde(path, env);
        if !is_absolute(&expanded) {
            return Err(CapabilityError::invalid_params(
                "path must be absolute",
                Some("path"),
            ));
        }
        if self.roots.is_empty() {
            return Err(CapabilityError::policy_denied(
                "no_granted_folders",
                "No folders are granted. Add one in Settings → Permissions → Folders.",
            ));
        }
        let p = canonical(&expanded, env);
        if !self.roots.iter().any(|r| is_within(&p, r)) {
            return Err(CapabilityError::policy_denied(
                "outside_granted_folders",
                format!("{path} is outside the granted folders"),
            )
            .with_detail("path", path));
        }
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::default().with("USERPROFILE", r"C:\Users\someone")
    }

    #[test]
    fn absolute_paths() {
        assert!(is_absolute(r"C:\x"));
        assert!(is_absolute("c:/x"));
        assert!(is_absolute(r"\\server\share\x"));
        assert!(!is_absolute(r"x\y"));
        assert!(!is_absolute(r"C:x"));
        assert!(!is_absolute(r"\x"));
    }

    #[test]
    fn within_is_case_insensitive_and_separator_aware() {
        let root = Path::new(r"C:\Users\someone\Downloads");
        assert!(is_within(
            Path::new(r"c:\users\SOMEONE\downloads\a.pdf"),
            root
        ));
        assert!(is_within(Path::new(r"C:\Users\someone\Downloads"), root));
        assert!(!is_within(
            Path::new(r"C:\Users\someone\Downloads2\a.pdf"),
            root
        ));
        assert!(!is_within(Path::new(r"C:\Users\someone"), root));
    }

    #[test]
    fn resolve_refuses_traversal_and_outside_paths() {
        let base = std::env::temp_dir().join(format!("psyche-roots-{}", std::process::id()));
        let granted = base.join("granted");
        std::fs::create_dir_all(granted.join("sub")).unwrap();
        let e = env();
        let roots = FinderRoots::new(vec![granted.to_string_lossy().into_owned()], &e);
        let inside = roots
            .resolve(&granted.join("sub").join("new.txt").to_string_lossy(), &e)
            .unwrap();
        assert!(inside.ends_with(Path::new("sub").join("new.txt")));
        let escape = format!(r"{}\..\outside.txt", granted.to_string_lossy());
        assert_eq!(
            roots.resolve(&escape, &e).unwrap_err().reason,
            "outside_granted_folders"
        );
        assert_eq!(
            roots.resolve("relative", &e).unwrap_err().reason,
            "invalid_params"
        );
        let none = FinderRoots::new(vec![], &e);
        assert_eq!(
            none.resolve(r"C:\x", &e).unwrap_err().reason,
            "no_granted_folders"
        );
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn tilde_expands_to_the_profile() {
        assert_eq!(
            expand_tilde(r"~\Downloads", &env()),
            r"C:\Users\someone\Downloads"
        );
        assert_eq!(expand_tilde("~", &env()), r"C:\Users\someone");
    }

    #[test]
    fn verbatim_prefixes_are_stripped() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\x")),
            PathBuf::from(r"C:\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\srv\share")
        );
    }
}
