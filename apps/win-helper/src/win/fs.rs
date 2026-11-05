//! File moves that never overwrite.

use std::io;
use std::path::Path;

use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS};
use windows::Win32::Storage::FileSystem::{MOVEFILE_COPY_ALLOWED, MOVEFILE_WRITE_THROUGH, MoveFileExW};
use windows::core::HSTRING;

/// Moves `from` to `to`, failing with `AlreadyExists` if `to` exists (no `MOVEFILE_REPLACE_EXISTING`).
/// Files may cross volumes (copied, then deleted); folders may not (the OS refuses).
pub fn move_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    let a = HSTRING::from(from.as_os_str());
    let b = HSTRING::from(to.as_os_str());
    // SAFETY: both strings are NUL-terminated and live for the call.
    match unsafe { MoveFileExW(&a, &b, MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH) } {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERROR_ALREADY_EXISTS.to_hresult() || e.code() == ERROR_FILE_EXISTS.to_hresult() => {
            Err(io::Error::new(io::ErrorKind::AlreadyExists, "destination exists"))
        }
        Err(e) => Err(io::Error::from_raw_os_error(e.code().0 & 0xFFFF)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn refuses_to_overwrite() {
        let dir = std::env::temp_dir().join(format!("psyche-mv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        assert_eq!(super::move_no_replace(&a, &b).unwrap_err().kind(), std::io::ErrorKind::AlreadyExists);
        std::fs::remove_file(&b).unwrap();
        super::move_no_replace(&a, &b).unwrap();
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "a");
        let _ = std::fs::remove_dir_all(dir);
    }
}
