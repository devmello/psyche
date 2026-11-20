//! `fs.*` on a machine (design §5.2): `fs.list`, `fs.stat`, `fs.read` (read), `fs.write`,
//! `fs.mkdir` (write) and `fs.remove` (destructive), with `apps/node`'s names and semantics.
//!
//! - Absolute paths only, judged by components (no `..`).
//! - Confined to the ceiling's `files.roots`, read again on every call. A path is judged by its
//!   real spelling (the real path of the root it was reached through, plus the rest) against
//!   every root's real path: the deepest root that holds it decides its mode, so a read-only
//!   root inside a read-write one stays read-only whichever spelling reaches it (#1512 review
//!   r1, finding 6). `ro` roots refuse every write.
//! - Protected paths ([`protected`]) are refused whatever the roots say. A remove may not take a
//!   folder that holds one, nor a root of the ceiling or a folder that holds one.
//! - Every component below the root is opened with `O_NOFOLLOW` from its parent's descriptor
//!   ([`walk`]), so a symbolic link (planted before or during the call) never leads out. A file
//!   with more than one hard link is refused: its other name may be anywhere.
//! - Reads are chunked (`offset`, `length`, at most 512 KiB, and less when the text would not
//!   fit in one frame as JSON: `bytes` says how much was read) and carry an `etag`; a read or
//!   write that names an `etag` is refused when the file changed since.
//! - Writes go to a new file next to the target and are renamed over it.
//! - Each write, mkdir and remove leaves one journal line (path and byte count, never content).

pub mod fit;
pub mod protected;
pub mod walk;

use std::ffi::OsString;
use std::io::Write as _;
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use psyche_protocol::{ErrorCode, SideEffect, TargetKind};
use serde_json::{json, Map, Value};

use crate::capability::{Capability, CapabilityError, CapabilitySpec, InvocationContext, Registry};
use crate::journal::Journal;
use crate::remote::policy::{Mode, Policy, PolicySource};
use walk::{Entry, WalkError};

/// One read's bytes: base64 of this is ~683 KiB, well inside a 1 MiB frame.
pub const FS_READ_MAX_BYTES: u64 = 512 * 1024;
/// One read's text, JSON-encoded, at most.
pub const FS_READ_JSON_BUDGET: usize = 700 * 1024;
pub const FS_WRITE_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const FS_LIST_MAX_ENTRIES: usize = 1000;
const REMOVE_MAX_ENTRIES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    List,
    Stat,
    Read,
    Write,
    Mkdir,
    Remove,
}

impl Op {
    pub const ALL: [Op; 6] = [
        Op::List,
        Op::Stat,
        Op::Read,
        Op::Write,
        Op::Mkdir,
        Op::Remove,
    ];
    fn name(self) -> &'static str {
        match self {
            Op::List => "fs.list",
            Op::Stat => "fs.stat",
            Op::Read => "fs.read",
            Op::Write => "fs.write",
            Op::Mkdir => "fs.mkdir",
            Op::Remove => "fs.remove",
        }
    }
    fn writes(self) -> bool {
        matches!(self, Op::Write | Op::Mkdir | Op::Remove)
    }
    fn keys(self) -> &'static [&'static str] {
        match self {
            Op::List | Op::Stat => &["path"],
            Op::Read => &["path", "offset", "length", "encoding", "etag"],
            Op::Write => &["path", "content", "encoding", "createParents", "etag"],
            Op::Mkdir | Op::Remove => &["path", "recursive"],
        }
    }
}

fn err(code: ErrorCode, reason: &str, message: &str) -> CapabilityError {
    CapabilityError::new(code, reason, message)
}
fn invalid(message: &str) -> CapabilityError {
    err(ErrorCode::InvalidParams, "invalid_params", message)
}

fn walk_err(e: WalkError, path: &Path) -> CapabilityError {
    let shown = path.display();
    match e {
        WalkError::Symlink => err(
            ErrorCode::Forbidden,
            "symlink_escape",
            &format!("{shown} goes through a symbolic link"),
        ),
        WalkError::Missing => err(
            ErrorCode::NotFound,
            "not_found",
            &format!("{shown} does not exist"),
        ),
        WalkError::NotDir => invalid(&format!("a part of {shown} is not a folder")),
        WalkError::Io(e) => match e.raw_os_error() {
            Some(libc::EACCES) | Some(libc::EPERM) => err(
                ErrorCode::Forbidden,
                "os_permission",
                &format!("{shown}: permission denied"),
            ),
            Some(libc::EEXIST) => err(
                ErrorCode::Conflict,
                "exists",
                &format!("{shown} already exists"),
            ),
            Some(libc::ENOTEMPTY) => err(
                ErrorCode::Conflict,
                "not_empty",
                &format!("{shown} is not empty"),
            ),
            _ => err(ErrorCode::Internal, "io", &format!("{shown}: {}", e.kind())),
        },
    }
}

/// A path placed under one root of the ceiling.
#[derive(Debug)]
pub struct Located {
    pub root: PathBuf,
    pub parts: Vec<OsString>,
    pub shown: PathBuf,
    pub mode: Mode,
}

fn expand_root(path: &str, home: &Path) -> Option<PathBuf> {
    let p = if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    };
    protected::lexical(p.to_str()?)
}

/// Every root of the ceiling that exists: as written (expanded) and as it resolves.
pub fn real_roots(policy: &Policy, home: &Path) -> Vec<(PathBuf, PathBuf, Mode)> {
    policy
        .files
        .roots
        .iter()
        .filter_map(|root| {
            let expanded = expand_root(&root.path, home)?;
            let real = std::fs::canonicalize(&expanded).ok()?;
            Some((expanded, real, root.mode))
        })
        .collect()
}

/// Where `raw` lies under the ceiling, or why it may not be touched.
pub fn locate(
    policy: &Policy,
    home: &Path,
    raw: &str,
    write: bool,
) -> Result<Located, CapabilityError> {
    let Some(lex) = protected::lexical(raw) else {
        return Err(invalid("path must be an absolute path without `..`"));
    };
    let refused = |p: &Path| {
        err(
            ErrorCode::Forbidden,
            "protected_path",
            &format!("{} is protected on this computer", p.display()),
        )
    };
    if protected::is_protected(&lex, home) {
        return Err(refused(&lex));
    }
    let roots = real_roots(policy, home);
    // The real spelling: through the root (by either of its spellings) that holds `lex` deepest.
    let mut reached: Option<(usize, PathBuf)> = None;
    for (expanded, real, _) in &roots {
        for spelling in [expanded, real] {
            let Ok(rest) = lex.strip_prefix(spelling) else {
                continue;
            };
            let depth = spelling.components().count();
            if reached.as_ref().is_none_or(|(d, _)| depth > *d) {
                reached = Some((depth, real.join(rest)));
            }
        }
    }
    let not_allowed = || {
        err(
            ErrorCode::Forbidden,
            "machine_policy",
            "This computer's limits do not allow that path",
        )
    };
    let Some((_, shown)) = reached else {
        return Err(not_allowed());
    };
    // The deepest root by real path that holds the real spelling decides; on a tie (one folder
    // listed twice), read-only wins.
    let Some((_, real, mode)) = roots
        .iter()
        .filter(|(_, real, _)| shown.starts_with(real))
        .max_by_key(|(_, real, mode)| (real.components().count(), *mode == Mode::Ro))
    else {
        return Err(not_allowed());
    };
    let rest = shown.strip_prefix(real).unwrap_or(Path::new(""));
    let located = Located {
        root: real.clone(),
        parts: rest.iter().map(|c| c.to_os_string()).collect(),
        shown: shown.clone(),
        mode: *mode,
    };
    if protected::is_protected(&located.shown, home) {
        return Err(refused(&located.shown));
    }
    if write && located.mode != Mode::Rw {
        return Err(err(
            ErrorCode::Forbidden,
            "read_only_root",
            &format!("{} is read-only on this computer", located.root.display()),
        ));
    }
    Ok(located)
}

fn check_keys(op: Op, params: &Value) -> Result<&Map<String, Value>, CapabilityError> {
    let Some(map) = params.as_object() else {
        return Err(invalid("params must be an object"));
    };
    if let Some(k) = map.keys().find(|k| !op.keys().contains(&k.as_str())) {
        return Err(invalid(&format!("unknown param: {k}")));
    }
    Ok(map)
}

fn opt_bool(map: &Map<String, Value>, key: &str) -> Result<bool, CapabilityError> {
    match map.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(invalid(&format!("{key} must be a boolean"))),
    }
}

fn opt_u64(map: &Map<String, Value>, key: &str) -> Result<Option<u64>, CapabilityError> {
    match map.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid(&format!("{key} must be a non-negative integer"))),
    }
}

fn opt_str<'a>(map: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, CapabilityError> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(invalid(&format!("{key} must be a string"))),
    }
}

fn base64_mode(map: &Map<String, Value>) -> Result<bool, CapabilityError> {
    match opt_str(map, "encoding")? {
        None | Some("utf8") => Ok(false),
        Some("base64") => Ok(true),
        Some(_) => Err(invalid("encoding must be \"utf8\" or \"base64\"")),
    }
}

fn entry_json(e: &Entry) -> Value {
    json!({
        "kind": e.kind(),
        "size": e.size,
        "mtimeMs": e.mtime_ms(),
    })
}

/// The shared state of the six capabilities.
pub struct Files {
    pub source: Arc<PolicySource>,
    pub journal: Journal,
}

impl Files {
    pub fn run(&self, op: Op, params: &Value) -> Result<Value, CapabilityError> {
        let map = check_keys(op, params)?;
        let Some(raw) = opt_str(map, "path")? else {
            return Err(invalid("path is required"));
        };
        let loaded = self.source.load();
        let home = &self.source.home;
        let at = locate(&loaded.policy, home, raw, op.writes())?;
        let root = walk::open_root(&at.root).map_err(|e| walk_err(e.into(), &at.root))?;
        let shown = at.shown.display().to_string();
        let (last, parents) = match at.parts.split_last() {
            Some((last, parents)) => (Some(last), parents),
            None => (None, &at.parts[..]),
        };
        match op {
            Op::List => {
                let dir =
                    walk::walk(&root, &at.parts, false).map_err(|e| walk_err(e, &at.shown))?;
                let mut names = walk::names(&dir, FS_LIST_MAX_ENTRIES)
                    .map_err(|e| walk_err(e.into(), &at.shown))?;
                let truncated = names.len() > FS_LIST_MAX_ENTRIES;
                names.truncate(FS_LIST_MAX_ENTRIES);
                names.sort();
                let mut entries = Vec::new();
                for name in names {
                    let Ok(e) = walk::stat_at(&dir, &name) else {
                        continue;
                    };
                    let mut v = entry_json(&e);
                    v["name"] = json!(name.to_string_lossy());
                    entries.push(v);
                }
                Ok(json!({ "path": shown, "entries": entries, "truncated": truncated }))
            }
            Op::Stat => {
                let e = match last {
                    None => walk::stat_fd(root.as_raw_fd())
                        .map_err(|e| walk_err(e.into(), &at.shown))?,
                    Some(last) => {
                        let dir = walk::walk(&root, parents, false)
                            .map_err(|e| walk_err(e, &at.shown))?;
                        walk::stat_at(&dir, last).map_err(|e| walk_err(e.into(), &at.shown))?
                    }
                };
                let mut v = entry_json(&e);
                v["path"] = json!(shown);
                v["etag"] = json!(e.etag());
                v["id"] = json!(e.id());
                v["mode"] = json!(e.mode & 0o7777);
                Ok(v)
            }
            Op::Read => {
                let Some(last) = last else {
                    return Err(invalid(&format!("{shown} is a folder")));
                };
                let b64 = base64_mode(map)?;
                let offset = opt_u64(map, "offset")?.unwrap_or(0);
                let length = opt_u64(map, "length")?
                    .unwrap_or(FS_READ_MAX_BYTES)
                    .min(FS_READ_MAX_BYTES);
                let dir = walk::walk(&root, parents, false).map_err(|e| walk_err(e, &at.shown))?;
                let file = walk::open_file_at(&dir, last).map_err(|e| walk_err(e, &at.shown))?;
                let e =
                    walk::stat_fd(file.as_raw_fd()).map_err(|e| walk_err(e.into(), &at.shown))?;
                if !e.is_file() {
                    return Err(invalid(&format!("{shown} is not a regular file")));
                }
                if e.nlink > 1 {
                    return Err(err(
                        ErrorCode::Forbidden,
                        "hard_link",
                        &format!("{shown} has other names (hard links); it is not read"),
                    ));
                }
                if let Some(want) = opt_str(map, "etag")? {
                    if want != e.etag() {
                        return Err(err(
                            ErrorCode::Conflict,
                            "etag_changed",
                            &format!("{shown} changed since it was read"),
                        ));
                    }
                }
                let offset = offset.min(e.size);
                let want = length.min(e.size - offset);
                let mut buf = vec![0u8; usize::try_from(want).unwrap_or(0)];
                let mut got = 0usize;
                while got < buf.len() {
                    match file.read_at(&mut buf[got..], offset + got as u64) {
                        Ok(0) => break,
                        Ok(n) => got += n,
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(e) => return Err(walk_err(e.into(), &at.shown)),
                    }
                }
                buf.truncate(got);
                // Text is cut where its JSON would no longer fit in one frame; `bytes` says how
                // far it got, so the next read goes on from there.
                let content = if b64 {
                    base64::engine::general_purpose::STANDARD.encode(&buf)
                } else {
                    let at_end = offset + got as u64 >= e.size;
                    let (text, covered) = fit::fit_utf8(&buf, FS_READ_JSON_BUDGET, at_end);
                    got = covered;
                    text
                };
                Ok(json!({
                    "path": shown,
                    "encoding": if b64 { "base64" } else { "utf8" },
                    "content": content,
                    "size": e.size,
                    "offset": offset,
                    "bytes": got,
                    "etag": e.etag(),
                    "eof": offset + got as u64 >= e.size,
                    "truncated": offset + (got as u64) < e.size,
                }))
            }
            Op::Write => {
                let Some(last) = last else {
                    return Err(invalid(&format!("{shown} is a folder")));
                };
                let b64 = base64_mode(map)?;
                let Some(content) = opt_str(map, "content")? else {
                    return Err(invalid("content is required"));
                };
                let data = if b64 {
                    base64::engine::general_purpose::STANDARD
                        .decode(content)
                        .map_err(|_| invalid("content is not base64"))?
                } else {
                    content.as_bytes().to_vec()
                };
                if data.len() > FS_WRITE_MAX_BYTES {
                    return Err(invalid(&format!(
                        "content exceeds {FS_WRITE_MAX_BYTES} bytes"
                    )));
                }
                let create = opt_bool(map, "createParents")?;
                let dir = walk::walk(&root, parents, create).map_err(|e| walk_err(e, &at.shown))?;
                let mut perm = 0o644;
                match walk::stat_at(&dir, last) {
                    Ok(e) if e.is_file() => {
                        perm = e.mode & 0o777;
                        if let Some(want) = opt_str(map, "etag")? {
                            if want != e.etag() {
                                return Err(err(
                                    ErrorCode::Conflict,
                                    "etag_changed",
                                    &format!("{shown} changed since it was read"),
                                ));
                            }
                        }
                    }
                    Ok(e) if e.kind() == "symlink" => {
                        return Err(walk_err(WalkError::Symlink, &at.shown));
                    }
                    Ok(_) => return Err(invalid(&format!("{shown} is not a regular file"))),
                    Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {
                        if opt_str(map, "etag")?.is_some() {
                            return Err(err(
                                ErrorCode::Conflict,
                                "etag_changed",
                                &format!("{shown} no longer exists"),
                            ));
                        }
                    }
                    Err(e) => return Err(walk_err(e.into(), &at.shown)),
                }
                let mut rnd = [0u8; 8];
                let _ = getrandom::fill(&mut rnd);
                let tmp: OsString = format!(
                    ".{}.psyche-{}",
                    last.to_string_lossy().chars().take(64).collect::<String>(),
                    rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()
                )
                .into();
                let written = (|| -> std::io::Result<()> {
                    let mut f = walk::create_new_at(&dir, &tmp, perm)?;
                    f.write_all(&data)?;
                    f.sync_all()?;
                    walk::rename_at(&dir, &tmp, last)
                })();
                if let Err(e) = written {
                    let _ = walk::unlink_at(&dir, &tmp, false);
                    return Err(walk_err(e.into(), &at.shown));
                }
                let etag = walk::stat_at(&dir, last)
                    .map(|e| e.etag())
                    .unwrap_or_default();
                self.journal.send(
                    "fs.write",
                    &format!("psyche wrote {} bytes to {shown}", data.len()),
                    &[("path", shown.clone()), ("bytes", data.len().to_string())],
                );
                Ok(json!({ "path": shown, "bytes": data.len(), "etag": etag }))
            }
            Op::Mkdir => {
                let Some(last) = last else {
                    return Ok(json!({ "path": shown, "created": false }));
                };
                let recursive = opt_bool(map, "recursive")?;
                let dir =
                    walk::walk(&root, parents, recursive).map_err(|e| walk_err(e, &at.shown))?;
                let created = match walk::mkdir_at(&dir, last) {
                    Ok(()) => true,
                    Err(e) if e.raw_os_error() == Some(libc::EEXIST) => {
                        let e =
                            walk::stat_at(&dir, last).map_err(|e| walk_err(e.into(), &at.shown))?;
                        if !e.is_dir() {
                            return Err(err(
                                ErrorCode::Conflict,
                                "exists",
                                &format!("{shown} exists and is not a folder"),
                            ));
                        }
                        false
                    }
                    Err(e) => return Err(walk_err(e.into(), &at.shown)),
                };
                if created {
                    self.journal.send(
                        "fs.mkdir",
                        &format!("psyche made the folder {shown}"),
                        &[("path", shown.clone())],
                    );
                }
                Ok(json!({ "path": shown, "created": created }))
            }
            Op::Remove => {
                let Some(last) = last else {
                    return Err(err(
                        ErrorCode::Forbidden,
                        "root",
                        "A root of this computer's limits is never removed",
                    ));
                };
                if protected::holds_protected(&at.shown, home) {
                    return Err(err(
                        ErrorCode::Forbidden,
                        "protected_path",
                        &format!("{shown} holds protected files"),
                    ));
                }
                // A folder that holds another root (a read-only one above all) would take it.
                if real_roots(&loaded.policy, home)
                    .iter()
                    .any(|(_, real, _)| real.starts_with(&at.shown))
                {
                    return Err(err(
                        ErrorCode::Forbidden,
                        "holds_root",
                        &format!(
                            "{shown} holds a root of this computer's limits; it is not removed"
                        ),
                    ));
                }
                let recursive = opt_bool(map, "recursive")?;
                let dir = walk::walk(&root, parents, false).map_err(|e| walk_err(e, &at.shown))?;
                let e = walk::stat_at(&dir, last).map_err(|e| walk_err(e.into(), &at.shown))?;
                if e.is_dir() && recursive {
                    let mut budget = REMOVE_MAX_ENTRIES;
                    walk::remove_tree_at(&dir, last, &mut budget)
                        .map_err(|e| walk_err(e, &at.shown))?;
                } else {
                    walk::unlink_at(&dir, last, e.is_dir())
                        .map_err(|e| walk_err(e.into(), &at.shown))?;
                }
                self.journal.send(
                    "fs.remove",
                    &format!("psyche removed {shown}"),
                    &[("path", shown.clone()), ("kind", e.kind().into())],
                );
                Ok(json!({ "path": shown, "removed": true }))
            }
        }
    }
}

struct FsCapability {
    op: Op,
    files: Arc<Files>,
}

impl Capability for FsCapability {
    fn spec(&self) -> CapabilitySpec {
        let (description, side_effect) = match self.op {
            Op::List => ("List a folder inside this computer's file roots.", SideEffect::Read),
            Op::Stat => ("Describe a file or folder inside this computer's file roots.", SideEffect::Read),
            Op::Read => ("Read part of a file (at most 512 KiB per call) inside this computer's file roots.", SideEffect::Read),
            Op::Write => ("Write a whole file inside a read-write root of this computer.", SideEffect::Write),
            Op::Mkdir => ("Make a folder inside a read-write root of this computer.", SideEffect::Write),
            Op::Remove => ("Remove a file or folder inside a read-write root of this computer. Needs an approval.", SideEffect::Destructive),
        };
        CapabilitySpec {
            name: self.op.name(),
            description,
            side_effect,
            target_kind: Some(TargetKind::Path),
            streaming: false,
        }
    }

    fn input_schema(&self) -> Option<Value> {
        let mut props = Map::new();
        props.insert(
            "path".into(),
            json!({ "type": "string", "minLength": 1, "maxLength": 4096 }),
        );
        for key in self.op.keys() {
            let schema = match *key {
                "offset" | "length" => json!({ "type": "integer", "minimum": 0 }),
                "encoding" => json!({ "type": "string", "enum": ["utf8", "base64"] }),
                "etag" => json!({ "type": "string", "maxLength": 128 }),
                "content" => json!({ "type": "string" }),
                "createParents" | "recursive" => json!({ "type": "boolean" }),
                _ => continue,
            };
            props.insert((*key).into(), schema);
        }
        let required: Vec<&str> = if self.op == Op::Write {
            vec!["path", "content"]
        } else {
            vec!["path"]
        };
        Some(json!({
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": false,
        }))
    }

    fn invoke(&self, ctx: &InvocationContext) -> Result<Value, CapabilityError> {
        self.files.run(self.op, &ctx.params)
    }
}

/// Registers the six `fs.*` capabilities (remote mode only; the policy gate wraps them too).
pub fn register(registry: &mut Registry, source: Arc<PolicySource>, journal: Journal) {
    let files = Arc::new(Files { source, journal });
    for op in Op::ALL {
        registry.register(Arc::new(FsCapability {
            op,
            files: Arc::clone(&files),
        }));
    }
}

#[cfg(test)]
mod tests;
