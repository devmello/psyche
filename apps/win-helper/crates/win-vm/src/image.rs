//! Guest images (`GuestImage.swift` for the Linux guest): a directory
//! `<images root>\<imageVersion>\` with `vmlinuz`, `initrd`, `rootfs.vhdx` and `manifest.json`:
//!
//! ```json
//! { "format": "psyche-guest-image", "formatVersion": 1, "id": "<imageVersion>",
//!   "guestOS": "linux", "createdAt": "…", "psycheVersion": "…", "kernelCmdline": "…",
//!   "files": [ {"name": "vmlinuz", "bytes": 123, "sha256": "<hex>"}, … ] }
//! ```
//!
//! `files` may also be an object (`{"vmlinuz": {"bytes", "sha256"}}` or `{"vmlinuz": "<hex>"}`).
//! Exactly `vmlinuz`, `initrd` and `rootfs.vhdx` must be listed; other files in the folder are
//! ignored (nothing is copied out of it). Every listed file is hashed before a guest is created
//! from the image and before every boot (cached per service run by size, write time and file
//! id); the manifest's own SHA-256 is pinned in the guest's config at create (and checked against
//! the publisher's `imageSha256` when given), so a swapped image is refused.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{VmError, VmResult};

pub const FORMAT: &str = "psyche-guest-image";
pub const FORMAT_VERSION: u64 = 1;
pub const KERNEL: &str = "vmlinuz";
pub const INITRD: &str = "initrd";
pub const ROOTFS: &str = "rootfs.vhdx";
pub const EXPECTED_FILES: [&str; 3] = [KERNEL, INITRD, ROOTFS];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u64,
    pub id: String,
    #[serde(rename = "guestOS")]
    pub guest_os: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psyche_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel_cmdline: Option<String>,
    pub psyche_installed: bool,
    pub files: Vec<ImageFile>,
}

/// `^[a-z0-9][a-z0-9.-]{0,63}$`
pub fn is_valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'.')
}

fn invalid(msg: impl Into<String>) -> VmError {
    VmError::invalid_params(msg, "image").with_reason("image_invalid")
}

impl VmError {
    fn with_reason(mut self, reason: &str) -> VmError {
        self.reason = reason.into();
        self.details.remove("field");
        self
    }
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Parses `manifest.json` (no file access).
pub fn parse_manifest(bytes: &[u8]) -> VmResult<Manifest> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| invalid("manifest.json is not JSON"))?;
    if v["format"].as_str() != Some(FORMAT) {
        return Err(invalid("manifest.json is not a Psyche guest image"));
    }
    let version = v["formatVersion"].as_u64().unwrap_or(0);
    if version != FORMAT_VERSION {
        return Err(VmError::unavailable(
            "image_version_unsupported",
            format!("Guest image format {version} is not supported by this service"),
        ));
    }
    let id = v["id"].as_str().unwrap_or_default().to_owned();
    if !is_valid_id(&id) {
        return Err(invalid("The image id must match ^[a-z0-9][a-z0-9.-]{0,63}$"));
    }
    let mut files = Vec::new();
    let entry = |name: &str, f: &Value| -> VmResult<ImageFile> {
        let (sha, bytes) = match f {
            Value::String(s) => (s.clone(), None),
            o => (o["sha256"].as_str().unwrap_or_default().to_owned(), o["bytes"].as_u64().or(o["size"].as_u64())),
        };
        if !is_hex64(&sha) {
            return Err(invalid(format!("{name} has no SHA-256 in the manifest")));
        }
        Ok(ImageFile { name: name.to_owned(), bytes: bytes.unwrap_or(u64::MAX), sha256: sha.to_ascii_lowercase() })
    };
    match &v["files"] {
        Value::Array(a) => {
            for f in a {
                files.push(entry(f["name"].as_str().unwrap_or_default(), f)?);
            }
        }
        Value::Object(o) => {
            for (k, f) in o {
                files.push(entry(k, f)?);
            }
        }
        _ => return Err(invalid("The image manifest lists no files")),
    }
    let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    names.sort_unstable();
    let mut want = EXPECTED_FILES.to_vec();
    want.sort_unstable();
    if names != want {
        return Err(invalid(format!("The image must list exactly {}", want.join(", "))));
    }
    let cmdline = v["kernelCmdline"].as_str().map(str::to_owned);
    if let Some(c) = &cmdline
        && (c.len() > 1024 || c.chars().any(|ch| ch.is_control()))
    {
        return Err(invalid("kernelCmdline is too long or has control characters"));
    }
    Ok(Manifest {
        format: FORMAT.into(),
        format_version: FORMAT_VERSION,
        id,
        guest_os: v["guestOS"].as_str().unwrap_or("linux").to_owned(),
        created_at: v["createdAt"].as_str().unwrap_or_default().to_owned(),
        psyche_version: v["psycheVersion"].as_str().map(str::to_owned),
        kernel_cmdline: cmdline,
        psyche_installed: v["psycheInstalled"].as_bool().unwrap_or(true),
        files,
    })
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    crate::paths::sha256_hex(bytes)
}

/// Streams the file in 8 MiB chunks; `progress` gets the bytes hashed so far.
pub fn sha256_file(path: &Path, mut progress: impl FnMut(u64)) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut done = 0u64;
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        done += n as u64;
        progress(done);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// A verified image on disk.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub dir: PathBuf,
    pub manifest: Manifest,
    pub manifest_sha256: String,
}

impl Image {
    pub fn kernel(&self) -> PathBuf {
        self.dir.join(KERNEL)
    }
    pub fn initrd(&self) -> PathBuf {
        self.dir.join(INITRD)
    }
    pub fn rootfs(&self) -> PathBuf {
        self.dir.join(ROOTFS)
    }
    pub fn bytes(&self) -> u64 {
        self.manifest.files.iter().filter(|f| f.bytes != u64::MAX).map(|f| f.bytes).sum()
    }
}

/// Per-run cache of hashed files: (path, size, write time, file index) → SHA-256.
#[derive(Default)]
pub struct VerifyCache(Mutex<HashMap<String, (u64, u64, u64, String)>>);

fn identity(path: &Path) -> Option<(u64, u64, u64)> {
    use std::os::windows::fs::MetadataExt;
    let m = std::fs::symlink_metadata(path).ok()?;
    if !m.is_file() || m.file_type().is_symlink() {
        return None;
    }
    // File index is not exposed by std; size + write time + creation time stand in.
    Some((m.file_size(), m.last_write_time(), m.creation_time()))
}

impl VerifyCache {
    fn hash(&self, path: &Path, progress: &mut dyn FnMut(u64)) -> VmResult<String> {
        let key = path.to_string_lossy().to_lowercase();
        let id = identity(path)
            .ok_or_else(|| VmError::policy_denied("image_checksum_mismatch", format!("{} is not a regular file", path.display())))?;
        if let Some((s, w, c, sha)) = self.0.lock().unwrap().get(&key)
            && (*s, *w, *c) == id
        {
            return Ok(sha.clone());
        }
        let sha = sha256_file(path, progress).map_err(|e| VmError::io(&path.to_string_lossy(), &e))?;
        // Only cache when the file did not change while it was read.
        if identity(path) == Some(id) {
            self.0.lock().unwrap().insert(key, (id.0, id.1, id.2, sha.clone()));
        }
        Ok(sha)
    }
}

/// Verifies an image directory: the manifest (against `expected_manifest_sha` when given), then
/// size and SHA-256 of each listed file.
pub fn verify(dir: &Path, expected_manifest_sha: Option<&str>, cache: &VerifyCache, mut progress: impl FnMut(f64)) -> VmResult<Image> {
    let manifest_path = dir.join("manifest.json");
    let bytes = std::fs::read(&manifest_path)
        .map_err(|_| VmError::not_found("image_not_found", format!("No guest image (manifest.json) at {}", dir.display())))?;
    let manifest_sha = sha256_hex(&bytes);
    if let Some(expected) = expected_manifest_sha
        && !expected.eq_ignore_ascii_case(&manifest_sha)
    {
        return Err(VmError::policy_denied("image_checksum_mismatch", "The image manifest does not match the expected checksum")
            .detail("expected", expected.to_ascii_lowercase())
            .detail("actual", manifest_sha.as_str()));
    }
    let manifest = parse_manifest(&bytes)?;
    let total = manifest.files.iter().map(|f| f.bytes.min(1 << 40)).sum::<u64>().max(1);
    let mut hashed = 0u64;
    for f in &manifest.files {
        let path = dir.join(&f.name);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| {
            VmError::policy_denied("image_checksum_mismatch", format!("{} is missing", f.name)).detail("file", f.name.as_str())
        })?;
        if !meta.is_file() || (f.bytes != u64::MAX && meta.len() != f.bytes) {
            return Err(VmError::policy_denied("image_checksum_mismatch", format!("{} is not the file the manifest describes", f.name))
                .detail("file", f.name.as_str()));
        }
        let base = hashed;
        let actual = cache.hash(&path, &mut |n| progress((base + n) as f64 / total as f64))?;
        if actual != f.sha256 {
            return Err(VmError::policy_denied("image_checksum_mismatch", format!("{} does not match its checksum", f.name))
                .detail("file", f.name.as_str()));
        }
        hashed += meta.len();
    }
    Ok(Image { dir: dir.to_path_buf(), manifest, manifest_sha256: manifest_sha })
}

/// Image folders under the root (no hashing): `{version, id, guestOS, createdAt, sizeBytes,
/// manifestSha256, valid, reason?}`, newest `createdAt` first.
pub fn list(root: &Path) -> Vec<Value> {
    let mut out: Vec<Value> = std::fs::read_dir(root)
        .map(|rd| rd.filter_map(|e| e.ok()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let version = e.file_name().to_str()?.to_owned();
            if !is_valid_id(&version) {
                return None;
            }
            let bytes = std::fs::read(e.path().join("manifest.json")).ok()?;
            let sha = sha256_hex(&bytes);
            Some(match parse_manifest(&bytes) {
                Ok(m) => serde_json::json!({
                    "version": version, "id": m.id, "guestOS": m.guest_os, "createdAt": m.created_at,
                    "psycheVersion": m.psyche_version, "sizeBytes": m.files.iter().filter(|f| f.bytes != u64::MAX).map(|f| f.bytes).sum::<u64>(),
                    "manifestSha256": sha, "valid": true,
                }),
                Err(err) => serde_json::json!({"version": version, "manifestSha256": sha, "valid": false, "reason": err.reason}),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["createdAt"].as_str().unwrap_or(""))
            .then_with(|| b["version"].as_str().cmp(&a["version"].as_str()))
    });
    out
}

/// The image folder for `image` (an image version under the root, or an absolute folder that
/// lies under the root), or the newest valid image when `None`.
pub fn locate(root: &Path, image: Option<&str>) -> VmResult<PathBuf> {
    match image {
        Some(v) if is_valid_id(v) => {
            let dir = root.join(v);
            if dir.join("manifest.json").is_file() {
                Ok(dir)
            } else {
                Err(VmError::not_found("image_not_found", format!("No guest image {v} in {}", root.display())))
            }
        }
        Some(p) => {
            let canonical = crate::shares::canonical_host_path(p)
                .map_err(|_| VmError::invalid_params("image must be an image version or an absolute folder", "image"))?;
            let root_s = root.to_string_lossy();
            let parent_ok = Path::new(&canonical)
                .parent()
                .map(|par| par.to_string_lossy().eq_ignore_ascii_case(root_s.trim_end_matches('\\')))
                .unwrap_or(false);
            if !parent_ok {
                return Err(VmError::policy_denied("image_outside_store", format!("Guest images must live in {}", root.display()))
                    .detail("path", p));
            }
            let dir = PathBuf::from(&canonical);
            if !dir.join("manifest.json").is_file() {
                return Err(VmError::not_found("image_not_found", format!("No guest image at {p}")));
            }
            Ok(dir)
        }
        None => list(root).iter().find(|i| i["valid"] == true).and_then(|i| i["version"].as_str()).map(|v| root.join(v)).ok_or_else(|| {
            VmError::not_found("image_not_found", format!("No guest image is installed in {}; download one first", root.display()))
        }),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Writes a small fake image (`vmlinuz`, `initrd`, `rootfs.vhdx` with fixed bytes).
    pub fn write_image(root: &Path, version: &str, created: &str) -> PathBuf {
        let dir = root.join(version);
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for (name, body) in [(KERNEL, b"kernel".as_slice()), (INITRD, b"initrd"), (ROOTFS, b"rootfs")] {
            std::fs::write(dir.join(name), body).unwrap();
            files.push(serde_json::json!({"name": name, "bytes": body.len(), "sha256": sha256_hex(body)}));
        }
        let m = serde_json::json!({"format": FORMAT, "formatVersion": 1, "id": version, "guestOS": "linux", "createdAt": created, "files": files});
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
        dir
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psyche-vm-image-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn manifest_parsing_accepts_both_file_forms() {
        let sha = "a".repeat(64);
        let arr = serde_json::json!({"format": FORMAT, "formatVersion": 1, "id": "linux-1", "files": [
            {"name": "vmlinuz", "bytes": 1, "sha256": sha}, {"name": "initrd", "bytes": 1, "sha256": sha}, {"name": "rootfs.vhdx", "bytes": 1, "sha256": sha}]});
        let m = parse_manifest(arr.to_string().as_bytes()).unwrap();
        assert_eq!(m.guest_os, "linux");
        let obj = serde_json::json!({"format": FORMAT, "formatVersion": 1, "id": "linux-1", "files": {"vmlinuz": sha, "initrd": {"sha256": sha, "size": 3}, "rootfs.vhdx": {"sha256": sha}}});
        let m = parse_manifest(obj.to_string().as_bytes()).unwrap();
        assert_eq!(m.files.iter().find(|f| f.name == "initrd").unwrap().bytes, 3);
        let missing = serde_json::json!({"format": FORMAT, "formatVersion": 1, "id": "x", "files": {"vmlinuz": sha}});
        assert_eq!(parse_manifest(missing.to_string().as_bytes()).unwrap_err().reason, "image_invalid");
        let v2 = serde_json::json!({"format": FORMAT, "formatVersion": 2, "id": "x", "files": []});
        assert_eq!(parse_manifest(v2.to_string().as_bytes()).unwrap_err().reason, "image_version_unsupported");
        assert_eq!(parse_manifest(b"{}").unwrap_err().reason, "image_invalid");
        let bad_id = serde_json::json!({"format": FORMAT, "formatVersion": 1, "id": "../x", "files": []});
        assert_eq!(parse_manifest(bad_id.to_string().as_bytes()).unwrap_err().reason, "image_invalid");
    }

    #[test]
    fn verification_hashes_every_file_and_pins_the_manifest() {
        let root = tmp("verify");
        let dir = write_image(&root, "linux-1", "2026-11-01T00:00:00Z");
        let cache = VerifyCache::default();
        let img = verify(&dir, None, &cache, |_| {}).unwrap();
        assert_eq!(img.manifest.id, "linux-1");
        assert_eq!(img.bytes(), 18);
        verify(&dir, Some(&img.manifest_sha256.to_uppercase()), &cache, |_| {}).unwrap();
        assert_eq!(verify(&dir, Some(&"0".repeat(64)), &cache, |_| {}).unwrap_err().reason, "image_checksum_mismatch");
        // Tampering with a file (same size) is caught even after a cached verification.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.join(ROOTFS), b"ROOTFS").unwrap();
        let e = verify(&dir, None, &cache, |_| {}).unwrap_err();
        assert_eq!((e.reason.as_str(), e.details["file"].as_str()), ("image_checksum_mismatch", Some(ROOTFS)));
        std::fs::remove_file(dir.join(INITRD)).unwrap();
        assert_eq!(verify(&dir, None, &cache, |_| {}).unwrap_err().reason, "image_checksum_mismatch");
        assert_eq!(verify(&root.join("nope"), None, &cache, |_| {}).unwrap_err().reason, "image_not_found");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn listing_and_locating() {
        let root = tmp("list");
        write_image(&root, "linux-1", "2026-10-01T00:00:00Z");
        write_image(&root, "linux-2", "2026-11-01T00:00:00Z");
        std::fs::create_dir_all(root.join("broken")).unwrap();
        std::fs::write(root.join("broken").join("manifest.json"), "{}").unwrap();
        let l = list(&root);
        assert_eq!(l.len(), 3);
        assert_eq!(l[0]["version"], "linux-2");
        assert_eq!(locate(&root, None).unwrap(), root.join("linux-2"));
        assert_eq!(locate(&root, Some("linux-1")).unwrap(), root.join("linux-1"));
        assert_eq!(locate(&root, Some("linux-9")).unwrap_err().reason, "image_not_found");
        let abs = root.join("linux-1").to_string_lossy().into_owned();
        assert_eq!(locate(&root, Some(&abs)).unwrap(), PathBuf::from(crate::shares::canonical_host_path(&abs).unwrap()));
        assert_eq!(locate(&root, Some(r"C:\Windows\Temp")).unwrap_err().reason, "image_outside_store");
        assert_eq!(locate(&tmp("empty"), None).unwrap_err().reason, "image_not_found");
        let _ = std::fs::remove_dir_all(root);
    }
}
