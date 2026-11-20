//! The ceiling: `policy.json` (design §5.3, §6.2). The box's owner sets it, on the box. The
//! Gateway can only narrow it; the helper enforces it at dispatch whatever the Gateway sends, by
//! reading the file again for every invocation.
//!
//! - `/etc/psyche-helper/policy.json` (root-owned, deb/rpm) wins when it exists; otherwise
//!   `$XDG_CONFIG_HOME/psyche-helper/policy.json` (the owner's, tarball install).
//! - **Fails closed.** A file that cannot be read, is not valid, has an unknown field, is owned by
//!   the wrong user, or can be written by others means *everything is denied*. A missing file
//!   means the defaults: computer use on the helper's own virtual screen, no shell, no files.
//! - Paths are lexical: no `..`, absolute after `~`. An existing path is also resolved through
//!   symlinks and must still be inside its root, so a link cannot lead out. (The shell and file
//!   implementations repeat the confinement; this is the first gate.)

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use psyche_protocol::ErrorCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::capability::CapabilityError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Surfaces {
    pub virtual_screen: bool,
    pub direct: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apps {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Exec {
    pub enabled: bool,
    pub contain: bool,
    pub network: bool,
    pub cwd_roots: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Ro,
    Rw,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub path: String,
    pub mode: Mode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Files {
    pub roots: Vec<Root>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Policy {
    #[serde(default = "default_surfaces")]
    pub surfaces: Surfaces,
    #[serde(default = "default_apps")]
    pub apps: Apps,
    #[serde(default = "default_exec")]
    pub exec: Exec,
    #[serde(default = "default_files")]
    pub files: Files,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_high: Option<String>,
    #[serde(default = "yes")]
    pub watch: bool,
}

fn yes() -> bool {
    true
}
fn default_surfaces() -> Surfaces {
    Surfaces {
        virtual_screen: true,
        direct: false,
    }
}
fn default_apps() -> Apps {
    Apps {
        allow: vec!["*".into()],
        deny: vec![],
    }
}
fn default_exec() -> Exec {
    Exec {
        enabled: false,
        contain: true,
        network: true,
        cwd_roots: vec![],
    }
}
fn default_files() -> Files {
    Files { roots: vec![] }
}

impl Default for Policy {
    /// No policy file: the helper's own screen, and nothing else.
    fn default() -> Self {
        Self {
            surfaces: default_surfaces(),
            apps: default_apps(),
            exec: default_exec(),
            files: default_files(),
            memory_high: None,
            watch: true,
        }
    }
}

impl Policy {
    /// Everything off. What an unreadable or unsafe policy means.
    pub fn deny_all() -> Self {
        Self {
            surfaces: Surfaces {
                virtual_screen: false,
                direct: false,
            },
            apps: Apps {
                allow: vec![],
                deny: vec!["*".into()],
            },
            exec: Exec {
                enabled: false,
                contain: true,
                network: false,
                cwd_roots: vec![],
            },
            files: Files { roots: vec![] },
            memory_high: None,
            watch: false,
        }
    }
}

/// Who can change the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Root,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    File(PathBuf),
    /// No file: the defaults.
    Default,
    /// A file that could not be trusted; everything is denied.
    Invalid(String),
}

#[derive(Debug, Clone)]
pub struct Loaded {
    pub policy: Policy,
    pub owner: Owner,
    pub source: Source,
}

/// Where the policy lives. Read again on every call.
#[derive(Debug, Clone)]
pub struct PolicySource {
    /// `/etc/psyche-helper/policy.json`; must be owned by `etc_owner`.
    pub etc: PathBuf,
    pub etc_owner: u32,
    pub user: PathBuf,
    pub home: PathBuf,
}

impl PolicySource {
    pub fn standard(user_config_dir: &Path, home: PathBuf, override_path: Option<PathBuf>) -> Self {
        Self {
            etc: override_path.unwrap_or_else(|| PathBuf::from("/etc/psyche-helper/policy.json")),
            etc_owner: 0,
            user: user_config_dir.join("policy.json"),
            home,
        }
    }

    pub fn load(&self) -> Loaded {
        // SAFETY: geteuid has no preconditions and cannot fail.
        let me = unsafe { libc::geteuid() };
        if std::fs::symlink_metadata(&self.etc).is_ok() {
            return load_file(&self.etc, self.etc_owner, Owner::Root);
        }
        match std::fs::symlink_metadata(&self.user) {
            Ok(_) => load_file(&self.user, me, Owner::User),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Loaded {
                policy: Policy::default(),
                owner: Owner::User,
                source: Source::Default,
            },
            Err(e) => invalid(Owner::User, format!("policy.json: {}", e.kind())),
        }
    }
}

fn invalid(owner: Owner, why: String) -> Loaded {
    Loaded {
        policy: Policy::deny_all(),
        owner,
        source: Source::Invalid(why),
    }
}

fn load_file(path: &Path, expected_uid: u32, owner: Owner) -> Loaded {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) => return invalid(owner, format!("policy.json: {}", e.kind())),
    };
    if !meta.file_type().is_file() {
        return invalid(owner, "policy.json is not a regular file".into());
    }
    if meta.uid() != expected_uid {
        return invalid(owner, "policy.json has the wrong owner".into());
    }
    if meta.permissions().mode() & 0o022 != 0 {
        return invalid(owner, "policy.json can be written by others".into());
    }
    if let Some(dir) = path.parent() {
        // A directory others can write to lets them swap the file.
        if let Ok(d) = std::fs::metadata(dir) {
            if d.permissions().mode() & 0o022 != 0 && d.permissions().mode() & 0o1000 == 0 {
                return invalid(
                    owner,
                    "the policy directory can be written by others".into(),
                );
            }
        }
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => return invalid(owner, format!("policy.json: {}", e.kind())),
    };
    match serde_json::from_slice::<Policy>(&bytes) {
        Ok(policy) => match check_shape(&policy) {
            Ok(()) => Loaded {
                policy,
                owner,
                source: Source::File(path.to_path_buf()),
            },
            Err(why) => invalid(owner, why),
        },
        Err(e) => invalid(owner, format!("policy.json: {e}")),
    }
}

fn check_shape(policy: &Policy) -> Result<(), String> {
    let path_ok = |p: &str| p == "~" || p.starts_with("~/") || p.starts_with('/');
    for root in &policy.files.roots {
        if !path_ok(&root.path) || root.path.split('/').any(|c| c == "..") {
            return Err(format!("policy.json: bad file root {}", root.path));
        }
    }
    for cwd in &policy.exec.cwd_roots {
        if !path_ok(cwd) || cwd.split('/').any(|c| c == "..") {
            return Err(format!("policy.json: bad cwd root {cwd}"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Enforcement

pub fn forbidden(reason: &str, message: &str) -> CapabilityError {
    CapabilityError::new(ErrorCode::Forbidden, reason, message)
}

fn expand(path: &str, home: &Path) -> Option<PathBuf> {
    let expanded = if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    // Absolute, with no `..` and no `.` tricks.
    if !expanded.is_absolute() {
        return None;
    }
    let mut out = PathBuf::from("/");
    for part in expanded.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// Whether `path` is `root` or below it, by whole components.
fn under(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// The path with symlinks resolved as far as it exists; the missing tail is appended unresolved.
fn resolve_existing(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut probe = path.to_path_buf();
    loop {
        match std::fs::canonicalize(&probe) {
            Ok(real) => {
                let mut out = real;
                for part in tail.iter().rev() {
                    out.push(part);
                }
                return Some(out);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tail.push(probe.file_name()?.to_os_string());
                probe = probe.parent()?.to_path_buf();
            }
            Err(_) => return None,
        }
    }
}

fn glob(pattern: &str, text: &str) -> bool {
    // `*` matches any run of characters; everything else is literal.
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part) && rest.len() >= part.len();
        } else {
            match rest.find(part) {
                Some(at) => rest = &rest[at + part.len()..],
                None => return false,
            }
        }
    }
    true
}

const APP_KEYS: [&str; 5] = ["app", "appId", "bundleId", "desktopId", "application"];

impl Policy {
    fn app_allowed(&self, id: Option<&str>) -> bool {
        match id {
            Some(id) => {
                !self.apps.deny.iter().any(|p| glob(p, id))
                    && self.apps.allow.iter().any(|p| glob(p, id))
            }
            // The call names no app: it is allowed only where every app is.
            None => {
                self.apps.allow.iter().any(|p| p == "*") && !self.apps.deny.iter().any(|p| p == "*")
            }
        }
    }

    fn root_for<'a>(
        &'a self,
        roots: impl Iterator<Item = (&'a str, Mode)>,
        home: &Path,
        path: &Path,
        write: bool,
    ) -> bool {
        let real = resolve_existing(path);
        roots.into_iter().any(|(root, mode)| {
            if write && mode != Mode::Rw {
                return false;
            }
            let Some(root) = expand(root, home) else {
                return false;
            };
            if !under(path, &root) {
                return false;
            }
            // A symlink inside the root must not lead out of it.
            let real_root = resolve_existing(&root).unwrap_or(root);
            real.as_ref().is_some_and(|r| under(r, &real_root))
        })
    }

    /// Whether this call may run under the ceiling. `Ok` for a capability the policy does not
    /// speak of (it is limited by the remote allowlist instead).
    pub fn check(
        &self,
        capability: &str,
        params: &Value,
        home: &Path,
    ) -> Result<(), CapabilityError> {
        let string = |key: &str| params.get(key).and_then(Value::as_str);
        let denied = |what: &str| {
            Err(forbidden(
                "machine_policy",
                &format!("This computer's limits do not allow {what}"),
            ))
        };
        let on_surface = |surface: &str| match surface {
            "virtual_screen" => self.surfaces.virtual_screen,
            "direct" => self.surfaces.direct,
            _ => false,
        };

        if capability == "vscreen.status" {
            return Ok(());
        }
        if capability.starts_with("vscreen.") {
            return if self.surfaces.virtual_screen {
                Ok(())
            } else {
                denied("the private screen")
            };
        }
        if capability.starts_with("computer.") || matches!(capability, "apps.open" | "apps.focus") {
            // The headless helper has one screen; a call that names none means that one.
            let surface = string("surface").unwrap_or("virtual_screen");
            if !on_surface(surface) {
                return denied(&format!("the {surface} screen"));
            }
            let id = APP_KEYS.iter().find_map(|k| string(k));
            if params.as_object().is_some_and(|o| {
                APP_KEYS
                    .iter()
                    .any(|k| o.get(*k).is_some_and(|v| !v.is_string()))
            }) {
                return denied("that app");
            }
            if !self.app_allowed(id) {
                return denied("that app");
            }
            return Ok(());
        }
        if capability == "exec.host" {
            if !self.exec.enabled {
                return denied("running commands");
            }
            let cwd = string("cwd").unwrap_or("~");
            let Some(cwd) = expand(cwd, home) else {
                return denied("that folder");
            };
            let roots = self.exec.cwd_roots.iter().map(|r| (r.as_str(), Mode::Rw));
            return if self.root_for(roots, home, &cwd, false) {
                Ok(())
            } else {
                denied("that folder")
            };
        }
        if let Some(op) = capability.strip_prefix("fs.") {
            let write = matches!(op, "write" | "mkdir" | "remove");
            let Some(path) = string("path").and_then(|p| expand(p, home)) else {
                return denied("that path");
            };
            let roots = self.files.roots.iter().map(|r| (r.path.as_str(), r.mode));
            return if self.root_for(roots, home, &path, write) {
                Ok(())
            } else {
                denied("that path")
            };
        }
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;

    fn me() -> u32 {
        // SAFETY: geteuid cannot fail.
        unsafe { libc::geteuid() }
    }

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            Self { dir }
        }
        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
        }
        fn source(&self) -> PolicySource {
            PolicySource {
                etc: self.path("etc-policy.json"),
                etc_owner: me(),
                user: self.path("user-policy.json"),
                home: self.path("home"),
            }
        }
        fn write(&self, name: &str, text: &str, mode: u32) {
            let p = self.path(name);
            std::fs::write(&p, text).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
        }
    }

    fn call(policy: &Policy, cap: &str, params: Value, home: &Path) -> bool {
        policy.check(cap, &params, home).is_ok()
    }

    #[test]
    fn no_file_means_the_defaults_and_they_are_narrow() {
        let f = Fixture::new();
        let loaded = f.source().load();
        assert_eq!(loaded.source, Source::Default);
        assert_eq!(loaded.owner, Owner::User);
        let p = loaded.policy;
        let home = f.path("home");
        assert!(call(
            &p,
            "computer.click",
            json!({"surface":"virtual_screen"}),
            &home
        ));
        assert!(call(&p, "computer.snapshot", json!({}), &home));
        assert!(!call(
            &p,
            "computer.click",
            json!({"surface":"direct"}),
            &home
        ));
        assert!(!call(&p, "exec.host", json!({"cwd":"~"}), &home));
        assert!(!call(
            &p,
            "fs.read",
            json!({"path": format!("{}/a", home.display())}),
            &home
        ));
    }

    #[test]
    fn a_broken_or_unsafe_file_denies_everything() {
        let f = Fixture::new();
        let home = f.path("home");
        let good = r#"{"files":{"roots":[{"path":"~","mode":"rw"}]},"exec":{"enabled":true,"contain":true,"network":true,"cwdRoots":["~"]}}"#;
        let cases: Vec<(&str, String, u32)> = vec![
            ("not json", "nope".into(), 0o600),
            ("unknown field", r#"{"admin":true}"#.into(), 0o600),
            ("unknown nested field", r#"{"exec":{"enabled":true,"contain":true,"network":true,"cwdRoots":[],"sudo":true}}"#.into(), 0o600),
            ("bad mode", r#"{"files":{"roots":[{"path":"~","mode":"rwx"}]}}"#.into(), 0o600),
            ("dotdot root", r#"{"files":{"roots":[{"path":"~/../..","mode":"ro"}]}}"#.into(), 0o600),
            ("relative root", r#"{"files":{"roots":[{"path":"x","mode":"ro"}]}}"#.into(), 0o600),
            ("group writable", good.into(), 0o660),
            ("world writable", good.into(), 0o666),
        ];
        for (label, text, mode) in cases {
            let name = "user-policy.json";
            let _ = std::fs::remove_file(f.path(name));
            f.write(name, &text, mode);
            let loaded = f.source().load();
            assert!(
                matches!(loaded.source, Source::Invalid(_)),
                "{label}: {:?}",
                loaded.source
            );
            assert_eq!(loaded.policy, Policy::deny_all(), "{label}");
            for (cap, params) in [
                ("computer.click", json!({})),
                ("vscreen.start", json!({})),
                ("exec.host", json!({"cwd":"~"})),
                ("fs.read", json!({"path": format!("{}/a", home.display())})),
            ] {
                assert!(!call(&loaded.policy, cap, params, &home), "{label} {cap}");
            }
        }
        // And the good one works, to show the cases above failed on purpose.
        let _ = std::fs::remove_file(f.path("user-policy.json"));
        f.write("user-policy.json", good, 0o600);
        assert!(matches!(f.source().load().source, Source::File(_)));
    }

    #[test]
    fn a_symlinked_or_foreign_owned_file_is_not_trusted() {
        let f = Fixture::new();
        f.write("real.json", "{}", 0o600);
        symlink(f.path("real.json"), f.path("user-policy.json")).unwrap();
        assert!(matches!(f.source().load().source, Source::Invalid(_)));
        // Root-owned means root: a file this user owns is refused as the /etc policy.
        let _ = std::fs::remove_file(f.path("user-policy.json"));
        f.write("etc-policy.json", "{}", 0o644);
        let mut source = f.source();
        source.etc_owner = me().wrapping_add(1);
        let loaded = source.load();
        assert!(matches!(loaded.source, Source::Invalid(_)));
        assert_eq!(loaded.owner, Owner::Root);
    }

    #[test]
    fn the_etc_policy_wins_over_the_users_and_the_user_cannot_loosen_it() {
        let f = Fixture::new();
        f.write(
            "etc-policy.json",
            r#"{"surfaces":{"virtualScreen":false,"direct":false}}"#,
            0o644,
        );
        f.write(
            "user-policy.json",
            r#"{"surfaces":{"virtualScreen":true,"direct":true}}"#,
            0o600,
        );
        let loaded = f.source().load();
        assert_eq!(loaded.owner, Owner::Root);
        assert!(!loaded.policy.surfaces.virtual_screen && !loaded.policy.surfaces.direct);
    }

    #[test]
    fn files_are_confined_to_the_roots_with_their_modes() {
        let f = Fixture::new();
        let home = f.path("home");
        std::fs::create_dir_all(home.join("work")).unwrap();
        std::fs::create_dir_all(home.join("ro")).unwrap();
        std::fs::create_dir_all(f.path("outside")).unwrap();
        std::fs::write(f.path("outside/secret"), "x").unwrap();
        symlink(f.path("outside"), home.join("work/link")).unwrap();
        let policy = Policy {
            files: Files {
                roots: vec![
                    Root {
                        path: "~/work".into(),
                        mode: Mode::Rw,
                    },
                    Root {
                        path: "~/ro".into(),
                        mode: Mode::Ro,
                    },
                ],
            },
            ..Policy::default()
        };
        let p = |s: &str| json!({ "path": s });
        let h = home.display().to_string();
        assert!(call(
            &policy,
            "fs.read",
            p(&format!("{h}/work/a.txt")),
            &home
        ));
        assert!(call(&policy, "fs.read", p("~/work/a.txt"), &home));
        assert!(call(&policy, "fs.write", p("~/work/new/deep.txt"), &home));
        assert!(call(&policy, "fs.list", p("~/ro"), &home));
        assert!(!call(&policy, "fs.write", p("~/ro/a"), &home), "ro root");
        assert!(!call(&policy, "fs.mkdir", p("~/ro/a"), &home));
        assert!(!call(&policy, "fs.remove", p("~/ro/a"), &home));
        // Outside every root, by `..`, by a sibling that shares a prefix, by a symlink.
        assert!(!call(
            &policy,
            "fs.read",
            p("~/work/../ro/../../outside/secret"),
            &home
        ));
        assert!(!call(&policy, "fs.read", p("~/workshop/a"), &home));
        assert!(!call(&policy, "fs.read", p("~/.ssh/id_ed25519"), &home));
        assert!(!call(&policy, "fs.read", p("/etc/passwd"), &home));
        assert!(!call(&policy, "fs.read", p("~/work/link/secret"), &home));
        assert!(!call(&policy, "fs.write", p("~/work/link/new"), &home));
        // Missing, empty, non-string or relative paths are denied, never defaulted.
        for params in [
            json!({}),
            json!({"path": ""}),
            json!({"path": 5}),
            json!({"path": "work/a"}),
            json!({"path": null}),
        ] {
            assert!(!call(&policy, "fs.read", params, &home));
        }
    }

    #[test]
    fn exec_needs_the_switch_and_a_cwd_inside_the_roots() {
        let f = Fixture::new();
        let home = f.path("home");
        std::fs::create_dir_all(home.join("proj")).unwrap();
        let mut policy = Policy::default();
        assert!(
            !call(&policy, "exec.host", json!({"cwd":"~/proj"}), &home),
            "off by default"
        );
        policy.exec = Exec {
            enabled: true,
            contain: true,
            network: true,
            cwd_roots: vec!["~/proj".into()],
        };
        assert!(call(
            &policy,
            "exec.host",
            json!({"cwd":"~/proj/sub"}),
            &home
        ));
        assert!(!call(&policy, "exec.host", json!({"cwd":"~"}), &home));
        assert!(
            !call(&policy, "exec.host", json!({}), &home),
            "no cwd means ~, outside the roots"
        );
        assert!(!call(
            &policy,
            "exec.host",
            json!({"cwd":"~/proj/../.ssh"}),
            &home
        ));
        assert!(!call(&policy, "exec.host", json!({"cwd":"/tmp"}), &home));
        assert!(!call(&policy, "exec.host", json!({"cwd": 5}), &home));
    }

    #[test]
    fn surfaces_and_apps_follow_the_ceiling() {
        let home = PathBuf::from("/h");
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec!["*".into()],
            deny: vec!["org.keepassxc.*".into(), "firefox".into()],
        };
        assert!(call(
            &policy,
            "computer.click",
            json!({"app":"org.gnome.TextEditor"}),
            &home
        ));
        assert!(call(&policy, "apps.open", json!({"appId":"gedit"}), &home));
        assert!(!call(
            &policy,
            "apps.open",
            json!({"appId":"org.keepassxc.KeePassXC"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.type",
            json!({"bundleId":"firefox"}),
            &home
        ));
        assert!(
            !call(&policy, "apps.focus", json!({"app": 5}), &home),
            "not a string"
        );
        // An allowlist: a call that names no app is not allowed, one that names another is not.
        policy.apps = Apps {
            allow: vec!["org.gnome.*".into()],
            deny: vec![],
        };
        assert!(call(
            &policy,
            "computer.click",
            json!({"app":"org.gnome.TextEditor"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.click",
            json!({"app":"firefox"}),
            &home
        ));
        assert!(!call(&policy, "computer.click", json!({}), &home));
        // Surfaces.
        policy.apps = default_apps();
        policy.surfaces = Surfaces {
            virtual_screen: false,
            direct: true,
        };
        assert!(!call(
            &policy,
            "computer.click",
            json!({"surface":"virtual_screen"}),
            &home
        ));
        assert!(!call(&policy, "vscreen.start", json!({}), &home));
        assert!(call(&policy, "vscreen.status", json!({}), &home));
        assert!(call(
            &policy,
            "computer.click",
            json!({"surface":"direct"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.click",
            json!({"surface":"elsewhere"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.click",
            json!({"surface": 1}),
            &home
        ));
    }

    #[test]
    fn globs_match_whole_strings() {
        assert!(glob("*", "anything"));
        assert!(glob("a*", "abc") && !glob("a*", "ba"));
        assert!(glob("*c", "abc") && !glob("*c", "cb"));
        assert!(glob("a*c", "abc") && glob("a*c", "ac") && !glob("a*c", "a"));
        assert!(glob("a*b*c", "axxbyyc") && !glob("a*b*c", "axxcyyb"));
        assert!(glob("exact", "exact") && !glob("exact", "exactly"));
        assert!(!glob("", "x") && glob("", ""));
    }
}
