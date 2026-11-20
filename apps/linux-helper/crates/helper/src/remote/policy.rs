//! The ceiling: `policy.json` (design §5.3, §6.2). The box's owner sets it, on the box. The
//! Gateway can only narrow it; the helper enforces it at dispatch whatever the Gateway sends, by
//! reading the file again for every invocation.
//!
//! - `/etc/psyche-helper/policy.json` (root-owned, deb/rpm) wins when it exists; otherwise
//!   `$XDG_CONFIG_HOME/psyche-helper/policy.json` (the owner's, tarball install).
//! - **Fails closed.** A file that cannot be read, is not valid, has an unknown field, is owned by
//!   the wrong user, or can be written by others means *everything is denied*. A missing file
//!   means the defaults: computer use on the helper's own virtual screen, no shell, no files.
//! - **The user-owned file is advisory.** An agent with a shell or a GUI terminal on the box runs
//!   as the same account and can edit it. Only the root-owned `/etc` ceiling (deb/rpm) is a limit
//!   the account cannot change. The Gateway's own machine rules (H3, H4) apply either way.
//! - `apps.deny` means "never launched": the call that opens or drives an app is refused. It does
//!   not stop an allowed app from opening a denied one, or a denied window that is already on the
//!   screen. H1 must also check the focused window's app against this list.
//! - Paths are lexical: no `..`, absolute after `~`. An existing path is also resolved through
//!   symlinks and must still be inside its root, so a link cannot lead out. (The shell and file
//!   implementations repeat the confinement; this is the first gate.)

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use psyche_linux_computer::app_id::{is_app_id, normalize};
use psyche_protocol::ErrorCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::capability::CapabilityError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Surfaces {
    #[serde(default = "yes")]
    pub virtual_screen: bool,
    #[serde(default)]
    pub direct: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Apps {
    #[serde(default = "star")]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Exec {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub contain: bool,
    #[serde(default = "yes")]
    pub network: bool,
    #[serde(default)]
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
    #[serde(default)]
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
fn star() -> Vec<String> {
    vec!["*".into()]
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
        // Only "there is no root policy" may fall through to the user's. Any other error (a
        // directory this account cannot enter, an I/O error) means a root policy may exist that
        // cannot be read, and the answer is to deny everything, never to read the user's file.
        match std::fs::symlink_metadata(&self.etc) {
            Ok(_) => return load_file(&self.etc, self.etc_owner, Owner::Root),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return invalid(Owner::Root, format!("policy.json (root): {}", e.kind()));
            }
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

/// The one matcher for app ids and for `apps.allow` / `apps.deny` entries (H1 reuses it).
///
/// - `*` matches any run of characters, including none, and may appear anywhere, any number of
///   times. Nothing else is special: no `?`, no classes, no escapes.
/// - The whole text must match, not a part of it.
/// - Matching ignores ASCII case on both sides, because an app id has no case (`apps.list` returns
///   lowercase ids, an entry may be written `org.keepassxc.KeePassXC`). Non-ASCII letters are
///   compared exactly.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    let text = text.to_ascii_lowercase();
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text.as_str();
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
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
    /// Whether an app is permitted by `apps.allow` and `apps.deny`, for an id as the call or the
    /// engine names it. Both sides go through `app_id::normalize` first (trim, Unicode lowercase,
    /// no `.desktop`), so the gate and the engine agree on which app is meant.
    pub fn app_permitted(&self, id: &str) -> bool {
        let id = normalize(id);
        let hit = |p: &String| glob_match(&normalize(p), &id);
        !self.apps.deny.iter().any(hit) && self.apps.allow.iter().any(hit)
    }

    /// The same for a call that names no app: it is as permitted as the empty id, so `*` and
    /// `**` mean the same here as for a named app.
    fn nameless_permitted(&self) -> bool {
        self.app_permitted("")
    }

    /// Whether `path` is below `root` by components that are all real files or directories.
    /// A symlink (even a dangling one) below the root is refused. This is a gate, not a
    /// confinement: H5 must open every file with `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)`
    /// so a link swapped in after this check cannot lead out.
    fn no_links_below(root: &Path, path: &Path) -> bool {
        let Ok(rest) = path.strip_prefix(root) else {
            return false;
        };
        let mut probe = root.to_path_buf();
        for part in rest.components() {
            probe.push(part);
            match std::fs::symlink_metadata(&probe) {
                Ok(m) if m.file_type().is_symlink() => return false,
                Ok(_) => {}
                // Nothing here, so nothing below it either.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
                Err(_) => return false,
            }
        }
        true
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
            if !under(path, &root) || !Self::no_links_below(&root, path) {
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
            // A call that names no surface is refused, not defaulted: what the helper runs for
            // a missing `surface` must not be able to differ from what this checked.
            let Some(surface) = string("surface") else {
                return denied("a call that names no screen");
            };
            if !on_surface(surface) {
                return denied(&format!("the {surface} screen"));
            }
            // Every app key the call carries is judged, not the first: the engine reads them in
            // its own order (`bundleId` before `app`), and an id the engine would read must be
            // an id of the shape it accepts.
            let mut named: Vec<&str> = Vec::new();
            for key in APP_KEYS {
                match params.get(key) {
                    None => {}
                    Some(Value::String(s)) => named.push(s),
                    Some(_) => return denied("that app"),
                }
            }
            if named.is_empty() {
                if !self.nameless_permitted() {
                    return denied("that app");
                }
            } else if named
                .iter()
                .any(|id| !is_app_id(id) || !self.app_permitted(id))
            {
                return denied("that app");
            }
            return Ok(());
        }
        if capability == "exec.host" {
            if !self.exec.enabled {
                return denied("running commands");
            }
            // No `cwd` is refused, not read as `~`, for the same reason.
            let Some(cwd) = string("cwd").and_then(|c| expand(c, home)) else {
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
        assert!(call(
            &p,
            "computer.snapshot",
            json!({"surface": "virtual_screen"}),
            &home
        ));
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

    /// A partial sub-object is the owner narrowing one thing, not a broken file: every field
    /// defaults to what no file at all means.
    #[test]
    fn a_policy_that_names_only_what_it_changes_loads_with_the_defaults_for_the_rest() {
        let defaults = Policy::default();
        for (text, check) in [
            (
                r#"{"apps":{"deny":["org.keepassxc.KeePassXC"]}}"#,
                (|p: &Policy| p.apps.allow == ["*"] && p.apps.deny == ["org.keepassxc.KeePassXC"])
                    as fn(&Policy) -> bool,
            ),
            (r#"{"apps":{"allow":["org.gnome.*"]}}"#, |p| {
                p.apps.allow == ["org.gnome.*"] && p.apps.deny.is_empty()
            }),
            (r#"{"surfaces":{"virtualScreen":false}}"#, |p| {
                !p.surfaces.virtual_screen && !p.surfaces.direct
            }),
            (r#"{"surfaces":{"direct":true}}"#, |p| {
                p.surfaces.virtual_screen && p.surfaces.direct
            }),
            (r#"{"exec":{"enabled":true}}"#, |p| {
                p.exec.enabled && p.exec.contain && p.exec.network && p.exec.cwd_roots.is_empty()
            }),
            (r#"{"exec":{"contain":false}}"#, |p| {
                !p.exec.enabled && !p.exec.contain && p.exec.network
            }),
            (r#"{"files":{}}"#, |p| p.files.roots.is_empty()),
            (r#"{"apps":{},"surfaces":{},"exec":{}}"#, |p| {
                *p == Policy::default()
            }),
        ] {
            let f = Fixture::new();
            f.write("user-policy.json", text, 0o600);
            let loaded = f.source().load();
            assert!(
                matches!(loaded.source, Source::File(_)),
                "{text}: {:?}",
                loaded.source
            );
            assert!(check(&loaded.policy), "{text}");
            // Whatever it did not name is what no file means.
            if text.contains("\"surfaces\":{}") {
                assert_eq!(loaded.policy.surfaces, defaults.surfaces);
            }
        }
        // Unknown keys are still refused, and a deny-only file denies that app and no other.
        let f = Fixture::new();
        f.write(
            "user-policy.json",
            r#"{"apps":{"deny":["a.b"],"bogus":1}}"#,
            0o600,
        );
        assert!(matches!(f.source().load().source, Source::Invalid(_)));
        let _ = std::fs::remove_file(f.path("user-policy.json"));
        f.write(
            "user-policy.json",
            r#"{"apps":{"deny":["org.keepassxc.KeePassXC"]}}"#,
            0o600,
        );
        let p = f.source().load().policy;
        assert!(!p.app_permitted("org.keepassxc.keepassxc"));
        assert!(p.app_permitted("org.gnome.TextEditor"));
    }

    /// The ceiling printed in the design (§5.3) must load as written.
    #[test]
    fn the_design_documents_example_policy_loads() {
        let doc = include_str!("../../../../../../docs/design/linux-helper-only-2026.md");
        let start = doc.find("### 5.3 The ceiling").expect("section 5.3");
        let rest = &doc[start..];
        let open = rest.find("```json\n").expect("the example") + "```json\n".len();
        let close = rest[open..].find("```").expect("end of the example");
        let example = &rest[open..open + close];
        let f = Fixture::new();
        f.write("user-policy.json", example, 0o600);
        let loaded = f.source().load();
        assert!(
            matches!(loaded.source, Source::File(_)),
            "{:?}",
            loaded.source
        );
        assert!(loaded.policy.surfaces.virtual_screen && !loaded.policy.surfaces.direct);
        assert!(!loaded.policy.app_permitted("org.keepassxc.KeePassXC"));
        assert!(loaded.policy.app_permitted("org.gnome.TextEditor"));
        assert!(loaded.policy.exec.enabled);
        assert_eq!(loaded.policy.files.roots.len(), 1);
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

    /// The gate and the engine must mean the same app: each way the engine would read a call as
    /// KeePassXC is refused here, under `allow:["*"]`, `deny:["org.keepassxc.KeePassXC"]`.
    #[test]
    fn every_spelling_the_engine_would_read_as_a_denied_app_is_refused() {
        let home = PathBuf::from("/h");
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec!["*".into()],
            deny: vec!["org.keepassxc.KeePassXC".into()],
        };
        let vs = |extra: Value| {
            let mut v = extra;
            v["surface"] = json!("virtual_screen");
            v
        };
        // The control: the exact id is refused, another app is not.
        assert!(!call(
            &policy,
            "apps.open",
            vs(json!({"app": "org.keepassxc.KeePassXC"})),
            &home
        ));
        assert!(call(
            &policy,
            "apps.open",
            vs(json!({"app": "org.gnome.TextEditor"})),
            &home
        ));
        for (cap, params) in [
            // 1. two keys: the engine opens `bundleId`, the old gate read `app`.
            (
                "apps.open",
                json!({"app": "gedit", "bundleId": "org.keepassxc.KeePassXC"}),
            ),
            (
                "apps.open",
                json!({"bundleId": "gedit", "app": "org.keepassxc.KeePassXC"}),
            ),
            // 2. the `.desktop` spelling.
            (
                "apps.open",
                json!({"app": "org.keepassxc.KeePassXC.desktop"}),
            ),
            // 3. a leading space.
            ("apps.open", json!({"app": " org.keepassxc.KeePassXC"})),
            // 4. the KELVIN SIGN spelling: not the shape of an app id.
            (
                "apps.focus",
                json!({"app": "org.\u{212A}eepassxc.\u{212A}eePassXC"}),
            ),
        ] {
            assert!(!call(&policy, cap, vs(params.clone()), &home), "{params}");
        }
        // The pattern is normalised too.
        policy.apps.deny = vec![" ORG.KeePassXC.KeePassXC.desktop ".into()];
        assert!(!call(
            &policy,
            "apps.open",
            vs(json!({"app": "org.keepassxc.keepassxc"})),
            &home
        ));
        // 5. and 6. (a display name, a pid) name no id the gate can judge: the engine judges the
        // app it resolves them to; see `app_gate_judges_the_resolved_app`.
    }

    #[test]
    fn a_pattern_of_only_stars_means_every_app_with_or_without_a_name() {
        let home = PathBuf::from("/h");
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec!["*".into()],
            deny: vec!["**".into()],
        };
        let nameless = json!({"surface": "virtual_screen", "pid": 4242});
        let named = json!({"surface": "virtual_screen", "app": "org.gnome.TextEditor"});
        assert!(!call(&policy, "computer.click", named, &home));
        assert!(!call(&policy, "computer.click", nameless.clone(), &home));
        // And the plain `*` deny: the same.
        policy.apps.deny = vec!["*".into()];
        assert!(!call(&policy, "computer.click", nameless, &home));
    }

    #[test]
    fn app_gate_judges_the_resolved_app() {
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec!["*".into()],
            deny: vec!["org.keepassxc.KeePassXC".into()],
        };
        for id in [
            "org.keepassxc.keepassxc",
            "org.keepassxc.KeePassXC",
            "org.keepassxc.keepassxc.desktop",
            " org.keepassxc.keepassxc",
        ] {
            assert!(!policy.app_permitted(id), "{id}");
        }
        assert!(policy.app_permitted("org.gnome.texteditor"));
        assert!(policy.app_permitted("keepassxc-helper"));
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
            json!({"surface": "virtual_screen", "app":"org.gnome.TextEditor"}),
            &home
        ));
        assert!(call(
            &policy,
            "apps.open",
            json!({"surface": "virtual_screen", "appId":"gedit"}),
            &home
        ));
        assert!(!call(
            &policy,
            "apps.open",
            json!({"surface": "virtual_screen", "appId":"org.keepassxc.KeePassXC"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.type",
            json!({"surface": "virtual_screen", "bundleId":"firefox"}),
            &home
        ));
        assert!(
            !call(
                &policy,
                "apps.focus",
                json!({"surface": "virtual_screen", "app": 5}),
                &home
            ),
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
            json!({"surface": "virtual_screen", "app":"org.gnome.TextEditor"}),
            &home
        ));
        assert!(!call(
            &policy,
            "computer.click",
            json!({"surface": "virtual_screen", "app":"firefox"}),
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
    fn a_call_without_a_surface_or_a_cwd_is_refused_not_defaulted() {
        let home = PathBuf::from("/h");
        let mut policy = Policy::default();
        policy.exec = Exec {
            enabled: true,
            contain: true,
            network: true,
            cwd_roots: vec!["~".into()],
        };
        for cap in [
            "computer.click",
            "computer.snapshot",
            "apps.open",
            "apps.focus",
        ] {
            assert!(
                !call(&policy, cap, json!({}), &home),
                "{cap} without a surface"
            );
            assert!(!call(&policy, cap, json!({"app": "gedit"}), &home), "{cap}");
            assert!(
                call(&policy, cap, json!({"surface": "virtual_screen"}), &home),
                "{cap}"
            );
        }
        assert!(!call(&policy, "exec.host", json!({}), &home));
        assert!(!call(&policy, "exec.host", json!({"argv": ["ls"]}), &home));
        assert!(call(&policy, "exec.host", json!({"cwd": "~"}), &home));
    }

    #[test]
    fn a_symlink_below_a_root_is_refused_even_when_it_dangles_or_points_inside() {
        let f = Fixture::new();
        let home = f.path("home");
        std::fs::create_dir_all(home.join("work/real")).unwrap();
        symlink("/nonexistent/target", home.join("work/dangling")).unwrap();
        symlink(home.join("work/real"), home.join("work/inside")).unwrap();
        symlink("/etc", home.join("work/out")).unwrap();
        let policy = Policy {
            files: Files {
                roots: vec![Root {
                    path: "~/work".into(),
                    mode: Mode::Rw,
                }],
            },
            ..Policy::default()
        };
        let p = |s: &str| json!({ "path": s });
        assert!(call(&policy, "fs.write", p("~/work/real/a.txt"), &home));
        for path in [
            "~/work/dangling",
            "~/work/dangling/new",
            "~/work/inside/a.txt",
            "~/work/out/passwd",
        ] {
            for cap in ["fs.read", "fs.write", "fs.mkdir", "fs.remove", "fs.stat"] {
                assert!(!call(&policy, cap, p(path), &home), "{cap} {path}");
            }
        }
    }

    #[test]
    fn an_unreadable_root_policy_denies_everything_and_never_falls_back_to_the_users() {
        let f = Fixture::new();
        // A user policy that would allow everything.
        f.write(
            "user-policy.json",
            r#"{"surfaces":{"virtualScreen":true,"direct":true},"exec":{"enabled":true,"contain":false,"network":true,"cwdRoots":["~"]}}"#,
            0o600,
        );
        // The root policy's directory cannot be entered (EACCES, not NotFound).
        let locked = f.path("etc-dir");
        std::fs::create_dir(&locked).unwrap();
        std::fs::write(locked.join("policy.json"), "{}").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let mut source = f.source();
        source.etc = locked.join("policy.json");
        let loaded = source.load();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
        // (Running as root defeats the test: root can read a mode 000 directory.)
        if me() != 0 {
            assert!(
                matches!(loaded.source, Source::Invalid(_)),
                "{:?}",
                loaded.source
            );
            assert_eq!(loaded.owner, Owner::Root);
            assert_eq!(loaded.policy, Policy::deny_all());
        }
        // A root policy that is simply absent does fall through to the user's.
        source.etc = f.path("absent/policy.json");
        assert!(matches!(source.load().source, Source::File(_)));
    }

    #[test]
    fn globs_match_whole_strings_ignoring_ascii_case() {
        // (pattern, text, matches)
        let table: [(&str, &str, bool); 24] = [
            ("*", "anything", true),
            ("a*", "abc", true),
            ("a*", "ba", false),
            ("*c", "abc", true),
            ("*c", "cb", false),
            ("a*c", "abc", true),
            ("a*c", "ac", true),
            ("a*c", "a", false),
            ("a*b*c", "axxbyyc", true),
            ("a*b*c", "axxcyyb", false),
            ("exact", "exact", true),
            ("exact", "exactly", false),
            ("", "x", false),
            ("", "", true),
            // Mixed case, either side.
            ("org.keepassxc.KeePassXC", "org.keepassxc.keepassxc", true),
            ("org.keepassxc.keepassxc", "org.keepassxc.KeePassXC", true),
            ("ORG.KEEPASSXC.*", "org.keepassxc.keepassxc", true),
            ("org.*.KeePassXC", "ORG.keepassxc.keepassxc", true),
            ("*PASS*", "org.keepassxc.keepassxc", true),
            ("Firefox", "firefox-esr", false),
            (
                "org.keepassxc.KeePassXC",
                "org.keepassxc.keepassxc.extra",
                false,
            ),
            // Only ASCII is folded.
            ("\u{c9}cole", "\u{e9}cole", false),
            ("\u{c9}cole", "\u{c9}COLE", true),
            ("a?c", "abc", false),
        ];
        for (pattern, text, want) in table {
            assert_eq!(glob_match(pattern, text), want, "{pattern:?} vs {text:?}");
        }
    }

    #[test]
    fn the_deny_list_matches_ids_in_any_case() {
        let home = PathBuf::from("/h");
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec!["*".into()],
            deny: vec!["org.keepassxc.KeePassXC".into(), "Firefox*".into()],
        };
        for id in [
            "org.keepassxc.keepassxc",
            "ORG.KEEPASSXC.KEEPASSXC",
            "org.keepassxc.KeePassXC",
            "firefox",
            "FIREFOX-esr",
        ] {
            for cap in ["apps.open", "apps.focus", "computer.click"] {
                assert!(
                    !call(
                        &policy,
                        cap,
                        json!({"surface": "virtual_screen", "app": id}),
                        &home
                    ),
                    "{cap} {id}"
                );
            }
        }
        assert!(call(
            &policy,
            "apps.open",
            json!({"surface": "virtual_screen", "app": "gedit"}),
            &home
        ));
        // An allow list is case-insensitive too.
        policy.apps = Apps {
            allow: vec!["Org.Gnome.*".into()],
            deny: vec![],
        };
        assert!(call(
            &policy,
            "apps.open",
            json!({"surface": "virtual_screen", "app": "org.gnome.texteditor"}),
            &home
        ));
    }
}
