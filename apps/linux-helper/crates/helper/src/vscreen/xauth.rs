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
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

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

/// `$XDG_RUNTIME_DIR/psyche`, created 0700 (falls back to the temp dir only when there is no
/// runtime dir, which is a test setup).
pub fn runtime_dir(xdg_runtime_dir: Option<&str>) -> std::io::Result<PathBuf> {
    let base = xdg_runtime_dir
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join("psyche");
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
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
