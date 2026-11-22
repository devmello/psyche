//! Code a contained command could plant in its read-write folder for something else to run
//! later, outside the sandbox (#1512 review r1 finding 7, r2 findings 1 to 3, r3 B1 to B4; the
//! Host's #1434 and #1435 list in `packages/hostfs/src/launch-config.ts`): git hooks and config
//! and what redirects git to others, direnv, editor and dev container tasks, agent and MCP
//! configs, package manager hooks.
//!
//! - **One at a time.** Read-write contained runs whose folders overlap run one after the other
//!   ([`Folders`]): no run can swap, plant into or move what another run's sandbox is being built
//!   from. This turn-taking is what stops a pinned folder being swapped for a link to outside
//!   while the sandbox is set up (#1512 r3 B3, r4): `--bind-fd` alone does not, because bwrap
//!   turns the descriptor back into a path (`realpath("/proc/self/fd/N")`) and mounts that
//!   path, and its own check afterwards is racy. Never let read-write runs overlap.
//! - **Pinned folders.** The working folder, every folder between it and the granted folder,
//!   the folders two levels below both, each existing `.git` among them, and the folders on the
//!   way to each read-only root inside the folder are bound read-write over themselves, each
//!   from a descriptor opened from the folder's without following a link and checked to be the
//!   folder [`masks`] saw (`--bind-fd`, [`open_pins`]). A mount point can't be renamed or
//!   removed, so a command can't move a `.git` (or a read-only root's parent) aside and make a
//!   fresh one the masks don't cover. Writing inside them works as before (`git commit`).
//! - **Existing entries** in the pinned folders are bound read-only over themselves; inside an
//!   existing `.git`, its hooks, submodules, `info`, linked worktrees, config, `commondir` and
//!   `config.worktree` (the last two send git to another config and hooks).
//! - **Missing entries** at the folder and the working folder (where launchers and git look)
//!   are covered too: an empty read-only folder or `/dev/null`, so the command can't create
//!   them. `bwrap` makes an empty file or folder on the disk to mount over; [`remove_stubs`]
//!   removes each one after the run if it is still empty. A `commondir` can't be covered (git
//!   stops on an empty one): a new one is moved aside after the run.
//! - **New or changed entries** (a new repository or `.vscode` one or two levels down, which VS
//!   Code and git-aware prompts open by themselves; a new `commondir` in an existing `.git`; a
//!   stub that isn't empty): after a read-write run the folder and the working folder are
//!   scanned by descriptor, never through a link, and each launch entry that wasn't there before
//!   is renamed in place with a random suffix ([`quarantine`]), never deleted, and named in the
//!   result.
//! - **Fail closed.** A folder too big or unreadable to scan before the run is refused. When the
//!   scan after a run is cut short or something can't be moved aside, the result says so and
//!   the folder takes no more read-write runs until the helper restarts ([`Folders::flag`]).
//! - Not covered: ordinary scripts the owner may run later (`build.sh`, a `Makefile`): a
//!   read-write folder is the owner's grant to change what is in it; and entries deeper than the
//!   scan.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use crate::fs::walk;

/// Folders an app or agent reads and runs code from when it opens the folder.
pub const LAUNCH_DIRS: &[&str] = &[
    ".obsidian",
    ".vscode",
    ".idea",
    ".zed",
    ".husky",
    ".devcontainer",
    ".claude",
    ".cursor",
    ".cargo",
];

/// Files with the same effect, or read by the next command run there.
pub const LAUNCH_FILES: &[&str] = &[
    ".envrc",
    ".mcp.json",
    ".nvim.lua",
    ".exrc",
    ".pre-commit-config.yaml",
    "lefthook.yml",
    "lefthook.yaml",
    ".yarnrc.yml",
    ".npmrc",
    ".pnpmfile.cjs",
];

/// Inside a `.git` folder: hooks, the submodules' own git folders, `info` (attributes that pick
/// filters, sparse checkout) and linked worktrees (each with its own `commondir` and `gitdir`).
pub const GIT_DIRS: &[&str] = &["hooks", "modules", "info", "worktrees"];
/// Inside a `.git` folder: the config that names hooks, filters and pagers, and the files that
/// send git to another repository's config and hooks.
pub const GIT_FILES: &[&str] = &["config", "commondir", "config.worktree"];

/// How many folders are pinned at most (the path to the working folder and to read-only roots
/// always are; the levels below fill the rest, shallowest first).
pub const PINNED_MAX: usize = 512;
/// How many levels below the folder and the working folder are pinned and scanned.
pub const DEPTH: usize = 2;
/// How many folders one scan reads at most; past it the scan is cut short.
pub const SCAN_DIRS_MAX: usize = 20_000;
/// How many names one folder may hold for the scan; past it the scan is cut short.
pub const SCAN_NAMES_MAX: usize = 100_000;
/// The longest file name Linux takes.
const NAME_MAX: usize = 255;

/// What to show read-only, and which folders to pin.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Masks {
    /// Folders bound read-write over themselves, parents first (the granted folder not listed).
    pub pinned: Vec<PathBuf>,
    /// Who each pinned folder was (`dev:ino`) when the masks were made.
    pub pin_ids: BTreeMap<PathBuf, (u64, u64)>,
    /// Existing files and folders, bound read-only over themselves.
    pub existing: Vec<PathBuf>,
    /// Missing folders: an empty read-only tmpfs.
    pub missing_dirs: Vec<PathBuf>,
    /// Missing files: `/dev/null`, read-only.
    pub missing_files: Vec<PathBuf>,
}

fn exists(p: &Path) -> Option<std::fs::Metadata> {
    std::fs::symlink_metadata(p).ok()
}

/// Whether `name` is something a launcher runs code from when it opens the folder.
pub fn is_launch_name(name: &str) -> bool {
    name == ".git"
        || LAUNCH_DIRS.contains(&name)
        || LAUNCH_FILES.contains(&name)
        || (name.len() > ".code-workspace".len() && name.ends_with(".code-workspace"))
}

fn under_any(p: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| p.starts_with(r))
}

/// The read-only roots strictly inside `folder`.
fn ro_inside(folder: &Path, read_only: &[PathBuf]) -> Vec<PathBuf> {
    read_only
        .iter()
        .filter(|r| r.starts_with(folder) && r.as_path() != folder)
        .cloned()
        .collect()
}

/// The folders between `from` (not included) and `to` (included), parents first.
fn between(from: &Path, to: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut at = to.to_path_buf();
    while at != from && at.starts_with(from) {
        out.push(at.clone());
        if !at.pop() {
            break;
        }
    }
    out.reverse();
    out
}

/// The folders to pin in a read-write `folder` with the command in `cwd`; `read_only` are the
/// ceiling's read-only roots (nothing at or under one is pinned: it is read-only already).
fn pinned_folders(folder: &Path, cwd: &Path, read_only: &[PathBuf]) -> Vec<PathBuf> {
    let ro = ro_inside(folder, read_only);
    let mut out: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut add = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if p.as_path() != folder && !under_any(&p, &ro) && seen.insert(p.clone()) {
            out.push(p);
        }
    };
    // Always: the way to the working folder and to each read-only root's parent.
    for p in between(folder, cwd) {
        add(p, &mut out);
    }
    for r in &ro {
        if let Some(parent) = r.parent() {
            for p in between(folder, parent) {
                add(p, &mut out);
            }
        }
    }
    // Then the levels below the folder and the working folder, shallowest first.
    let mut level: Vec<PathBuf> = vec![folder.to_path_buf(), cwd.to_path_buf()];
    for _ in 0..DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(rd) = std::fs::read_dir(dir) else {
                continue;
            };
            for e in rd.flatten() {
                if out.len() >= PINNED_MAX {
                    break;
                }
                // `file_type` does not follow a link: a link to a folder is not entered.
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    let p = e.path();
                    if !under_any(&p, &ro) {
                        next.push(p.clone());
                        add(p, &mut out);
                    }
                }
            }
        }
        level = next;
    }
    out
}

/// The masks for a read-write `folder` with the command in `cwd`.
pub fn masks(folder: &Path, cwd: &Path, read_only: &[PathBuf]) -> Masks {
    let mut m = Masks::default();
    let tops: BTreeSet<&Path> = [folder, cwd].into_iter().collect();
    let mut bases = vec![folder.to_path_buf()];
    bases.extend(pinned_folders(folder, cwd, read_only));
    m.pinned = bases[1..].to_vec();
    for base in &bases {
        let top = tops.contains(base.as_path());
        let git = base.join(".git");
        match exists(&git) {
            Some(meta) if meta.is_dir() => {
                // Pinned itself: it can't be moved aside and replaced by one without the masks.
                m.pinned.push(git.clone());
                for d in GIT_DIRS {
                    let p = git.join(d);
                    if exists(&p).is_some() {
                        m.existing.push(p);
                    } else if *d == "hooks" {
                        m.missing_dirs.push(p);
                    }
                }
                for f in GIT_FILES {
                    let p = git.join(f);
                    if exists(&p).is_some() {
                        m.existing.push(p);
                    } else if *f == "config" {
                        // git takes an empty config; not an empty `commondir` (moved aside after).
                        m.missing_files.push(p);
                    }
                }
            }
            // A `gitdir:` pointer: rewritten, it would lead git to hooks the command wrote.
            Some(_) => m.existing.push(git),
            None if top => m.missing_dirs.push(git),
            None => {}
        }
        for d in LAUNCH_DIRS {
            let p = base.join(d);
            if exists(&p).is_some() {
                m.existing.push(p);
            } else if top {
                m.missing_dirs.push(p);
            }
        }
        for f in LAUNCH_FILES {
            let p = base.join(f);
            if exists(&p).is_some() {
                m.existing.push(p);
            } else if top {
                m.missing_files.push(p);
            }
        }
        // VS Code workspace files: tasks and settings, like `.vscode`.
        if let Ok(rd) = std::fs::read_dir(base) {
            for e in rd.flatten().take(4096) {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.len() > ".code-workspace".len() && name.ends_with(".code-workspace") {
                    m.existing.push(e.path());
                }
            }
        }
    }
    // Parents before children: a bind over a parent would hide one made below it before.
    m.pinned.sort_by_key(|p| p.components().count());
    m.pinned.dedup();
    // Only real folders are pinned, and who each one is now is noted.
    let ids = &mut m.pin_ids;
    m.pinned.retain(|p| match exists(p) {
        Some(meta) if meta.is_dir() => {
            ids.insert(p.clone(), (meta.dev(), meta.ino()));
            true
        }
        _ => false,
    });
    m.existing.sort();
    m.existing.dedup();
    m.missing_dirs.sort();
    m.missing_dirs.dedup();
    m.missing_files.sort();
    m.missing_files.dedup();
    m
}

fn parts_of(rel: &Path) -> Vec<OsString> {
    rel.iter().map(|c| c.to_os_string()).collect()
}

/// Each pinned folder (not under a read-only root), opened from the folder's descriptor one
/// component at a time without following a link, and checked to be the folder [`masks`] saw.
/// `bwrap` binds the descriptor (`--bind-fd`). That is a check, not the guard: bwrap resolves the
/// descriptor back to a path before it mounts, so only [`Folders`]' turn-taking keeps another run
/// from swapping a pin for a link meanwhile (#1512 r3 B3, r4). Any change, or one that can't be
/// opened, refuses the run: the path is returned.
pub fn open_pins(
    folder: &Path,
    m: &Masks,
    read_only: &[PathBuf],
) -> Result<Vec<(OwnedFd, PathBuf)>, PathBuf> {
    let ro = ro_inside(folder, read_only);
    let root = walk::open_root(folder).map_err(|_| folder.to_path_buf())?;
    let mut out = Vec::new();
    for p in m.pinned.iter().filter(|p| !under_any(p, &ro)) {
        let Ok(rel) = p.strip_prefix(folder) else {
            return Err(p.clone());
        };
        let fd = walk::walk(&root, &parts_of(rel), false).map_err(|_| p.clone())?;
        let e = walk::stat_fd(fd.as_raw_fd()).map_err(|_| p.clone())?;
        if m.pin_ids.get(p) != Some(&(e.dev, e.ino)) {
            return Err(p.clone());
        }
        out.push((fd, p.clone()));
    }
    Ok(out)
}

/// Read-write contained runs one at a time per folder (two folders overlap when one holds the
/// other), and the folders whose last scan was cut short.
#[derive(Default)]
pub struct Folders {
    busy: Mutex<Vec<PathBuf>>,
    freed: Condvar,
    flagged: Mutex<Vec<PathBuf>>,
}

fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

/// One read-write run's hold on its folder; dropping it lets the next one in.
pub struct Held<'a> {
    folders: &'a Folders,
    folder: PathBuf,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        let mut busy = self.folders.busy.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = busy.iter().position(|b| *b == self.folder) {
            busy.remove(i);
        }
        self.folders.freed.notify_all();
    }
}

impl Folders {
    pub fn global() -> &'static Folders {
        static FOLDERS: OnceLock<Folders> = OnceLock::new();
        FOLDERS.get_or_init(Folders::default)
    }

    /// Waits until no other read-write run holds a folder overlapping `folder`, then holds it.
    /// `None` when the call was cancelled meanwhile.
    pub fn hold(&self, folder: &Path, cancelled: &AtomicBool) -> Option<Held<'_>> {
        let mut busy = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !busy.iter().any(|b| overlap(b, folder)) {
                busy.push(folder.to_path_buf());
                return Some(Held {
                    folders: self,
                    folder: folder.to_path_buf(),
                });
            }
            if cancelled.load(Ordering::SeqCst) {
                return None;
            }
            busy = self
                .freed
                .wait_timeout(busy, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// A run in `folder` left launch entries that may not have been moved aside.
    pub fn flag(&self, folder: &Path) {
        let mut f = self.flagged.lock().unwrap_or_else(|e| e.into_inner());
        if !f.iter().any(|x| x == folder) {
            f.push(folder.to_path_buf());
        }
    }

    /// Tests only: as if the helper restarted.
    #[cfg(test)]
    pub fn unflag(&self, folder: &Path) {
        self.flagged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|x| x != folder);
    }

    /// The flagged folder that overlaps `folder`, if any.
    pub fn flagged(&self, folder: &Path) -> Option<PathBuf> {
        self.flagged
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|x| overlap(x, folder))
            .cloned()
    }
}

/// Who a launch entry is: a folder by `dev:ino`, a file by `dev:ino` and when it last changed.
type Key = (u64, u64, i128);

fn key(e: &walk::Entry) -> Key {
    (e.dev, e.ino, if e.is_dir() { 0 } else { e.mtime_ns })
}

/// Why a scan could not see everything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut(pub String);

/// One launch entry a scan found.
struct Found<'a> {
    dir: &'a OwnedFd,
    dir_path: &'a Path,
    name: &'a OsStr,
    key: Key,
}

/// The roots a scan starts from, relative to the folder: the folder and the working folder.
fn rels(folder: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::new()];
    if let Ok(r) = cwd.strip_prefix(folder) {
        if !r.as_os_str().is_empty() {
            out.push(r.to_path_buf());
        }
    }
    out
}

/// Walks `rel` below the folder's descriptor and [`DEPTH`] levels below it, never through a
/// link, calling `f` for each launch entry; for a `.git` folder, when `f` says so, also for each
/// of its [`GIT_DIRS`] and [`GIT_FILES`]. Anything it can't read cuts it short.
fn scan(
    folder_fd: &OwnedFd,
    folder: &Path,
    rel: &Path,
    f: &mut dyn FnMut(&Found) -> bool,
) -> Result<(), Cut> {
    let root = folder.join(rel);
    let fd = walk::walk(folder_fd, &parts_of(rel), false)
        .map_err(|_| Cut(format!("{} could not be opened", root.display())))?;
    let mut budget = SCAN_DIRS_MAX;
    scan_dir(&fd, &root, 0, &mut budget, f)
}

fn scan_dir(
    dir: &OwnedFd,
    path: &Path,
    depth: usize,
    budget: &mut usize,
    f: &mut dyn FnMut(&Found) -> bool,
) -> Result<(), Cut> {
    if *budget == 0 {
        return Err(Cut(format!("more than {SCAN_DIRS_MAX} folders to check")));
    }
    *budget -= 1;
    let unreadable = |p: &Path| Cut(format!("{} could not be read", p.display()));
    let names = walk::names(dir, SCAN_NAMES_MAX).map_err(|_| unreadable(path))?;
    if names.len() > SCAN_NAMES_MAX {
        return Err(Cut(format!(
            "{} holds more than {SCAN_NAMES_MAX} entries",
            path.display()
        )));
    }
    for name in names {
        let e = match walk::stat_at(dir, &name) {
            Ok(e) => e,
            Err(err) if err.raw_os_error() == Some(libc::ENOENT) => continue,
            Err(_) => return Err(unreadable(&path.join(&name))),
        };
        let found = Found {
            dir,
            dir_path: path,
            name: &name,
            key: key(&e),
        };
        if is_launch_name(&name.to_string_lossy()) {
            if f(&found) && name == ".git" && e.is_dir() {
                let gpath = path.join(&name);
                let git = walk::open_dir_at(dir, &name).map_err(|_| unreadable(&gpath))?;
                for inner in GIT_DIRS.iter().chain(GIT_FILES) {
                    let inner = OsStr::new(inner);
                    match walk::stat_at(&git, inner) {
                        Ok(ie) => {
                            f(&Found {
                                dir: &git,
                                dir_path: &gpath,
                                name: inner,
                                key: key(&ie),
                            });
                        }
                        Err(err) if err.raw_os_error() == Some(libc::ENOENT) => {}
                        Err(_) => return Err(unreadable(&gpath.join(inner))),
                    }
                }
            }
            continue;
        }
        if depth < DEPTH && e.is_dir() {
            let sub_path = path.join(&name);
            let sub = walk::open_dir_at(dir, &name).map_err(|_| unreadable(&sub_path))?;
            scan_dir(&sub, &sub_path, depth + 1, budget, f)?;
        }
    }
    Ok(())
}

/// The launch entries in a read-write folder before a run. A folder that can't be scanned
/// whole is refused before anything runs.
#[derive(Debug, Default)]
pub struct Before(HashSet<Key>);

pub fn before(folder: &Path, cwd: &Path) -> Result<Before, Cut> {
    let fd = walk::open_root(folder)
        .map_err(|_| Cut(format!("{} could not be opened", folder.display())))?;
    let mut keys = HashSet::new();
    for rel in rels(folder, cwd) {
        scan(&fd, folder, &rel, &mut |e| {
            keys.insert(e.key);
            true
        })?;
    }
    Ok(Before(keys))
}

/// One entry moved aside: where it was and where it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quarantined {
    pub path: PathBuf,
    pub moved_to: PathBuf,
}

/// What [`quarantine`] did.
#[derive(Debug, Default)]
pub struct Outcome {
    pub moved: Vec<Quarantined>,
    /// Why some entries may still be in place (the scan was cut short, a rename failed).
    pub cut: Option<String>,
}

/// `name` renamed in `dir` to `<name>.psyche-quarantine-<random>` (or the suffix alone when
/// that is too long a name), never replacing anything.
fn move_aside(dir: &OwnedFd, name: &OsStr) -> io::Result<OsString> {
    let mut last = io::Error::from_raw_os_error(libc::EEXIST);
    for _ in 0..4 {
        let mut r = [0u8; 8];
        getrandom::fill(&mut r).map_err(|_| io::Error::other("no randomness"))?;
        let tag: String = r.iter().map(|b| format!("{b:02x}")).collect();
        let suffix = format!(".psyche-quarantine-{tag}");
        let to = if name.as_bytes().len() + suffix.len() <= NAME_MAX {
            let mut t = name.to_os_string();
            t.push(&suffix);
            t
        } else {
            OsString::from(suffix)
        };
        match walk::rename_noreplace_at(dir, name, &to) {
            Ok(()) => return Ok(to),
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// After a read-write run (and [`remove_stubs`]): every launch entry that is new or changed
/// since [`before`] is renamed in place ([`move_aside`]), which no launcher reads. It is never
/// removed: the owner decides. A scan cut short or a rename that failed is in `cut`.
pub fn quarantine(folder: &Path, cwd: &Path, before: &Before) -> Outcome {
    let mut out = Outcome::default();
    let Ok(fd) = walk::open_root(folder) else {
        out.cut = Some(format!("{} could not be opened", folder.display()));
        return out;
    };
    let mut done: HashSet<(u64, u64)> = HashSet::new();
    for rel in rels(folder, cwd) {
        let mut failed: Option<String> = None;
        let moved = &mut out.moved;
        let scanned = scan(&fd, folder, &rel, &mut |e| {
            if before.0.contains(&e.key) {
                return true;
            }
            if !done.insert((e.key.0, e.key.1)) {
                return false;
            }
            let path = e.dir_path.join(e.name);
            match move_aside(e.dir, e.name) {
                Ok(to) => moved.push(Quarantined {
                    moved_to: e.dir_path.join(to),
                    path,
                }),
                Err(err) => {
                    failed.get_or_insert(format!(
                        "{} could not be moved aside ({})",
                        path.display(),
                        err.kind()
                    ));
                }
            }
            false
        });
        if let Err(Cut(why)) = scanned {
            out.cut.get_or_insert(why);
        }
        if let Some(why) = failed {
            out.cut.get_or_insert(why);
        }
    }
    out
}

/// Removes the empty files and folders `bwrap` made on the disk to mount over (the masks'
/// missing entries), each from its parent's descriptor reached from the folder's without
/// following a link. One that isn't empty stays for [`quarantine`], which moves it aside as a
/// new entry (#1512 r3, B4).
pub fn remove_stubs(folder: &Path, m: &Masks) {
    let Ok(root) = walk::open_root(folder) else {
        return;
    };
    let mut all: Vec<&PathBuf> = m.missing_dirs.iter().chain(&m.missing_files).collect();
    // Deepest first, so a stub folder inside another goes before it.
    all.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for p in all {
        let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else {
            continue;
        };
        let Ok(rel) = parent.strip_prefix(folder) else {
            continue;
        };
        let Ok(dir) = walk::walk(&root, &parts_of(rel), false) else {
            continue;
        };
        match walk::stat_at(&dir, name) {
            // A folder that isn't empty is refused by the kernel (ENOTEMPTY): it stays.
            Ok(e) if e.is_dir() => {
                let _ = walk::unlink_at(&dir, name, true);
            }
            Ok(e) if e.is_file() && e.size == 0 => {
                let _ = walk::unlink_at(&dir, name, false);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_entries_are_found_and_missing_ones_only_at_the_top() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("code");
        let proj = folder.join("proj");
        let sibling = folder.join("other");
        std::fs::create_dir_all(proj.join(".git/hooks")).unwrap();
        std::fs::create_dir_all(proj.join(".git/info")).unwrap();
        std::fs::write(proj.join(".git/config"), "[core]").unwrap();
        std::fs::write(proj.join(".git/commondir"), "..").unwrap();
        std::fs::create_dir_all(sibling.join(".git")).unwrap();
        std::fs::create_dir_all(sibling.join(".vscode")).unwrap();
        std::fs::create_dir_all(proj.join("deep/deeper/.vscode")).unwrap();
        std::fs::create_dir_all(proj.join("deep/deeper/much/deeper/.vscode")).unwrap();
        std::fs::write(proj.join(".envrc"), "x").unwrap();
        std::fs::write(proj.join("app.code-workspace"), "{}").unwrap();
        std::fs::write(proj.join("notes.code-workspace.md"), "").unwrap();
        let m = masks(&folder, &proj, &[]);
        let has = |v: &[PathBuf], p: &Path| v.iter().any(|x| x == p);
        // must be read-only: existing, two levels below the working folder too
        for p in [
            proj.join(".git/hooks"),
            proj.join(".git/info"),
            proj.join(".git/config"),
            proj.join(".git/commondir"),
            proj.join(".envrc"),
            proj.join("app.code-workspace"),
            sibling.join(".vscode"),
            proj.join("deep/deeper/.vscode"),
        ] {
            assert!(has(&m.existing, &p), "{p:?} in {m:?}");
        }
        // must be pinned: the way to the working folder, siblings, each `.git`, two levels down
        for p in [
            proj.clone(),
            sibling.clone(),
            proj.join(".git"),
            sibling.join(".git"),
            proj.join("deep"),
            proj.join("deep/deeper"),
        ] {
            assert!(has(&m.pinned, &p), "{p:?} pinned in {:?}", m.pinned);
            assert!(m.pin_ids.contains_key(&p), "{p:?} has its id");
        }
        assert!(!has(&m.pinned, &folder), "the folder is bound already");
        let depth = |p: &PathBuf| p.components().count();
        assert!(m.pinned.windows(2).all(|w| depth(&w[0]) <= depth(&w[1])));
        // must be covered: missing at the top folders
        for p in [
            folder.join(".git"),
            folder.join(".vscode"),
            proj.join(".vscode"),
            proj.join(".devcontainer"),
            sibling.join(".git/hooks"),
        ] {
            assert!(has(&m.missing_dirs, &p), "{p:?}");
        }
        for p in [
            folder.join(".envrc"),
            proj.join(".mcp.json"),
            sibling.join(".git/config"),
        ] {
            assert!(has(&m.missing_files, &p), "{p:?}");
        }
        // must stay writable: ordinary files, missing ones below the top, far deeper entries,
        // and a missing `commondir` (git stops on an empty one: moved aside after instead)
        for p in [
            proj.join("notes.code-workspace.md"),
            sibling.join(".envrc"),
            sibling.join(".git/commondir"),
            proj.join("deep/.git"),
            proj.join("deep/deeper/much/deeper/.vscode"),
        ] {
            assert!(
                !has(&m.existing, &p) && !has(&m.missing_dirs, &p) && !has(&m.missing_files, &p),
                "{p:?}"
            );
        }
    }

    #[test]
    fn the_way_to_a_read_only_root_is_pinned_and_nothing_inside_it() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        let keep = folder.join("a/b/keep");
        std::fs::create_dir_all(keep.join("inner")).unwrap();
        let m = masks(&folder, &folder, std::slice::from_ref(&keep));
        let has = |p: &Path| m.pinned.iter().any(|x| x == p);
        assert!(
            has(&folder.join("a")) && has(&folder.join("a/b")),
            "{:?}",
            m.pinned
        );
        assert!(!has(&keep) && !has(&keep.join("inner")));
    }

    /// #1512 r3, B3: a pinned folder swapped (for a link, or another folder) after the masks
    /// were made refuses the run.
    #[test]
    fn pins_are_opened_without_links_and_must_be_the_folders_the_masks_saw() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        let other = dir.path().join("other");
        std::fs::create_dir_all(folder.join("nd")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let m = masks(&folder, &folder, &[]);
        let pins = open_pins(&folder, &m, &[]).unwrap();
        assert!(pins.iter().any(|(_, p)| *p == folder.join("nd")));
        drop(pins);
        std::fs::remove_dir(folder.join("nd")).unwrap();
        std::os::unix::fs::symlink("../other", folder.join("nd")).unwrap();
        assert_eq!(open_pins(&folder, &m, &[]).err(), Some(folder.join("nd")));
        std::fs::remove_file(folder.join("nd")).unwrap();
        std::fs::create_dir(folder.join("nd")).unwrap();
        assert_eq!(open_pins(&folder, &m, &[]).err(), Some(folder.join("nd")));
    }

    #[test]
    fn new_launch_entries_two_levels_down_are_moved_aside_and_old_ones_stay() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::create_dir_all(folder.join("old/.vscode")).unwrap();
        let b = before(&folder, &folder).unwrap();
        // What a command planted.
        std::fs::create_dir_all(folder.join("sub/.git/hooks")).unwrap();
        std::fs::write(folder.join("sub/.git/config"), "[core]\n\tfsmonitor = x\n").unwrap();
        std::fs::create_dir_all(folder.join("newrepo/.git")).unwrap();
        std::fs::create_dir_all(folder.join("a/b/.vscode")).unwrap();
        std::fs::write(folder.join("sub/.envrc"), "x").unwrap();
        std::fs::create_dir_all(folder.join("a/b/c/d/.vscode")).unwrap();
        // B1: a `commondir` in the existing repository.
        std::fs::write(folder.join(".git/commondir"), "evil\n").unwrap();
        // B2: the names a command can guess don't stop it.
        std::fs::write(folder.join("sub/.git.psyche-quarantine-0"), "").unwrap();
        let long = format!("{}.code-workspace", "w".repeat(240));
        std::fs::write(folder.join(&long), "{}").unwrap();
        // A link to a folder elsewhere is not followed.
        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join(".git")).unwrap();
        std::os::unix::fs::symlink(&other, folder.join("link")).unwrap();
        let q = quarantine(&folder, &folder, &b);
        assert_eq!(q.cut, None);
        let moved: Vec<PathBuf> = q.moved.iter().map(|x| x.path.clone()).collect();
        for p in [
            "sub/.git",
            "newrepo/.git",
            "a/b/.vscode",
            "sub/.envrc",
            ".git/commondir",
            long.as_str(),
        ] {
            let p = folder.join(p);
            assert!(moved.contains(&p), "{p:?} in {moved:?}");
            assert!(
                std::fs::symlink_metadata(&p).is_err(),
                "{p:?} is gone from its place"
            );
        }
        for x in &q.moved {
            assert!(x.moved_to.exists(), "kept, not deleted: {x:?}");
            let name = x
                .moved_to
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            assert!(!is_launch_name(&name), "{name}");
            assert!(name.contains(".psyche-quarantine-") && name.len() <= NAME_MAX);
        }
        // The planted config is kept, aside.
        let aside = q
            .moved
            .iter()
            .find(|x| x.path == folder.join("sub/.git"))
            .unwrap();
        assert!(aside.moved_to.join("config").is_file());
        // Old entries, links and entries deeper than the scan stay where they were.
        assert!(folder.join(".git").is_dir() && folder.join("old/.vscode").is_dir());
        assert!(other.join(".git").is_dir());
        assert!(folder.join("a/b/c/d/.vscode").is_dir());
        let again = quarantine(&folder, &folder, &before(&folder, &folder).unwrap());
        assert!(again.moved.is_empty() && again.cut.is_none());
    }

    /// #1512 r3, B2: a scan that can't see everything says so; before a run it refuses.
    #[test]
    fn a_scan_cut_short_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        let b = before(&folder, &folder).unwrap();
        std::fs::create_dir_all(folder.join("hidden/.git")).unwrap();
        std::fs::set_permissions(
            folder.join("hidden"),
            std::fs::Permissions::from_mode(0o300),
        )
        .unwrap();
        // Root reads anything: then there is nothing to check here.
        // SAFETY: geteuid cannot fail.
        if unsafe { libc::geteuid() } != 0 {
            let q = quarantine(&folder, &folder, &b);
            assert!(q.cut.is_some_and(|w| w.contains("hidden")));
            assert!(before(&folder, &folder).is_err());
        }
        std::fs::set_permissions(
            folder.join("hidden"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }

    #[test]
    fn empty_stubs_go_and_one_with_something_in_it_is_moved_aside() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(&folder).unwrap();
        let b = before(&folder, &folder).unwrap();
        let m = masks(&folder, &folder, &[]);
        assert!(m.missing_dirs.contains(&folder.join(".vscode")));
        // bwrap made them; something wrote into two of them.
        std::fs::create_dir(folder.join(".vscode")).unwrap();
        std::fs::create_dir(folder.join(".git")).unwrap();
        std::fs::write(folder.join(".envrc"), "").unwrap();
        std::fs::write(folder.join(".npmrc"), "registry=x").unwrap();
        std::fs::write(folder.join(".vscode/tasks.json"), "{}").unwrap();
        remove_stubs(&folder, &m);
        assert!(!folder.join(".git").exists() && !folder.join(".envrc").exists());
        let q = quarantine(&folder, &folder, &b);
        let moved: Vec<PathBuf> = q.moved.iter().map(|x| x.path.clone()).collect();
        assert!(moved.contains(&folder.join(".vscode")), "{moved:?}");
        assert!(moved.contains(&folder.join(".npmrc")), "{moved:?}");
        assert!(!folder.join(".vscode").exists() && !folder.join(".npmrc").exists());
    }

    #[test]
    fn overlapping_folders_take_turns_and_a_flag_covers_overlaps() {
        let f = Folders::default();
        let no = AtomicBool::new(false);
        let a = f.hold(Path::new("/p"), &no).unwrap();
        // Not overlapping: at once.
        let other = f.hold(Path::new("/q"), &no).unwrap();
        drop(other);
        let cancelled = AtomicBool::new(true);
        assert!(f.hold(Path::new("/p/sub"), &cancelled).is_none());
        assert!(f.hold(Path::new("/"), &cancelled).is_none());
        drop(a);
        assert!(f.hold(Path::new("/p/sub"), &cancelled).is_some());
        f.flag(Path::new("/p"));
        assert_eq!(f.flagged(Path::new("/p/sub")), Some(PathBuf::from("/p")));
        assert_eq!(f.flagged(Path::new("/q")), None);
    }
}
