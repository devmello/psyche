//! VHDX operations (`virtdisk.dll`): dynamic session disks, differencing children over a
//! read-only parent (the image's `rootfs.vhdx`, or a snapshot layer), the parent of a child, and
//! a flattened copy of a chain (image export). No disk is ever attached on the host.
//!
//! Behind `DiskOps` so snapshot logic is tested with `FakeDisks` (small JSON files that record
//! their parent).

use std::path::{Path, PathBuf};

use crate::error::{VmError, VmResult};

pub trait DiskOps: Send + Sync {
    /// A new dynamic VHDX of `size_bytes` (unformatted; the guest formats it on first boot).
    fn create_dynamic(&self, path: &Path, size_bytes: u64) -> VmResult<()>;
    /// A new differencing VHDX whose parent is `parent` (absolute path).
    fn create_differencing(&self, path: &Path, parent: &Path) -> VmResult<()>;
    /// The parent a differencing disk names, `None` for a base disk.
    fn parent_of(&self, path: &Path) -> VmResult<Option<PathBuf>>;
    /// A new standalone VHDX with the full content of `source` (its chain merged).
    fn flatten_copy(&self, source: &Path, dest: &Path) -> VmResult<()>;
}

fn disk_error(what: &str, path: &Path, code: u32) -> VmError {
    let reason = match code {
        112 => "disk_full",
        5 => "access_denied",
        32 | 33 => "disk_in_use",
        2 | 3 => "not_found",
        _ => "vhd_error",
    };
    VmError::unavailable(reason, format!("{what} {} failed (Win32 error {code})", path.display())).detail("win32", code)
}

/// The real implementation.
pub struct VirtDisk;

#[cfg(windows)]
mod real {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WIN32_ERROR};
    use windows::Win32::Storage::Vhd::*;
    use windows::core::{GUID, HSTRING, PCWSTR};

    fn vhdx_type() -> VIRTUAL_STORAGE_TYPE {
        VIRTUAL_STORAGE_TYPE { DeviceId: VIRTUAL_STORAGE_TYPE_DEVICE_VHDX, VendorId: VIRTUAL_STORAGE_TYPE_VENDOR_MICROSOFT }
    }

    struct Disk(HANDLE);
    impl Drop for Disk {
        fn drop(&mut self) {
            // SAFETY: the handle came from Create/OpenVirtualDisk and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn check(what: &str, path: &Path, e: WIN32_ERROR) -> VmResult<()> {
        if e.0 == 0 { Ok(()) } else { Err(disk_error(what, path, e.0)) }
    }

    /// `CreateVirtualDisk` version 2 (parent, source and size as given).
    fn create(path: &Path, size: u64, block: u32, parent: Option<&Path>, source: Option<&Path>) -> VmResult<()> {
        let path_w = HSTRING::from(path.as_os_str());
        let parent_w = parent.map(|p| HSTRING::from(p.as_os_str()));
        let source_w = source.map(|p| HSTRING::from(p.as_os_str()));
        let mut params = CREATE_VIRTUAL_DISK_PARAMETERS { Version: CREATE_VIRTUAL_DISK_VERSION_2, ..Default::default() };
        params.Anonymous.Version2 = CREATE_VIRTUAL_DISK_PARAMETERS_0_1 {
            UniqueId: GUID::zeroed(),
            MaximumSize: size,
            BlockSizeInBytes: block,
            SectorSizeInBytes: 0,
            PhysicalSectorSizeInBytes: 0,
            ParentPath: parent_w.as_ref().map(|h| PCWSTR(h.as_ptr())).unwrap_or(PCWSTR::null()),
            SourcePath: source_w.as_ref().map(|h| PCWSTR(h.as_ptr())).unwrap_or(PCWSTR::null()),
            OpenFlags: OPEN_VIRTUAL_DISK_FLAG_NONE,
            ParentVirtualStorageType: if parent.is_some() { vhdx_type() } else { VIRTUAL_STORAGE_TYPE::default() },
            SourceVirtualStorageType: if source.is_some() { vhdx_type() } else { VIRTUAL_STORAGE_TYPE::default() },
            ResiliencyGuid: GUID::zeroed(),
        };
        let mut handle = HANDLE::default();
        let ty = vhdx_type();
        // SAFETY: every pointer in `params` outlives the call; the handle is closed by `Disk`.
        let e = unsafe {
            CreateVirtualDisk(&ty, &path_w, VIRTUAL_DISK_ACCESS_NONE, None, CREATE_VIRTUAL_DISK_FLAG_NONE, 0, &params, None, &mut handle)
        };
        let what = if source.is_some() { "Copying the disk to" } else { "Creating" };
        check(what, path, e)?;
        drop(Disk(handle));
        Ok(())
    }

    impl DiskOps for VirtDisk {
        fn create_dynamic(&self, path: &Path, size_bytes: u64) -> VmResult<()> {
            // 1 MiB blocks keep a sparse ext4 disk small (what WSL uses for ext4.vhdx).
            create(path, size_bytes, 1 << 20, None, None)
        }

        fn create_differencing(&self, path: &Path, parent: &Path) -> VmResult<()> {
            create(path, 0, 0, Some(parent), None)
        }

        fn flatten_copy(&self, source: &Path, dest: &Path) -> VmResult<()> {
            create(dest, 0, 0, None, Some(source))
        }

        fn parent_of(&self, path: &Path) -> VmResult<Option<PathBuf>> {
            let path_w = HSTRING::from(path.as_os_str());
            let mut open = OPEN_VIRTUAL_DISK_PARAMETERS { Version: OPEN_VIRTUAL_DISK_VERSION_2, ..Default::default() };
            open.Anonymous.Version2 =
                OPEN_VIRTUAL_DISK_PARAMETERS_0_1 { GetInfoOnly: true.into(), ReadOnly: true.into(), ResiliencyGuid: GUID::zeroed() };
            let mut handle = HANDLE::default();
            let ty = vhdx_type();
            // SAFETY: plain call; the handle is closed by `Disk`.
            let e = unsafe {
                OpenVirtualDisk(&ty, &path_w, VIRTUAL_DISK_ACCESS_NONE, OPEN_VIRTUAL_DISK_FLAG_NO_PARENTS, Some(&open), &mut handle)
            };
            check("Opening", path, e)?;
            let disk = Disk(handle);
            // A parent locator list is a few paths: 64 KiB is ample.
            let mut buf = vec![0u64; 8192];
            let mut size = (buf.len() * 8) as u32;
            let info = buf.as_mut_ptr() as *mut GET_VIRTUAL_DISK_INFO;
            // SAFETY: `info` points at a zeroed, 8-aligned buffer of `size` bytes.
            unsafe { (*info).Version = GET_VIRTUAL_DISK_INFO_PARENT_LOCATION };
            // SAFETY: as above; the call writes at most `size` bytes.
            let e = unsafe { GetVirtualDiskInformation(disk.0, &mut size, info, None) };
            // ERROR_VHD_INVALID_TYPE (0xC03A001B as a Win32 code 0x1B... reported for base disks).
            if e.0 != 0 {
                return if e.0 == 0xC03A_001B || e.0 == 87 { Ok(None) } else { Err(disk_error("Reading the parent of", path, e.0)) };
            }
            // SAFETY: on success the union holds ParentLocation: BOOL + a multi-sz of paths.
            let first = unsafe {
                let loc = std::ptr::addr_of!((*info).Anonymous.ParentLocation.ParentLocationBuffer) as *const u16;
                let max = (size as usize).saturating_sub(loc as usize - info as usize) / 2;
                let s = std::slice::from_raw_parts(loc, max);
                let end = s.iter().position(|c| *c == 0).unwrap_or(s.len());
                String::from_utf16_lossy(&s[..end])
            };
            Ok((!first.is_empty()).then(|| PathBuf::from(first.strip_prefix(r"\\?\").unwrap_or(&first))))
        }
    }
}

/// Test double: a "disk" is a JSON file `{"kind": "dynamic"|"differencing"|"flat", "parent", "size"}`.
#[derive(Default)]
pub struct FakeDisks;

impl DiskOps for FakeDisks {
    fn create_dynamic(&self, path: &Path, size_bytes: u64) -> VmResult<()> {
        if path.exists() {
            return Err(disk_error("Creating", path, 80));
        }
        std::fs::write(path, serde_json::json!({"kind": "dynamic", "size": size_bytes}).to_string()).map_err(|e| VmError::io("disk", &e))
    }

    fn create_differencing(&self, path: &Path, parent: &Path) -> VmResult<()> {
        if path.exists() {
            return Err(disk_error("Creating", path, 80));
        }
        if !parent.is_file() {
            return Err(disk_error("Creating", path, 2));
        }
        std::fs::write(path, serde_json::json!({"kind": "differencing", "parent": parent}).to_string()).map_err(|e| VmError::io("disk", &e))
    }

    fn parent_of(&self, path: &Path) -> VmResult<Option<PathBuf>> {
        let v: serde_json::Value = crate::fsx::read_json(path).ok_or_else(|| disk_error("Opening", path, 2))?;
        Ok(v["parent"].as_str().map(PathBuf::from))
    }

    fn flatten_copy(&self, source: &Path, dest: &Path) -> VmResult<()> {
        if !source.is_file() {
            return Err(disk_error("Copying the disk to", dest, 2));
        }
        std::fs::write(dest, serde_json::json!({"kind": "flat", "from": source}).to_string()).map_err(|e| VmError::io("disk", &e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psyche-vm-vhd-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// virtdisk works without elevation for create / open-info (no attach), so this runs live.
    #[test]
    fn virtdisk_creates_chains_and_reports_parents() {
        let d = tmp("real");
        let base = d.join("base.vhdx");
        let child = d.join("child.vhdx");
        let grandchild = d.join("grandchild.vhdx");
        let ops = VirtDisk;
        ops.create_dynamic(&base, 1 << 30).unwrap();
        assert!(std::fs::metadata(&base).unwrap().len() < 16 << 20, "dynamic disks start small");
        assert_eq!(ops.parent_of(&base).unwrap(), None);
        ops.create_differencing(&child, &base).unwrap();
        ops.create_differencing(&grandchild, &child).unwrap();
        let p = ops.parent_of(&grandchild).unwrap().unwrap();
        assert!(p.to_string_lossy().eq_ignore_ascii_case(&child.to_string_lossy()), "{p:?}");
        let flat = d.join("flat.vhdx");
        ops.flatten_copy(&grandchild, &flat).unwrap();
        assert_eq!(ops.parent_of(&flat).unwrap(), None);
        let e = ops.create_differencing(&d.join("orphan.vhdx"), &d.join("missing.vhdx")).unwrap_err();
        assert_eq!(e.code, crate::error::Code::Unavailable);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn fake_disks_record_parents() {
        let d = tmp("fake");
        let f = FakeDisks;
        f.create_dynamic(&d.join("a"), 10).unwrap();
        f.create_differencing(&d.join("b"), &d.join("a")).unwrap();
        assert_eq!(f.parent_of(&d.join("b")).unwrap(), Some(d.join("a")));
        assert_eq!(f.parent_of(&d.join("a")).unwrap(), None);
        assert!(f.create_differencing(&d.join("c"), &d.join("zz")).is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}
