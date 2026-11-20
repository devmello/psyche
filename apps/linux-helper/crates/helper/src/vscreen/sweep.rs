//! What a crashed helper leaves behind, cleared when the next one starts.
//!
//! Xvfb, the private bus and the accessibility launcher die with the helper (PDEATHSIG). Apps do
//! not (they are the owner's work, in their own scopes), and nothing removes the session dirs.
//! Every scope and dir carries the pid of the helper that made it (`psyche-vs-<pid>-...`,
//! `vs-<pid>-...`, `psyche-vscreen-<pid>-...`), so the next helper removes only those whose pid
//! no longer runs. A pid that runs (another helper, or a reused pid) keeps its things: the sweep
//! errs on leaving something behind.

use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Whether `pid` is a running process (one we may not signal still counts).
pub fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The names whose owner pid (`owner_of`) is known, is not ours and no longer runs.
pub fn stale<'a>(
    names: impl Iterator<Item = &'a str>,
    owner_of: impl Fn(&str) -> Option<u32>,
    me: u32,
    alive: &dyn Fn(u32) -> bool,
) -> Vec<&'a str> {
    names
        .filter(|n| owner_of(n).is_some_and(|pid| pid != me && !alive(pid)))
        .collect()
}

/// The pid in `<prefix><pid>-<rest>`.
pub fn dir_owner_pid(name: &str, prefix: &str) -> Option<u32> {
    let rest = name.strip_prefix(prefix)?;
    let (pid, tail) = rest.split_once('-')?;
    if tail.is_empty() || pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// Removes `<base>/<prefix><pid>-*` directories of dead helpers, ours only (a real directory,
/// owned by this uid), with `rmtree`. Returns what it removed.
pub fn sweep_dirs(base: &Path, prefix: &str, me: u32, alive: &dyn Fn(u32) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    // SAFETY: geteuid has no preconditions.
    let euid = unsafe { libc::geteuid() };
    let mut removed = Vec::new();
    for name in stale(
        names.iter().map(String::as_str),
        |n| dir_owner_pid(n, prefix),
        me,
        alive,
    ) {
        let path = base.join(name);
        let Ok(st) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !st.is_dir() || st.file_type().is_symlink() || st.uid() != euid {
            continue;
        }
        super::rmtree::remove_tree_logged(&path, "leftover session dir");
        if std::fs::symlink_metadata(&path).is_err() {
            removed.push(path);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dead_helpers_things_are_stale() {
        let alive = |pid: u32| pid == 500;
        let names = [
            "psyche-vs-100-bus-90-1.scope", // dead helper
            "psyche-vs-500-bus-91-2.scope", // a live helper
            "psyche-vs-42-firefox-3.scope", // ours (me = 42)
            "psyche-vs-display-90-7.scope", // no pid: not ours to judge
            "other.scope",
        ];
        assert_eq!(
            stale(
                names.iter().copied(),
                super::super::scope::unit_owner_pid,
                42,
                &alive
            ),
            ["psyche-vs-100-bus-90-1.scope"]
        );
    }

    #[test]
    fn pids_are_read_from_dir_names() {
        assert_eq!(dir_owner_pid("vs-123-abcdef", "vs-"), Some(123));
        assert_eq!(
            dir_owner_pid("psyche-vscreen-9-Ab3xYz", "psyche-vscreen-"),
            Some(9)
        );
        for bad in ["vs-abcdef", "vs-12", "vs--x", "xvs-1-a", "vs-1a-b"] {
            assert_eq!(dir_owner_pid(bad, "vs-"), None, "{bad}");
        }
    }

    #[test]
    fn the_sweep_removes_dead_helpers_dirs_and_nothing_else() {
        let base = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "owner's").unwrap();
        for d in [
            "vs-100-aaaa/bus-dir",
            "vs-500-bbbb",
            "vs-42-cccc",
            "vs-dddd",
        ] {
            std::fs::create_dir_all(base.path().join(d)).unwrap();
        }
        std::fs::write(base.path().join("vs-100-aaaa/bus-dir/f"), "x").unwrap();
        // A dead helper's name on a symlink: never followed, never swept as a dir.
        std::os::unix::fs::symlink(outside.path(), base.path().join("vs-101-eeee")).unwrap();
        // A file, not a dir.
        std::fs::write(base.path().join("vs-102-ffff"), "x").unwrap();
        let removed = sweep_dirs(base.path(), "vs-", 42, &|pid| pid == 500);
        assert_eq!(removed, [base.path().join("vs-100-aaaa")]);
        for kept in ["vs-500-bbbb", "vs-42-cccc", "vs-dddd", "vs-102-ffff"] {
            assert!(base.path().join(kept).exists(), "{kept}");
        }
        assert!(outside.path().join("keep").is_file());
    }

    #[test]
    fn our_own_pid_counts_as_alive() {
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0));
        assert!(!pid_alive(u32::MAX));
    }
}
