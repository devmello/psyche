//! The X authority file for the virtual display (`Xvfb -auth <file>`): one MIT-MAGIC-COOKIE-1
//! entry, mode 0600, under `$XDG_RUNTIME_DIR/psyche`. Written by hand (the `xauth` tool is not
//! always installed). The same cookie is handed to our own X connections in memory and to the
//! apps we launch through `XAUTHORITY`.
//!
//! The entry is FamilyWild (any address, this display number), so a hostname change on a
//! headless box does not lock new apps out. That is safe here: the file is private to the owner,
//! and the cookie is random per start and only ever accepted by our own server.
//!
//! Every start gets its own file name (`xauth-<n>-<random>`), so a late cleanup of an older
//! server can never delete the file a newer server on the same display number uses.

use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const AUTH_NAME: &[u8] = b"MIT-MAGIC-COOKIE-1";
/// Matches any address (Xauth.h `FamilyWild`).
const FAMILY_WILD: u16 = 0xffff;

pub type Cookie = [u8; 16];

pub fn new_cookie() -> std::io::Result<Cookie> {
    let mut cookie = [0u8; 16];
    getrandom::fill(&mut cookie).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(cookie)
}

fn push_counted(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// The binary Xauthority entry for any connection to `display_number`.
pub fn entry_bytes(display_number: u32, cookie: &Cookie) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&FAMILY_WILD.to_be_bytes());
    push_counted(&mut out, b"");
    push_counted(&mut out, display_number.to_string().as_bytes());
    push_counted(&mut out, AUTH_NAME);
    push_counted(&mut out, cookie);
    out
}

fn refuse(path: &Path, why: &str) -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        format!("{}: {why}", path.display()),
    )
}

/// A directory this user owns, seen without following a symlink: not a symlink, a directory,
/// owned by the effective uid, and (with `private`) not reachable by anyone else.
fn check_owned_dir(path: &Path, private: bool) -> std::io::Result<std::fs::Metadata> {
    let st = std::fs::symlink_metadata(path)?;
    if st.file_type().is_symlink() {
        return Err(refuse(path, "is a symlink"));
    }
    if !st.is_dir() {
        return Err(refuse(path, "is not a directory"));
    }
    // SAFETY: geteuid has no preconditions.
    if st.uid() != unsafe { libc::geteuid() } {
        return Err(refuse(path, "belongs to another user"));
    }
    if private && st.mode() & 0o077 != 0 {
        return Err(refuse(path, "is open to other users"));
    }
    Ok(st)
}

/// Where the virtual screen keeps its authority files and session dirs.
///
/// - With `$XDG_RUNTIME_DIR`: `<it>/psyche`. The runtime dir must be ours and not writable by
///   others; `psyche` is made with `mkdir` (never through a symlink), and an existing one must be
///   ours too, then it is narrowed to 0700.
/// - Without (ssh, cron, a system unit): never a fixed name in `/tmp`, which another account
///   could plant first. A fresh `mkdtemp` directory, 0700 from the start, once per process.
pub fn runtime_dir(xdg_runtime_dir: Option<&str>) -> std::io::Result<PathBuf> {
    let Some(base) = xdg_runtime_dir.filter(|b| !b.is_empty()) else {
        return private_temp_dir();
    };
    let base = PathBuf::from(base);
    let st = check_owned_dir(&base, false)?;
    if st.mode() & 0o022 != 0 {
        return Err(refuse(&base, "is writable by other users"));
    }
    let dir = base.join("psyche");
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let st = check_owned_dir(&dir, false)?;
    if st.mode() & 0o077 != 0 {
        // Ours and not a symlink, inside a directory only we can write: safe to narrow.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    check_owned_dir(&dir, true)?;
    Ok(dir)
}

/// `mkdtemp(<temp dir>/psyche-vscreen-<pid>-XXXXXX)`, checked, made once per process.
fn private_temp_dir() -> std::io::Result<PathBuf> {
    static DIR: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    DIR.get_or_init(|| make_temp_dir(&std::env::temp_dir()).map_err(|e| e.to_string()))
        .clone()
        .map_err(std::io::Error::other)
}

pub fn make_temp_dir(parent: &Path) -> std::io::Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let template = parent.join(format!("psyche-vscreen-{}-XXXXXX", std::process::id()));
    let mut bytes = template.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    // SAFETY: `bytes` is a writable NUL-terminated template; mkdtemp fills in the X's and makes
    // the directory 0700 atomically.
    let made = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
    if made.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    bytes.pop();
    let dir = PathBuf::from(std::ffi::OsStr::from_bytes(&bytes));
    check_owned_dir(&dir, true)?;
    Ok(dir)
}

/// `xauth-<n>-<12 hex digits>`: a fresh name for every start.
pub fn file_name(display_number: u32) -> std::io::Result<String> {
    let mut tag = [0u8; 6];
    getrandom::fill(&mut tag).map_err(|e| std::io::Error::other(e.to_string()))?;
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("xauth-{display_number}-{hex}"))
}

/// Writes the authority file (0600, replacing any older one).
pub fn write_file(path: &Path, display_number: u32, cookie: &Cookie) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&entry_bytes(display_number, cookie))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_has_the_xauthority_layout() {
        let cookie = [7u8; 16];
        let bytes = entry_bytes(90, &cookie);
        // FamilyWild, an empty address, then the display number.
        let mut want = vec![0xff, 0xff, 0, 0];
        want.extend_from_slice(&[0, 2]);
        want.extend_from_slice(b"90");
        want.extend_from_slice(&[0, 18]);
        want.extend_from_slice(AUTH_NAME);
        want.extend_from_slice(&[0, 16]);
        want.extend_from_slice(&cookie);
        assert_eq!(bytes, want);
    }

    #[test]
    fn the_file_is_private_and_the_dir_too() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime_dir(Some(dir.path().to_str().unwrap())).unwrap();
        assert_eq!(
            std::fs::metadata(&rt).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let file = rt.join("xauth-90");
        write_file(&file, 90, &[1u8; 16]).unwrap();
        write_file(&file, 90, &[2u8; 16]).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn without_a_runtime_dir_a_fresh_private_temp_dir_is_used() {
        let a = runtime_dir(None).unwrap();
        assert_ne!(
            a,
            std::env::temp_dir().join("psyche"),
            "never the fixed name"
        );
        assert!(a.starts_with(std::env::temp_dir()));
        assert!(a
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("psyche-vscreen-"));
        let st = std::fs::symlink_metadata(&a).unwrap();
        assert!(st.is_dir() && !st.file_type().is_symlink());
        assert_eq!(st.mode() & 0o777, 0o700);
        assert_eq!(st.uid(), unsafe { libc::geteuid() });
        assert_eq!(runtime_dir(None).unwrap(), a, "one per process");
        assert_eq!(
            runtime_dir(Some("")).unwrap(),
            a,
            "an empty variable counts as none"
        );
        // Each mkdtemp is new.
        let parent = tempfile::tempdir().unwrap();
        assert_ne!(
            make_temp_dir(parent.path()).unwrap(),
            make_temp_dir(parent.path()).unwrap()
        );
    }

    #[test]
    fn a_planted_symlink_or_an_open_runtime_dir_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let rt = base.path().join("rt");
        std::fs::create_dir(&rt).unwrap();
        std::fs::set_permissions(&rt, std::fs::Permissions::from_mode(0o700)).unwrap();
        // `<rt>/psyche` is a symlink someone planted.
        std::os::unix::fs::symlink(elsewhere.path(), rt.join("psyche")).unwrap();
        assert!(runtime_dir(Some(rt.to_str().unwrap())).is_err());
        assert_eq!(
            std::fs::metadata(elsewhere.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            std::fs::metadata(elsewhere.path())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
        );
        // The runtime dir itself is a symlink.
        let link = base.path().join("rt-link");
        std::os::unix::fs::symlink(elsewhere.path(), &link).unwrap();
        assert!(runtime_dir(Some(link.to_str().unwrap())).is_err());
        // The runtime dir is writable by others.
        let open = base.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(runtime_dir(Some(open.to_str().unwrap())).is_err());
        assert!(!open.join("psyche").exists());
        // A good one: `psyche` is made 0700, and an existing 0755 one of ours is narrowed.
        let good = base.path().join("good");
        std::fs::create_dir(&good).unwrap();
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::create_dir(good.join("psyche")).unwrap();
        std::fs::set_permissions(good.join("psyche"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let dir = runtime_dir(Some(good.to_str().unwrap())).unwrap();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn every_start_gets_its_own_file_name() {
        let a = file_name(90).unwrap();
        let b = file_name(90).unwrap();
        assert_ne!(a, b);
        assert!(
            a.starts_with("xauth-90-") && a.len() == "xauth-90-".len() + 12,
            "{a}"
        );
    }

    #[test]
    fn cookies_differ() {
        assert_ne!(new_cookie().unwrap(), new_cookie().unwrap());
    }
}
