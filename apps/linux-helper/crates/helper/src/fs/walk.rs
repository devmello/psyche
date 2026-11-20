//! Descriptor-relative file access that never follows a symbolic link below a root.
//!
//! Every path is opened one component at a time from the root's descriptor with `O_NOFOLLOW`,
//! and the last step works on the parent's descriptor (`openat`, `mkdirat`, `unlinkat`,
//! `renameat`). A link swapped in after a check cannot lead out: the open itself refuses it.

use std::ffi::{CStr, CString, OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

/// Why a walk stopped.
#[derive(Debug)]
pub enum WalkError {
    /// A component is a symbolic link.
    Symlink,
    /// A component is missing.
    Missing,
    /// A component is not a directory.
    NotDir,
    Io(io::Error),
}

impl From<io::Error> for WalkError {
    fn from(e: io::Error) -> Self {
        match e.raw_os_error() {
            Some(libc::ENOENT) => WalkError::Missing,
            Some(libc::ELOOP) => WalkError::Symlink,
            Some(libc::ENOTDIR) => WalkError::NotDir,
            _ => WalkError::Io(e),
        }
    }
}

fn cstr(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

/// Opens a root directory (it may itself be reached through links: it is the owner's choice).
pub fn open_root(root: &Path) -> io::Result<OwnedFd> {
    let c = cstr(root.as_os_str())?;
    // SAFETY: a valid C string; the descriptor is owned on success.
    let fd = check(unsafe {
        libc::open(
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    })?;
    // SAFETY: `fd` was just opened and is owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// What `fstatat(AT_SYMLINK_NOFOLLOW)` says of one name.
#[derive(Debug, Clone, Copy)]
pub struct Entry {
    pub mode: u32,
    pub size: u64,
    pub dev: u64,
    pub ino: u64,
    pub nlink: u64,
    pub mtime_ns: i128,
}

impl Entry {
    #[allow(clippy::unnecessary_cast)]
    pub fn kind(&self) -> &'static str {
        match self.mode & libc::S_IFMT as u32 {
            m if m == libc::S_IFREG as u32 => "file",
            m if m == libc::S_IFDIR as u32 => "dir",
            m if m == libc::S_IFLNK as u32 => "symlink",
            _ => "other",
        }
    }
    pub fn is_dir(&self) -> bool {
        self.kind() == "dir"
    }
    pub fn is_file(&self) -> bool {
        self.kind() == "file"
    }
    pub fn etag(&self) -> String {
        format!("{:x}-{:x}-{:x}", self.ino, self.size, self.mtime_ns)
    }
    /// Who it is (`dev:ino`): a folder swapped for another at the same path has a new one.
    pub fn id(&self) -> String {
        format!("{:x}:{:x}", self.dev, self.ino)
    }
    pub fn mtime_ms(&self) -> i64 {
        i64::try_from(self.mtime_ns / 1_000_000).unwrap_or(i64::MAX)
    }
}

#[allow(clippy::unnecessary_cast)]
fn entry_of(st: &libc::stat) -> Entry {
    Entry {
        mode: st.st_mode as u32,
        size: st.st_size as u64,
        dev: st.st_dev as u64,
        ino: st.st_ino as u64,
        nlink: st.st_nlink as u64,
        mtime_ns: i128::from(st.st_mtime as i64) * 1_000_000_000
            + i128::from(st.st_mtime_nsec as i64),
    }
}

/// `fstatat` without following a link.
pub fn stat_at(dir: &OwnedFd, name: &OsStr) -> io::Result<Entry> {
    let c = cstr(name)?;
    // SAFETY: zeroed is a valid `stat`; the call fills it.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid descriptor, C string and out pointer.
    check(unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            c.as_ptr(),
            &mut st,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    })?;
    Ok(entry_of(&st))
}

/// `fstat` of an open descriptor.
pub fn stat_fd(fd: RawFd) -> io::Result<Entry> {
    // SAFETY: zeroed is a valid `stat`; the call fills it.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid descriptor and out pointer.
    check(unsafe { libc::fstat(fd, &mut st) })?;
    Ok(entry_of(&st))
}

/// Opens a directory below `dir` without following a link.
pub fn open_dir_at(dir: &OwnedFd, name: &OsStr) -> Result<OwnedFd, WalkError> {
    let c = cstr(name)?;
    // SAFETY: valid descriptor and C string; the result is owned on success.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let err = io::Error::last_os_error();
        // A link to a directory fails with ELOOP on Linux, ENOTDIR on some systems: ask.
        if let Ok(e) = stat_at(dir, name) {
            if e.kind() == "symlink" {
                return Err(WalkError::Symlink);
            }
        }
        return Err(err.into());
    }
    // SAFETY: owned by nobody else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Walks `parts` below `root`; with `create`, missing directories are made (0755).
pub fn walk(root: &OwnedFd, parts: &[OsString], create: bool) -> Result<OwnedFd, WalkError> {
    let mut cur = root.try_clone().map_err(WalkError::Io)?;
    for part in parts {
        cur = match open_dir_at(&cur, part) {
            Ok(fd) => fd,
            Err(WalkError::Missing) if create => {
                mkdir_at(&cur, part)?;
                open_dir_at(&cur, part)?
            }
            Err(e) => return Err(e),
        };
    }
    Ok(cur)
}

pub fn mkdir_at(dir: &OwnedFd, name: &OsStr) -> io::Result<()> {
    let c = cstr(name)?;
    // SAFETY: valid descriptor and C string.
    check(unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o755) })?;
    Ok(())
}

/// Opens a regular file below `dir` for reading, never through a link and never a FIFO.
pub fn open_file_at(dir: &OwnedFd, name: &OsStr) -> Result<std::fs::File, WalkError> {
    let c = cstr(name)?;
    // SAFETY: valid descriptor and C string; the result is owned on success.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: owned by nobody else.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Creates a new file below `dir` (`O_EXCL`, so never an existing name or a link).
pub fn create_new_at(dir: &OwnedFd, name: &OsStr, mode: u32) -> io::Result<std::fs::File> {
    let c = cstr(name)?;
    // SAFETY: valid descriptor and C string; the result is owned on success.
    let fd = check(unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    })?;
    // SAFETY: owned by nobody else.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// Renames within one directory. The target name is replaced, never followed.
pub fn rename_at(dir: &OwnedFd, from: &OsStr, to: &OsStr) -> io::Result<()> {
    let (a, b) = (cstr(from)?, cstr(to)?);
    // SAFETY: valid descriptors and C strings.
    check(unsafe { libc::renameat(dir.as_raw_fd(), a.as_ptr(), dir.as_raw_fd(), b.as_ptr()) })?;
    Ok(())
}

pub fn unlink_at(dir: &OwnedFd, name: &OsStr, is_dir: bool) -> io::Result<()> {
    let c = cstr(name)?;
    let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: valid descriptor and C string.
    check(unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), flags) })?;
    Ok(())
}

/// The names in a directory (not `.` or `..`), at most `max` (+1 to tell that there were more).
pub fn names(dir: &OwnedFd, max: usize) -> io::Result<Vec<OsString>> {
    // `fdopendir` takes the descriptor, so give it a copy.
    // SAFETY: dup of a valid descriptor.
    let copy = check(unsafe { libc::dup(dir.as_raw_fd()) })?;
    // SAFETY: `copy` is a fresh descriptor that the DIR now owns.
    let d = unsafe { libc::fdopendir(copy) };
    if d.is_null() {
        let e = io::Error::last_os_error();
        // SAFETY: fdopendir failed, so the copy is still ours to close.
        unsafe { libc::close(copy) };
        return Err(e);
    }
    let mut out = Vec::new();
    loop {
        // SAFETY: `d` is a valid DIR stream until closedir.
        let ent = unsafe { libc::readdir(d) };
        if ent.is_null() {
            break;
        }
        // SAFETY: readdir returns a valid entry whose name is NUL-terminated.
        let name = unsafe { CStr::from_ptr((*ent).d_name.as_ptr()) };
        let bytes = name.to_bytes();
        if bytes == b"." || bytes == b".." {
            continue;
        }
        out.push(OsStr::from_bytes(bytes).to_os_string());
        if out.len() > max {
            break;
        }
    }
    // SAFETY: closes the stream and its descriptor.
    unsafe { libc::closedir(d) };
    Ok(out)
}

/// Removes a tree below `dir` without following any link (a link is removed, not entered).
/// Stops after `budget` entries.
pub fn remove_tree_at(dir: &OwnedFd, name: &OsStr, budget: &mut usize) -> Result<(), WalkError> {
    if *budget == 0 {
        return Err(WalkError::Io(io::Error::other("too many entries")));
    }
    *budget -= 1;
    let e = stat_at(dir, name)?;
    if !e.is_dir() {
        unlink_at(dir, name, false)?;
        return Ok(());
    }
    let sub = open_dir_at(dir, name)?;
    for child in names(&sub, usize::MAX)? {
        remove_tree_at(&sub, &child, budget)?;
    }
    drop(sub);
    unlink_at(dir, name, true)?;
    Ok(())
}
