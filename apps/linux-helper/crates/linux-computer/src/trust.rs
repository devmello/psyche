//! Whether a file on disk is out of the agent's reach (round-3 review, findings 1 and 5).
//!
//! The helper runs as the owner's account, and so does anything the agent can write through a
//! file grant. A file is **trusted** only when nothing on its way from `/` could have been
//! written by that account: the file and every directory above it are owned by another account
//! (in practice root) and are neither group- nor world-writable. A sticky world-writable dir
//! (`/tmp`) is world-writable, so it is not trusted either. Symlinks are followed: each link must
//! sit in a trusted dir and must not be owned by the helper's account, and its target is judged
//! by the same rule, component by component. A trusted file cannot change under the helper
//! between the check and its use, because nothing on its path is writable by the agent.
//!
//! Used for:
//! - `apps.open`: only a trusted desktop entry is launched ([`launchable_desktop_file`]), so an
//!   entry the agent wrote under `~/.local/share/applications` never runs;
//! - the separate desktop guest's `computer-use.json` ([`SettingsSource`]), which apps inside the
//!   guest (same uid) must not be able to loosen.
//!
//! The decisions are pure over [`FsView`], so they are unit-tested anywhere; [`RealFs`] is the
//! thin `lstat` glue.

use crate::app_id;
use crate::error::{code, CapError, CapResult};
use crate::tiers::TierSettings;
use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

/// What `lstat` says about one path component.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    pub uid: u32,
    /// `st_mode` (permission bits are what matter here).
    pub mode: u32,
    pub is_symlink: bool,
}

/// The file system as the trust rule sees it.
pub trait FsView {
    /// `lstat`: does not follow a final symlink. `None` when the path does not exist or cannot
    /// be read.
    fn lstat(&self, path: &Path) -> Option<Meta>;
    /// A symlink's target as stored (relative or absolute).
    fn read_link(&self, path: &Path) -> Option<PathBuf>;
    /// The entries of a directory (full paths), empty when it does not exist.
    fn list(&self, dir: &Path) -> Vec<PathBuf>;
    /// A file's bytes, `None` when it cannot be read.
    fn read(&self, path: &Path) -> Option<Vec<u8>>;
}

/// Why a path is not trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Untrusted {
    /// Only absolute paths are judged.
    Relative,
    /// A component does not exist or cannot be examined.
    Missing(PathBuf),
    /// A component (file, directory or symlink) belongs to the helper's own account.
    OwnedByHelper(PathBuf),
    /// A file or directory is group- or world-writable (sticky dirs included).
    Writable(PathBuf),
    /// More symlinks than the kernel would follow.
    TooManyLinks,
}

impl Untrusted {
    /// The component the rule failed on, for logs and error details.
    pub fn path(&self) -> Option<&Path> {
        match self {
            Untrusted::Missing(p) | Untrusted::OwnedByHelper(p) | Untrusted::Writable(p) => Some(p),
            Untrusted::Relative | Untrusted::TooManyLinks => None,
        }
    }

    pub fn why(&self) -> &'static str {
        match self {
            Untrusted::Relative => "relative_path",
            Untrusted::Missing(_) => "missing",
            Untrusted::OwnedByHelper(_) => "owned_by_helper_account",
            Untrusted::Writable(_) => "group_or_world_writable",
            Untrusted::TooManyLinks => "too_many_links",
        }
    }
}

/// Linux's `MAXSYMLINKS`.
const MAX_LINKS: usize = 40;

fn judge(meta: &Meta, path: &Path, own_uid: u32) -> Result<(), Untrusted> {
    if meta.uid == own_uid {
        return Err(Untrusted::OwnedByHelper(path.to_path_buf()));
    }
    if !meta.is_symlink && meta.mode & 0o022 != 0 {
        return Err(Untrusted::Writable(path.to_path_buf()));
    }
    Ok(())
}

/// Checks `path` (absolute) against the trust rule and returns its real path. Every directory
/// from `/` down, the file itself, every symlink met on the way and every component of each
/// link's target must pass: not owned by `own_uid`, and (for files and dirs) no group or world
/// write bit.
pub fn check(fs: &dyn FsView, path: &Path, own_uid: u32) -> Result<PathBuf, Untrusted> {
    if !path.is_absolute() {
        return Err(Untrusted::Relative);
    }
    let root = PathBuf::from("/");
    let meta = fs
        .lstat(&root)
        .ok_or_else(|| Untrusted::Missing(root.clone()))?;
    judge(&meta, &root, own_uid)?;
    // Components still to walk, last first (a link's target is pushed on top).
    let mut pending: Vec<OsString> = Vec::new();
    push_components(&mut pending, path);
    let mut real = root.clone();
    let mut links = 0usize;
    while let Some(name) = pending.pop() {
        if name == "." {
            continue;
        }
        if name == ".." {
            // `real` is already resolved and checked up to here, so its parent is too.
            real.pop();
            continue;
        }
        let next = real.join(&name);
        let meta = fs
            .lstat(&next)
            .ok_or_else(|| Untrusted::Missing(next.clone()))?;
        judge(&meta, &next, own_uid)?;
        if meta.is_symlink {
            links += 1;
            if links > MAX_LINKS {
                return Err(Untrusted::TooManyLinks);
            }
            let target = fs
                .read_link(&next)
                .ok_or_else(|| Untrusted::Missing(next.clone()))?;
            if target.is_absolute() {
                real = root.clone();
            }
            push_components(&mut pending, &target);
            continue;
        }
        real = next;
    }
    Ok(real)
}

fn push_components(pending: &mut Vec<OsString>, path: &Path) {
    let parts: Vec<OsString> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(n) => Some(n.to_os_string()),
            Component::ParentDir => Some(OsString::from("..")),
            Component::CurDir => Some(OsString::from(".")),
            Component::RootDir | Component::Prefix(_) => None,
        })
        .collect();
    pending.extend(parts.into_iter().rev());
}

/// The desktop file XDG lookup would pick for `id`: the first data dir, in order
/// (`$XDG_DATA_HOME` before `$XDG_DATA_DIRS`, see [`app_id::DesktopIndex::default_dirs`]), whose
/// `applications/` holds a file named for the id. Names are compared normalized (case and the
/// `.desktop` suffix), which is stricter than XDG: a look-alike in an earlier dir shadows too.
/// Within one dir the exact name wins, else the first in sorted order.
pub fn resolve_desktop_file(fs: &dyn FsView, dirs: &[PathBuf], id: &str) -> Option<PathBuf> {
    let want = app_id::normalize(id);
    for dir in dirs {
        let apps = dir.join("applications");
        let mut hits: Vec<PathBuf> = fs
            .list(&apps)
            .into_iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|f| f.to_str())
                    .and_then(|f| f.strip_suffix(".desktop"))
                    .is_some_and(|stem| app_id::normalize(stem) == want)
            })
            .collect();
        if hits.is_empty() {
            continue;
        }
        hits.sort();
        let exact = hits
            .iter()
            .position(|p| p.file_name().and_then(|f| f.to_str()) == Some(&format!("{id}.desktop")))
            .unwrap_or(0);
        return Some(hits.swap_remove(exact));
    }
    None
}

/// `policy_denied/untrusted_desktop_entry`: the entry XDG would launch for `id` is one the
/// agent could have written.
pub fn untrusted_entry(id: &str, file: &Path, why: &Untrusted) -> CapError {
    let mut e = CapError::new(
        code::POLICY_DENIED,
        "untrusted_desktop_entry",
        format!(
            "Psyche only opens apps installed system-wide (or through system Flatpak or snap). {id} comes from {}, which is in the owner's own applications folder or another place Psyche cannot vouch for, so the owner must open it.",
            file.display()
        ),
    )
    .detail("app", id)
    .detail("file", file.display().to_string())
    .detail("why", why.why());
    if let Some(p) = why.path() {
        e = e.detail("at", p.display().to_string());
    }
    e
}

/// The desktop file `apps.open` may hand to `gio launch` for `id`: the one XDG lookup picks
/// ([`resolve_desktop_file`]), and only when it is trusted ([`check`]). If an untrusted entry
/// shadows a system one, the launch is refused: the shadowed entry is not launched either.
/// Returns the path as found (its basename is the desktop id GLib reports); every component of
/// it and of any link target has been checked.
pub fn launchable_desktop_file(
    fs: &dyn FsView,
    dirs: &[PathBuf],
    id: &str,
    own_uid: u32,
) -> CapResult<PathBuf> {
    let file = resolve_desktop_file(fs, dirs, id).ok_or_else(|| {
        CapError::new(
            code::NOT_FOUND,
            "app_not_installed",
            format!("{id} has no desktop file"),
        )
    })?;
    check(fs, &file, own_uid).map_err(|why| untrusted_entry(id, &file, &why))?;
    Ok(file)
}

/// The system program dirs, in `PATH` order. Only those that pass [`check`] are used.
pub const SYSTEM_BIN_DIRS: &[&str] = &[
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
    "/snap/bin",
    "/var/lib/flatpak/exports/bin",
];

/// `PATH` for what `apps.open` starts: the trusted system program dirs only. GLib resolves a
/// bare `Exec=` command (and the terminal for `Terminal=true`) through `PATH`, and the session's
/// `PATH` usually starts with `~/.local/bin`, where the agent could plant a `gnome-text-editor`
/// that a trusted entry would then run.
pub fn trusted_search_path(fs: &dyn FsView, own_uid: u32) -> String {
    SYSTEM_BIN_DIRS
        .iter()
        .filter(|d| check(fs, Path::new(d), own_uid).is_ok())
        .copied()
        .collect::<Vec<_>>()
        .join(":")
}

/// The first trusted `name` in the trusted system program dirs (`gio`), never one found
/// through the session's `PATH`.
pub fn trusted_program(fs: &dyn FsView, name: &str, own_uid: u32) -> Option<PathBuf> {
    SYSTEM_BIN_DIRS
        .iter()
        .filter(|d| check(fs, Path::new(d), own_uid).is_ok())
        .map(|d| Path::new(d).join(name))
        .find(|p| check(fs, p, own_uid).is_ok())
}

/// Where the engine reads Settings → Computer use from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsSource {
    /// The Host: `$PSYCHE_HOME/config/computer-use.json`, written by the Gateway.
    File(PathBuf),
    /// The separate desktop's guest: a file baked into the image, used only while it passes the
    /// trust rule (checked on every load).
    Trusted { path: PathBuf, own_uid: u32 },
    /// The built-in defaults: default Ask, no per-app tiers, built-in caps only.
    Defaults,
}

/// The guest's settings file, set by the image (`/etc/psyche/computer-use.json`).
pub const GUEST_SETTINGS_ENV: &str = "PSYCHE_COMPUTER_USE_SETTINGS";

impl SettingsSource {
    /// The Host reads `$PSYCHE_HOME/config/computer-use.json` and ignores
    /// [`GUEST_SETTINGS_ENV`]. The guest never reads `$PSYCHE_HOME` (apps inside the guest run
    /// as the same account and can write it): it reads [`GUEST_SETTINGS_ENV`] when that names
    /// an absolute path, and only while that file is trusted; otherwise the built-in defaults.
    pub fn choose(
        is_guest: bool,
        env: &dyn Fn(&str) -> Option<String>,
        psyche_home: &Path,
        own_uid: u32,
    ) -> SettingsSource {
        if !is_guest {
            return SettingsSource::File(psyche_home.join("config").join("computer-use.json"));
        }
        match env(GUEST_SETTINGS_ENV)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
        {
            Some(path) => SettingsSource::Trusted { path, own_uid },
            None => SettingsSource::Defaults,
        }
    }

    /// Reads the settings through `fs`. A missing, unreadable, malformed or untrusted file gives
    /// the built-in defaults.
    pub fn load_with(&self, fs: &dyn FsView) -> TierSettings {
        let path = match self {
            SettingsSource::Defaults => return TierSettings::default(),
            SettingsSource::File(p) => p,
            SettingsSource::Trusted { path, own_uid } => {
                if check(fs, path, *own_uid).is_err() {
                    return TierSettings::default();
                }
                path
            }
        };
        fs.read(path)
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .map(|v| TierSettings::from_json(&v))
            .unwrap_or_default()
    }

    /// Reads the settings from the real file system.
    pub fn load(&self) -> TierSettings {
        match self {
            SettingsSource::File(p) => TierSettings::load(p),
            #[cfg(unix)]
            other => other.load_with(&RealFs),
            #[cfg(not(unix))]
            _ => TierSettings::default(),
        }
    }
}

/// `lstat` on the real file system.
#[cfg(unix)]
pub struct RealFs;

#[cfg(unix)]
impl FsView for RealFs {
    fn lstat(&self, path: &Path) -> Option<Meta> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(path).ok()?;
        Some(Meta {
            uid: m.uid(),
            mode: m.mode(),
            is_symlink: m.file_type().is_symlink(),
        })
    }

    fn read_link(&self, path: &Path) -> Option<PathBuf> {
        std::fs::read_link(path).ok()
    }

    fn list(&self, dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|rd| rd.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    fn read(&self, path: &Path) -> Option<Vec<u8>> {
        use std::io::Read;
        // Bounded: a settings or desktop file is a few KiB.
        let mut out = Vec::new();
        std::fs::File::open(path)
            .ok()?
            .take(1024 * 1024)
            .read_to_end(&mut out)
            .ok()?;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const ME: u32 = 1000;
    const ROOT: u32 = 0;

    #[derive(Default)]
    struct MapFs {
        nodes: HashMap<PathBuf, (Meta, Option<PathBuf>, Vec<u8>)>,
    }

    impl MapFs {
        /// A tree of root-owned 0755 dirs above `path`, created on demand.
        fn dirs(&mut self, path: &str) -> &mut Self {
            let mut p = PathBuf::from("/");
            self.nodes.entry(p.clone()).or_insert((
                Meta {
                    uid: ROOT,
                    mode: 0o40755,
                    is_symlink: false,
                },
                None,
                vec![],
            ));
            for c in Path::new(path).components().skip(1) {
                p.push(c);
                self.nodes.entry(p.clone()).or_insert((
                    Meta {
                        uid: ROOT,
                        mode: 0o40755,
                        is_symlink: false,
                    },
                    None,
                    vec![],
                ));
            }
            self
        }
        fn set(&mut self, path: &str, uid: u32, mode: u32) -> &mut Self {
            if let Some(parent) = Path::new(path).parent() {
                self.dirs(parent.to_str().unwrap());
            }
            self.nodes.insert(
                PathBuf::from(path),
                (
                    Meta {
                        uid,
                        mode,
                        is_symlink: false,
                    },
                    None,
                    b"{}".to_vec(),
                ),
            );
            self
        }
        fn file(&mut self, path: &str, uid: u32, mode: u32, body: &str) -> &mut Self {
            self.set(path, uid, 0o100000 | mode);
            self.nodes.get_mut(Path::new(path)).unwrap().2 = body.as_bytes().to_vec();
            self
        }
        fn link(&mut self, path: &str, uid: u32, target: &str) -> &mut Self {
            if let Some(parent) = Path::new(path).parent() {
                self.dirs(parent.to_str().unwrap());
            }
            self.nodes.insert(
                PathBuf::from(path),
                (
                    Meta {
                        uid,
                        mode: 0o120777,
                        is_symlink: true,
                    },
                    Some(PathBuf::from(target)),
                    vec![],
                ),
            );
            self
        }
    }

    impl FsView for MapFs {
        fn lstat(&self, path: &Path) -> Option<Meta> {
            self.nodes.get(path).map(|n| n.0)
        }
        fn read_link(&self, path: &Path) -> Option<PathBuf> {
            self.nodes.get(path).and_then(|n| n.1.clone())
        }
        fn list(&self, dir: &Path) -> Vec<PathBuf> {
            self.nodes
                .keys()
                .filter(|p| p.parent() == Some(dir) && p.as_path() != dir)
                .cloned()
                .collect()
        }
        fn read(&self, path: &Path) -> Option<Vec<u8>> {
            self.nodes.get(path).map(|n| n.2.clone())
        }
    }

    fn sys_entry(fs: &mut MapFs, path: &str) {
        fs.file(
            path,
            ROOT,
            0o644,
            "[Desktop Entry]\nType=Application\nExec=x\n",
        );
    }

    #[test]
    fn the_rule_table() {
        let mut fs = MapFs::default();
        // Root-owned 0644 file in root-owned 0755 dirs.
        sys_entry(&mut fs, "/usr/share/applications/org.gnome.Notes.desktop");
        assert_eq!(
            check(
                &fs,
                Path::new("/usr/share/applications/org.gnome.Notes.desktop"),
                ME
            ),
            Ok(PathBuf::from(
                "/usr/share/applications/org.gnome.Notes.desktop"
            ))
        );
        // The file is the helper account's own.
        fs.file("/usr/share/applications/mine.desktop", ME, 0o644, "");
        assert!(matches!(
            check(&fs, Path::new("/usr/share/applications/mine.desktop"), ME),
            Err(Untrusted::OwnedByHelper(_))
        ));
        // A directory on the way is the helper account's own (the home dir).
        fs.set("/home/me", ME, 0o40755);
        sys_entry(&mut fs, "/home/me/.local/share/applications/x.desktop");
        assert_eq!(
            check(
                &fs,
                Path::new("/home/me/.local/share/applications/x.desktop"),
                ME
            ),
            Err(Untrusted::OwnedByHelper(PathBuf::from("/home/me")))
        );
        // Group-writable and world-writable dirs.
        for mode in [0o40775, 0o40777, 0o40757] {
            fs.set("/opt/apps", ROOT, mode);
            sys_entry(&mut fs, "/opt/apps/applications/y.desktop");
            assert_eq!(
                check(&fs, Path::new("/opt/apps/applications/y.desktop"), ME),
                Err(Untrusted::Writable(PathBuf::from("/opt/apps"))),
                "{mode:o}"
            );
        }
        // A sticky world-writable dir (/tmp) does not count either.
        fs.set("/tmp", ROOT, 0o41777);
        sys_entry(&mut fs, "/tmp/share/applications/z.desktop");
        assert_eq!(
            check(&fs, Path::new("/tmp/share/applications/z.desktop"), ME),
            Err(Untrusted::Writable(PathBuf::from("/tmp")))
        );
        // A group- or world-writable file in trusted dirs.
        fs.file("/usr/share/applications/w.desktop", ROOT, 0o664, "");
        assert!(matches!(
            check(&fs, Path::new("/usr/share/applications/w.desktop"), ME),
            Err(Untrusted::Writable(_))
        ));
        // Relative and missing paths.
        assert_eq!(
            check(&fs, Path::new("usr/share/x.desktop"), ME),
            Err(Untrusted::Relative)
        );
        assert!(matches!(
            check(&fs, Path::new("/usr/share/applications/none.desktop"), ME),
            Err(Untrusted::Missing(_))
        ));
    }

    #[test]
    fn symlinks_are_judged_on_the_way_and_at_their_target() {
        let mut fs = MapFs::default();
        fs.set("/home/me", ME, 0o40755);
        fs.file(
            "/home/me/.local/share/applications/evil.desktop",
            ME,
            0o644,
            "",
        );
        // A root-owned link in a system dir pointing into the user's dir.
        fs.link(
            "/usr/share/applications/notes.desktop",
            ROOT,
            "/home/me/.local/share/applications/evil.desktop",
        );
        assert_eq!(
            check(&fs, Path::new("/usr/share/applications/notes.desktop"), ME),
            Err(Untrusted::OwnedByHelper(PathBuf::from("/home/me")))
        );
        // A relative link that climbs into the user's dir.
        fs.link(
            "/usr/share/applications/rel.desktop",
            ROOT,
            "../../../home/me/.local/share/applications/evil.desktop",
        );
        assert!(matches!(
            check(&fs, Path::new("/usr/share/applications/rel.desktop"), ME),
            Err(Untrusted::OwnedByHelper(_))
        ));
        // A link the helper's account owns, even to a trusted target.
        sys_entry(&mut fs, "/usr/share/applications/real.desktop");
        fs.link("/usr/share/applications/mylink.desktop", ME, "real.desktop");
        assert!(matches!(
            check(&fs, Path::new("/usr/share/applications/mylink.desktop"), ME),
            Err(Untrusted::OwnedByHelper(_))
        ));
        // A directory link (Flatpak's exports) into trusted dirs is fine, and the real path is
        // reported.
        sys_entry(
            &mut fs,
            "/var/lib/flatpak/app/org.x.App/current/active/export/share/applications/org.x.App.desktop",
        );
        fs.link(
            "/var/lib/flatpak/exports/share/applications/org.x.App.desktop",
            ROOT,
            "../../../app/org.x.App/current/active/export/share/applications/org.x.App.desktop",
        );
        assert_eq!(
            check(
                &fs,
                Path::new("/var/lib/flatpak/exports/share/applications/org.x.App.desktop"),
                ME
            ),
            Ok(PathBuf::from(
                "/var/lib/flatpak/app/org.x.App/current/active/export/share/applications/org.x.App.desktop"
            ))
        );
        // A link loop.
        fs.link("/usr/share/applications/a.desktop", ROOT, "b.desktop");
        fs.link("/usr/share/applications/b.desktop", ROOT, "a.desktop");
        assert_eq!(
            check(&fs, Path::new("/usr/share/applications/a.desktop"), ME),
            Err(Untrusted::TooManyLinks)
        );
    }

    fn xdg_dirs() -> Vec<PathBuf> {
        crate::app_id::DesktopIndex::default_dirs(&|k| match k {
            "HOME" => Some("/home/me".into()),
            _ => None,
        })
    }

    fn home(fs: &mut MapFs) {
        fs.set("/home/me", ME, 0o40755);
        for d in [
            "/home/me/.local",
            "/home/me/.local/share",
            "/home/me/.local/share/applications",
        ] {
            fs.set(d, ME, 0o40755);
        }
    }

    #[test]
    fn apps_open_launches_system_flatpak_and_snap_entries() {
        let mut fs = MapFs::default();
        home(&mut fs);
        for p in [
            "/usr/share/applications/org.gnome.Notes.desktop",
            "/usr/local/share/applications/local-tool.desktop",
            "/var/lib/flatpak/exports/share/applications/org.mozilla.Thunderbird.desktop",
            "/var/lib/snapd/desktop/applications/thunderbird_thunderbird.desktop",
        ] {
            sys_entry(&mut fs, p);
        }
        let dirs = xdg_dirs();
        for (id, want) in [
            (
                "org.gnome.notes",
                "/usr/share/applications/org.gnome.Notes.desktop",
            ),
            (
                "local-tool",
                "/usr/local/share/applications/local-tool.desktop",
            ),
            (
                "org.mozilla.thunderbird",
                "/var/lib/flatpak/exports/share/applications/org.mozilla.Thunderbird.desktop",
            ),
            (
                "thunderbird_thunderbird",
                "/var/lib/snapd/desktop/applications/thunderbird_thunderbird.desktop",
            ),
        ] {
            assert_eq!(
                launchable_desktop_file(&fs, &dirs, id, ME).unwrap(),
                PathBuf::from(want),
                "{id}"
            );
        }
        let err = launchable_desktop_file(&fs, &dirs, "org.nothing.Here", ME).unwrap_err();
        assert_eq!(err.reason, "app_not_installed");
    }

    #[test]
    fn apps_open_refuses_user_entries_and_user_entries_that_shadow_system_ones() {
        let mut fs = MapFs::default();
        home(&mut fs);
        sys_entry(&mut fs, "/usr/share/applications/org.gnome.Notes.desktop");
        let dirs = xdg_dirs();
        assert!(launchable_desktop_file(&fs, &dirs, "org.gnome.notes", ME).is_ok());
        // The agent writes a same-named entry in ~/.local/share/applications: XDG picks it, so
        // nothing is launched (not the shadowed system entry either).
        fs.file(
            "/home/me/.local/share/applications/org.gnome.Notes.desktop",
            ME,
            0o644,
            "[Desktop Entry]\nType=Application\nExec=sh -c evil\n",
        );
        let err = launchable_desktop_file(&fs, &dirs, "org.gnome.notes", ME).unwrap_err();
        assert_eq!(
            (err.code, err.reason.as_str()),
            (code::POLICY_DENIED, "untrusted_desktop_entry")
        );
        assert!(
            err.message.contains("installed system-wide"),
            "{}",
            err.message
        );
        assert!(
            err.message.contains("owner must open it"),
            "{}",
            err.message
        );
        // A look-alike name (case) shadows too.
        fs.nodes.remove(Path::new(
            "/home/me/.local/share/applications/org.gnome.Notes.desktop",
        ));
        fs.file(
            "/home/me/.local/share/applications/ORG.GNOME.NOTES.desktop",
            ME,
            0o644,
            "",
        );
        assert_eq!(
            launchable_desktop_file(&fs, &dirs, "org.gnome.notes", ME)
                .unwrap_err()
                .reason,
            "untrusted_desktop_entry"
        );
        // A user-only entry, and a user Flatpak export.
        fs.file(
            "/home/me/.local/share/applications/org.example.Mine.desktop",
            ME,
            0o644,
            "",
        );
        fs.file(
            "/home/me/.local/share/flatpak/exports/share/applications/org.example.Pak.desktop",
            ME,
            0o644,
            "",
        );
        for id in ["org.example.mine", "org.example.pak"] {
            assert_eq!(
                launchable_desktop_file(&fs, &dirs, id, ME)
                    .unwrap_err()
                    .reason,
                "untrusted_desktop_entry",
                "{id}"
            );
        }
    }

    #[test]
    fn a_user_writable_dir_smuggled_into_xdg_data_dirs_is_refused() {
        let mut fs = MapFs::default();
        home(&mut fs);
        fs.set("/home/me/share", ME, 0o40755);
        fs.file(
            "/home/me/share/applications/org.gnome.Notes.desktop",
            ME,
            0o644,
            "",
        );
        fs.set("/srv/shared", ROOT, 0o40777);
        fs.file(
            "/srv/shared/applications/org.example.Tool.desktop",
            ROOT,
            0o644,
            "",
        );
        sys_entry(&mut fs, "/usr/share/applications/org.gnome.Notes.desktop");
        let dirs = crate::app_id::DesktopIndex::default_dirs(&|k| match k {
            "HOME" => Some("/home/me".into()),
            "XDG_DATA_DIRS" => Some("/home/me/share:/srv/shared:/usr/share".into()),
            _ => None,
        });
        for id in ["org.gnome.notes", "org.example.tool"] {
            assert_eq!(
                launchable_desktop_file(&fs, &dirs, id, ME)
                    .unwrap_err()
                    .reason,
                "untrusted_desktop_entry",
                "{id}"
            );
        }
    }

    #[test]
    fn programs_and_path_come_from_trusted_system_dirs_only() {
        let mut fs = MapFs::default();
        home(&mut fs);
        fs.dirs("/usr/bin").dirs("/usr/local/bin");
        fs.set("/usr/local/sbin", ROOT, 0o40775);
        fs.link("/bin", ROOT, "usr/bin");
        fs.file("/usr/bin/gio", ROOT, 0o755, "");
        fs.set("/home/me/.local/bin", ME, 0o40755);
        fs.file("/home/me/.local/bin/gio", ME, 0o755, "");
        assert_eq!(trusted_search_path(&fs, ME), "/usr/local/bin:/usr/bin:/bin");
        assert_eq!(
            trusted_program(&fs, "gio", ME),
            Some(PathBuf::from("/usr/bin/gio"))
        );
        // A gio this account could replace is not used, whatever the dir.
        fs.file("/usr/bin/gio", ME, 0o755, "");
        assert_eq!(trusted_program(&fs, "gio", ME), None);
    }

    #[test]
    fn the_guest_reads_only_its_trusted_settings_file() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        let home = Path::new("/tmp/psyche");
        let set = &[(GUEST_SETTINGS_ENV, "/etc/psyche/computer-use.json")];
        // The Host ignores the variable.
        assert_eq!(
            SettingsSource::choose(false, &env(set), home, ME),
            SettingsSource::File(PathBuf::from("/tmp/psyche/config/computer-use.json"))
        );
        assert_eq!(
            SettingsSource::choose(false, &env(&[]), home, ME),
            SettingsSource::File(PathBuf::from("/tmp/psyche/config/computer-use.json"))
        );
        // The guest reads it, and never $PSYCHE_HOME.
        assert_eq!(
            SettingsSource::choose(true, &env(set), home, ME),
            SettingsSource::Trusted {
                path: PathBuf::from("/etc/psyche/computer-use.json"),
                own_uid: ME
            }
        );
        assert_eq!(
            SettingsSource::choose(true, &env(&[]), home, ME),
            SettingsSource::Defaults
        );
        assert_eq!(
            SettingsSource::choose(
                true,
                &env(&[(GUEST_SETTINGS_ENV, "etc/computer-use.json")]),
                home,
                ME
            ),
            SettingsSource::Defaults
        );

        let body = r#"{"version":1,"default":"interact","caps":{"app.zen-browser.zen":"read"}}"#;
        let trusted = SettingsSource::Trusted {
            path: PathBuf::from("/etc/psyche/computer-use.json"),
            own_uid: ME,
        };
        let mut fs = MapFs::default();
        fs.file("/etc/psyche/computer-use.json", ROOT, 0o644, body);
        let s = trusted.load_with(&fs);
        assert_eq!(s.default_value, crate::tiers::SettingValue::Interact);
        assert_eq!(
            s.file_cap(Some("app.zen-browser.zen")),
            crate::tiers::Tier::Read
        );
        // Owned by the guest's account, or in a writable dir: the built-in defaults.
        for (dir_uid, dir_mode, file_uid, file_mode) in [
            (ROOT, 0o40755, ME, 0o644),
            (ROOT, 0o40755, ROOT, 0o666),
            (ME, 0o40755, ROOT, 0o644),
            (ROOT, 0o41777, ROOT, 0o644),
        ] {
            let mut fs = MapFs::default();
            fs.set("/etc/psyche", dir_uid, dir_mode);
            fs.file("/etc/psyche/computer-use.json", file_uid, file_mode, body);
            assert_eq!(
                trusted.load_with(&fs),
                TierSettings::default(),
                "{dir_uid} {dir_mode:o} {file_uid} {file_mode:o}"
            );
        }
        assert_eq!(
            SettingsSource::Defaults.load_with(&fs),
            TierSettings::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_files_the_test_account_wrote_are_not_trusted() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("computer-use.json");
        std::fs::write(&file, r#"{"version":1,"default":"interact"}"#).unwrap();
        let me = std::fs::metadata(&file).unwrap().uid();
        // Owned by this account somewhere on the way (macOS), or under a world-writable /tmp
        // (Linux): either way not trusted.
        assert!(check(&RealFs, &file, me).is_err());
        let src = SettingsSource::Trusted {
            path: file.clone(),
            own_uid: me,
        };
        assert_eq!(src.load(), TierSettings::default());
        // The Host's own file is read as before.
        assert_eq!(
            SettingsSource::File(file).load().default_value,
            crate::tiers::SettingValue::Interact
        );
        // `/` itself is someone else's (root) and not writable.
        if me != 0 {
            assert_eq!(check(&RealFs, Path::new("/"), me), Ok(PathBuf::from("/")));
        }
    }
}
