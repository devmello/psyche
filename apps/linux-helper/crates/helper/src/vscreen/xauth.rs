//! The X authority file for the virtual display (`Xvfb -auth <file>`): one MIT-MAGIC-COOKIE-1
//! entry, mode 0600, under `$XDG_RUNTIME_DIR/psyche`. Written by hand (the `xauth` tool is not
//! always installed). The same cookie is handed to our own X connections in memory and to the
//! apps we launch through `XAUTHORITY`.

use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const AUTH_NAME: &[u8] = b"MIT-MAGIC-COOKIE-1";
const FAMILY_LOCAL: u16 = 256;

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

/// The binary Xauthority entry for a local connection to `display_number`.
pub fn entry_bytes(hostname: &str, display_number: u32, cookie: &Cookie) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&FAMILY_LOCAL.to_be_bytes());
    push_counted(&mut out, hostname.as_bytes());
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

/// Writes the authority file (0600, replacing any older one).
pub fn write_file(path: &Path, hostname: &str, display_number: u32, cookie: &Cookie) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&entry_bytes(hostname, display_number, cookie))
}

pub fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_has_the_xauthority_layout() {
        let cookie = [7u8; 16];
        let bytes = entry_bytes("box", 90, &cookie);
        let mut want = vec![1, 0, 0, 3];
        want.extend_from_slice(b"box");
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
        assert_eq!(std::fs::metadata(&rt).unwrap().permissions().mode() & 0o777, 0o700);
        let file = rt.join("xauth-90");
        write_file(&file, "box", 90, &[1u8; 16]).unwrap();
        write_file(&file, "box", 90, &[2u8; 16]).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn cookies_differ() {
        assert_ne!(new_cookie().unwrap(), new_cookie().unwrap());
    }
}
