//! Code a contained command could plant in its read-write folder for something else to run
//! later, outside the sandbox (#1512 review r1 finding 7, r2 findings 1 to 3; the Host's #1434
//! and #1435 list in `packages/hostfs/src/launch-config.ts`): git hooks and config, direnv,
//! editor and dev container tasks, agent and MCP configs, package manager hooks.
//!
//! - **Pinned folders.** The folder, the working folder, every folder between the two, the
//!   folders two levels below the folder and the working folder, each existing `.git` among
//!   them, and the folders on the way to each read-only root inside the folder are bound
//!   read-write over themselves. A mount point can't be renamed or removed, so a command can't
//!   move a `.git` (or a read-only root's parent) aside and make a fresh one the masks don't
//!   cover. Writing inside them works as before (`git commit`).
//! - **Existing entries** in the pinned folders are bound read-only over themselves; inside an
//!   existing `.git`, its hooks, submodules and config.
//! - **Missing entries** at the folder and the working folder (where launchers and git look)
//!   are covered too: an empty read-only folder or `/dev/null`, so the command can't create
//!   them. `bwrap` makes an empty file or folder on the disk to mount over; [`Stubs`] removes
//!   each one when the last contained command has ended, if it is still empty.
//! - **New entries deeper down** (a new repository or `.vscode` one or two levels down, which
//!   VS Code and git-aware prompts open by themselves): after a read-write run the folder and
//!   the working folder are scanned down to two levels below without following a link, and each launch
//!   entry that wasn't there before is moved aside ([`quarantine`]), never deleted, and named in
//!   the result.
//! - Not covered: ordinary scripts the owner may run later (`build.sh`, a `Makefile`): a
//!   read-write folder is the owner's grant to change what is in it; and entries deeper than
//!   two levels below.

use std::collections::{BTreeSet, HashSet};
use std::ffi::{OsStr, OsString};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

/// Inside a `.git` folder: hooks and the config that names hooks, filters and pagers, and the
/// submodules' own git folders.
pub const GIT_DIRS: &[&str] = &["hooks", "modules"];
pub const GIT_FILES: &[&str] = &["config"];

/// How many folders are pinned at most (the path to the working folder and to read-only roots
/// always are; the levels below fill the rest, shallowest first).
pub const PINNED_MAX: usize = 512;
/// How many levels below the folder and the working folder are pinned and scanned.
pub const DEPTH: usize = 2;
/// How many folders one scan reads at most.
const SCAN_DIRS_MAX: usize = 20_000;

/// What to show read-only, and which folders to pin.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Masks {
    /// Folders bound read-write over themselves, parents first (the granted folder not listed).
    pub pinned: Vec<PathBuf>,
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
    let ro: Vec<PathBuf> = read_only
        .iter()
        .filter(|r| r.starts_with(folder) && r.as_path() != folder)
        .cloned()
        .collect();
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
                    } else {
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
    m.existing.sort();
    m.existing.dedup();
    m.missing_dirs.sort();
    m.missing_dirs.dedup();
    m.missing_files.sort();
    m.missing_files.dedup();
    m
}

/// One launch entry a scan found.
struct Found<'a> {
    dir: &'a OwnedFd,
    dir_path: &'a Path,
    name: &'a OsStr,
    id: (u64, u64),
}

/// Walks `root` and the folders up to [`DEPTH`] levels below it by descriptor (never through a
/// link), calling `f` for each launch entry.
fn scan(root: &Path, f: &mut dyn FnMut(Found)) {
    let Ok(fd) = walk::open_root(root) else {
        return;
    };
    let mut budget = SCAN_DIRS_MAX;
    scan_dir(&fd, root, 0, &mut budget, f);
}

fn scan_dir(
    dir: &OwnedFd,
    path: &Path,
    depth: usize,
    budget: &mut usize,
    f: &mut dyn FnMut(Found),
) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    let Ok(names) = walk::names(dir, 100_000) else {
        return;
    };
    for name in names {
        let Ok(e) = walk::stat_at(dir, &name) else {
            continue;
        };
        if is_launch_name(&name.to_string_lossy()) {
            f(Found {
                dir,
                dir_path: path,
                name: &name,
                id: (e.dev, e.ino),
            });
            continue;
        }
        if depth < DEPTH && e.is_dir() {
            if let Ok(sub) = walk::open_dir_at(dir, &name) {
                scan_dir(&sub, &path.join(&name), depth + 1, budget, f);
            }
        }
    }
}

/// The launch entries in a read-write folder before a run, by device and inode.
#[derive(Debug, Default)]
pub struct Before(HashSet<(u64, u64)>);

pub fn before(folder: &Path, cwd: &Path) -> Before {
    let mut ids = HashSet::new();
    for root in [folder, cwd] {
        scan(root, &mut |e| {
            ids.insert(e.id);
        });
    }
    Before(ids)
}

/// One entry moved aside: where it was and where it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quarantined {
    pub path: PathBuf,
    pub moved_to: PathBuf,
}

/// After a read-write run: every launch entry that wasn't there before (and isn't a stub a
/// contained command mounts over) is renamed in place to `<name>.psyche-quarantine-<n>`, which no
/// launcher reads. It is never removed: the owner decides.
pub fn quarantine(folder: &Path, cwd: &Path, before: &Before) -> Vec<Quarantined> {
    let stubs = Stubs::global();
    let mut out = Vec::new();
    let mut done: HashSet<(u64, u64)> = HashSet::new();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for root in [folder, cwd] {
        scan(root, &mut |e| {
            let path = e.dir_path.join(e.name);
            if before.0.contains(&e.id) || done.contains(&e.id) || stubs.holds(&path) {
                return;
            }
            for n in 0..100u32 {
                let mut to = OsString::from(e.name);
                to.push(format!(".psyche-quarantine-{stamp}"));
                if n > 0 {
                    to.push(format!("-{n}"));
                }
                match walk::rename_noreplace_at(e.dir, e.name, &to) {
                    Ok(()) => {
                        done.insert(e.id);
                        out.push(Quarantined {
                            moved_to: e.dir_path.join(&to),
                            path,
                        });
                        break;
                    }
                    Err(err) if err.raw_os_error() == Some(libc::EEXIST) => continue,
                    Err(_) => break,
                }
            }
        });
    }
    out
}

/// Empty files and folders `bwrap` made to mount over, with how many contained read-write
/// commands are running: they are removed only when the last one ends, so a command that started
/// meanwhile never loses its cover (unlinking a mount point detaches it everywhere).
#[derive(Default)]
pub struct Stubs {
    state: Mutex<(usize, BTreeSet<PathBuf>)>,
}

impl Stubs {
    pub fn global() -> &'static Stubs {
        static STUBS: OnceLock<Stubs> = OnceLock::new();
        STUBS.get_or_init(Stubs::default)
    }

    /// One command starts: what is missing now and will be made by `bwrap` is noted. Returns the
    /// masks to use (a stub another command made counts as existing).
    pub fn begin(&self, mut m: Masks) -> Masks {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        st.0 += 1;
        let stubs = &mut st.1;
        let mut keep = |list: &mut Vec<PathBuf>, existing: &mut Vec<PathBuf>| {
            list.retain(|p| {
                if exists(p).is_some() {
                    existing.push(p.clone());
                    false
                } else {
                    stubs.insert(p.clone());
                    true
                }
            });
        };
        keep(&mut m.missing_dirs, &mut m.existing);
        keep(&mut m.missing_files, &mut m.existing);
        m
    }

    /// Whether `path` is a stub some running command mounts over.
    pub fn holds(&self, path: &Path) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .1
            .contains(path)
    }

    /// One command ended. The last one removes the stubs that are still empty.
    pub fn end(&self) {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        st.0 = st.0.saturating_sub(1);
        if st.0 > 0 {
            return;
        }
        let stubs = std::mem::take(&mut st.1);
        // Deepest first, so a stub folder inside another goes before it.
        for p in stubs.iter().rev() {
            match std::fs::symlink_metadata(p) {
                Ok(m) if m.is_dir() => {
                    let _ = std::fs::remove_dir(p);
                }
                Ok(m) if m.is_file() && m.len() == 0 => {
                    let _ = std::fs::remove_file(p);
                }
                _ => {}
            }
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
        std::fs::write(proj.join(".git/config"), "[core]").unwrap();
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
            proj.join(".git/config"),
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
        // must stay writable: ordinary files, missing ones below the top, far deeper entries
        for p in [
            proj.join("notes.code-workspace.md"),
            sibling.join(".envrc"),
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

    #[test]
    fn new_launch_entries_two_levels_down_are_moved_aside_and_old_ones_stay() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("proj");
        std::fs::create_dir_all(folder.join(".git")).unwrap();
        std::fs::create_dir_all(folder.join("old/.vscode")).unwrap();
        let b = before(&folder, &folder);
        // What a command planted.
        std::fs::create_dir_all(folder.join("sub/.git/hooks")).unwrap();
        std::fs::write(folder.join("sub/.git/config"), "[core]\n\tfsmonitor = x\n").unwrap();
        std::fs::create_dir_all(folder.join("newrepo/.git")).unwrap();
        std::fs::create_dir_all(folder.join("a/b/.vscode")).unwrap();
        std::fs::write(folder.join("sub/.envrc"), "x").unwrap();
        std::fs::create_dir_all(folder.join("a/b/c/d/.vscode")).unwrap();
        // A link to a folder elsewhere is not followed.
        let other = dir.path().join("other");
        std::fs::create_dir_all(other.join(".git")).unwrap();
        std::os::unix::fs::symlink(&other, folder.join("link")).unwrap();
        let q = quarantine(&folder, &folder, &b);
        let moved: Vec<PathBuf> = q.iter().map(|x| x.path.clone()).collect();
        for p in ["sub/.git", "newrepo/.git", "a/b/.vscode", "sub/.envrc"] {
            let p = folder.join(p);
            assert!(moved.contains(&p), "{p:?} in {moved:?}");
            assert!(
                std::fs::symlink_metadata(&p).is_err(),
                "{p:?} is gone from its place"
            );
        }
        for x in &q {
            assert!(x.moved_to.exists(), "kept, not deleted: {x:?}");
            assert!(!is_launch_name(
                &x.moved_to.file_name().unwrap().to_string_lossy()
            ));
        }
        // The planted config is kept, aside.
        let aside = q
            .iter()
            .find(|x| x.path == folder.join("sub/.git"))
            .unwrap();
        assert!(aside.moved_to.join("config").is_file());
        // Old entries, links and entries deeper than the scan stay where they were.
        assert!(folder.join(".git").is_dir() && folder.join("old/.vscode").is_dir());
        assert!(other.join(".git").is_dir());
        assert!(folder.join("a/b/c/d/.vscode").is_dir());
        assert!(quarantine(&folder, &folder, &before(&folder, &folder)).is_empty());
    }

    #[test]
    fn stubs_go_when_the_last_command_ends_and_only_if_empty() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let stubs = Stubs::default();
        let first = stubs.begin(Masks {
            missing_dirs: vec![folder.join(".vscode")],
            missing_files: vec![folder.join(".envrc"), folder.join(".npmrc")],
            ..Masks::default()
        });
        assert_eq!(first.missing_files.len(), 2);
        assert!(stubs.holds(&folder.join(".envrc")));
        // bwrap made them.
        std::fs::create_dir(folder.join(".vscode")).unwrap();
        std::fs::write(folder.join(".envrc"), "").unwrap();
        std::fs::write(folder.join(".npmrc"), "").unwrap();
        // A second command sees them as existing and keeps them covered.
        let second = stubs.begin(Masks {
            missing_dirs: vec![folder.join(".vscode")],
            missing_files: vec![folder.join(".envrc")],
            ..Masks::default()
        });
        assert!(second.missing_dirs.is_empty() && second.missing_files.is_empty());
        assert_eq!(second.existing.len(), 2);
        stubs.end();
        assert!(
            folder.join(".envrc").exists(),
            "the second command still runs"
        );
        // The owner wrote a real .npmrc meanwhile: it stays.
        std::fs::write(folder.join(".npmrc"), "registry=x").unwrap();
        stubs.end();
        assert!(!folder.join(".envrc").exists());
        assert!(!folder.join(".vscode").exists());
        assert!(folder.join(".npmrc").exists());
        assert!(!stubs.holds(&folder.join(".envrc")));
    }
}
