//! Removing a directory tree the virtual screen made, without leaving it.
//!
//! `std::fs::remove_dir_all` walks into mount points. A session dir can hold FUSE mounts (gvfs,
//! the document portal) that map to the owner's real files, and a teardown that walked into a
//! live one would delete them. So this walk:
//! - opens every directory relative to its parent's descriptor with `O_NOFOLLOW`, so a symlink
//!   (or a directory swapped for one mid-walk) is never followed, only unlinked;
//! - compares each directory's `st_dev` with the root's, before and after opening it, and leaves
//!   any directory on another device (a mount point) and everything under it alone;
//! - keeps going past entries it cannot read (a dead FUSE mount answers `ENOTCONN`), and reports
//!   how many it left.

use std::ffi::{CStr, CString, OsStr};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// What a removal left behind.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Removal {
    /// Directories skipped because they are on another device (mount points).
    pub other_devices: usize,
    /// Entries that could not be read or removed.
    pub failed: usize,
    /// Whether the root itself is gone.
    pub root_removed: bool,
}

fn cstr(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `st` is valid for the write fstat makes.
    if unsafe { libc::fstat(fd, st.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded, so `st` is initialised.
    Ok(unsafe { st.assume_init() })
}

fn lstat_at(dir: RawFd, name: &CStr) -> io::Result<libc::stat> {
    let mut st = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `name` is NUL-terminated and `st` is valid for the write.
    if unsafe {
        libc::fstatat(
            dir,
            name.as_ptr(),
            st.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstatat succeeded.
    Ok(unsafe { st.assume_init() })
}

fn open_dir_at(dir: RawFd, name: &CStr) -> io::Result<OwnedFd> {
    // SAFETY: `name` is NUL-terminated; the flags never follow a symlink.
    let fd = unsafe {
        libc::openat(
            dir,
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat just returned this descriptor.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// `st_dev` as a u64 (its C type differs between platforms).
#[allow(clippy::unnecessary_cast)]
fn dev_of(st: &libc::stat) -> u64 {
    st.st_dev as u64
}

fn is_dir(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

/// The names in the directory open on `dir` (not `.` or `..`).
fn names(dir: &OwnedFd) -> io::Result<Vec<CString>> {
    // SAFETY: dup of a descriptor we own; fdopendir takes the copy and closedir closes it.
    let copy = unsafe { libc::dup(dir.as_raw_fd()) };
    if copy < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `copy` is an open directory descriptor.
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        // SAFETY: fdopendir failed, so the copy is still ours to close.
        unsafe { libc::close(copy) };
        return Err(io::Error::last_os_error());
    }
    let mut out = Vec::new();
    loop {
        // SAFETY: `stream` is a valid DIR*; the entry is read before the next readdir.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            break;
        }
        // SAFETY: d_name is NUL-terminated within the entry.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            out.push(name.to_owned());
        }
    }
    // SAFETY: closes the stream and the copied descriptor.
    unsafe { libc::closedir(stream) };
    Ok(out)
}

fn unlink_at(dir: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<()> {
    // SAFETY: `name` is NUL-terminated.
    if unsafe { libc::unlinkat(dir, name.as_ptr(), flags) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Empties the directory open on `dir`, staying on `dev`. `foreign` lets tests mark a directory
/// as another device.
fn empty(dir: &OwnedFd, dev: u64, path: &Path, foreign: &dyn Fn(&Path) -> bool, out: &mut Removal) {
    let Ok(entries) = names(dir) else {
        out.failed += 1;
        return;
    };
    for name in entries {
        let child = path.join(OsStr::from_bytes(name.to_bytes()));
        let st = match lstat_at(dir.as_raw_fd(), &name) {
            Ok(st) => st,
            Err(_) => {
                out.failed += 1;
                continue;
            }
        };
        if !is_dir(&st) {
            // Files, sockets and symlinks: the link itself goes, never what it points at.
            if unlink_at(dir.as_raw_fd(), &name, 0).is_err() {
                out.failed += 1;
            }
            continue;
        }
        if dev_of(&st) != dev || foreign(&child) {
            out.other_devices += 1;
            continue;
        }
        let sub = match open_dir_at(dir.as_raw_fd(), &name) {
            Ok(fd) => fd,
            Err(_) => {
                out.failed += 1;
                continue;
            }
        };
        // Something could have been mounted or swapped in between: check what we opened.
        match fstat(sub.as_raw_fd()) {
            Ok(s) if dev_of(&s) == dev && is_dir(&s) => {}
            Ok(_) => {
                out.other_devices += 1;
                continue;
            }
            Err(_) => {
                out.failed += 1;
                continue;
            }
        }
        empty(&sub, dev, &child, foreign, out);
        drop(sub);
        if unlink_at(dir.as_raw_fd(), &name, libc::AT_REMOVEDIR).is_err() {
            out.failed += 1;
        }
    }
}

fn remove_tree_with(root: &Path, foreign: &dyn Fn(&Path) -> bool) -> io::Result<Removal> {
    let parent = root.parent().unwrap_or(Path::new("/"));
    let name = cstr(
        root.file_name()
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?,
    )?;
    let parent_c = cstr(parent.as_os_str())?;
    // SAFETY: NUL-terminated path; the parent is opened as a directory.
    let pfd = unsafe {
        libc::open(
            parent_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if pfd < 0 {
        let e = io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ENOENT) {
            // No parent, so no tree: nothing to remove.
            return Ok(Removal {
                root_removed: true,
                ..Removal::default()
            });
        }
        return Err(e);
    }
    // SAFETY: open just returned it.
    let pfd = unsafe { OwnedFd::from_raw_fd(pfd) };
    let st = match lstat_at(pfd.as_raw_fd(), &name) {
        Ok(st) => st,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {
            return Ok(Removal {
                root_removed: true,
                ..Removal::default()
            })
        }
        Err(e) => return Err(e),
    };
    if !is_dir(&st) {
        // A symlink (or file) where the tree should be: remove the link, follow nothing.
        unlink_at(pfd.as_raw_fd(), &name, 0)?;
        return Ok(Removal {
            root_removed: true,
            ..Removal::default()
        });
    }
    // The root must be on its parent's device: a mount on the session dir or the profile dir
    // itself would otherwise become the device the walk trusts.
    let parent_st = fstat(pfd.as_raw_fd())?;
    if dev_of(&st) != dev_of(&parent_st) || foreign(root) {
        return Err(io::Error::other(format!(
            "{} is on another device than its parent (a mount point); not removing it",
            root.display()
        )));
    }
    let dev = dev_of(&st);
    let rfd = open_dir_at(pfd.as_raw_fd(), &name)?;
    // What was opened must be what was checked.
    let opened = fstat(rfd.as_raw_fd())?;
    if dev_of(&opened) != dev || opened.st_ino != st.st_ino || !is_dir(&opened) {
        return Err(io::Error::other(format!(
            "{} changed while it was being opened; not removing it",
            root.display()
        )));
    }
    let mut out = Removal::default();
    empty(&rfd, dev, root, foreign, &mut out);
    drop(rfd);
    out.root_removed = unlink_at(pfd.as_raw_fd(), &name, libc::AT_REMOVEDIR).is_ok();
    Ok(out)
}

/// Removes `root` and everything under it on the same device, never following a symlink.
pub fn remove_tree(root: &Path) -> io::Result<Removal> {
    remove_tree_with(root, &|_| false)
}

/// `remove_tree`, logging what was left (teardown never fails on it).
pub fn remove_tree_logged(root: &Path, what: &str) {
    match remove_tree(root) {
        Ok(r) if r.other_devices > 0 || r.failed > 0 => crate::log(&format!(
            "vscreen: {what}: left {} mount(s) and {} entr(ies) in place",
            r.other_devices, r.failed
        )),
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => crate::log(&format!("vscreen: {what}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_tree_goes_entirely() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("vs-1");
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::write(root.join("a/b/c/f"), "x").unwrap();
        std::fs::write(root.join("top"), "x").unwrap();
        let r = remove_tree(&root).unwrap();
        assert_eq!(
            r,
            Removal {
                root_removed: true,
                ..Removal::default()
            }
        );
        assert!(!root.exists());
        // Gone already: nothing to do, no error.
        assert!(remove_tree(&root).unwrap().root_removed);
        // Not even the parent exists (a Firefox copy that was never made): no error either.
        let deep = base.path().join("never/made/profile");
        assert!(remove_tree(&deep).unwrap().root_removed);
    }

    #[test]
    fn symlinks_are_removed_and_never_followed() {
        let base = tempfile::tempdir().unwrap();
        let outside = base.path().join("owners-files");
        std::fs::create_dir_all(outside.join("docs")).unwrap();
        std::fs::write(outside.join("docs/thesis.odt"), "precious").unwrap();
        let root = base.path().join("vs-2");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("docs"), root.join("sub/deep")).unwrap();
        std::os::unix::fs::symlink(outside.join("docs/thesis.odt"), root.join("file-link"))
            .unwrap();
        let r = remove_tree(&root).unwrap();
        assert!(r.root_removed);
        assert!(!root.exists());
        assert_eq!(
            std::fs::read_to_string(outside.join("docs/thesis.odt")).unwrap(),
            "precious"
        );
        // A root that is itself a symlink: the link goes, its target stays.
        let root_link = base.path().join("vs-3");
        std::os::unix::fs::symlink(&outside, &root_link).unwrap();
        assert!(remove_tree(&root_link).unwrap().root_removed);
        assert!(std::fs::symlink_metadata(&root_link).is_err());
        assert!(outside.join("docs/thesis.odt").is_file());
    }

    #[test]
    fn a_directory_on_another_device_is_left_alone() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("vs-4");
        // `doc` stands in for the document portal's FUSE mount.
        std::fs::create_dir_all(root.join("doc/by-app")).unwrap();
        std::fs::write(root.join("doc/by-app/exported.pdf"), "owner's").unwrap();
        std::fs::create_dir_all(root.join("tmp")).unwrap();
        std::fs::write(root.join("tmp/x"), "x").unwrap();
        let mount = root.join("doc");
        let r = remove_tree_with(&root, &|p| p == mount).unwrap();
        assert_eq!(r.other_devices, 1);
        assert!(!r.root_removed, "the root stays while a mount is inside it");
        assert!(root.join("doc/by-app/exported.pdf").is_file());
        assert!(
            !root.join("tmp").exists(),
            "everything on our own device went"
        );
    }

    #[test]
    fn a_root_that_is_itself_a_mount_point_is_refused_untouched() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("vs-5");
        std::fs::create_dir_all(root.join("owners")).unwrap();
        std::fs::write(root.join("owners/file"), "owner's").unwrap();
        let r = remove_tree_with(&root, &|p| p == root);
        assert!(r.is_err(), "refused");
        assert!(
            root.join("owners/file").is_file(),
            "nothing under it was removed"
        );
    }
}
