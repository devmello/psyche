//! File helpers: crash-safe JSON records (write to a temp file, flush, rename over), recursive
//! copies that never follow links, sizes.
//!
//! Callers run these while impersonating the owner (`security::Owner`): every path here lies in
//! the owner's profile, so the owner's own rights apply and a junction planted there cannot
//! redirect the service.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{VmError, VmResult};

/// Pretty JSON with sorted keys is not needed (serde preserves declaration order); one record
/// per file, replaced atomically (`MoveFileEx(REPLACE_EXISTING | WRITE_THROUGH)` via `rename`).
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> VmResult<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| VmError::internal(format!("encode: {e}")))?;
    write_atomic(path, &bytes)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> VmResult<()> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    let res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(VmError::io(name, &e));
    }
    Ok(())
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn create_dir_all(path: &Path) -> VmResult<()> {
    fs::create_dir_all(path).map_err(|e| VmError::io(&path.to_string_lossy(), &e))
}

/// Whether `path` itself (not its target) is a symlink or junction.
pub fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.file_type().is_symlink() || is_reparse(&m)).unwrap_or(false)
}

fn is_reparse(m: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// Copies a file or a folder tree. Links inside the tree are skipped (never followed), so a copy
/// cannot pull in files from outside what the caller chose.
pub fn copy_tree(from: &Path, to: &Path) -> VmResult<u64> {
    let meta = fs::symlink_metadata(from).map_err(|e| VmError::io(&from.to_string_lossy(), &e))?;
    if meta.file_type().is_symlink() || is_reparse(&meta) {
        return Ok(0);
    }
    if meta.is_dir() {
        create_dir_all(to)?;
        let mut total = 0;
        for entry in fs::read_dir(from).map_err(|e| VmError::io(&from.to_string_lossy(), &e))? {
            let entry = entry.map_err(|e| VmError::io(&from.to_string_lossy(), &e))?;
            total += copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(total)
    } else {
        fs::copy(from, to).map_err(|e| VmError::io(&from.to_string_lossy(), &e))
    }
}

/// Bytes of a file, or of the regular files in a tree (links not followed).
pub fn size(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if meta.file_type().is_symlink() || is_reparse(&meta) {
        return 0;
    }
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path).map(|rd| rd.filter_map(|e| e.ok()).map(|e| size(&e.path())).sum()).unwrap_or(0)
}

/// Removes a file or tree if present.
pub fn remove(path: &Path) -> VmResult<()> {
    let Ok(meta) = fs::symlink_metadata(path) else { return Ok(()) };
    let res = if meta.is_dir() && !meta.file_type().is_symlink() && !is_reparse(&meta) {
        fs::remove_dir_all(path)
    } else if meta.is_dir() {
        fs::remove_dir(path) // a junction: remove the link, never the target's contents
    } else {
        fs::remove_file(path)
    };
    res.map_err(|e| VmError::io(&path.to_string_lossy(), &e))
}

/// `name 2.ext`, `name 3.ext`, … until free (copy-out never overwrites).
pub fn unique_destination(dir: &Path, file_name: &str) -> std::path::PathBuf {
    let first = dir.join(file_name);
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let p = Path::new(file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = p.extension().and_then(|s| s.to_str());
    (2..)
        .map(|n| {
            dir.join(match ext {
                Some(e) => format!("{stem} {n}.{e}"),
                None => format!("{stem} {n}"),
            })
        })
        .find(|c| fs::symlink_metadata(c).is_err())
        .unwrap_or(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("psyche-vm-fsx-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn json_round_trip_is_atomic() {
        let d = tmp("json");
        let p = d.join("state.json");
        write_json(&p, &serde_json::json!({"phase": "stopped"})).unwrap();
        write_json(&p, &serde_json::json!({"phase": "running"})).unwrap();
        let v: serde_json::Value = read_json(&p).unwrap();
        assert_eq!(v["phase"], "running");
        assert_eq!(fs::read_dir(&d).unwrap().count(), 1, "no temp files left");
        assert!(read_json::<serde_json::Value>(&d.join("missing.json")).is_none());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn copies_trees_and_picks_free_names() {
        let d = tmp("copy");
        fs::create_dir_all(d.join("src").join("sub")).unwrap();
        fs::write(d.join("src").join("a.txt"), "abc").unwrap();
        fs::write(d.join("src").join("sub").join("b.txt"), "de").unwrap();
        assert_eq!(copy_tree(&d.join("src"), &d.join("dst")).unwrap(), 5);
        assert_eq!(size(&d.join("dst")), 5);
        assert_eq!(unique_destination(&d.join("src"), "a.txt"), d.join("src").join("a 2.txt"));
        assert_eq!(unique_destination(&d.join("src"), "sub"), d.join("src").join("sub 2"));
        assert_eq!(unique_destination(&d.join("src"), "new"), d.join("src").join("new"));
        remove(&d.join("dst")).unwrap();
        assert!(!d.join("dst").exists());
        let _ = fs::remove_dir_all(d);
    }
}
