//! `psyche-helper update` (H7; linux-helper-only design §3.6): a verified update of the helper, the
//! way the desktop updates itself (apps/desktop/src/main/update-manifest.ts and update-flow.ts).
//!
//! Before anything is put in place, in order:
//!
//! 1. the manifest's Ed25519 signature, by a key built into this binary ([`TRUSTED_RELEASE_KEYS`]).
//!    An unsigned manifest, an unknown key and a bad signature are refused;
//! 2. the manifest's shape, and that its `baseUrl` is under the pinned release host
//!    ([`PINNED_RELEASE_BASE`]), over https;
//! 3. no downgrade and no re-install of the same version;
//! 4. the downloaded tarball's size and SHA-256 against the manifest;
//! 5. the unpacked binary reports the release's version when it is run with `--build-info`.
//!
//! Only the tarball install updates itself. A deb or rpm install is root-owned: it is updated by
//! the package manager, and this command says so. The previous binary stays next to the new one as
//! `psyche-helper.prev`; `update --rollback` swaps them back, and an update whose service does not
//! come back up rolls itself back.
//!
//! `--from <dir>` reads `update-manifest.json`, its `.sig` and the tarball from a directory instead
//! of the network (a machine with no route to GitHub). Every check above still applies.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command as Process;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Releases come only from here (the desktop's `PINNED_RELEASE_BASE`).
pub const PINNED_RELEASE_BASE: &str = "https://github.com/devmello/psyche/releases/download/";
/// The newest release's manifest.
pub const DEFAULT_FEED: &str = "https://github.com/devmello/psyche/releases/latest/download/";
pub const MANIFEST_FILE: &str = "update-manifest.json";
pub const SIGNATURE_FILE: &str = "update-manifest.json.sig";
/// The version this binary is: the release's, stamped at build time, else the crate's.
pub const RELEASE_VERSION: &str = match option_env!("PSYCHE_RELEASE_VERSION") {
    Some(v) if !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

const MAX_MANIFEST: usize = 1 << 20;
const MAX_ARTIFACT: usize = 128 << 20;

/// The keys whose signatures are accepted. The same list as the desktop's `release-keys.ts`.
pub const TRUSTED_RELEASE_KEYS: &[(&str, &str)] = &[(
    "37312dba0e2eddad",
    "hbM9GyfYsfhRfSZX6E6QimBS7GqkV2CMlDpVdxolxNk=",
)];

/// A key a *test build* also trusts (`PSYCHE_HELPER_TEST_RELEASE_KEY=<base64 public key>` at
/// compile time). Release builds do not set it, and release.yml checks that.
const TEST_RELEASE_KEY: Option<&str> = option_env!("PSYCHE_HELPER_TEST_RELEASE_KEY");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseKey {
    pub key_id: String,
    pub public_key: String,
}

pub fn trusted_keys() -> Vec<ReleaseKey> {
    let mut keys: Vec<ReleaseKey> = TRUSTED_RELEASE_KEYS
        .iter()
        .map(|(id, k)| ReleaseKey {
            key_id: (*id).into(),
            public_key: (*k).into(),
        })
        .collect();
    if let Some(k) = TEST_RELEASE_KEY.filter(|k| !k.is_empty()) {
        if let Ok(raw) = STANDARD.decode(k) {
            keys.push(ReleaseKey {
                key_id: key_id_of(&raw),
                public_key: k.into(),
            });
        }
    }
    keys
}

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    Unsigned(String),
    UnknownKey(String),
    BadSignature,
    Malformed(String),
    UntrustedHost(String),
    NoArtifact(String),
    HashMismatch(String),
    Network(String),
    Install(String),
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use UpdateError::*;
        match self {
            Unsigned(m) => write!(f, "refused: {m}"),
            UnknownKey(k) => write!(
                f,
                "refused: the manifest is signed by key {k}, which this helper does not trust"
            ),
            BadSignature => write!(f, "refused: the manifest signature does not match"),
            Malformed(m) => write!(f, "refused: the manifest {m}"),
            UntrustedHost(m) => write!(f, "refused: {m}"),
            NoArtifact(m) | HashMismatch(m) | Network(m) | Install(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for UpdateError {}

pub fn key_id_of(raw: &[u8]) -> String {
    Sha256::digest(raw)[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// semver precedence (-1, 0, 1), as the desktop's `compareVersions`. `None` when malformed.
pub fn compare_versions(a: &str, b: &str) -> Option<i32> {
    type Parsed = ([u64; 3], Option<String>);
    fn parse(v: &str) -> Option<Parsed> {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (v, None),
        };
        if let Some(p) = pre {
            if p.is_empty()
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            {
                return None;
            }
        }
        let mut nums = [0u64; 3];
        let mut it = core.split('.');
        for n in nums.iter_mut() {
            let s = it.next()?;
            if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            *n = s.parse().ok()?;
        }
        it.next().is_none().then(|| (nums, pre.map(String::from)))
    }
    let (na, pa) = parse(a)?;
    let (nb, pb) = parse(b)?;
    for i in 0..3 {
        if na[i] != nb[i] {
            return Some(if na[i] < nb[i] { -1 } else { 1 });
        }
    }
    match (pa, pb) {
        (None, None) => Some(0),
        (None, Some(_)) => Some(1),
        (Some(_), None) => Some(-1),
        (Some(x), Some(y)) => {
            let (xs, ys): (Vec<&str>, Vec<&str>) = (x.split('.').collect(), y.split('.').collect());
            for i in 0..xs.len().max(ys.len()) {
                let (Some(s), Some(t)) = (xs.get(i), ys.get(i)) else {
                    return Some(if xs.get(i).is_none() { -1 } else { 1 });
                };
                let (ns, nt) = (
                    s.bytes().all(|c| c.is_ascii_digit()),
                    t.bytes().all(|c| c.is_ascii_digit()),
                );
                if ns && nt {
                    let (p, q): (u128, u128) = (s.parse().ok()?, t.parse().ok()?);
                    if p != q {
                        return Some(if p < q { -1 } else { 1 });
                    }
                } else if ns != nt {
                    return Some(if ns { -1 } else { 1 });
                } else if s != t {
                    return Some(if s < t { -1 } else { 1 });
                }
            }
            Some(0)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Artifact {
    pub name: String,
    pub kind: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub release: String,
    pub base_url: String,
    /// `platforms["linux-<arch>"]`, entries of kinds this helper knows or not alike.
    pub artifacts: Vec<Artifact>,
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// Checks the signature with the trusted keys, then the manifest's shape. `arch` is `x64`/`arm64`.
pub fn verify_manifest(
    bytes: &[u8],
    signature_text: Option<&str>,
    trusted: &[ReleaseKey],
    arch: &str,
) -> Result<Manifest, UpdateError> {
    use UpdateError::*;
    let text = signature_text.ok_or_else(|| Unsigned("the manifest has no signature".into()))?;
    let env: Value = serde_json::from_str(text)
        .map_err(|_| Unsigned("the signature file is not JSON".into()))?;
    let (Some("ed25519"), Some(key_id), Some(sig_b64)) = (
        env["alg"].as_str(),
        env["keyId"].as_str(),
        env["signature"].as_str(),
    ) else {
        return Err(Unsigned(
            "the signature file is not an ed25519 envelope".into(),
        ));
    };
    let key = trusted
        .iter()
        .find(|k| k.key_id == key_id)
        .ok_or_else(|| UnknownKey(key_id.to_string()))?;
    let raw: [u8; 32] = STANDARD
        .decode(&key.public_key)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(BadSignature)?;
    let sig: [u8; 64] = STANDARD
        .decode(sig_b64)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(BadSignature)?;
    VerifyingKey::from_bytes(&raw)
        .and_then(|k| k.verify_strict(bytes, &Signature::from_bytes(&sig)))
        .map_err(|_| BadSignature)?;
    parse_manifest(bytes, arch)
}

fn parse_manifest(bytes: &[u8], arch: &str) -> Result<Manifest, UpdateError> {
    let bad = |why: &str| UpdateError::Malformed(why.to_string());
    let m: Value = serde_json::from_slice(bytes).map_err(|_| bad("is not JSON"))?;
    if m["format"] != "psyche-update-manifest" || m["version"] != 1 {
        return Err(bad("has an unknown format"));
    }
    let get = |k: &str| {
        m[k].as_str()
            .map(String::from)
            .ok_or_else(|| bad(&format!("lacks {k}")))
    };
    let release = get("release")?;
    let minimum = get("minimumVersion")?;
    let base_url = get("baseUrl")?;
    if compare_versions(&release, &minimum).is_none() {
        return Err(bad("has a malformed version"));
    }
    let mut artifacts = Vec::new();
    if let Some(list) = m["platforms"][format!("linux-{arch}")].as_array() {
        for a in list {
            let (Some(name), Some(kind), Some(sha), Some(len)) = (
                a["name"].as_str(),
                a["kind"].as_str(),
                a["sha256"].as_str(),
                a["bytes"].as_u64(),
            ) else {
                return Err(bad("has an invalid artifact"));
            };
            if !safe_name(name)
                || sha.len() != 64
                || !sha.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
            {
                return Err(bad("has an invalid artifact"));
            }
            artifacts.push(Artifact {
                name: name.into(),
                kind: kind.into(),
                sha256: sha.into(),
                bytes: len,
            });
        }
    }
    Ok(Manifest {
        release,
        base_url,
        artifacts,
    })
}

/// True when `candidate` is under `pin` after URL normalisation: same origin, https, no
/// credentials, query or fragment, and no encoded slash or dot segment (the desktop's `isUnderPin`).
pub fn is_under_pin(candidate: &str, pin: &str) -> bool {
    let (Some(c), Some(p)) = (Url::parse(candidate), Url::parse(pin)) else {
        return false;
    };
    if c.host != p.host || c.port != p.port || c.path.contains('?') || c.path.contains('#') {
        return false;
    }
    let lower = c.path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") || lower.contains("%2e") {
        return false;
    }
    if c.path.split('/').any(|s| s == "." || s == "..") {
        return false;
    }
    let prefix = if p.path.ends_with('/') {
        p.path.clone()
    } else {
        format!("{}/", p.path)
    };
    c.path.starts_with(&prefix)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Url {
    host: String,
    port: u16,
    path: String,
}

impl Url {
    /// `https://host[:port]/path` only: no userinfo, no query, no fragment.
    fn parse(s: &str) -> Option<Url> {
        let rest = s.strip_prefix("https://")?;
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty()
            || authority.contains('@')
            || path.contains('?')
            || path.contains('#')
            || path.bytes().any(|c| c <= b' ' || c == b'\\' || c >= 0x7f)
        {
            return None;
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse().ok()?),
            None => (authority, 443),
        };
        if host.is_empty()
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        {
            return None;
        }
        Some(Url {
            host: host.to_ascii_lowercase(),
            port,
            path: path.into(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub release: String,
    pub artifact: Artifact,
    pub url: String,
}

/// What to do about `manifest` from `current`. `Ok(None)`: nothing newer.
pub fn plan_update(
    manifest: &Manifest,
    current: &str,
    pin: &str,
) -> Result<Option<Plan>, UpdateError> {
    if !manifest.base_url.ends_with('/') || !is_under_pin(&manifest.base_url, pin) {
        return Err(UpdateError::UntrustedHost(format!(
            "the artifacts are not under {pin}"
        )));
    }
    match compare_versions(&manifest.release, current) {
        None => return Err(UpdateError::Malformed("has a malformed version".into())),
        Some(c) if c <= 0 => return Ok(None),
        Some(_) => {}
    }
    let artifact = manifest
        .artifacts
        .iter()
        .find(|a| a.kind == "helper-tar-zst")
        .ok_or_else(|| {
            UpdateError::NoArtifact(format!(
                "no helper tarball for this CPU in {}",
                manifest.release
            ))
        })?;
    Ok(Some(Plan {
        release: manifest.release.clone(),
        url: format!("{}{}", manifest.base_url, artifact.name),
        artifact: artifact.clone(),
    }))
}

/// The downloaded artifact must be byte-for-byte the one the manifest names.
pub fn verify_artifact(bytes: &[u8], artifact: &Artifact) -> Result<(), UpdateError> {
    if bytes.len() as u64 != artifact.bytes {
        return Err(UpdateError::HashMismatch(format!(
            "refused: {} is {} bytes, the manifest says {}",
            artifact.name,
            bytes.len(),
            artifact.bytes
        )));
    }
    if sha256_hex(bytes) != artifact.sha256 {
        return Err(UpdateError::HashMismatch(format!(
            "refused: {} does not match the SHA-256 in the manifest",
            artifact.name
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Fetching

pub trait Fetch {
    fn get(&self, url: &str, max: usize) -> Result<Vec<u8>, UpdateError>;
}

/// Reads `<dir>/<last path segment>`: `--from <dir>`.
pub struct DirFetch(pub PathBuf);

impl Fetch for DirFetch {
    fn get(&self, url: &str, max: usize) -> Result<Vec<u8>, UpdateError> {
        let name = url.rsplit('/').next().unwrap_or("");
        if !safe_name(name) {
            return Err(UpdateError::Network(format!("not a file name: {name}")));
        }
        let path = self.0.join(name);
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| UpdateError::Network(format!("{}: {e}", path.display())))?;
        if !meta.is_file() || meta.len() as usize > max {
            return Err(UpdateError::Network(format!(
                "{} is not a regular file of a sane size",
                path.display()
            )));
        }
        fs::read(&path).map_err(|e| UpdateError::Network(format!("{}: {e}", path.display())))
    }
}

/// Redirects may only go to GitHub's own hosts. (The manifest's signature and the artifact's hash
/// are what make the bytes trustworthy; this keeps the request from wandering.)
fn redirect_host_ok(host: &str) -> bool {
    host == "github.com" || host.ends_with(".githubusercontent.com")
}

pub struct HttpsFetch {
    /// The hosts a first request may go to besides GitHub's (tests only).
    pub extra_hosts: Vec<String>,
}

impl HttpsFetch {
    pub fn new() -> Self {
        Self {
            extra_hosts: Vec::new(),
        }
    }
}

impl Default for HttpsFetch {
    fn default() -> Self {
        Self::new()
    }
}

struct Response {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

fn decode_chunked(mut data: &[u8], max: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let eol = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("truncated chunk header")?;
        let size_text = std::str::from_utf8(&data[..eol]).map_err(|_| "bad chunk header")?;
        let size_text = size_text.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| "bad chunk size")?;
        data = &data[eol + 2..];
        if size == 0 {
            return Ok(out);
        }
        let too_big = out.len().checked_add(size).is_none_or(|n| n > max);
        let end = size.checked_add(2);
        if too_big || end.is_none_or(|n| data.len() < n) {
            return Err("chunk too large or truncated".into());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

fn request(url: &Url, max: usize) -> Result<Response, UpdateError> {
    let net = |m: String| UpdateError::Network(format!("{}: {m}", url.host));
    let addr = (url.host.as_str(), url.port)
        .to_socket_addrs()
        .map_err(|e| net(e.to_string()))?
        .next()
        .ok_or_else(|| net("no address".into()))?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(20))
        .map_err(|e| net(e.to_string()))?;
    tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
    tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();
    let config = crate::remote::tls::ca_config().map_err(|e| net(e.to_string()))?;
    let name = rustls::pki_types::ServerName::try_from(url.host.clone())
        .map_err(|e| net(e.to_string()))?;
    let conn =
        rustls::ClientConnection::new(Arc::new(config), name).map_err(|e| net(e.to_string()))?;
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    let head = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: psyche-helper/{}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
        url.path, url.host, RELEASE_VERSION
    );
    tls.write_all(head.as_bytes())
        .map_err(|e| net(e.to_string()))?;
    let deadline = Instant::now() + Duration::from_secs(600);
    let mut raw = Vec::new();
    let mut buf = [0u8; 16 * 1024];
    loop {
        if Instant::now() > deadline {
            return Err(net("timed out".into()));
        }
        match tls.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > max + 16 * 1024 + max / 64 {
                    return Err(net("response too large".into()));
                }
            }
            // A server that closes without close_notify: the length check and the hash decide.
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(net(e.to_string())),
        }
    }
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| net("no response headers".into()))?;
    let head_text = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head_text.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| net("bad status line".into()))?;
    let (mut location, mut chunked, mut length) = (None, false, None::<usize>);
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.trim().to_ascii_lowercase().as_str() {
                "location" => location = Some(v.to_string()),
                "transfer-encoding" => chunked = v.to_ascii_lowercase().contains("chunked"),
                "content-length" => length = v.parse().ok(),
                _ => {}
            }
        }
    }
    let rest = &raw[split + 4..];
    let body = if chunked {
        decode_chunked(rest, max).map_err(net)?
    } else {
        if let Some(n) = length {
            if rest.len() < n {
                return Err(net("the download was cut short".into()));
            }
        }
        rest[..length.unwrap_or(rest.len()).min(rest.len())].to_vec()
    };
    if body.len() > max {
        return Err(net("response too large".into()));
    }
    Ok(Response {
        status,
        location,
        body,
    })
}

impl Fetch for HttpsFetch {
    fn get(&self, url: &str, max: usize) -> Result<Vec<u8>, UpdateError> {
        let mut current = Url::parse(url)
            .ok_or_else(|| UpdateError::UntrustedHost(format!("{url} is not a plain https URL")))?;
        if !redirect_host_ok(&current.host) && !self.extra_hosts.contains(&current.host) {
            return Err(UpdateError::UntrustedHost(format!(
                "{} is not a Psyche release host",
                current.host
            )));
        }
        for _ in 0..6 {
            let r = request(&current, max)?;
            match r.status {
                200 => return Ok(r.body),
                301 | 302 | 303 | 307 | 308 => {
                    let loc = r.location.ok_or_else(|| {
                        UpdateError::Network("redirect without a location".into())
                    })?;
                    let next = if loc.starts_with("https://") {
                        Url::parse(&loc)
                    } else if loc.starts_with('/') && !loc.starts_with("//") {
                        Url::parse(&format!("https://{}{}", current.host, loc))
                    } else {
                        None
                    };
                    let next = next.ok_or_else(|| {
                        UpdateError::UntrustedHost("a redirect left https".into())
                    })?;
                    if !redirect_host_ok(&next.host) {
                        return Err(UpdateError::UntrustedHost(format!(
                            "a redirect to {}, which is not a Psyche release host",
                            next.host
                        )));
                    }
                    current = next;
                }
                s => {
                    return Err(UpdateError::Network(format!(
                        "{} answered {s} for {}",
                        current.host, current.path
                    )))
                }
            }
        }
        Err(UpdateError::Network("too many redirects".into()))
    }
}

// ---------------------------------------------------------------------------------------------
// Installing

/// The user service around the swap.
pub trait Service {
    /// Whether the service is running now (so it is restarted, and checked, afterwards).
    fn running(&self) -> bool;
    fn restart(&self);
    /// Whether it came up and stayed up.
    fn healthy(&self) -> bool;
}

pub const UNIT: &str = "psyche-helper-remote.service";

pub struct Systemd;

impl Systemd {
    fn ctl(args: &[&str]) -> Option<std::process::Output> {
        Process::new("systemctl")
            .arg("--user")
            .args(args)
            .output()
            .ok()
    }
}

impl Service for Systemd {
    fn running(&self) -> bool {
        Self::ctl(&["is-active", "--quiet", UNIT]).is_some_and(|o| o.status.success())
    }
    fn restart(&self) {
        Self::ctl(&["restart", UNIT]);
    }
    fn healthy(&self) -> bool {
        // It must be active, and still active a few seconds later (Restart=on-failure would
        // otherwise make a crash loop look alive between restarts).
        for _ in 0..2 {
            std::thread::sleep(Duration::from_secs(4));
            if !Self::ctl(&["is-active", "--quiet", UNIT]).is_some_and(|o| o.status.success()) {
                return false;
            }
        }
        true
    }
}

/// Where this binary lives and may be replaced. `None` when it is a package's (root-owned) copy.
pub fn tarball_binary(exe: &Path) -> Result<PathBuf, UpdateError> {
    let exe = fs::canonicalize(exe).map_err(|e| UpdateError::Install(e.to_string()))?;
    if exe.starts_with("/usr/") || exe.starts_with("/opt/") {
        return Err(UpdateError::Install(
            "this helper was installed by your package manager (apt, dnf): update it with that, \
             for example `sudo apt install --only-upgrade psyche-helper`"
                .into(),
        ));
    }
    let dir = exe
        .parent()
        .ok_or_else(|| UpdateError::Install("no directory".into()))?;
    let probe = dir.join(".psyche-helper-write-test");
    fs::write(&probe, b"").map_err(|_| {
        UpdateError::Install(format!(
            "{} is not writable by this account: this helper cannot update itself (a root-owned \
             install is updated by running the new release's install.sh again)",
            dir.display()
        ))
    })?;
    fs::remove_file(&probe).ok();
    Ok(exe)
}

fn prev_path(bin: &Path) -> PathBuf {
    bin.with_file_name("psyche-helper.prev")
}

/// A private work directory, created atomically with mode 0700 (it fails if the name exists, so
/// nobody can have planted it).
fn private_dir(parent: &Path) -> Result<PathBuf, UpdateError> {
    use std::os::unix::fs::DirBuilderExt;
    let mut seed = [0u8; 8];
    getrandom::fill(&mut seed).map_err(|e| UpdateError::Install(e.to_string()))?;
    let name = format!(
        ".update-{}-{}",
        std::process::id(),
        seed.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let dir = parent.join(name);
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| UpdateError::Install(format!("could not make a work directory: {e}")))?;
    Ok(dir)
}

/// Unpacks the (already verified) tarball and returns the new binary, staged next to `bin`. The
/// bytes go to `tar` on its standard input (no archive file to swap), the work directory is private
/// from the moment it exists, and the binary is hashed when it comes out and again just before it
/// is used. The tar is run with a fixed argument list, never a shell.
fn stage(bin: &Path, tar_bytes: &[u8], release: &str, arch: &str) -> Result<PathBuf, UpdateError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let err = |m: String| UpdateError::Install(m);
    let dir = bin.parent().unwrap();
    let work = private_dir(dir)?;
    let result = (|| {
        let out = work.join("x");
        fs::create_dir(&out).map_err(|e| err(e.to_string()))?;
        let mut child = Process::new("tar")
            .args(["--zstd", "-xf", "-", "-C"])
            .arg(&out)
            .arg("--no-same-owner")
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| err(format!("could not run tar (is zstd installed?): {e}")))?;
        let mut stdin = child.stdin.take().unwrap();
        let bytes = tar_bytes.to_vec();
        let writer = std::thread::spawn(move || stdin.write_all(&bytes));
        let status = child.wait().map_err(|e| err(e.to_string()))?;
        let _ = writer.join();
        if !status.success() {
            return Err(err(
                "could not unpack the release (needs tar and zstd)".into()
            ));
        }
        let new = out
            .join(format!("psyche-helper-{release}-linux-{arch}"))
            .join("bin/psyche-helper");
        let meta = fs::symlink_metadata(&new)
            .map_err(|_| err("the release has no bin/psyche-helper".into()))?;
        if !meta.is_file() {
            return Err(err(
                "bin/psyche-helper in the release is not a regular file".into(),
            ));
        }
        let data = fs::read(&new).map_err(|e| err(e.to_string()))?;
        let want = sha256_hex(&data);
        let staged = dir.join(".psyche-helper.new");
        let _ = fs::remove_file(&staged);
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&staged)
            .map_err(|e| err(e.to_string()))?;
        f.write_all(&data).map_err(|e| err(e.to_string()))?;
        f.sync_all().map_err(|e| err(e.to_string()))?;
        drop(f);
        let check = (|| {
            // The file that is about to run is the file that was unpacked.
            if sha256_hex(&fs::read(&staged).map_err(|e| err(e.to_string()))?) != want {
                return Err(err("the staged helper changed while it was staged".into()));
            }
            // It must be a helper of this release before it replaces anything.
            let info = Process::new(&staged)
                .arg("--build-info")
                .output()
                .map_err(|e| err(format!("the new helper does not run: {e}")))?;
            let v: Value = serde_json::from_slice(&info.stdout)
                .map_err(|_| err("the new helper did not answer --build-info".into()))?;
            if !info.status.success() || v["name"] != "psyche-helper" || v["version"] != release {
                return Err(err(format!(
                    "the new helper reports version {}, not {release}",
                    v["version"]
                )));
            }
            if sha256_hex(&fs::read(&staged).map_err(|e| err(e.to_string()))?) != want {
                return Err(err("the staged helper changed while it was checked".into()));
            }
            fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))
                .map_err(|e| err(e.to_string()))
        })();
        if let Err(e) = check {
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
        Ok(staged)
    })();
    let _ = fs::remove_dir_all(&work);
    result
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    UpToDate(String),
    Available(String),
    Updated { from: String, to: String },
    RolledBackAfterFailure { tried: String },
}

pub struct Context<'a> {
    pub current: &'a str,
    pub arch: &'a str,
    pub pin: &'a str,
    pub feed: &'a str,
    pub trusted: &'a [ReleaseKey],
    pub bin: &'a Path,
    pub check_only: bool,
}

/// Fetch, verify, install, restart, and roll back on a bad start.
pub fn update(
    ctx: &Context,
    fetch: &dyn Fetch,
    service: &dyn Service,
) -> Result<Outcome, UpdateError> {
    let manifest_bytes = fetch.get(&format!("{}{MANIFEST_FILE}", ctx.feed), MAX_MANIFEST)?;
    let sig = fetch
        .get(&format!("{}{SIGNATURE_FILE}", ctx.feed), 64 * 1024)
        .ok()
        .and_then(|b| String::from_utf8(b).ok());
    let manifest = verify_manifest(&manifest_bytes, sig.as_deref(), ctx.trusted, ctx.arch)?;
    let Some(plan) = plan_update(&manifest, ctx.current, ctx.pin)? else {
        return Ok(Outcome::UpToDate(ctx.current.to_string()));
    };
    if ctx.check_only {
        return Ok(Outcome::Available(plan.release));
    }
    let bytes = fetch.get(&plan.url, MAX_ARTIFACT)?;
    verify_artifact(&bytes, &plan.artifact)?;
    let staged = stage(ctx.bin, &bytes, &plan.release, ctx.arch)?;
    let was_running = service.running();
    swap_in(ctx.bin, &staged)?;
    if was_running {
        service.restart();
        if !service.healthy() {
            rollback(ctx.bin)?;
            service.restart();
            return Ok(Outcome::RolledBackAfterFailure {
                tried: plan.release,
            });
        }
    }
    Ok(Outcome::Updated {
        from: ctx.current.to_string(),
        to: plan.release,
    })
}

/// `staged` becomes `bin`; the old `bin` is kept as `psyche-helper.prev`. The old file gets a
/// second name first (a hard link, a copy where links are not allowed) and then one rename
/// replaces `bin`, so at every moment `bin` is a whole helper: a crash cannot leave none.
fn swap_in(bin: &Path, staged: &Path) -> Result<(), UpdateError> {
    let err = |m: String| UpdateError::Install(m);
    let prev = prev_path(bin);
    let _ = fs::remove_file(&prev);
    if fs::hard_link(bin, &prev).is_err() {
        fs::copy(bin, &prev).map_err(|e| err(format!("could not keep the old helper: {e}")))?;
    }
    fs::rename(staged, bin).map_err(|e| {
        let _ = fs::remove_file(&prev);
        err(format!("could not put the new helper in place: {e}"))
    })
}

/// Swaps the previous binary back in (and keeps the one it replaces as the new `.prev`, so a
/// second `--rollback` goes forward again). Also never without a `bin`: one rename replaces it.
pub fn rollback(bin: &Path) -> Result<(), UpdateError> {
    let prev = prev_path(bin);
    if !prev.is_file() {
        return Err(UpdateError::Install(
            "there is no previous helper to go back to".into(),
        ));
    }
    let tmp = bin.with_file_name(".psyche-helper.swap");
    let err = |m: String| UpdateError::Install(m);
    let _ = fs::remove_file(&tmp);
    if fs::hard_link(bin, &tmp).is_err() {
        fs::copy(bin, &tmp).map_err(|e| err(e.to_string()))?;
    }
    if let Err(e) = fs::rename(&prev, bin) {
        let _ = fs::remove_file(&tmp);
        return Err(err(e.to_string()));
    }
    fs::rename(&tmp, &prev).map_err(|e| err(e.to_string()))?;
    Ok(())
}

pub fn arch_name() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        other => Err(format!("no helper release for {other}")),
    }
}

/// The command: `psyche-helper update [--check] [--rollback] [--from <dir>]`.
pub fn run(check: bool, do_rollback: bool, from: Option<&Path>) -> Result<String, String> {
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return Err(
            "do not run update as root: it works in the helper's own folder, which the \
            helper's account owns. Run it as that account (a root-owned install is updated by \
            running the new release's install.sh again)"
                .into(),
        );
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = tarball_binary(&exe).map_err(|e| e.to_string())?;
    if do_rollback {
        rollback(&bin).map_err(|e| e.to_string())?;
        if Systemd.running() {
            Systemd.restart();
        }
        return Ok("went back to the previous helper".into());
    }
    let arch = arch_name()?;
    let trusted = trusted_keys();
    let ctx = Context {
        current: RELEASE_VERSION,
        arch,
        pin: PINNED_RELEASE_BASE,
        feed: DEFAULT_FEED,
        trusted: &trusted,
        bin: &bin,
        check_only: check,
    };
    let outcome = match from {
        Some(dir) => update(&ctx, &DirFetch(dir.to_path_buf()), &Systemd),
        None => update(&ctx, &HttpsFetch::new(), &Systemd),
    }
    .map_err(|e| e.to_string())?;
    match outcome {
        Outcome::UpToDate(v) => Ok(format!("psyche-helper {v} is the newest release")),
        Outcome::Available(v) => Ok(format!(
            "psyche-helper {v} is available (run `psyche-helper update`)"
        )),
        Outcome::Updated { from, to } => Ok(format!(
            "updated psyche-helper {from} -> {to} (`psyche-helper update --rollback` goes back)"
        )),
        Outcome::RolledBackAfterFailure { tried } => Err(format!(
            "{tried} did not start cleanly, so the previous helper is back; nothing else changed"
        )),
    }
}

/// The key ids this binary trusts for updates, sorted. `--build-info` prints them and the release
/// job compares them with the app's `release-keys.ts` (a test key or a drifted list fails there).
pub fn trusted_key_ids() -> Vec<String> {
    let mut ids: Vec<String> = trusted_keys().into_iter().map(|k| k.key_id).collect();
    ids.sort();
    ids
}

// ---------------------------------------------------------------------------------------------
// Who really owns the ceiling

/// Whether `path` and every directory above it belong to root and cannot be written by group or
/// others. A root-owned `policy.json` limits the account only if the program that reads it is out
/// of the account's reach too.
pub fn root_controlled(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(real) = fs::canonicalize(path) else {
        return false;
    };
    real.ancestors()
        .all(|p| fs::symlink_metadata(p).is_ok_and(|m| m.uid() == 0 && m.mode() & 0o022 == 0))
}

/// Whether `systemctl --user show -p FragmentPath -p DropInPaths` output names only unit files in
/// root-owned directories.
pub fn unit_files_packaged(show_output: &str) -> bool {
    const OK: [&str; 4] = [
        "/usr/lib/systemd/user/",
        "/lib/systemd/user/",
        "/etc/systemd/user/",
        "/usr/local/lib/systemd/user/",
    ];
    let mut fragment = false;
    for line in show_output.lines() {
        if let Some(v) = line.strip_prefix("FragmentPath=") {
            fragment = OK.iter().any(|p| v.starts_with(p));
            if !fragment {
                return false;
            }
        } else if let Some(v) = line.strip_prefix("DropInPaths=") {
            if v.split_whitespace()
                .any(|d| !OK.iter().any(|p| d.starts_with(p)))
            {
                return false;
            }
        }
    }
    fragment
}

fn unit_is_packaged() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        // Run by hand (`psyche-helper remote` in a terminal): there is no unit to check.
        if std::env::var_os("INVOCATION_ID").is_none() {
            return true;
        }
        Process::new("systemctl")
            .args([
                "--user",
                "show",
                "-p",
                "FragmentPath",
                "-p",
                "DropInPaths",
                UNIT,
            ])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .is_some_and(|o| unit_files_packaged(&String::from_utf8_lossy(&o.stdout)))
    })
}

/// `("root" | "user", reason)` for what Settings should say about the ceiling. A root-owned
/// `policy.json` counts as root's only when nothing the account owns can stand between the
/// file and the program that enforces it: the program and its folders are root's, and the
/// service's unit files are in root-owned places.
pub fn ceiling_owner(policy_is_root: bool) -> (&'static str, Option<&'static str>) {
    ceiling_owner_with(
        policy_is_root,
        std::env::current_exe().is_ok_and(|e| root_controlled(&e)),
        unit_is_packaged,
    )
}

pub fn ceiling_owner_with(
    policy_is_root: bool,
    program_root_controlled: bool,
    unit_packaged: impl FnOnce() -> bool,
) -> (&'static str, Option<&'static str>) {
    if !policy_is_root {
        return ("user", None);
    }
    if !program_root_controlled {
        return ("user", Some("program_writable"));
    }
    if !unit_packaged() {
        return ("user", Some("unit_overridden"));
    }
    ("root", None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    const PIN: &str = PINNED_RELEASE_BASE;
    const BASE: &str = "https://github.com/devmello/psyche/releases/download/v1.2.0/";

    fn key(seed: u8) -> (SigningKey, ReleaseKey) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let raw = sk.verifying_key().to_bytes();
        (
            sk,
            ReleaseKey {
                key_id: key_id_of(&raw),
                public_key: STANDARD.encode(raw),
            },
        )
    }

    fn sign(sk: &SigningKey, rk: &ReleaseKey, bytes: &[u8]) -> String {
        format!(
            "{{\"alg\":\"ed25519\",\"keyId\":\"{}\",\"signature\":\"{}\"}}",
            rk.key_id,
            STANDARD.encode(sk.sign(bytes).to_bytes())
        )
    }

    fn manifest_json(release: &str, base: &str, tar: &[u8]) -> Vec<u8> {
        serde_json::to_vec_pretty(&serde_json::json!({
            "format": "psyche-update-manifest", "version": 1,
            "release": release, "minimumVersion": "0.0.0",
            "publishedAt": "2026-11-20T00:00:00.000Z", "baseUrl": base,
            "artifacts": [],
            "platforms": { "linux-x64": [
                { "name": format!("psyche-helper-{release}-linux-x64.tar.zst"),
                  "kind": "helper-tar-zst", "sha256": sha256_hex(tar), "bytes": tar.len() },
                { "name": format!("psyche-helper-{release}-linux-x64.deb"),
                  "kind": "helper-deb", "sha256": sha256_hex(b"x"), "bytes": 1 },
            ]}
        }))
        .unwrap()
    }

    #[test]
    fn the_embedded_key_matches_its_id() {
        for (id, k) in TRUSTED_RELEASE_KEYS {
            assert_eq!(key_id_of(&STANDARD.decode(k).unwrap()), *id);
        }
    }

    #[test]
    fn versions_order_like_semver() {
        for (a, b, want) in [
            ("1.2.3", "1.2.3", 0),
            ("1.2.4", "1.2.3", 1),
            ("1.10.0", "1.9.0", 1),
            ("1.0.0", "1.0.0-alpha.1", 1),
            ("1.0.0-alpha.2", "1.0.0-alpha.10", -1),
            ("1.0.0-alpha", "1.0.0-alpha.1", -1),
            ("0.9.9", "1.0.0", -1),
        ] {
            assert_eq!(compare_versions(a, b), Some(want), "{a} {b}");
        }
        for bad in ["1.2", "x", "1.2.3.4", "1.2.3-", "01.a.3", ""] {
            assert_eq!(compare_versions(bad, "1.0.0"), None, "{bad}");
        }
    }

    #[test]
    fn the_pin_table() {
        for ok in [
            BASE,
            "https://github.com/devmello/psyche/releases/download/v1/",
        ] {
            assert!(is_under_pin(ok, PIN), "{ok}");
        }
        for bad in [
            "http://github.com/devmello/psyche/releases/download/v1/",
            "https://github.com.evil.example/devmello/psyche/releases/download/v1/",
            "https://evil@github.com/devmello/psyche/releases/download/v1/",
            "https://github.com:8443/devmello/psyche/releases/download/v1/",
            "https://github.com/devmello/psyche/releases/download/../../../evil/",
            "https://github.com/devmello/psyche/releases/download/%2e%2e/x/",
            "https://github.com/devmello/psyche/releases/download%2Fv1/",
            "https://github.com/devmello/psyche/releases/download/v1/?x=1",
            "https://github.com/devmello/psyche/releases/",
            "https://github.com/devmello/psyche-evil/releases/download/v1/",
            "https://github.com/devmello/psyche/releases/download",
            "https://github.com/other/psyche/releases/download/v1/",
        ] {
            assert!(!is_under_pin(bad, PIN), "{bad}");
        }
    }

    #[test]
    fn a_manifest_needs_a_signature_from_a_trusted_key() {
        let (sk, rk) = key(1);
        let (other, other_rk) = key(2);
        let bytes = manifest_json("1.2.0", BASE, b"tar");
        let good = sign(&sk, &rk, &bytes);
        assert!(verify_manifest(&bytes, Some(&good), &[rk.clone()], "x64").is_ok());
        assert!(matches!(
            verify_manifest(&bytes, None, &[rk.clone()], "x64"),
            Err(UpdateError::Unsigned(_))
        ));
        assert!(matches!(
            verify_manifest(&bytes, Some("nope"), &[rk.clone()], "x64"),
            Err(UpdateError::Unsigned(_))
        ));
        // Signed by a key we do not trust.
        assert!(matches!(
            verify_manifest(
                &bytes,
                Some(&sign(&other, &other_rk, &bytes)),
                &[rk.clone()],
                "x64"
            ),
            Err(UpdateError::UnknownKey(_))
        ));
        // Right key id, wrong signature (a different key's signature under our id).
        let forged = sign(&other, &rk, &bytes);
        assert_eq!(
            verify_manifest(&bytes, Some(&forged), &[rk.clone()], "x64"),
            Err(UpdateError::BadSignature)
        );
        // A byte changed after signing.
        let mut tampered = bytes.clone();
        tampered.push(b' ');
        assert_eq!(
            verify_manifest(&tampered, Some(&good), &[rk], "x64"),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn planning_refuses_downgrades_foreign_hosts_and_missing_artifacts() {
        let m = |release: &str, base: &str| Manifest {
            release: release.into(),
            base_url: base.into(),
            artifacts: vec![Artifact {
                name: "a.tar.zst".into(),
                kind: "helper-tar-zst".into(),
                sha256: "0".repeat(64),
                bytes: 1,
            }],
        };
        let plan = plan_update(&m("1.2.0", BASE), "1.1.0", PIN)
            .unwrap()
            .unwrap();
        assert_eq!(plan.url, format!("{BASE}a.tar.zst"));
        assert_eq!(
            plan_update(&m("1.2.0", BASE), "1.2.0", PIN),
            Ok(None),
            "same"
        );
        assert_eq!(
            plan_update(&m("1.1.0", BASE), "1.2.0", PIN),
            Ok(None),
            "downgrade"
        );
        assert!(matches!(
            plan_update(&m("1.2.0", "https://evil.example/x/"), "1.1.0", PIN),
            Err(UpdateError::UntrustedHost(_))
        ));
        assert!(matches!(
            plan_update(
                &m(
                    "1.2.0",
                    "https://github.com/devmello/psyche/releases/download/v1"
                ),
                "1.1.0",
                PIN
            ),
            Err(UpdateError::UntrustedHost(_))
        ));
        let mut none = m("1.2.0", BASE);
        none.artifacts.clear();
        assert!(matches!(
            plan_update(&none, "1.1.0", PIN),
            Err(UpdateError::NoArtifact(_))
        ));
    }

    #[test]
    fn artifacts_are_checked_by_size_and_hash() {
        let a = Artifact {
            name: "a".into(),
            kind: "helper-tar-zst".into(),
            sha256: sha256_hex(b"abc"),
            bytes: 3,
        };
        assert!(verify_artifact(b"abc", &a).is_ok());
        assert!(matches!(
            verify_artifact(b"abd", &a),
            Err(UpdateError::HashMismatch(_))
        ));
        assert!(matches!(
            verify_artifact(b"abcd", &a),
            Err(UpdateError::HashMismatch(_))
        ));
    }

    #[test]
    fn chunked_bodies_decode_and_truncated_ones_do_not() {
        assert_eq!(
            decode_chunked(b"3\r\nabc\r\n2;x=1\r\nde\r\n0\r\n\r\n", 100).unwrap(),
            b"abcde"
        );
        assert!(decode_chunked(b"5\r\nab", 100).is_err());
        assert!(decode_chunked(b"zz\r\n", 100).is_err());
        assert!(decode_chunked(b"3\r\nabc\r\n0\r\n\r\n", 2).is_err());
    }

    #[test]
    fn file_names_are_plain() {
        for bad in ["", "..", ".", "a/b", "a b", "a\\b", "é"] {
            assert!(!safe_name(bad), "{bad:?}");
        }
        assert!(safe_name("psyche-helper-1.2.0-linux-x64.tar.zst"));
    }

    // -- install, with a fake release ------------------------------------------------------

    struct MapFetch(RefCell<HashMap<String, Vec<u8>>>);
    impl Fetch for MapFetch {
        fn get(&self, url: &str, _max: usize) -> Result<Vec<u8>, UpdateError> {
            self.0
                .borrow()
                .get(url)
                .cloned()
                .ok_or_else(|| UpdateError::Network(format!("404 {url}")))
        }
    }

    struct FakeService {
        running: bool,
        healthy_after: Vec<bool>,
        restarts: Cell<u32>,
    }
    impl Service for FakeService {
        fn running(&self) -> bool {
            self.running
        }
        fn restart(&self) {
            self.restarts.set(self.restarts.get() + 1);
        }
        fn healthy(&self) -> bool {
            self.healthy_after[(self.restarts.get() as usize - 1).min(self.healthy_after.len() - 1)]
        }
    }

    /// A tar.zst holding a shell script that answers `--build-info` as `version`. None when the
    /// machine has no tar with zstd.
    fn fake_release(dir: &Path, version: &str) -> Option<Vec<u8>> {
        fake_release_as(dir, version, version)
    }

    /// The same, but the script inside reports `claims`.
    fn fake_release_as(dir: &Path, version: &str, claims: &str) -> Option<Vec<u8>> {
        let root = dir.join(format!("psyche-helper-{version}-linux-x64/bin"));
        fs::create_dir_all(&root).unwrap();
        let script =
            format!("#!/bin/sh\necho '{{\"name\":\"psyche-helper\",\"version\":\"{claims}\"}}'\n");
        fs::write(root.join("psyche-helper"), script).unwrap();
        let out = dir.join("r.tar.zst");
        let ok = Process::new("tar")
            .args(["--zstd", "-cf"])
            .arg(&out)
            .arg("-C")
            .arg(dir)
            .arg(format!("psyche-helper-{version}-linux-x64"))
            .status()
            .ok()?
            .success();
        ok.then(|| fs::read(out).unwrap())
    }

    struct Rig {
        _dir: tempfile::TempDir,
        bin: PathBuf,
        fetch: MapFetch,
        trusted: Vec<ReleaseKey>,
    }

    fn rig(
        release: &str,
        mutate: impl FnOnce(&mut Vec<u8>, &mut Vec<u8>, &mut String),
    ) -> Option<Rig> {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir(&src).unwrap();
        let mut tar = fake_release(&src, release)?;
        let (sk, rk) = key(7);
        let mut manifest = manifest_json(release, BASE, &tar);
        let mut sig = sign(&sk, &rk, &manifest);
        mutate(&mut tar, &mut manifest, &mut sig);
        let inst = dir.path().join("lib");
        fs::create_dir(&inst).unwrap();
        let bin = inst.join("psyche-helper");
        fs::write(&bin, "#!/bin/sh\necho old\n").unwrap();
        let mut files = HashMap::new();
        let feed = DEFAULT_FEED;
        files.insert(format!("{feed}{MANIFEST_FILE}"), manifest);
        files.insert(format!("{feed}{SIGNATURE_FILE}"), sig.into_bytes());
        files.insert(
            format!("{BASE}psyche-helper-{release}-linux-x64.tar.zst"),
            tar,
        );
        Some(Rig {
            _dir: dir,
            bin,
            fetch: MapFetch(RefCell::new(files)),
            trusted: vec![rk],
        })
    }

    fn ctx<'a>(r: &'a Rig, current: &'a str) -> Context<'a> {
        Context {
            current,
            arch: "x64",
            pin: PIN,
            feed: DEFAULT_FEED,
            trusted: &r.trusted,
            bin: &r.bin,
            check_only: false,
        }
    }

    fn svc(running: bool, healthy: Vec<bool>) -> FakeService {
        FakeService {
            running,
            healthy_after: healthy,
            restarts: Cell::new(0),
        }
    }

    #[test]
    fn an_update_installs_keeps_the_old_binary_and_rolls_back() {
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        let s = svc(true, vec![true]);
        let out = update(&ctx(&r, "1.1.0"), &r.fetch, &s).unwrap();
        assert_eq!(
            out,
            Outcome::Updated {
                from: "1.1.0".into(),
                to: "1.2.0".into()
            }
        );
        assert!(fs::read_to_string(&r.bin).unwrap().contains("1.2.0"));
        assert!(fs::read_to_string(prev_path(&r.bin))
            .unwrap()
            .contains("old"));
        assert_eq!(s.restarts.get(), 1);
        rollback(&r.bin).unwrap();
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
        assert!(fs::read_to_string(prev_path(&r.bin))
            .unwrap()
            .contains("1.2.0"));
        // No staging leftovers.
        let names: Vec<_> = fs::read_dir(r.bin.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn an_update_whose_service_does_not_start_rolls_itself_back() {
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        let s = svc(true, vec![false, true]);
        let out = update(&ctx(&r, "1.1.0"), &r.fetch, &s).unwrap();
        assert_eq!(
            out,
            Outcome::RolledBackAfterFailure {
                tried: "1.2.0".into()
            }
        );
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
        assert_eq!(s.restarts.get(), 2);
    }

    #[test]
    fn a_stopped_service_is_left_stopped() {
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        let s = svc(false, vec![true]);
        update(&ctx(&r, "1.1.0"), &r.fetch, &s).unwrap();
        assert_eq!(s.restarts.get(), 0);
    }

    #[test]
    fn a_tampered_tarball_is_refused_and_nothing_changes() {
        let Some(r) = rig("1.2.0", |tar, _, _| {
            let n = tar.len() / 2;
            tar[n] ^= 0xff;
        }) else {
            return;
        };
        let s = svc(true, vec![true]);
        let e = update(&ctx(&r, "1.1.0"), &r.fetch, &s).unwrap_err();
        assert!(matches!(e, UpdateError::HashMismatch(_)), "{e:?}");
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
        assert!(!prev_path(&r.bin).exists());
        assert_eq!(s.restarts.get(), 0);
    }

    #[test]
    fn a_tampered_or_unsigned_manifest_is_refused() {
        let Some(r) = rig("1.2.0", |_, m, _| m.push(b'\n')) else {
            return;
        };
        let e = update(&ctx(&r, "1.1.0"), &r.fetch, &svc(true, vec![true])).unwrap_err();
        assert_eq!(e, UpdateError::BadSignature);
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        r.fetch
            .0
            .borrow_mut()
            .remove(&format!("{DEFAULT_FEED}{SIGNATURE_FILE}"));
        let e = update(&ctx(&r, "1.1.0"), &r.fetch, &svc(true, vec![true])).unwrap_err();
        assert!(matches!(e, UpdateError::Unsigned(_)), "{e:?}");
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
    }

    #[test]
    fn an_older_signed_release_is_not_installed() {
        let Some(r) = rig("1.0.0", |_, _, _| {}) else {
            return;
        };
        let out = update(&ctx(&r, "1.1.0"), &r.fetch, &svc(true, vec![true])).unwrap();
        assert_eq!(out, Outcome::UpToDate("1.1.0".into()));
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
    }

    #[test]
    fn a_binary_that_reports_another_version_is_not_installed() {
        // The manifest and tarball say 1.2.0; the binary inside says 9.9.9.
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let Some(liar) = fake_release_as(dir.path(), "1.2.0", "9.9.9") else {
            return;
        };
        let (sk, rk) = key(7);
        // Rebuild the manifest around the liar tarball, named as 1.2.0 and correctly signed.
        let name = "psyche-helper-1.2.0-linux-x64.tar.zst";
        let m = manifest_json("1.2.0", BASE, &liar);
        let sig = sign(&sk, &rk, &m);
        r.fetch
            .0
            .borrow_mut()
            .insert(format!("{DEFAULT_FEED}{MANIFEST_FILE}"), m);
        r.fetch
            .0
            .borrow_mut()
            .insert(format!("{DEFAULT_FEED}{SIGNATURE_FILE}"), sig.into_bytes());
        r.fetch.0.borrow_mut().insert(format!("{BASE}{name}"), liar);
        let e = update(&ctx(&r, "1.1.0"), &r.fetch, &svc(true, vec![true])).unwrap_err();
        assert!(e.to_string().contains("9.9.9"), "{e}");
        assert!(fs::read_to_string(&r.bin).unwrap().contains("old"));
    }

    #[test]
    fn check_only_downloads_nothing() {
        let Some(r) = rig("1.2.0", |_, _, _| {}) else {
            return;
        };
        r.fetch
            .0
            .borrow_mut()
            .remove(&format!("{BASE}psyche-helper-1.2.0-linux-x64.tar.zst"));
        let mut c = ctx(&r, "1.1.0");
        c.check_only = true;
        assert_eq!(
            update(&c, &r.fetch, &svc(true, vec![true])).unwrap(),
            Outcome::Available("1.2.0".into())
        );
    }

    #[test]
    fn a_package_install_is_not_self_updating() {
        let e = tarball_binary(Path::new("/bin/sh"));
        // /bin/sh canonicalizes to /bin or /usr/bin: either way it is not ours to write.
        assert!(e.is_err());
    }

    #[test]
    fn redirects_stay_on_release_hosts() {
        assert!(redirect_host_ok("github.com"));
        assert!(redirect_host_ok("objects.githubusercontent.com"));
        assert!(redirect_host_ok("release-assets.githubusercontent.com"));
        for bad in [
            "evil.example",
            "githubusercontent.com.evil.example",
            "notgithub.com",
            "evilgithubusercontent.com",
        ] {
            assert!(!redirect_host_ok(bad), "{bad}");
        }
    }

    /// The ceilings install.sh writes must be ones the helper itself accepts: a file it refuses
    /// would deny everything on the box (remote/policy.rs fails closed).
    #[test]
    fn the_shipped_ceilings_parse_as_the_helper_reads_them() {
        use crate::remote::policy::Policy;
        for (name, text, shell) in [
            (
                "default",
                include_str!("../../../../../deploy/linux-helper/policy.default.json"),
                true,
            ),
            (
                "narrow",
                include_str!("../../../../../deploy/linux-helper/policy.narrow.json"),
                false,
            ),
        ] {
            let p: Policy = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(p.exec.enabled, shell, "{name}");
            assert!(p.exec.contain, "{name}");
            assert!(!p.surfaces.direct, "{name}");
            assert!(p.surfaces.virtual_screen, "{name}");
        }
    }

    #[test]
    fn a_chunk_size_that_overflows_is_refused_not_a_panic() {
        assert!(decode_chunked(b"1\r\na\r\nfffffffffffffffe\r\nxx", 100).is_err());
        assert!(decode_chunked(b"ffffffffffffffff\r\nxx", usize::MAX).is_err());
        assert!(decode_chunked(b"fffffffffffffffe\r\nxx", usize::MAX).is_err());
    }

    #[test]
    fn the_ceiling_is_root_owned_only_when_nothing_the_account_owns_is_in_the_way() {
        assert_eq!(ceiling_owner_with(false, true, || true), ("user", None));
        assert_eq!(
            ceiling_owner_with(true, false, || true),
            ("user", Some("program_writable"))
        );
        assert_eq!(
            ceiling_owner_with(true, true, || false),
            ("user", Some("unit_overridden"))
        );
        assert_eq!(ceiling_owner_with(true, true, || true), ("root", None));
        // The unit is not even asked when the program already settles it.
        assert_eq!(
            ceiling_owner_with(true, false, || panic!("not needed")),
            ("user", Some("program_writable"))
        );
    }

    #[test]
    fn unit_files_must_be_in_root_owned_places() {
        let ok = "FragmentPath=/usr/lib/systemd/user/psyche-helper-remote.service\nDropInPaths=\n";
        assert!(unit_files_packaged(ok));
        assert!(unit_files_packaged(
            "FragmentPath=/etc/systemd/user/psyche-helper-remote.service\nDropInPaths=/etc/systemd/user/psyche-helper-remote.service.d/a.conf\n"
        ));
        for bad in [
            "FragmentPath=/home/a/.config/systemd/user/psyche-helper-remote.service\nDropInPaths=\n",
            "FragmentPath=/home/a/.local/share/systemd/user/psyche-helper-remote.service\nDropInPaths=\n",
            "FragmentPath=/run/user/1000/systemd/user/psyche-helper-remote.service\nDropInPaths=\n",
            "FragmentPath=/usr/lib/systemd/user/psyche-helper-remote.service\nDropInPaths=/home/a/.config/systemd/user/psyche-helper-remote.service.d/x.conf\n",
            "FragmentPath=/usr/lib/systemd/user/psyche-helper-remote.service\nDropInPaths=/usr/lib/systemd/user/x.d/a.conf /home/a/x.conf\n",
            "FragmentPath=/usr/lib/systemd/user-evil/x.service\nDropInPaths=\n",
            "FragmentPath=\nDropInPaths=\n",
            "",
        ] {
            assert!(!unit_files_packaged(bad), "{bad}");
        }
    }

    #[test]
    fn a_program_is_root_controlled_only_in_root_owned_folders() {
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            let dir = tempfile::tempdir().unwrap();
            let f = dir.path().join("p");
            fs::write(&f, "x").unwrap();
            assert!(!root_controlled(&f));
        }
        assert!(!root_controlled(Path::new("/nonexistent/psyche")));
        #[cfg(target_os = "linux")]
        assert!(root_controlled(Path::new("/usr/bin/env")));
    }

    #[test]
    fn the_trusted_key_ids_are_listed() {
        assert!(trusted_key_ids().contains(&"37312dba0e2eddad".to_string()));
    }

    #[test]
    fn a_swap_never_leaves_no_binary_and_update_refuses_root_paths_to_a_missing_prev() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("psyche-helper");
        fs::write(&bin, "old").unwrap();
        let staged = dir.path().join("new");
        fs::write(&staged, "new").unwrap();
        swap_in(&bin, &staged).unwrap();
        assert_eq!(fs::read_to_string(&bin).unwrap(), "new");
        assert_eq!(fs::read_to_string(prev_path(&bin)).unwrap(), "old");
        // A failed final rename leaves the old helper where it was and removes the .prev copy.
        let bin2 = dir.path().join("b2");
        fs::write(&bin2, "old2").unwrap();
        assert!(swap_in(&bin2, &dir.path().join("missing")).is_err());
        assert_eq!(fs::read_to_string(&bin2).unwrap(), "old2");
        assert!(!prev_path(&bin2).exists());
        assert!(rollback(&bin2).is_err());
    }
}
