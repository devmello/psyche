//! The ceiling's `apps.deny` (helper-only design §5.3): desktop ids the box's owner has put out
//! of reach. H2 owns `policy.json` (loading, the rest of the ceiling, enforcement at dispatch);
//! this reads only `apps.deny`, so that Psyche cannot open a denied app on the virtual screen
//! and cannot type into one that has the focus. It fails closed: a `policy.json` that exists but
//! cannot be read or parsed denies every app.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::paths::Env;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Deny {
    #[default]
    Nothing,
    /// Lower-case ids; a trailing `*` matches a prefix (`org.mozilla.*`).
    Some(Vec<String>),
    /// The file is there and unusable.
    Everything,
}

impl Deny {
    pub fn is_denied(&self, app_id: &str) -> bool {
        match self {
            Deny::Nothing => false,
            Deny::Everything => true,
            Deny::Some(patterns) => {
                let id = app_id.trim().to_ascii_lowercase();
                patterns.iter().any(|p| match p.strip_suffix('*') {
                    Some(prefix) => id.starts_with(prefix),
                    None => *p == id,
                })
            }
        }
    }

    /// `{"apps": {"deny": ["org.keepassxc.KeePassXC"]}}`. Other keys are not this module's.
    pub fn from_policy(text: &str) -> Deny {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
            return Deny::Everything;
        };
        match v.get("apps").and_then(|a| a.get("deny")) {
            None => Deny::Nothing,
            Some(serde_json::Value::Array(items)) => {
                let mut out = Vec::new();
                for item in items {
                    match item.as_str() {
                        Some(s) if !s.trim().is_empty() => out.push(s.trim().to_ascii_lowercase()),
                        // A deny entry we cannot read is not one we may ignore.
                        _ => return Deny::Everything,
                    }
                }
                Deny::Some(out)
            }
            Some(_) => Deny::Everything,
        }
    }

    pub fn merge(self, other: Deny) -> Deny {
        match (self, other) {
            (Deny::Everything, _) | (_, Deny::Everything) => Deny::Everything,
            (Deny::Nothing, x) | (x, Deny::Nothing) => x,
            (Deny::Some(mut a), Deny::Some(b)) => {
                a.extend(b);
                Deny::Some(a)
            }
        }
    }
}

/// `$XDG_CONFIG_HOME/psyche-helper/policy.json`, else `~/.config/psyche-helper/policy.json`.
pub fn policy_path(env: &dyn Env) -> Option<PathBuf> {
    let base = match env.get("XDG_CONFIG_HOME") {
        Some(x) if x.starts_with('/') => PathBuf::from(x),
        _ => PathBuf::from(env.get("HOME")?).join(".config"),
    };
    Some(base.join("psyche-helper").join("policy.json"))
}

/// The list as the file and `PSYCHE_APPS_DENY` (comma separated) say, re-read when the file's
/// modification time changes, so an owner's edit applies to the next input.
pub struct DenyPolicy {
    path: Option<PathBuf>,
    from_env: Deny,
    cache: Mutex<Option<(Option<SystemTime>, Deny)>>,
}

impl DenyPolicy {
    pub fn from_env(env: &dyn Env) -> DenyPolicy {
        let from_env = match env.get("PSYCHE_APPS_DENY") {
            Some(v) => Deny::Some(
                v.split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect(),
            ),
            None => Deny::Nothing,
        };
        DenyPolicy {
            path: policy_path(env),
            from_env,
            cache: Mutex::new(None),
        }
    }

    pub fn with_path(path: PathBuf) -> DenyPolicy {
        DenyPolicy {
            path: Some(path),
            from_env: Deny::Nothing,
            cache: Mutex::new(None),
        }
    }

    fn read(path: &Path) -> (Option<SystemTime>, Deny) {
        match std::fs::metadata(path) {
            Ok(meta) => {
                let stamp = meta.modified().ok();
                match std::fs::read_to_string(path) {
                    Ok(text) => (stamp, Deny::from_policy(&text)),
                    Err(_) => (stamp, Deny::Everything),
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (None, Deny::Nothing),
            Err(_) => (None, Deny::Everything),
        }
    }

    pub fn current(&self) -> Deny {
        let Some(path) = &self.path else {
            return self.from_env.clone();
        };
        let stamp = std::fs::metadata(path).ok().and_then(|m| m.modified().ok());
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached, deny)) = cache.as_ref() {
            if *cached == stamp && stamp.is_some() {
                return deny.clone().merge(self.from_env.clone());
            }
        }
        let (stamp, deny) = Self::read(path);
        *cache = Some((stamp, deny.clone()));
        deny.merge(self.from_env.clone())
    }

    pub fn is_denied(&self, app_id: &str) -> bool {
        self.current().is_denied(app_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_matches_ids_case_insensitively_and_by_prefix() {
        let d = Deny::from_policy(
            r#"{"apps":{"allow":["*"],"deny":["org.keepassxc.KeePassXC","com.example.*"]}}"#,
        );
        assert!(d.is_denied("org.keepassxc.keepassxc"));
        assert!(d.is_denied("ORG.KEEPASSXC.KEEPASSXC"));
        assert!(d.is_denied("com.example.Mail"));
        // Near misses share a word and are not denied.
        assert!(!d.is_denied("org.keepassxc"));
        assert!(!d.is_denied("org.keepassxc.keepassxc.extra"));
        assert!(!d.is_denied("com.exampl"));
        assert!(!d.is_denied("org.gnome.texteditor"));
    }

    #[test]
    fn a_policy_without_a_list_denies_nothing_and_a_broken_one_denies_everything() {
        assert!(!Deny::from_policy("{}").is_denied("a.b"));
        assert!(!Deny::from_policy(r#"{"apps":{}}"#).is_denied("a.b"));
        for bad in [
            "not json",
            r#"{"apps":{"deny":"org.x"}}"#,
            r#"{"apps":{"deny":["ok.x", 7]}}"#,
            r#"{"apps":{"deny":[""]}}"#,
        ] {
            assert!(Deny::from_policy(bad).is_denied("any.app"), "{bad}");
        }
    }

    #[test]
    fn the_file_is_reread_when_it_changes_and_a_bad_file_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policy.json");
        let policy = DenyPolicy::with_path(path.clone());
        assert!(!policy.is_denied("org.x.App"), "no file: nothing denied");
        std::fs::write(&path, r#"{"apps":{"deny":["org.x.App"]}}"#).unwrap();
        assert!(policy.is_denied("org.x.App"));
        assert!(!policy.is_denied("org.y.App"));
        std::fs::write(&path, "{ broken").unwrap();
        // The modification time may be equal on a coarse clock: force a different stamp.
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        let f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        f.set_modified(later).unwrap();
        assert!(
            policy.is_denied("org.y.App"),
            "unreadable policy denies all"
        );
    }

    #[test]
    fn the_environment_list_adds_to_the_file() {
        let mut env = std::collections::HashMap::new();
        env.insert(
            "PSYCHE_APPS_DENY".to_string(),
            " org.a.App , org.b.* ".to_string(),
        );
        env.insert("HOME".to_string(), "/nonexistent-home".to_string());
        let policy = DenyPolicy::from_env(&env);
        assert!(policy.is_denied("org.a.app"));
        assert!(policy.is_denied("org.b.Anything"));
        assert!(!policy.is_denied("org.c.App"));
    }
}
