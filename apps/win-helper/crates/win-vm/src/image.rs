//! Guest images (`GuestImage.swift` for the Linux guest), as `deploy/windows/guest-image`
//! builds them: `<images root>\<imageVersion>\{vmlinuz, initrd, rootfs.vhdx, manifest.json}`.
//!
//! ```jsonc
//! { "schema": 1, "kind": "psyche-windows-guest-image", "contract": 1,
//!   "imageVersion": "0.1.0-1a2b3c4d", "version": "0.1.0", "builtAt": "…",
//!   "files": { "vmlinuz": {"name", "size", "sha256"}, "initrd": {…}, "rootfs": {"name": "rootfs.vhdx", …},
//!              "sessiondata": {…template, not installed} },
//!   "boot": {"kernelCmdline": "…"}, "resources": {"minMemoryMiB", "minCpus"},
//!   "guest": {"gatewayVsockPort": 7980, "controlVsockPort": 7000, …}, "node": {"version"} }
//! ```
//!
//! `vmlinuz`, `initrd` and `rootfs.vhdx` are hashed before a guest is created from the image and
//! before every boot (cached per service run by size and write / creation time); the manifest's
//! own SHA-256 is pinned in the guest's config at create (and checked against the publisher's
//! `imageSha256` when given), so a swapped image is refused. Other files in the folder are
//! ignored: nothing is copied out of it.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{VmError, VmResult};

pub const KIND: &str = "psyche-windows-guest-image";
pub const SCHEMA: u64 = 1;
pub const CONTRACT: u64 = 1;
pub const KERNEL: &str = "vmlinuz";
pub const INITRD: &str = "initrd";
pub const ROOTFS: &str = "rootfs.vhdx";
pub const EXPECTED_FILES: [&str; 3] = [KERNEL, INITRD, ROOTFS];
/// `files` keys for the three files the service uses.
const ROLES: [(&str, &str); 3] = [("vmlinuz", KERNEL), ("initrd", INITRD), ("rootfs", ROOTFS)];

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
    /// `imageVersion` (the install folder's name).
    pub id: String,
    pub version: Option<String>,
    #[serde(rename = "guestOS")]
    pub guest_os: String,
    /// `builtAt`.
    pub created_at: String,
    /// `node.version`.
    pub psyche_version: Option<String>,
    /// `boot.kernelCmdline`.
    pub kernel_cmdline: Option<String>,
    /// The image ships psyche-node.
    pub psyche_installed: bool,
    pub min_memory_mib: Option<u64>,
    pub min_cpus: Option<u64>,
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
    let mut e = VmError::invalid_params(msg, "image");
    e.reason = "image_invalid".into();
    e.details.remove("field");
    e
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// Parses `manifest.json` (no file access).
pub fn parse_manifest(bytes: &[u8]) -> VmResult<Manifest> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| invalid("manifest.json is not JSON"))?;
    if v["kind"].as_str() != Some(KIND) {
        return Err(invalid("manifest.json is not a Psyche Windows guest image"));
    }
    for (key, want) in [("schema", SCHEMA), ("contract", CONTRACT)] {
        let got = v[key].as_u64().unwrap_or(0);
        if got != want {
            return Err(VmError::unavailable(
                "image_version_unsupported",
                format!("Guest image {key} {got} is not supported by this service (needs {want})"),
            ));
        }
    }
    let id = v["imageVersion"].as_str().unwrap_or_default().to_owned();
    if !is_valid_id(&id) {
        return Err(invalid("imageVersion must match ^[a-z0-9][a-z0-9.-]{0,63}$"));
    }
    let mut files = Vec::new();
    for (role, name) in ROLES {
        let f = &v["files"][role];
        let sha = f["sha256"].as_str().unwrap_or_default();
        if f["name"].as_str() != Some(name) || !is_hex64(sha) {
            return Err(invalid(format!("files.{role} must name {name} with its SHA-256")));
        }
        let bytes = f["size"].as_u64().ok_or_else(|| invalid(format!("files.{role} has no size")))?;
        files.push(ImageFile { name: name.to_owned(), bytes, sha256: sha.to_ascii_lowercase() });
    }
    // The ports are fixed (registered under GuestCommunicationServices at install).
    for (key, want) in [("gatewayVsockPort", crate::manager::GATEWAY_NODE_PORT), ("controlVsockPort", crate::manager::GUEST_AGENT_PORT)] {
        if let Some(p) = v["guest"][key].as_u64()
            && p != u64::from(want)
        {
            return Err(VmError::unavailable(
                "image_unsupported",
                format!("The image uses vsock port {p} for {key}; this service needs {want}"),
            ));
        }
    }
    let cmdline = v["boot"]["kernelCmdline"].as_str().map(str::to_owned);
    if let Some(c) = &cmdline
        && (c.len() > 1024 || c.chars().any(|ch| ch.is_control()))
    {
        return Err(invalid("boot.kernelCmdline is too long or has control characters"));
    }
    Ok(Manifest {
        id,
        version: v["version"].as_str().map(str::to_owned),
        guest_os: "linux".into(),
        created_at: v["builtAt"].as_str().unwrap_or_default().to_owned(),
        psyche_version: v["node"]["version"].as_str().map(str::to_owned),
        kernel_cmdline: cmdline,
        psyche_installed: true,
        min_memory_mib: v["resources"]["minMemoryMiB"].as_u64(),
        min_cpus: v["resources"]["minCpus"].as_u64(),
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
        self.manifest.files.iter().map(|f| f.bytes).sum()
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
    let total = manifest.files.iter().map(|f| f.bytes).sum::<u64>().max(1);
    let mut hashed = 0u64;
    for f in &manifest.files {
        let path = dir.join(&f.name);
        let meta = std::fs::symlink_metadata(&path).map_err(|_| {
            VmError::policy_denied("image_checksum_mismatch", format!("{} is missing", f.name)).detail("file", f.name.as_str())
        })?;
        if !meta.is_file() || meta.len() != f.bytes {
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
                    "psycheVersion": m.psyche_version, "sizeBytes": m.files.iter().map(|f| f.bytes).sum::<u64>(),
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

/// A schema-1 manifest for `files` (`vmlinuz`, `initrd`, `rootfs.vhdx` with size and SHA-256),
/// as `make-manifest.mjs` writes it (the fields the service reads, plus the fixed guest ports).
pub fn build_manifest(
    image_version: &str,
    built_at: &str,
    node_version: Option<&str>,
    cmdline: Option<&str>,
    files: &[ImageFile],
) -> Value {
    let mut by_role = serde_json::Map::new();
    for (role, name) in ROLES {
        if let Some(f) = files.iter().find(|f| f.name == name) {
            by_role.insert(role.into(), serde_json::json!({"name": f.name, "size": f.bytes, "sha256": f.sha256}));
        }
    }
    let mut m = serde_json::json!({
        "schema": SCHEMA, "kind": KIND, "contract": CONTRACT, "imageVersion": image_version, "builtAt": built_at,
        "files": by_role,
        "guest": {"hostCid": 2, "gatewayVsockPort": crate::manager::GATEWAY_NODE_PORT, "controlVsockPort": crate::manager::GUEST_AGENT_PORT},
    });
    if let Some(c) = cmdline {
        m["boot"] = serde_json::json!({"kernelCmdline": c});
    }
    if let Some(v) = node_version {
        m["node"] = serde_json::json!({"version": v});
    }
    m
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn file(name: &str, body: &[u8]) -> ImageFile {
        ImageFile { name: name.into(), bytes: body.len() as u64, sha256: sha256_hex(body) }
    }

    /// Writes a small fake image (`vmlinuz`, `initrd`, `rootfs.vhdx` with fixed bytes).
    pub fn write_image(root: &Path, version: &str, created: &str) -> PathBuf {
        let dir = root.join(version);
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for (name, body) in [(KERNEL, b"kernel".as_slice()), (INITRD, b"initrd"), (ROOTFS, b"rootfs")] {
            std::fs::write(dir.join(name), body).unwrap();
            files.push(file(name, body));
        }
        let m = build_manifest(version, created, Some("0.1.0"), Some("console=ttyS0"), &files);
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&m).unwrap()).unwrap();
        dir
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("psyche-vm-image-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The manifest `deploy/windows/guest-image/make-manifest.mjs` writes (trimmed).
    const VM_IMAGE_MANIFEST: &str = r#"{
      "schema": 1, "kind": "psyche-windows-guest-image", "contract": 1,
      "imageVersion": "0.1.0-200e621f", "version": "0.1.0", "arch": "x86_64", "builtAt": "2026-11-05T12:34:32.352Z",
      "files": {
        "vmlinuz": {"name": "vmlinuz", "size": 29774848, "sha256": "ebfe01aa7659abf78dd056cbbd8283787e02cf35d5f81b3adceae7b8c60028ec"},
        "initrd": {"name": "initrd", "size": 1065063, "sha256": "35896c4acd34ff40f473470124a20b76cb848d634c9ab107b14a4e986370a943"},
        "rootfs": {"name": "rootfs.vhdx", "size": 1337982976, "sha256": "22898659f89a1e8880197460b18802fcf97e7a9a7600e7df6b99f71e8f4f406d",
                   "readOnly": true, "format": "vhdx", "subformat": "dynamic",
                   "compressed": {"name": "rootfs.vhdx.zst", "size": 317159067, "sha256": "206c213edf38c470a49359f15a8d7dd1d396a3ed0835d57a206971154be49582", "format": "zstd"}},
        "sessiondata": {"name": "sessiondata.vhdx", "size": 8388608, "sha256": "bfb469d3531d73731625b3ae8449f48ae2e28694ced6d01391ad515f1e28a9e0", "template": true, "virtualSizeBytes": 8589934592}
      },
      "boot": {"kernelCmdline": "console=ttyS0,115200 loglevel=4 panic=10 net.ifnames=0 random.trust_cpu=on psyche.hostname=psyche-pc"},
      "resources": {"minMemoryMiB": 1024, "recommendedMemoryMiB": 2048, "minCpus": 1, "recommendedCpus": 2},
      "guest": {"user": "psyche", "uid": 1000, "hostCid": 2, "gatewayVsockPort": 7980, "controlVsockPort": 7000},
      "node": {"package": "@psyche/node", "version": "0.1.0"}
    }"#;

    #[test]
    fn parses_the_guest_image_pipelines_manifest() {
        let m = parse_manifest(VM_IMAGE_MANIFEST.as_bytes()).unwrap();
        assert_eq!(m.id, "0.1.0-200e621f");
        assert_eq!(m.created_at, "2026-11-05T12:34:32.352Z");
        assert_eq!(
            m.kernel_cmdline.as_deref(),
            Some("console=ttyS0,115200 loglevel=4 panic=10 net.ifnames=0 random.trust_cpu=on psyche.hostname=psyche-pc")
        );
        assert_eq!((m.min_memory_mib, m.min_cpus), (Some(1024), Some(1)));
        assert_eq!(m.psyche_version.as_deref(), Some("0.1.0"));
        let names: Vec<&str> = m.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["vmlinuz", "initrd", "rootfs.vhdx"], "the session template and .zst are not used");
        assert_eq!(m.files[2].bytes, 1_337_982_976);
        let mut v: Value = serde_json::from_str(VM_IMAGE_MANIFEST).unwrap();
        v["schema"] = 2.into();
        assert_eq!(parse_manifest(v.to_string().as_bytes()).unwrap_err().reason, "image_version_unsupported");
        let mut v: Value = serde_json::from_str(VM_IMAGE_MANIFEST).unwrap();
        v["guest"]["gatewayVsockPort"] = 1234.into();
        assert_eq!(parse_manifest(v.to_string().as_bytes()).unwrap_err().reason, "image_unsupported");
        let mut v: Value = serde_json::from_str(VM_IMAGE_MANIFEST).unwrap();
        v["files"]["rootfs"]["name"] = "other.vhdx".into();
        assert_eq!(parse_manifest(v.to_string().as_bytes()).unwrap_err().reason, "image_invalid");
        let mut v: Value = serde_json::from_str(VM_IMAGE_MANIFEST).unwrap();
        v["imageVersion"] = "../x".into();
        assert_eq!(parse_manifest(v.to_string().as_bytes()).unwrap_err().reason, "image_invalid");
        assert_eq!(parse_manifest(b"{}").unwrap_err().reason, "image_invalid");
        assert_eq!(parse_manifest(b"nope").unwrap_err().reason, "image_invalid");
        // What export_image writes parses back.
        let files = vec![file(KERNEL, b"k"), file(INITRD, b"i"), file(ROOTFS, b"r")];
        let built = build_manifest("linux-x", "t", None, Some("console=ttyS0"), &files);
        assert_eq!(parse_manifest(built.to_string().as_bytes()).unwrap().files, files);
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
        let empty = tmp("empty");
        assert_eq!(locate(&empty, None).unwrap_err().reason, "image_not_found");
        let _ = std::fs::remove_dir_all(empty);
        let _ = std::fs::remove_dir_all(root);
    }
}
