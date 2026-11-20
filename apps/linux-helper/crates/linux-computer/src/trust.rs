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
//! - `apps.open` of a `DBusActivatable` entry: the session bus service (and systemd user unit)
//!   that would start it must be trusted too ([`check_dbus_activation`]);
//! - `apps.open` of a `Terminal=true` entry: an empty private config, cache and data dir and
//!   the trusted data and config dirs only ([`launch_env`], [`terminal_dirs`]), so
//!   `xdg-terminal-exec` reads nothing the agent wrote;
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
    /// `(st_dev, st_ino)` of the directory `path` names, symlinks followed; `None` when it is
    /// not a directory or cannot be examined.
    fn dir_id(&self, path: &Path) -> Option<(u64, u64)>;
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

/// The environment `apps.open` gives `gio launch`, which the app inherits when GLib spawns it:
/// the trusted `PATH` ([`trusted_search_path`]) and the switches that make Qt, GTK and Firefox
/// export their accessibility trees.
///
/// For a `Terminal=true` entry (`terminal` is a fresh dir from [`private_launch_dir_ok`] and the
/// dirs from [`terminal_dirs`]) also an empty `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
/// `XDG_DATA_HOME`, and `XDG_DATA_DIRS` and `XDG_CONFIG_DIRS` cut down to the trusted entries
/// (round-4 review, finding 2; Linux run, failure 1294-2; round 8, findings 1 and 2). GLib 2.80
/// and later start such entries through `xdg-terminal-exec`, which reads
/// `<desktop>-xdg-terminals.list` from `$XDG_CONFIG_HOME` and `$XDG_CONFIG_DIRS`, replays a
/// command cached under `$XDG_CACHE_HOME/xdg-terminal-exec`, and with no list runs the first
/// terminal entry it finds in `$XDG_DATA_HOME` and then `$XDG_DATA_DIRS`. The agent could write
/// all of these in the real home. The terminal and the program in it inherit the empty dirs, so
/// they start with fresh config, cache and data (dconf-backed settings read their defaults);
/// terminal entries are capped at click anyway. Other launches keep the owner's dirs: the app
/// would inherit them too, and an app that keeps its settings under `~/.config` would start as
/// if newly installed.
pub fn launch_env(
    search_path: &str,
    terminal: Option<(&Path, &TerminalDirs)>,
) -> Vec<(&'static str, OsString)> {
    let mut env: Vec<(&'static str, OsString)> = vec![
        ("PATH", search_path.into()),
        ("ACCESSIBILITY_ENABLED", "1".into()),
        ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".into()),
        ("GNOME_ACCESSIBILITY", "1".into()),
    ];
    if let Some((dir, dirs)) = terminal {
        env.push(("XDG_CONFIG_HOME", dir.join("config").into_os_string()));
        env.push(("XDG_CACHE_HOME", dir.join("cache").into_os_string()));
        env.push(("XDG_DATA_HOME", dir.join("data").into_os_string()));
        env.push(("XDG_DATA_DIRS", dirs.data_dirs.as_str().into()));
        env.push(("XDG_CONFIG_DIRS", dirs.config_dirs.as_str().into()));
    }
    env
}

/// The shared dirs a `Terminal=true` launch reads ([`terminal_dirs`]), `:`-joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalDirs {
    pub data_dirs: String,
    pub config_dirs: String,
}

/// The fallback lists newer `xdg-terminal-exec` reads whatever `$XDG_DATA_DIRS` says.
const XDG_TERMINAL_EXEC_SYSTEM_DIRS: &[&str] = &[
    "/usr/local/share/xdg-terminal-exec",
    "/usr/share/xdg-terminal-exec",
];

/// The `XDG_DATA_DIRS` and `XDG_CONFIG_DIRS` a `Terminal=true` launch gets ([`launch_env`]):
/// the session's entries (else the spec's `/usr/local/share:/usr/share` and `/etc/xdg`) that pass
/// [`check`], in order. An entry this account could write is dropped rather than vetted, because
/// the agent could add a terminal entry to it after the check.
///
/// `xdg-terminal-exec` reads terminal entries from different places by version: Ubuntu 24.04's
/// (2023) from `<data dir>/xdg-terminals/`, upstream's from `<data dir>/applications/` (entries
/// in the `TerminalEmulator` category) with fallback lists in `<data dir>/xdg-terminal-exec/`
/// and `/usr/{local/,}share/xdg-terminal-exec/`. So the launch is refused
/// (`policy_denied/untrusted_terminal_choice`) when any of these fails [`check`]:
/// - a kept data dir's `xdg-terminals/` or `xdg-terminal-exec/`, or a file in it;
/// - `/usr/local/share/xdg-terminal-exec/` or `/usr/share/xdg-terminal-exec/`, or a file in it;
/// - a subdir or `.desktop` entry of a kept data dir's `applications/`, at any depth and through
///   symlinked subdirs (upstream walks it with `find -L`), whatever its category: a file this
///   account owns could gain `TerminalEmulator` after the check. A walk past
///   [`VET_MAX_ENTRIES`] entries is refused too;
/// - an `*xdg-terminals.list` in a kept config dir.
///
/// A data dir whose `applications/` itself fails [`check`] is dropped. Also refused when no data
/// dir or no config dir is left.
pub fn terminal_dirs(
    fs: &dyn FsView,
    env: &dyn Fn(&str) -> Option<String>,
    id: &str,
    own_uid: u32,
) -> CapResult<TerminalDirs> {
    let trusted = |p: &Path| check(fs, p, own_uid).is_ok();
    let refuse = |at: &Path| Err(untrusted_terminal(id, Some(at)));
    // `/etc/xdg` missing under a trusted `/etc`: only root could create it, so it stays the
    // config dir rather than leaving none (a box without it would refuse every terminal).
    let root_only_absent = |p: &Path| {
        p == Path::new("/etc/xdg") && fs.lstat(p).is_none() && trusted(Path::new("/etc"))
    };
    let kept = |var: &str, default: &str| -> Vec<PathBuf> {
        let session = env(var)
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default.into());
        let mut keep: Vec<PathBuf> = Vec::new();
        for dir in session
            .split(':')
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
        {
            if !keep.contains(&dir) && (trusted(&dir) || root_only_absent(&dir)) {
                keep.push(dir);
            }
        }
        keep
    };
    let joined = |dirs: &[PathBuf]| {
        dirs.iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(":")
    };

    let mut data: Vec<PathBuf> = Vec::new();
    for dir in kept("XDG_DATA_DIRS", "/usr/local/share:/usr/share") {
        for list in ["xdg-terminals", "xdg-terminal-exec"] {
            if let Err(bad) = vet_dir(fs, &dir.join(list), own_uid, false, &|_| true) {
                return refuse(&bad);
            }
        }
        let apps = dir.join("applications");
        if fs.lstat(&apps).is_some() && !trusted(&apps) {
            continue;
        }
        let entry = |p: &Path| {
            p.extension().is_some_and(|e| e == "desktop")
                || fs
                    .lstat(p)
                    .is_some_and(|m| m.mode & 0o170000 == 0o040000 || m.is_symlink)
        };
        if let Err(bad) = vet_dir(fs, &apps, own_uid, true, &entry) {
            return refuse(&bad);
        }
        data.push(dir);
    }
    for dir in XDG_TERMINAL_EXEC_SYSTEM_DIRS {
        if let Err(bad) = vet_dir(fs, Path::new(dir), own_uid, false, &|_| true) {
            return refuse(&bad);
        }
    }
    let config = kept("XDG_CONFIG_DIRS", "/etc/xdg");
    for dir in &config {
        if let Some(bad) = fs.list(dir).into_iter().find(|f| {
            f.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with("xdg-terminals.list"))
                && !trusted(f)
        }) {
            return refuse(&bad);
        }
    }
    if data.is_empty() || config.is_empty() {
        return Err(untrusted_terminal(id, None));
    }
    Ok(TerminalDirs {
        data_dirs: joined(&data),
        config_dirs: joined(&config),
    })
}

/// How many entries one [`vet_dir`] walk lists before it gives up (and the launch is refused).
pub const VET_MAX_ENTRIES: usize = 5_000;

/// Whether `dir` (when it exists) and every entry `relevant` picks in it pass [`check`]; the
/// first that fails otherwise. With `recurse`, subdirs are walked at any depth and symlinked ones
/// followed, each directory once (by `(st_dev, st_ino)`, so a link loop ends), like `find -L`.
/// A walk that lists more than [`VET_MAX_ENTRIES`] entries fails at `dir`: what it did not see
/// could be planted.
fn vet_dir(
    fs: &dyn FsView,
    dir: &Path,
    own_uid: u32,
    recurse: bool,
    relevant: &dyn Fn(&Path) -> bool,
) -> Result<(), PathBuf> {
    if fs.lstat(dir).is_none() {
        return Ok(());
    }
    if check(fs, dir, own_uid).is_err() {
        return Err(dir.to_path_buf());
    }
    let mut seen: std::collections::HashSet<(u64, u64)> = std::collections::HashSet::new();
    if let Some(id) = fs.dir_id(dir) {
        seen.insert(id);
    }
    let mut pending = vec![dir.to_path_buf()];
    let mut listed = 0usize;
    while let Some(d) = pending.pop() {
        for e in fs.list(&d) {
            listed += 1;
            if listed > VET_MAX_ENTRIES {
                return Err(dir.to_path_buf());
            }
            if !relevant(&e) {
                continue;
            }
            if check(fs, &e, own_uid).is_err() {
                return Err(e);
            }
            if recurse {
                if let Some(id) = fs.dir_id(&e) {
                    if seen.insert(id) {
                        pending.push(e);
                    }
                }
            }
        }
    }
    Ok(())
}

/// `policy_denied/untrusted_terminal_choice`.
fn untrusted_terminal(id: &str, at: Option<&Path>) -> CapError {
    let mut e = CapError::new(
        code::POLICY_DENIED,
        "untrusted_terminal_choice",
        format!(
            "{id} runs in a terminal, and the terminal it would open in could be one Psyche cannot vouch for, so the owner must open it."
        ),
    )
    .detail("app", id);
    if let Some(p) = at {
        e = e.detail("at", p.display().to_string());
    }
    e
}

/// `$XDG_RUNTIME_DIR`, else `/run/user/<uid>` (where systemd puts it).
fn runtime_dir(env: &dyn Fn(&str) -> Option<String>, own_uid: u32) -> PathBuf {
    env("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{own_uid}")))
}

/// Where the private dirs of terminal launches go: `<runtime dir>/psyche-helper` (per user,
/// cleared at logout), or `/tmp/psyche-helper-<uid>` when there is no runtime dir. Each launch
/// gets its own fresh subdir; [`private_launch_dir_ok`] vets it before gio runs.
pub fn private_launch_root(
    fs: &dyn FsView,
    env: &dyn Fn(&str) -> Option<String>,
    own_uid: u32,
) -> PathBuf {
    let run = runtime_dir(env, own_uid);
    if run.is_absolute() && fs.lstat(&run).is_some() {
        run.join("psyche-helper")
    } else {
        PathBuf::from(format!("/tmp/psyche-helper-{own_uid}"))
    }
}

/// A dir only this account can use: a real dir (not a symlink), owned by `own_uid`, no group or
/// world bits.
fn private_dir_meta_ok(meta: &Meta, own_uid: u32) -> bool {
    !meta.is_symlink
        && meta.mode & 0o170000 == 0o040000
        && meta.uid == own_uid
        && meta.mode & 0o077 == 0
}

/// Whether `dir` is a launch dir as the helper just made it: it and its parent (the
/// [`private_launch_root`]) are private dirs of this account, and it holds exactly the empty
/// private dirs `cache`, `config` and `data`. Anything else (a planted symlink, a shared mode, files
/// already inside) and the terminal launch is refused.
pub fn private_launch_dir_ok(fs: &dyn FsView, dir: &Path, own_uid: u32) -> bool {
    let ok = |p: &Path| {
        fs.lstat(p)
            .is_some_and(|m| private_dir_meta_ok(&m, own_uid))
    };
    let Some(parent) = dir.parent() else {
        return false;
    };
    if !dir.is_absolute() || !ok(parent) || !ok(dir) {
        return false;
    }
    let mut names: Vec<String> = fs
        .list(dir)
        .iter()
        .filter_map(|p| p.file_name().map(|f| f.to_string_lossy().into_owned()))
        .collect();
    names.sort();
    names == ["cache", "config", "data"]
        && names.iter().all(|n| {
            let p = dir.join(n);
            ok(&p) && fs.list(&p).is_empty()
        })
}

/// Whether `name` is a well-known D-Bus name (GLib's `g_dbus_is_name`, not a unique `:1.2`
/// name): two or more dot-separated elements of `[A-Za-z0-9_-]`, none empty or starting with a
/// digit, at most 255 bytes. GLib only D-Bus-activates a `DBusActivatable` entry whose basename
/// is one; otherwise it runs `Exec=`.
pub fn is_bus_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && !p.as_bytes()[0].is_ascii_digit()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

/// The session bus's service dirs, in its search order: `$XDG_RUNTIME_DIR/dbus-1/services`,
/// then `dbus-1/services` under `$XDG_DATA_HOME` and each `$XDG_DATA_DIRS` entry (with the
/// Flatpak and snap export dirs sessions add there, as in
/// [`app_id::DesktopIndex::default_dirs`]), then the built-in `/usr/local/share` and
/// `/usr/share` ones.
pub fn dbus_service_dirs(env: &dyn Fn(&str) -> Option<String>, own_uid: u32) -> Vec<PathBuf> {
    let mut dirs = vec![runtime_dir(env, own_uid).join("dbus-1/services")];
    dirs.extend(
        app_id::DesktopIndex::default_dirs(env)
            .into_iter()
            .map(|d| d.join("dbus-1/services")),
    );
    dirs.push(PathBuf::from("/usr/local/share/dbus-1/services"));
    dirs.push(PathBuf::from("/usr/share/dbus-1/services"));
    dedup(dirs)
}

/// The systemd user manager's unit search path (`systemd.unit(5)`, user mode), in order.
pub fn systemd_user_unit_dirs(env: &dyn Fn(&str) -> Option<String>, own_uid: u32) -> Vec<PathBuf> {
    let home = env("HOME").unwrap_or_default();
    let config_home =
        PathBuf::from(env("XDG_CONFIG_HOME").unwrap_or_else(|| format!("{home}/.config")));
    let data_home =
        PathBuf::from(env("XDG_DATA_HOME").unwrap_or_else(|| format!("{home}/.local/share")));
    let split = |v: String| -> Vec<PathBuf> {
        v.split(':')
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .collect()
    };
    let config_dirs = split(env("XDG_CONFIG_DIRS").unwrap_or_else(|| "/etc/xdg".into()));
    let data_dirs =
        split(env("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into()));
    let run = runtime_dir(env, own_uid).join("systemd");
    let mut dirs = vec![
        config_home.join("systemd/user.control"),
        run.join("user.control"),
        run.join("transient"),
        run.join("generator.early"),
        config_home.join("systemd/user"),
    ];
    dirs.extend(config_dirs.iter().map(|d| d.join("systemd/user")));
    dirs.push(PathBuf::from("/etc/systemd/user"));
    dirs.push(run.join("user"));
    dirs.push(PathBuf::from("/run/systemd/user"));
    dirs.push(run.join("generator"));
    dirs.push(data_home.join("systemd/user"));
    dirs.extend(data_dirs.iter().map(|d| d.join("systemd/user")));
    dirs.push(PathBuf::from("/usr/local/lib/systemd/user"));
    dirs.push(PathBuf::from("/usr/lib/systemd/user"));
    dirs.push(run.join("generator.late"));
    dedup(dirs)
}

fn dedup(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

/// `Name=` and `SystemdService=` from a D-Bus service file's `[D-BUS Service]` group.
fn dbus_service_keys(text: &str) -> (Option<String>, Option<String>) {
    let (mut name, mut unit) = (None, None);
    let mut in_main = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[D-BUS Service]";
            continue;
        }
        if !in_main || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim().to_string();
            match k.trim() {
                "Name" => name = Some(v),
                "SystemdService" => unit = Some(v).filter(|u| !u.is_empty()),
                _ => {}
            }
        }
    }
    (name, unit)
}

const UNIT_KINDS: &[&str] = &[
    "service",
    "socket",
    "target",
    "timer",
    "path",
    "mount",
    "automount",
    "swap",
    "slice",
    "scope",
    "device",
];

/// Whether an entry named `entry` in a unit dir changes what starting `unit` runs: the unit
/// file itself (or an alias of that name), its template (`foo@.service` for `foo@x.service`),
/// any `<unit>.d`, `.wants`, `.requires` or `.upholds` dir, a prefix drop-in dir
/// (`org-gnome-.service.d`) or the drop-in dir for every unit of its type (`service.d`).
fn unit_entry_affects(unit: &str, entry: &str) -> bool {
    let (stem, kind) = match unit.rsplit_once('.') {
        Some((s, k)) if UNIT_KINDS.contains(&k) => (s, k),
        _ => (unit, "service"),
    };
    let mut names = vec![unit.to_string(), format!("{stem}.{kind}")];
    if let Some((pre, _)) = stem.split_once('@') {
        names.push(format!("{pre}@.{kind}"));
    }
    if names.iter().any(|n| {
        entry == n
            || entry
                .strip_prefix(n.as_str())
                .is_some_and(|rest| rest.starts_with('.'))
    }) {
        return true;
    }
    if entry == format!("{kind}.d") {
        return true;
    }
    stem.char_indices()
        .any(|(i, c)| c == '-' && entry == format!("{}.{kind}.d", &stem[..=i]))
}

/// `Alias=` names from a unit file's `[Install]` group (space-separated, an empty assignment
/// clears the list, as systemd reads it).
fn install_aliases(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_install = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_install = line == "[Install]";
            continue;
        }
        if !in_install || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == "Alias" {
                if v.trim().is_empty() {
                    out.clear();
                }
                out.extend(v.split_whitespace().map(String::from));
            }
        }
    }
    out
}

/// `path` with `.` and `..` folded away, without touching the file system.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// How many alias symlinks [`systemd_unit_names`] follows.
const MAX_ALIAS_HOPS: usize = 8;

/// Every name systemd knows `unit` by, for the drop-in scan (round-5 review, finding 5.2): the
/// name itself, the target name of each alias symlink followed from the first trusted unit dir
/// that holds it, and the `[Install] Alias=` names of the real unit file. `trusted[i]` says
/// whether `dirs[i]` passes [`check`]. A unit in no trusted dir is left to the scan of the
/// untrusted ones. Refused: an alias that points outside the trusted unit dirs (into a user dir,
/// at `/dev/null`, at a linked unit elsewhere), is this account's, or does not end within
/// [`MAX_ALIAS_HOPS`]; and a real unit file in a trusted dir that fails [`check`].
fn systemd_unit_names(
    fs: &dyn FsView,
    dirs: &[PathBuf],
    trusted: &[bool],
    unit: &str,
    own_uid: u32,
) -> Result<Vec<String>, (PathBuf, &'static str)> {
    let mut names = vec![unit.to_string()];
    let trusted_dirs: Vec<PathBuf> = dirs
        .iter()
        .zip(trusted)
        .filter(|(_, t)| **t)
        .map(|(d, _)| lexical(d))
        .collect();
    let Some(mut entry) = trusted_dirs
        .iter()
        .map(|d| d.join(unit))
        .find(|e| fs.lstat(e).is_some())
    else {
        return Ok(names);
    };
    for _ in 0..=MAX_ALIAS_HOPS {
        let Some(meta) = fs.lstat(&entry) else {
            // A dangling alias: nothing to load from the trusted dirs, and the target's name is
            // in `names` for the scan of the untrusted ones.
            return Ok(names);
        };
        if !meta.is_symlink {
            if check(fs, &entry, own_uid).is_err() {
                return Err((entry, "untrusted_systemd_unit"));
            }
            let aliases = fs
                .read(&entry)
                .map(|b| install_aliases(&String::from_utf8_lossy(&b)))
                .unwrap_or_default();
            for a in aliases {
                if !names.contains(&a) {
                    names.push(a);
                }
            }
            return Ok(names);
        }
        let parent = entry.parent().map(Path::to_path_buf).unwrap_or_default();
        let target = (meta.uid != own_uid)
            .then(|| fs.read_link(&entry))
            .flatten()
            .map(|t| lexical(&parent.join(t)));
        let next = target.as_ref().and_then(|t| {
            let in_trusted = t
                .parent()
                .is_some_and(|p| trusted_dirs.iter().any(|d| d == p));
            let name = t.file_name()?.to_str()?.to_string();
            in_trusted.then_some(name)
        });
        let (Some(target), Some(next)) = (target, next) else {
            return Err((entry, "untrusted_systemd_alias"));
        };
        if !names.contains(&next) {
            names.push(next);
        }
        entry = target;
    }
    Err((entry, "untrusted_systemd_alias"))
}

/// `policy_denied/untrusted_dbus_activation`.
fn untrusted_dbus(id: &str, name: &str, at: Option<&Path>, why: &'static str) -> CapError {
    let message = if at.is_none() {
        format!(
            "{id} starts through D-Bus as {name}, and Psyche found no service file for it installed system-wide. A service file Psyche cannot vouch for could take its place, so the owner must open it."
        )
    } else {
        format!(
            "{id} starts through D-Bus as {name}, and a service file Psyche cannot vouch for could take its place, so the owner must open it."
        )
    };
    let mut e = CapError::new(code::POLICY_DENIED, "untrusted_dbus_activation", message)
        .detail("app", id)
        .detail("busName", name)
        .detail("why", why);
    if let Some(p) = at {
        e = e.detail("at", p.display().to_string());
    }
    e
}

/// The D-Bus side of `apps.open` (round-4 review, finding 3; round 5, finding 5). For a
/// `DBusActivatable=true` entry GLib skips `Exec=` and activates the bus name `file`'s basename
/// gives; the session bus then runs the first service file, in its dir order, whose `Name=` is
/// that name (whatever the file is called), and with `SystemdService=` a systemd user unit.
/// `file` and `contents` are the trusted desktop file [`launchable_desktop_file`] picked. The
/// launch is allowed only when:
/// - the first service dir that passes [`check`] and holds a `.service` file with
///   `Name=<name>` holds exactly one (several are `ambiguous_service_files`: the bus takes
///   whichever it reads first), and that file passes [`check`];
/// - no service dir that fails [`check`] (`$XDG_RUNTIME_DIR`, `$XDG_DATA_HOME`, an untrusted
///   `$XDG_DATA_DIRS` entry, user Flatpak exports) holds a `<name>.service` or any `.service`
///   file whose `Name=` is `<name>`; nor does a trusted dir hold such a file that fails
///   [`check`];
/// - with `SystemdService=<unit>` on the winning file, the unit's aliases resolve within the
///   trusted unit dirs ([`systemd_unit_names`]), and no unit dir that fails [`check`] holds,
///   for the unit or any of its names, the unit, its template, or a drop-in or dependency dir
///   for it ([`unit_entry_affects`]), nor a symlink that makes another name an alias of it.
///
/// Not checked: entries that are not `DBusActivatable`, and basenames that are not bus names
/// (GLib runs `Exec=` for both).
pub fn check_dbus_activation(
    fs: &dyn FsView,
    env: &dyn Fn(&str) -> Option<String>,
    id: &str,
    file: &Path,
    contents: &str,
    own_uid: u32,
) -> CapResult<()> {
    if !app_id::desktop_entry_dbus_activatable(contents) {
        return Ok(());
    }
    let Some(name) = file
        .file_name()
        .and_then(|f| f.to_str())
        .and_then(|f| f.strip_suffix(".desktop"))
        .filter(|n| is_bus_name(n))
    else {
        return Ok(());
    };
    let want = format!("{name}.service");
    let keys = |f: &Path| {
        fs.read(f)
            .map(|b| dbus_service_keys(&String::from_utf8_lossy(&b)))
            .unwrap_or_default()
    };
    // The `SystemdService=` of the trusted service file the bus would use.
    let mut provider: Option<Option<String>> = None;
    for dir in dbus_service_dirs(env, own_uid) {
        let dir_trusted = check(fs, &dir, own_uid).is_ok();
        let mut files = fs.list(&dir);
        files.sort();
        let mut claims: Vec<(PathBuf, Option<String>)> = Vec::new();
        for f in files {
            let Some(fname) = f.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            if !fname.ends_with(".service") {
                continue;
            }
            let by_file_name = fname == want;
            if !dir_trusted {
                if by_file_name || keys(&f).0.as_deref() == Some(name) {
                    return Err(untrusted_dbus(id, name, Some(&f), "user_service_file"));
                }
                continue;
            }
            let (svc_name, unit) = keys(&f);
            let claims_it = svc_name.as_deref() == Some(name);
            if (by_file_name || claims_it) && check(fs, &f, own_uid).is_err() {
                return Err(untrusted_dbus(id, name, Some(&f), "untrusted_service_file"));
            }
            if claims_it {
                claims.push((f, unit));
            }
        }
        if provider.is_none() {
            if let Some((second, _)) = claims.get(1) {
                return Err(untrusted_dbus(
                    id,
                    name,
                    Some(second),
                    "ambiguous_service_files",
                ));
            }
            provider = claims.pop().map(|(_, unit)| unit);
        }
    }
    let Some(unit) = provider else {
        return Err(untrusted_dbus(id, name, None, "no_system_service"));
    };
    if let Some(unit) = unit {
        let dirs = systemd_user_unit_dirs(env, own_uid);
        let trusted: Vec<bool> = dirs.iter().map(|d| check(fs, d, own_uid).is_ok()).collect();
        let names = systemd_unit_names(fs, &dirs, &trusted, &unit, own_uid)
            .map_err(|(at, why)| untrusted_dbus(id, name, Some(&at), why))?;
        for (dir, _) in dirs.iter().zip(&trusted).filter(|(_, t)| !**t) {
            for e in fs.list(dir) {
                let Some(f) = e.file_name().and_then(|f| f.to_str()) else {
                    continue;
                };
                // A user symlink naming one of the unit's names makes its own name an alias.
                let aliases_it = fs.lstat(&e).is_some_and(|m| m.is_symlink)
                    && fs
                        .read_link(&e)
                        .and_then(|t| t.file_name().and_then(|x| x.to_str()).map(String::from))
                        .is_some_and(|t| names.contains(&t));
                if aliases_it || names.iter().any(|n| unit_entry_affects(n, f)) {
                    return Err(untrusted_dbus(id, name, Some(&e), "user_systemd_unit"));
                }
            }
        }
    }
    Ok(())
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

    fn dir_id(&self, path: &Path) -> Option<(u64, u64)> {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::metadata(path).ok()?;
        m.is_dir().then(|| (m.dev(), m.ino()))
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

    impl MapFs {
        /// `path` with every symlink resolved (at most 40), `None` when a component is missing.
        fn resolve(&self, path: &Path) -> Option<PathBuf> {
            let mut pending: Vec<OsString> = Vec::new();
            push_components(&mut pending, path);
            let mut real = PathBuf::from("/");
            let mut links = 0;
            while let Some(c) = pending.pop() {
                if c == "." {
                    continue;
                }
                if c == ".." {
                    real.pop();
                    continue;
                }
                let next = real.join(&c);
                let node = self.nodes.get(&next)?;
                if node.0.is_symlink {
                    links += 1;
                    if links > 40 {
                        return None;
                    }
                    let target = node.1.clone()?;
                    if target.is_absolute() {
                        real = PathBuf::from("/");
                    }
                    push_components(&mut pending, &target);
                    continue;
                }
                real = next;
            }
            Some(real)
        }
    }

    impl FsView for MapFs {
        fn lstat(&self, path: &Path) -> Option<Meta> {
            self.nodes.get(path).map(|n| n.0)
        }
        fn read_link(&self, path: &Path) -> Option<PathBuf> {
            self.nodes.get(path).and_then(|n| n.1.clone())
        }
        /// Like `read_dir`: a symlinked dir lists its target's entries under its own path.
        fn list(&self, dir: &Path) -> Vec<PathBuf> {
            let Some(real) = self.resolve(dir) else {
                return Vec::new();
            };
            self.nodes
                .keys()
                .filter(|p| p.parent() == Some(real.as_path()) && **p != real)
                .filter_map(|p| p.file_name().map(|n| dir.join(n)))
                .collect()
        }
        fn dir_id(&self, path: &Path) -> Option<(u64, u64)> {
            use std::hash::{Hash, Hasher};
            let real = self.resolve(path)?;
            let node = self.nodes.get(&real)?;
            if node.0.mode & 0o170000 != 0o040000 {
                return None;
            }
            let mut h = std::collections::hash_map::DefaultHasher::new();
            real.hash(&mut h);
            Some((0, h.finish()))
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
    fn terminal_launches_get_empty_private_dirs_and_the_trusted_data_dirs() {
        let names = |env: &[(&'static str, OsString)]| -> Vec<&'static str> {
            env.iter().map(|(k, _)| *k).collect()
        };
        let plain = launch_env("/usr/bin:/bin", None);
        assert_eq!(
            names(&plain),
            [
                "PATH",
                "ACCESSIBILITY_ENABLED",
                "QT_LINUX_ACCESSIBILITY_ALWAYS_ON",
                "GNOME_ACCESSIBILITY"
            ]
        );
        assert_eq!(plain[0].1, OsString::from("/usr/bin:/bin"));
        let dir = Path::new("/run/user/1000/psyche-helper/terminal-1");
        let dirs = TerminalDirs {
            data_dirs: "/usr/share".into(),
            config_dirs: "/etc/xdg".into(),
        };
        let term = launch_env("/usr/bin", Some((dir, &dirs)));
        let get = |k: &str| term.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
        assert_eq!(
            get("XDG_CONFIG_HOME"),
            Some(OsString::from(
                "/run/user/1000/psyche-helper/terminal-1/config"
            ))
        );
        assert_eq!(
            get("XDG_CACHE_HOME"),
            Some(OsString::from(
                "/run/user/1000/psyche-helper/terminal-1/cache"
            ))
        );
        assert_eq!(
            get("XDG_DATA_HOME"),
            Some(OsString::from(
                "/run/user/1000/psyche-helper/terminal-1/data"
            ))
        );
        assert_eq!(get("XDG_DATA_DIRS"), Some(OsString::from("/usr/share")));
        assert_eq!(get("XDG_CONFIG_DIRS"), Some(OsString::from("/etc/xdg")));
        assert_eq!(get("PATH"), Some(OsString::from("/usr/bin")));
        // Other launches keep the owner's config, cache and data dirs.
        let plain_get = |k: &str| plain.iter().any(|(n, _)| *n == k);
        assert!(![
            "XDG_CONFIG_HOME",
            "XDG_CACHE_HOME",
            "XDG_DATA_HOME",
            "XDG_DATA_DIRS",
            "XDG_CONFIG_DIRS"
        ]
        .iter()
        .any(|k| plain_get(k)));
    }

    /// Linux run, failure 1294-2, and round 8, findings 1 and 2: a terminal launch reads only
    /// trusted data and config dirs (its own homes are private) and refuses an untrusted terminal
    /// entry or list in them, wherever an `xdg-terminal-exec` version looks.
    #[test]
    fn terminal_dirs_table() {
        let base = || {
            let mut fs = MapFs::default();
            fs.dirs("/usr/share/applications");
            fs.file("/usr/share/applications/xterm.desktop", ROOT, 0o644, "x");
            fs.dirs("/usr/local/share");
            fs.dirs("/etc/xdg");
            fs.set("/home/me", ME, 0o40700);
            fs.set("/home/me/.config", ME, 0o40700);
            fs.set("/home/me/.config/kdedefaults", ME, 0o40700);
            fs.set("/home/me/.local", ME, 0o40700);
            fs.set("/home/me/.local/share", ME, 0o40700);
            fs.set("/home/me/.local/share/flatpak", ME, 0o40755);
            fs.set("/home/me/.local/share/flatpak/exports", ME, 0o40755);
            fs.set("/home/me/.local/share/flatpak/exports/share", ME, 0o40755);
            fs.set("/srv/shared", ROOT, 0o40777);
            fs
        };
        let run = |fs: &MapFs, data: Option<&'static str>, config: Option<&'static str>| {
            let env = move |k: &str| match k {
                "HOME" => Some("/home/me".to_string()),
                "XDG_DATA_HOME" => Some("/home/me/.local/share".to_string()),
                "XDG_DATA_DIRS" => data.map(String::from),
                "XDG_CONFIG_DIRS" => config.map(String::from),
                _ => None,
            };
            match terminal_dirs(fs, &env, "psyche.test.Term", ME) {
                Ok(d) => format!("ok {} | {}", d.data_dirs, d.config_dirs),
                Err(e) => format!("{} {}", e.code, e.reason),
            }
        };
        const OK: &str = "ok /usr/local/share:/usr/share | /etc/xdg";
        const REFUSED: &str = "policy_denied untrusted_terminal_choice";
        let session = Some(
            "/home/me/.local/share/flatpak/exports/share:/srv/shared:/usr/local/share:/usr/share:/usr/share",
        );
        // Untrusted entries are dropped (never vetted, so nothing planted later is read),
        // duplicates once, order kept; unset or empty means the spec's defaults.
        assert_eq!(run(&base(), session, None), OK);
        assert_eq!(run(&base(), None, None), OK);
        assert_eq!(run(&base(), Some(""), Some("")), OK);
        assert_eq!(
            run(&base(), Some("relative/share:/usr/share"), None),
            "ok /usr/share | /etc/xdg"
        );
        // KDE's ~/.config/kdedefaults first in XDG_CONFIG_DIRS (round 8, finding 2): dropped.
        assert_eq!(
            run(
                &base(),
                session,
                Some("/home/me/.config/kdedefaults:/etc/xdg:/etc/xdg")
            ),
            OK
        );

        // The planted file from the Linux run: in the owner's data home and in a dropped dir,
        // nothing is read, so nothing is refused. Likewise a list in a dropped config dir and
        // an entry in a dropped dir's applications/.
        let mut fs = base();
        fs.file(
            "/home/me/.local/share/xdg-terminals/aaa-evil.desktop",
            ME,
            0o644,
            "[Desktop Entry]\nExec=/usr/local/bin/psyche-mark\n",
        );
        fs.file("/srv/shared/xdg-terminals/aaa-evil.desktop", ME, 0o644, "x");
        fs.file(
            "/home/me/.local/share/flatpak/exports/share/xdg-terminals/evil.desktop",
            ME,
            0o644,
            "x",
        );
        fs.file(
            "/home/me/.local/share/flatpak/exports/share/applications/evil.desktop",
            ME,
            0o644,
            "[Desktop Entry]\nCategories=System;TerminalEmulator;\n",
        );
        fs.file(
            "/home/me/.config/kdedefaults/kde-xdg-terminals.list",
            ME,
            0o644,
            "evil.desktop",
        );
        assert_eq!(
            run(&fs, session, Some("/home/me/.config/kdedefaults:/etc/xdg")),
            OK
        );

        // Root-owned terminal entries and lists in trusted dirs are fine.
        let mut fs = base();
        fs.file("/usr/share/xdg-terminals/xterm.desktop", ROOT, 0o644, "x");
        fs.file(
            "/usr/share/xdg-terminal-exec/xdg-terminals.list",
            ROOT,
            0o644,
            "x",
        );
        fs.file(
            "/usr/share/applications/kde4/konsole.desktop",
            ROOT,
            0o644,
            "x",
        );
        fs.file("/etc/xdg/xdg-terminals.list", ROOT, 0o644, "xterm.desktop");
        assert_eq!(run(&fs, session, None), OK);

        // A trusted data dir whose applications/ this account owns is dropped (newer
        // xdg-terminal-exec reads terminal entries there).
        let mut fs = base();
        fs.set("/usr/local/share/applications", ME, 0o40755);
        assert_eq!(run(&fs, session, None), "ok /usr/share | /etc/xdg");

        // Refused, in a trusted dir: an xdg-terminals or xdg-terminal-exec dir or a file in it
        // this account owns or anyone may write, a symlink to the owner's home; any applications/
        // entry or subdir that fails the check; the system fallback lists; an untrusted
        // *xdg-terminals.list in a kept config dir.
        type Case = (&'static str, fn(&mut MapFs));
        let cases: Vec<Case> = vec![
            ("own dir", |fs| {
                fs.set("/usr/local/share/xdg-terminals", ME, 0o40755);
            }),
            ("writable dir", |fs| {
                fs.set("/usr/local/share/xdg-terminals", ROOT, 0o40777);
            }),
            ("own file", |fs| {
                fs.dirs("/usr/share/xdg-terminals");
                fs.file("/usr/share/xdg-terminals/evil.desktop", ME, 0o644, "x");
            }),
            ("writable file", |fs| {
                fs.dirs("/usr/share/xdg-terminals");
                fs.file("/usr/share/xdg-terminals/evil.desktop", ROOT, 0o666, "x");
            }),
            ("link home", |fs| {
                fs.link(
                    "/usr/share/xdg-terminals",
                    ROOT,
                    "/home/me/.local/share/xdg-terminals",
                );
                fs.set("/home/me/.local/share/xdg-terminals", ME, 0o40755);
            }),
            ("own terminal app entry", |fs| {
                fs.file(
                    "/usr/share/applications/evil.desktop",
                    ME,
                    0o644,
                    "[Desktop Entry]\nCategories=System;TerminalEmulator;\n",
                );
            }),
            ("own entry, any category", |fs| {
                fs.file("/usr/share/applications/notes.desktop", ME, 0o644, "x");
            }),
            ("own subdir of applications", |fs| {
                fs.set("/usr/share/applications/kde4", ME, 0o40755);
            }),
            ("own entry in a subdir", |fs| {
                fs.file("/usr/share/applications/kde4/evil.desktop", ME, 0o644, "x");
            }),
            ("entry linked to the home", |fs| {
                fs.link(
                    "/usr/share/applications/evil.desktop",
                    ROOT,
                    "/home/me/.local/share/evil.desktop",
                );
                fs.file("/home/me/.local/share/evil.desktop", ME, 0o644, "x");
            }),
            ("own xdg-terminal-exec list in a data dir", |fs| {
                fs.dirs("/usr/local/share/xdg-terminal-exec");
                fs.file(
                    "/usr/local/share/xdg-terminal-exec/xdg-terminals.list",
                    ME,
                    0o644,
                    "evil.desktop",
                );
            }),
            ("own config list", |fs| {
                fs.file("/etc/xdg/kde-xdg-terminals.list", ME, 0o644, "evil.desktop");
            }),
        ];
        for (name, case) in cases {
            let mut fs = base();
            case(&mut fs);
            assert_eq!(run(&fs, session, None), REFUSED, "{name}");
        }
        // The system fallback lists are read whatever XDG_DATA_DIRS says, so they are vetted
        // even when /usr/local/share is dropped from it.
        let mut fs = base();
        fs.dirs("/usr/local/share/xdg-terminal-exec");
        fs.file(
            "/usr/local/share/xdg-terminal-exec/xdg-terminals.list",
            ME,
            0o644,
            "evil.desktop",
        );
        assert_eq!(run(&fs, Some("/usr/share"), None), REFUSED);
        // A non-desktop file this account owns in applications/ is not a terminal entry.
        let mut fs = base();
        fs.file("/usr/share/applications/notes.txt", ME, 0o644, "x");
        assert_eq!(run(&fs, session, None), OK);

        // Round 9: applications/ is walked like `find -L`, at any depth, through symlinked
        // subdirs, each dir once, and refused past VET_MAX_ENTRIES.
        let mut fs = base();
        fs.dirs("/usr/share/applications/a/b/c/d/e/f");
        fs.file(
            "/usr/share/applications/a/b/c/d/e/f/evil.desktop",
            ME,
            0o644,
            "x",
        );
        assert_eq!(run(&fs, session, None), REFUSED, "deep nesting");
        let mut fs = base();
        fs.dirs("/usr/share/applications/a/b/c/d/e/f");
        fs.file(
            "/usr/share/applications/a/b/c/d/e/f/ok.desktop",
            ROOT,
            0o644,
            "x",
        );
        assert_eq!(run(&fs, session, None), OK, "deep nesting, all root-owned");
        let mut fs = base();
        fs.dirs("/opt/vendor/apps");
        fs.file("/opt/vendor/apps/evil.desktop", ME, 0o644, "x");
        fs.link("/usr/share/applications/vendor", ROOT, "/opt/vendor/apps");
        assert_eq!(
            run(&fs, session, None),
            REFUSED,
            "symlinked subdir with an owned entry"
        );
        let mut fs = base();
        fs.dirs("/opt/vendor/apps");
        fs.file("/opt/vendor/apps/ok.desktop", ROOT, 0o644, "x");
        fs.link("/usr/share/applications/vendor", ROOT, "/opt/vendor/apps");
        assert_eq!(run(&fs, session, None), OK, "symlinked subdir, root-owned");
        let mut fs = base();
        fs.link(
            "/usr/share/applications/loop",
            ROOT,
            "/usr/share/applications",
        );
        fs.link(
            "/usr/share/applications/xterm.d",
            ROOT,
            "../applications/loop",
        );
        assert_eq!(run(&fs, session, None), OK, "a symlink loop ends");
        let mut fs = base();
        for i in 0..VET_MAX_ENTRIES {
            fs.file(
                &format!("/usr/share/applications/app{i}.desktop"),
                ROOT,
                0o644,
                "x",
            );
        }
        assert_eq!(run(&fs, session, None), REFUSED, "past the entry cap");

        // Round 9, residual 2: a missing /etc/xdg under a trusted /etc stays the config dir
        // (only root could create it); under an /etc this account owns, it does not.
        let mut fs = base();
        fs.nodes.remove(Path::new("/etc/xdg"));
        assert_eq!(run(&fs, session, None), OK, "/etc/xdg missing");
        assert_eq!(
            run(&fs, session, Some("/home/me/.config/kdedefaults:/etc/xdg")),
            OK
        );
        fs.set("/etc", ME, 0o40755);
        assert_eq!(
            run(&fs, session, None),
            REFUSED,
            "/etc owned, /etc/xdg missing"
        );

        // Nothing trusted left: refused.
        assert_eq!(
            run(&base(), Some("/srv/shared:/home/me/.local/share"), None),
            REFUSED
        );
        assert_eq!(
            run(&base(), session, Some("/home/me/.config/kdedefaults")),
            REFUSED
        );
    }

    #[test]
    fn the_private_launch_dir_must_be_fresh_and_this_accounts_alone() {
        let env = |run: Option<&'static str>| {
            move |k: &str| match k {
                "XDG_RUNTIME_DIR" => run.map(String::from),
                _ => None,
            }
        };
        let mut fs = MapFs::default();
        fs.dirs("/run/user");
        fs.set("/run/user/1000", ME, 0o40700);
        assert_eq!(
            private_launch_root(&fs, &env(Some("/run/user/1000")), ME),
            PathBuf::from("/run/user/1000/psyche-helper")
        );
        // Unset: systemd's place; missing or relative: /tmp.
        assert_eq!(
            private_launch_root(&fs, &env(None), ME),
            PathBuf::from("/run/user/1000/psyche-helper")
        );
        assert_eq!(
            private_launch_root(&fs, &env(None), 1001),
            PathBuf::from("/tmp/psyche-helper-1001")
        );
        assert_eq!(
            private_launch_root(&fs, &env(Some("run")), ME),
            PathBuf::from("/tmp/psyche-helper-1000")
        );

        let fresh = || {
            let mut fs = MapFs::default();
            fs.dirs("/run/user");
            fs.set("/run/user/1000", ME, 0o40700);
            fs.set("/run/user/1000/psyche-helper", ME, 0o40700);
            fs.set("/run/user/1000/psyche-helper/t1", ME, 0o40700);
            fs.set("/run/user/1000/psyche-helper/t1/config", ME, 0o40700);
            fs.set("/run/user/1000/psyche-helper/t1/cache", ME, 0o40700);
            fs.set("/run/user/1000/psyche-helper/t1/data", ME, 0o40700);
            fs
        };
        let dir = Path::new("/run/user/1000/psyche-helper/t1");
        assert!(private_launch_dir_ok(&fresh(), dir, ME));
        // Another account's, shared modes, a symlink, a file instead of a dir, extra or
        // missing entries, a non-empty config dir: refused.
        let cases: Vec<fn(&mut MapFs)> = vec![
            |fs| {
                fs.set("/run/user/1000/psyche-helper/t1", ROOT, 0o40700);
            },
            |fs| {
                fs.set("/run/user/1000/psyche-helper", ME, 0o40755);
            },
            |fs| {
                fs.set("/run/user/1000/psyche-helper/t1/cache", ME, 0o40770);
            },
            |fs| {
                fs.link(
                    "/run/user/1000/psyche-helper/t1/config",
                    ME,
                    "/home/me/.config",
                );
            },
            |fs| {
                fs.set("/run/user/1000/psyche-helper/t1/config", ME, 0o100600);
            },
            |fs| {
                fs.set("/run/user/1000/psyche-helper/t1/extra", ME, 0o40700);
            },
            |fs| {
                fs.nodes
                    .remove(Path::new("/run/user/1000/psyche-helper/t1/cache"));
            },
            |fs| {
                fs.nodes
                    .remove(Path::new("/run/user/1000/psyche-helper/t1/data"));
            },
            |fs| {
                fs.file(
                    "/run/user/1000/psyche-helper/t1/data/xdg-terminals/evil.desktop",
                    ME,
                    0o600,
                    "[Desktop Entry]",
                );
            },
            |fs| {
                fs.file(
                    "/run/user/1000/psyche-helper/t1/config/ubuntu-xdg-terminals.list",
                    ME,
                    0o600,
                    "evil.desktop",
                );
            },
        ];
        for (i, case) in cases.iter().enumerate() {
            let mut fs = fresh();
            case(&mut fs);
            assert!(!private_launch_dir_ok(&fs, dir, ME), "case {i}");
        }
        assert!(!private_launch_dir_ok(
            &fresh(),
            Path::new("/run/user/1000/psyche-helper/none"),
            ME
        ));
    }

    #[test]
    fn bus_names_follow_glib() {
        let long = format!("{}c", "ab.".repeat(100));
        for ok in ["org.gnome.TextEditor", "org.x-y.App_2", "a.b"] {
            assert!(is_bus_name(ok), "{ok}");
        }
        for bad in [
            "",
            "gedit",
            "org..x",
            "org.2x",
            ":1.2",
            "org.gnome.Text Editor",
            "org.gnome.",
            long.as_str(),
        ] {
            assert!(!is_bus_name(bad), "{bad}");
        }
    }

    #[test]
    fn unit_entries_that_change_what_a_unit_runs() {
        let u = "org-gnome-TextEditor.service";
        for hit in [
            "org-gnome-TextEditor.service",
            "org-gnome-TextEditor.service.d",
            "org-gnome-TextEditor.service.wants",
            "org-gnome-TextEditor.service.requires",
            "org-.service.d",
            "org-gnome-.service.d",
            "service.d",
        ] {
            assert!(unit_entry_affects(u, hit), "{hit}");
        }
        for miss in [
            "org-gnome-Other.service",
            "org-gnome-TextEditor.serviceX",
            "socket.d",
            "org-gnome-.socket.d",
            "default.target.wants",
        ] {
            assert!(!unit_entry_affects(u, miss), "{miss}");
        }
        // Templates and a unit named without its type.
        assert!(unit_entry_affects("app@x.service", "app@.service"));
        assert!(unit_entry_affects("app@x.service", "app@.service.d"));
        assert!(unit_entry_affects(
            "gnome-text-editor",
            "gnome-text-editor.service.d"
        ));
    }

    const TEXT_EDITOR: &str = "/usr/share/applications/org.gnome.TextEditor.desktop";
    const DBUS_ENTRY: &str =
        "[Desktop Entry]\nType=Application\nExec=gnome-text-editor\nDBusActivatable=true\n";

    fn dbus_home(fs: &mut MapFs) {
        home(fs);
        fs.dirs("/run/user");
        fs.set("/run/user/1000", ME, 0o40700);
        fs.file(TEXT_EDITOR, ROOT, 0o644, DBUS_ENTRY);
    }

    fn system_service(fs: &mut MapFs, systemd: Option<&str>) {
        let unit = systemd
            .map(|u| format!("SystemdService={u}\n"))
            .unwrap_or_default();
        fs.file(
            "/usr/share/dbus-1/services/org.gnome.TextEditor.service",
            ROOT,
            0o644,
            &format!("[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/usr/bin/gnome-text-editor --gapplication-service\n{unit}"),
        );
    }

    fn user_env(k: &str) -> Option<String> {
        match k {
            "HOME" => Some("/home/me".into()),
            "XDG_RUNTIME_DIR" => Some("/run/user/1000".into()),
            _ => None,
        }
    }

    fn dbus_check(fs: &MapFs, contents: &str) -> CapResult<()> {
        check_dbus_activation(
            fs,
            &user_env,
            "org.gnome.texteditor",
            Path::new(TEXT_EDITOR),
            contents,
            ME,
        )
    }

    fn dbus_why(r: CapResult<()>) -> String {
        let e = r.unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (code::POLICY_DENIED, "untrusted_dbus_activation")
        );
        assert!(e.message.contains("starts through D-Bus"), "{}", e.message);
        assert!(e.message.contains("owner must open it"), "{}", e.message);
        e.details
            .get("why")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    }

    #[test]
    fn dbus_activation_table() {
        // A trusted system service and no user one: launched.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        system_service(&mut fs, None);
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
        // Also in /usr/local/share and through a system Flatpak export.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        fs.file(
            "/var/lib/flatpak/exports/share/dbus-1/services/org.gnome.TextEditor.service",
            ROOT,
            0o644,
            "[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/usr/bin/flatpak run org.gnome.TextEditor\n",
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());

        // DBusActivatable=false (or absent): not checked, even with no service at all.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        let plain =
            "[Desktop Entry]\nType=Application\nExec=gnome-text-editor\nDBusActivatable=false\n";
        assert!(dbus_check(&fs, plain).is_ok());
        // A basename that is not a bus name: GLib runs Exec=, so not checked either.
        assert!(check_dbus_activation(
            &fs,
            &user_env,
            "gedit",
            Path::new("/usr/share/applications/gedit.desktop"),
            DBUS_ENTRY,
            ME
        )
        .is_ok());

        // No system service at all.
        assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "no_system_service");
        // A system file of that name that names another bus name does not count.
        fs.file(
            "/usr/share/dbus-1/services/org.gnome.TextEditor.service",
            ROOT,
            0o644,
            "[D-BUS Service]\nName=org.gnome.Other\nExec=/usr/bin/x\n",
        );
        assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "no_system_service");

        // A user service file shadowing it in the data home, by file name or by Name= alone.
        for (path, body) in [
            (
                "/home/me/.local/share/dbus-1/services/org.gnome.TextEditor.service",
                "[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/bin/sh -c evil\n",
            ),
            (
                "/home/me/.local/share/dbus-1/services/zz-innocent.service",
                "[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/bin/sh -c evil\n",
            ),
            // The runtime dir.
            (
                "/run/user/1000/dbus-1/services/org.gnome.TextEditor.service",
                "[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/bin/sh -c evil\n",
            ),
            // A user Flatpak export.
            (
                "/home/me/.local/share/flatpak/exports/share/dbus-1/services/org.gnome.TextEditor.service",
                "",
            ),
        ] {
            let mut fs = MapFs::default();
            dbus_home(&mut fs);
            system_service(&mut fs, None);
            fs.file(path, ME, 0o644, body);
            assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "user_service_file", "{path}");
        }
        // An unrelated user service is fine.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        system_service(&mut fs, None);
        fs.file(
            "/home/me/.local/share/dbus-1/services/org.example.Other.service",
            ME,
            0o644,
            "[D-BUS Service]\nName=org.example.Other\nExec=/bin/true\n",
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());

        // An untrusted dir smuggled into XDG_DATA_DIRS.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        system_service(&mut fs, None);
        fs.set("/srv/shared", ROOT, 0o40777);
        fs.file(
            "/srv/shared/dbus-1/services/org.gnome.TextEditor.service",
            ROOT,
            0o644,
            "",
        );
        let env = |k: &str| match k {
            "XDG_DATA_DIRS" => Some("/srv/shared:/usr/share".into()),
            _ => user_env(k),
        };
        assert_eq!(
            dbus_why(check_dbus_activation(
                &fs,
                &env,
                "org.gnome.texteditor",
                Path::new(TEXT_EDITOR),
                DBUS_ENTRY,
                ME
            )),
            "user_service_file"
        );

        // The system file itself is this account's (in a root-owned dir).
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        fs.file(
            "/usr/share/dbus-1/services/org.gnome.TextEditor.service",
            ME,
            0o644,
            "[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/bin/sh\n",
        );
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "untrusted_service_file"
        );
    }

    #[test]
    fn dbus_activation_through_a_systemd_user_unit() {
        let unit = "app-org.gnome.TextEditor.service";
        let ok = || {
            let mut fs = MapFs::default();
            dbus_home(&mut fs);
            system_service(&mut fs, Some(unit));
            fs.file(
                &format!("/usr/lib/systemd/user/{unit}"),
                ROOT,
                0o644,
                "[Service]\nExecStart=/usr/bin/gnome-text-editor\n",
            );
            fs
        };
        assert!(dbus_check(&ok(), DBUS_ENTRY).is_ok());
        for path in [
            format!("/home/me/.config/systemd/user/{unit}"),
            format!("/home/me/.config/systemd/user/{unit}.d/override.conf"),
            format!("/home/me/.local/share/systemd/user/{unit}"),
            format!("/run/user/1000/systemd/user/{unit}"),
            format!("/run/user/1000/systemd/user/{unit}.d/evil.conf"),
            format!("/home/me/.config/systemd/user/{unit}.wants/evil.service"),
            "/home/me/.config/systemd/user/app-.service.d/evil.conf".to_string(),
            "/home/me/.config/systemd/user/service.d/evil.conf".to_string(),
        ] {
            let mut fs = ok();
            fs.file(
                &path,
                ME,
                0o644,
                "[Service]\nExecStartPre=/bin/sh -c evil\n",
            );
            assert_eq!(
                dbus_why(dbus_check(&fs, DBUS_ENTRY)),
                "user_systemd_unit",
                "{path}"
            );
        }
        // Unrelated user units, and the same unit in /etc (root's): fine.
        let mut fs = ok();
        fs.file(
            "/home/me/.config/systemd/user/syncthing.service",
            ME,
            0o644,
            "",
        );
        fs.file(
            &format!("/etc/systemd/user/{unit}.d/site.conf"),
            ROOT,
            0o644,
            "",
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
        // Without SystemdService= the user units are not consulted.
        let mut fs = MapFs::default();
        dbus_home(&mut fs);
        system_service(&mut fs, None);
        fs.file(
            &format!("/home/me/.config/systemd/user/{unit}"),
            ME,
            0o644,
            "",
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
    }

    fn service_body(systemd: &str) -> String {
        format!("[D-BUS Service]\nName=org.gnome.TextEditor\nExec=/usr/bin/gnome-text-editor --gapplication-service\nSystemdService={systemd}\n")
    }

    #[test]
    fn the_provider_is_the_first_file_that_names_the_bus_name() {
        let unit = "app-gnome-text-editor.service";
        let base = || {
            let mut fs = MapFs::default();
            dbus_home(&mut fs);
            fs.file(
                &format!("/usr/lib/systemd/user/{unit}"),
                ROOT,
                0o644,
                "[Service]\nExecStart=/usr/bin/gnome-text-editor\n",
            );
            fs
        };
        // The provider under another file name is found, and its SystemdService= is the unit
        // that is checked.
        let mut fs = base();
        fs.file(
            "/usr/share/dbus-1/services/gnome-text-editor.service",
            ROOT,
            0o644,
            &service_body(unit),
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
        fs.file(
            &format!("/home/me/.config/systemd/user/{unit}.d/evil.conf"),
            ME,
            0o644,
            "[Service]\nExecStartPre=/bin/sh -c evil\n",
        );
        assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "user_systemd_unit");
        // Such a provider that fails the trust rule is refused.
        let mut fs = base();
        fs.file(
            "/usr/share/dbus-1/services/gnome-text-editor.service",
            ME,
            0o644,
            &service_body(unit),
        );
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "untrusted_service_file"
        );
        // Two files claiming the name in the winning dir: whichever the bus reads first wins.
        let mut fs = base();
        system_service(&mut fs, None);
        fs.file(
            "/usr/share/dbus-1/services/gnome-text-editor.service",
            ROOT,
            0o644,
            &service_body(unit),
        );
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "ambiguous_service_files"
        );
        // An earlier trusted dir's provider wins over a later one: only its unit is checked.
        let other = "org.gnome.TextEditor-old.service";
        let mut fs = base();
        fs.file(
            "/usr/local/share/dbus-1/services/local-editor.service",
            ROOT,
            0o644,
            &service_body(unit),
        );
        fs.file(
            "/usr/share/dbus-1/services/org.gnome.TextEditor.service",
            ROOT,
            0o644,
            &service_body(other),
        );
        // Two claims in the later dir do not count either: it does not win.
        fs.file(
            "/usr/share/dbus-1/services/zz-editor.service",
            ROOT,
            0o644,
            &service_body(other),
        );
        fs.file(
            &format!("/home/me/.config/systemd/user/{other}"),
            ME,
            0o644,
            "",
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
        fs.file(
            &format!("/home/me/.config/systemd/user/{unit}"),
            ME,
            0o644,
            "",
        );
        assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "user_systemd_unit");
    }

    #[test]
    fn systemd_aliases_resolve_to_real_units_before_the_drop_in_scan() {
        let alias = "dbus-org.gnome.TextEditor.service";
        let real = "org.gnome.TextEditor.service";
        let with_link = |target: &str| {
            let mut fs = MapFs::default();
            dbus_home(&mut fs);
            system_service(&mut fs, Some(alias));
            fs.file(
                &format!("/usr/lib/systemd/user/{real}"),
                ROOT,
                0o644,
                "[Service]\nExecStart=/usr/bin/gnome-text-editor\n[Install]\nAlias=org.gnome.Editor.service\n",
            );
            fs.link(&format!("/usr/lib/systemd/user/{alias}"), ROOT, target);
            fs
        };
        // The alias resolves within trusted dirs (relative or absolute) and no user unit
        // touches any of its names: launched. A same-name link from /etc to /usr/lib too.
        assert!(dbus_check(&with_link(real), DBUS_ENTRY).is_ok());
        assert!(dbus_check(
            &with_link(&format!("/usr/lib/systemd/user/{real}")),
            DBUS_ENTRY
        )
        .is_ok());
        let mut fs = with_link(real);
        fs.link(
            &format!("/etc/systemd/user/{alias}"),
            ROOT,
            &format!("/usr/lib/systemd/user/{alias}"),
        );
        assert!(dbus_check(&fs, DBUS_ENTRY).is_ok());
        // A user drop-in, unit or template for the real name, or for an [Install] Alias= name.
        for path in [
            format!("/home/me/.config/systemd/user/{real}.d/override.conf"),
            format!("/home/me/.config/systemd/user/{real}"),
            "/home/me/.local/share/systemd/user/org.gnome.Editor.service.d/x.conf".to_string(),
            format!("/run/user/1000/systemd/user/{real}.wants/evil.service"),
            "/home/me/.config/systemd/user/dbus-.service.d/x.conf".to_string(),
        ] {
            let mut fs = with_link(real);
            fs.file(
                &path,
                ME,
                0o644,
                "[Service]\nExecStartPre=/bin/sh -c evil\n",
            );
            assert_eq!(
                dbus_why(dbus_check(&fs, DBUS_ENTRY)),
                "user_systemd_unit",
                "{path}"
            );
        }
        // A user symlink that makes another name an alias of the real unit.
        let mut fs = with_link(real);
        fs.link(
            "/home/me/.config/systemd/user/innocent.service",
            ME,
            &format!("/usr/lib/systemd/user/{real}"),
        );
        assert_eq!(dbus_why(dbus_check(&fs, DBUS_ENTRY)), "user_systemd_unit");
        // The alias points into a user dir, outside every unit dir, or at /dev/null.
        for target in [
            format!("/home/me/.config/systemd/user/{real}"),
            format!("/opt/units/{real}"),
            "/dev/null".to_string(),
        ] {
            let mut fs = with_link(&target);
            fs.file(&format!("/opt/units/{real}"), ROOT, 0o644, "");
            assert_eq!(
                dbus_why(dbus_check(&fs, DBUS_ENTRY)),
                "untrusted_systemd_alias",
                "{target}"
            );
        }
        // An alias loop, and an alias link this account owns.
        let mut fs = with_link("b.service");
        fs.link("/usr/lib/systemd/user/b.service", ROOT, alias);
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "untrusted_systemd_alias"
        );
        let mut fs = with_link(real);
        fs.link(&format!("/usr/lib/systemd/user/{alias}"), ME, real);
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "untrusted_systemd_alias"
        );
        // The real unit file in a trusted dir is this account's.
        let mut fs = with_link(real);
        fs.file(&format!("/usr/lib/systemd/user/{real}"), ME, 0o644, "");
        assert_eq!(
            dbus_why(dbus_check(&fs, DBUS_ENTRY)),
            "untrusted_systemd_unit"
        );
    }

    #[test]
    fn install_aliases_follow_systemd() {
        assert_eq!(
            install_aliases(
                "[Unit]\nAlias=no.service\n[Install]\nAlias=a.service b.service\n# Alias=c.service\nAlias=d.service\n"
            ),
            vec!["a.service", "b.service", "d.service"]
        );
        assert_eq!(
            install_aliases("[Install]\nAlias=a.service\nAlias=\nAlias=e.service\n"),
            vec!["e.service"]
        );
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
