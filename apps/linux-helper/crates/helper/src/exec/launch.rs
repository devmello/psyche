//! Code a contained command could plant in its read-write folder for something else to run
//! later, outside the sandbox (#1512 review r1, finding 7; the Host's #1434 and #1435 list in
//! `packages/hostfs/src/launch-config.ts`): git hooks and config, direnv, editor and dev
//! container tasks, agent and MCP configs, package manager hooks. The contained shell shows
//! each of them read-only.
//!
//! - **Existing entries** in the folder, the working folder, every folder between the two, and
//!   their immediate subfolders (sibling repositories) are bound read-only over themselves.
//! - **Missing entries** at the folder and the working folder (where launchers and git look)
//!   are covered too: an empty read-only folder or `/dev/null`, so the command cannot create
//!   them. `bwrap` makes an empty file or folder on the disk to mount over; [`Stubs`] removes
//!   each one when the last command in that folder has ended, if it is still empty.
//! - Not covered: entries deeper down that do not exist yet (a new repository two levels down
//!   gets its own hooks), and ordinary scripts the owner may run later (`build.sh`, a
//!   `Makefile`): a read-write folder is the owner's grant to change what is in it.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

const SUBFOLDERS_MAX: usize = 256;

/// What to show read-only.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Masks {
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

/// The folders whose existing entries are checked: `folder`, `cwd` and the folders between,
/// and the immediate subfolders of `folder` and `cwd`.
fn bases(folder: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut out: BTreeSet<PathBuf> = BTreeSet::new();
    let mut at = cwd.to_path_buf();
    loop {
        out.insert(at.clone());
        if at == folder || !at.starts_with(folder) || !at.pop() {
            break;
        }
    }
    for top in [folder, cwd] {
        let Ok(rd) = std::fs::read_dir(top) else {
            continue;
        };
        for e in rd.flatten().take(SUBFOLDERS_MAX) {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                out.insert(e.path());
            }
        }
    }
    out.into_iter().collect()
}

/// The masks for a read-write `folder` with the command in `cwd`.
pub fn masks(folder: &Path, cwd: &Path) -> Masks {
    let mut m = Masks::default();
    let tops: BTreeSet<&Path> = [folder, cwd].into_iter().collect();
    for base in bases(folder, cwd) {
        let top = tops.contains(base.as_path());
        let git = base.join(".git");
        match exists(&git) {
            Some(meta) if meta.is_dir() => {
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
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten().take(4096) {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.len() > ".code-workspace".len() && name.ends_with(".code-workspace") {
                    m.existing.push(e.path());
                }
            }
        }
    }
    m.existing.sort();
    m.existing.dedup();
    m.missing_dirs.sort();
    m.missing_dirs.dedup();
    m.missing_files.sort();
    m.missing_files.dedup();
    m
}

/// Empty files and folders `bwrap` made to mount over, by folder, with how many contained
/// commands are running there: they are removed only when the last one ends, so a command that
/// started meanwhile never loses its cover (unlinking a mount point detaches it everywhere).
#[derive(Default)]
pub struct Stubs {
    by_folder: Mutex<HashMap<PathBuf, (usize, BTreeSet<PathBuf>)>>,
}

impl Stubs {
    pub fn global() -> &'static Stubs {
        static STUBS: OnceLock<Stubs> = OnceLock::new();
        STUBS.get_or_init(Stubs::default)
    }

    /// One command starts in `folder`: what is missing now and will be made by `bwrap` is noted.
    /// Returns the masks to use (a stub another command made counts as existing).
    pub fn begin(&self, folder: &Path, mut m: Masks) -> Masks {
        let mut map = self.by_folder.lock().unwrap_or_else(|e| e.into_inner());
        let entry = map.entry(folder.to_path_buf()).or_default();
        entry.0 += 1;
        let mut keep = |list: &mut Vec<PathBuf>, existing: &mut Vec<PathBuf>| {
            list.retain(|p| {
                if exists(p).is_some() {
                    existing.push(p.clone());
                    false
                } else {
                    entry.1.insert(p.clone());
                    true
                }
            });
        };
        keep(&mut m.missing_dirs, &mut m.existing);
        keep(&mut m.missing_files, &mut m.existing);
        m
    }

    /// One command in `folder` ended. The last one removes the stubs that are still empty.
    pub fn end(&self, folder: &Path) {
        let mut map = self.by_folder.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = map.get_mut(folder) else {
            return;
        };
        entry.0 = entry.0.saturating_sub(1);
        if entry.0 > 0 {
            return;
        }
        let stubs = std::mem::take(&mut entry.1);
        map.remove(folder);
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
        std::fs::write(proj.join(".envrc"), "x").unwrap();
        std::fs::write(proj.join("app.code-workspace"), "{}").unwrap();
        std::fs::write(proj.join("notes.code-workspace.md"), "").unwrap();
        let m = masks(&folder, &proj);
        let has = |v: &[PathBuf], p: &Path| v.iter().any(|x| x == p);
        // must be read-only: existing
        for p in [
            proj.join(".git/hooks"),
            proj.join(".git/config"),
            proj.join(".envrc"),
            proj.join("app.code-workspace"),
            sibling.join(".vscode"),
        ] {
            assert!(has(&m.existing, &p), "{p:?} in {m:?}");
        }
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
        // must stay writable: ordinary files, deeper entries, missing ones below the top
        for p in [
            proj.join("notes.code-workspace.md"),
            proj.join("deep/deeper/.vscode"),
            sibling.join(".envrc"),
            proj.join("deep/.git"),
        ] {
            assert!(
                !has(&m.existing, &p) && !has(&m.missing_dirs, &p) && !has(&m.missing_files, &p),
                "{p:?}"
            );
        }
    }

    #[test]
    fn stubs_go_when_the_last_command_ends_and_only_if_empty() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let stubs = Stubs::default();
        let first = stubs.begin(
            &folder,
            Masks {
                existing: vec![],
                missing_dirs: vec![folder.join(".vscode")],
                missing_files: vec![folder.join(".envrc"), folder.join(".npmrc")],
            },
        );
        assert_eq!(first.missing_files.len(), 2);
        // bwrap made them.
        std::fs::create_dir(folder.join(".vscode")).unwrap();
        std::fs::write(folder.join(".envrc"), "").unwrap();
        std::fs::write(folder.join(".npmrc"), "").unwrap();
        // A second command sees them as existing and keeps them covered.
        let second = stubs.begin(
            &folder,
            Masks {
                existing: vec![],
                missing_dirs: vec![folder.join(".vscode")],
                missing_files: vec![folder.join(".envrc")],
            },
        );
        assert!(second.missing_dirs.is_empty() && second.missing_files.is_empty());
        assert_eq!(second.existing.len(), 2);
        stubs.end(&folder);
        assert!(
            folder.join(".envrc").exists(),
            "the second command still runs"
        );
        // The owner wrote a real .npmrc meanwhile: it stays.
        std::fs::write(folder.join(".npmrc"), "registry=x").unwrap();
        stubs.end(&folder);
        assert!(!folder.join(".envrc").exists());
        assert!(!folder.join(".vscode").exists());
        assert!(folder.join(".npmrc").exists());
    }
}
