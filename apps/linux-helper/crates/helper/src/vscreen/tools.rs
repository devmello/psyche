//! The programs the helper starts itself (the service manager's tools, the X server, the bus).
//!
//! They are found once, by absolute path, in folders only root writes. The helper never looks
//! them up through `$PATH`: the account's own manager can change what `$PATH` says, and a program
//! of the account's in front would become the launcher or the screen of the helper.

use std::path::{Path, PathBuf};

/// Where a tool may live, in order. `/usr/sbin` and `/sbin` only for tools that ship there.
pub const BIN_DIRS: &[&str] = &["/usr/bin", "/bin"];
pub const SBIN_DIRS: &[&str] = &["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/// The PATH every helper child that needs one gets, whatever the helper inherited.
pub const FIXED_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// `name` in the first of `dirs` that has it. When none does, the path in the first folder, so
/// starting it fails with an error that names an absolute path.
pub fn find_in(name: &str, dirs: &[&str]) -> PathBuf {
    debug_assert!(!name.contains('/'));
    dirs.iter()
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| Path::new(dirs[0]).join(name))
}

pub fn systemd_run() -> PathBuf {
    find_in("systemd-run", BIN_DIRS)
}
pub fn systemctl() -> PathBuf {
    find_in("systemctl", BIN_DIRS)
}
pub fn busctl() -> PathBuf {
    find_in("busctl", BIN_DIRS)
}
pub fn xvfb() -> PathBuf {
    find_in("Xvfb", SBIN_DIRS)
}
pub fn dbus_daemon() -> PathBuf {
    find_in("dbus-daemon", SBIN_DIRS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_is_found_only_in_the_listed_folders() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("fake"), "x").unwrap();
        // Present in the folder: found there. Absent: the first folder's path, still absolute.
        assert_eq!(find_in("fake", &[&d]), dir.path().join("fake"));
        assert_eq!(find_in("nothere", &["/usr/bin"]), Path::new("/usr/bin/nothere"));
        for p in [systemd_run(), systemctl(), busctl(), xvfb(), dbus_daemon()] {
            assert!(p.is_absolute(), "{p:?}");
        }
    }

    #[test]
    fn the_path_the_helper_passes_on_is_fixed() {
        assert_eq!(FIXED_PATH, "/usr/local/bin:/usr/bin:/bin");
    }
}
