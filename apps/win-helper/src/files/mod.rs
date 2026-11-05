//! `files.recent`, `files.move`, `files.rename`, `files.trash`, `finder.list`, `finder.reveal`
//! (apple-apps-2026 §4.8, F1–F3), Windows edition, granted folders only (`node::roots`).
//!
//! - `files.trash` moves items to the Recycle Bin with `IFileOperation`; an item that cannot be
//!   recycled (network share, a drive without a Recycle Bin) is refused, never deleted.
//!   `trashPath` is where the Recycle Bin put it.
//! - `files.recent` lists a granted folder newest first by creation time (Windows has no
//!   "date added"; a download's creation time is when it arrived). `folder: "shell:recent"` lists
//!   the shell's Recent items instead (files the user opened lately, newest first by last use),
//!   limited to targets inside granted folders.
//! - `contentType` is a UTType-style id from the extension (`com.adobe.pdf`, `public.png`, …);
//!   `contentTypes` filters accept those ids, a few conformance groups (`public.image`,
//!   `public.movie`, `public.audio`, `public.text`, `public.archive`, `public.data`) or extensions.
//! - `finder.*` keeps its name: `finder.reveal` opens an Explorer window with the item selected.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use windows::Win32::Foundation::E_ABORT;
use windows::Win32::System::Com::{CLSCTX_ALL, CoCreateInstance};
use windows::Win32::UI::Shell::{
    FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING,
    FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOLDERID_Recent, FileOperation, IFileOperation,
    IFileOperationProgressSink, IFileOperationProgressSink_Impl, IShellItem,
    SHCreateItemFromParsingName, SIGDN_FILESYSPATH, TSF_DELETE_RECYCLE_IF_POSSIBLE,
};
use windows::core::{HRESULT, HSTRING, PCWSTR, Ref, implement};

use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, ErrorCode, ReceiptDraft, SideEffect,
    TargetKind,
};
use crate::node::paths::Env;
use crate::node::roots::{FinderRoots, expand_tilde, is_absolute, is_within};
use crate::node::time::{iso8601, parse_iso8601_millis, unix_millis};
use crate::node::{CapabilityRegistry, schema};
use crate::win::shell;

pub const MAX_MOVE: usize = 100;
pub const MAX_TRASH: usize = 200;
pub const RECENT_FOLDER: &str = "shell:recent";

const UTIS: &[(&str, &str)] = &[
    ("pdf", "com.adobe.pdf"),
    ("png", "public.png"),
    ("jpg", "public.jpeg"),
    ("jpeg", "public.jpeg"),
    ("gif", "com.compuserve.gif"),
    ("heic", "public.heic"),
    ("tif", "public.tiff"),
    ("tiff", "public.tiff"),
    ("bmp", "com.microsoft.bmp"),
    ("webp", "org.webmproject.webp"),
    ("svg", "public.svg-image"),
    ("txt", "public.plain-text"),
    ("md", "net.daringfireball.markdown"),
    ("csv", "public.comma-separated-values-text"),
    ("json", "public.json"),
    ("html", "public.html"),
    ("htm", "public.html"),
    ("xml", "public.xml"),
    ("rtf", "public.rtf"),
    ("zip", "public.zip-archive"),
    ("7z", "org.7-zip.7-zip-archive"),
    ("doc", "com.microsoft.word.doc"),
    ("docx", "org.openxmlformats.wordprocessingml.document"),
    ("xls", "com.microsoft.excel.xls"),
    ("xlsx", "org.openxmlformats.spreadsheetml.sheet"),
    ("ppt", "com.microsoft.powerpoint.ppt"),
    ("pptx", "org.openxmlformats.presentationml.presentation"),
    ("mp3", "public.mp3"),
    ("m4a", "com.apple.m4a-audio"),
    ("wav", "com.microsoft.waveform-audio"),
    ("mp4", "public.mpeg-4"),
    ("mov", "com.apple.quicktime-movie"),
    ("avi", "public.avi"),
    ("mkv", "org.matroska.mkv"),
    ("eml", "com.apple.mail.email"),
    ("ics", "com.apple.ical.ics"),
];

const GROUPS: &[(&str, &[&str])] = &[
    (
        "public.image",
        &[
            "png", "jpg", "jpeg", "gif", "heic", "tif", "tiff", "bmp", "webp", "svg",
        ],
    ),
    ("public.movie", &["mp4", "mov", "avi", "mkv"]),
    ("public.video", &["mp4", "mov", "avi", "mkv"]),
    (
        "public.audiovisual-content",
        &["mp4", "mov", "avi", "mkv", "mp3", "m4a", "wav"],
    ),
    ("public.audio", &["mp3", "m4a", "wav"]),
    (
        "public.text",
        &["txt", "md", "csv", "json", "html", "htm", "xml", "rtf"],
    ),
    ("public.archive", &["zip", "7z"]),
];

/// The UTType-style id for a file name's extension.
pub fn content_type(name: &str) -> Option<&'static str> {
    let ext = Path::new(name)
        .extension()?
        .to_string_lossy()
        .to_lowercase();
    UTIS.iter().find(|(e, _)| *e == ext).map(|(_, u)| *u)
}

/// Requested types → allowed extensions (`None`: everything). Unknown types are `invalid_params`.
pub fn wanted_extensions(
    types: Option<&[String]>,
) -> Result<Option<HashSet<String>>, CapabilityError> {
    let Some(types) = types.filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    if types.len() > 20 {
        return Err(CapabilityError::invalid_params(
            "at most 20 contentTypes",
            Some("contentTypes"),
        ));
    }
    let mut out = HashSet::new();
    for raw in types {
        let t = raw.trim().trim_matches('.').to_lowercase();
        if t == "public.data" || t == "public.item" || t == "public.content" {
            return Ok(None);
        }
        if let Some((_, exts)) = GROUPS.iter().find(|(g, _)| *g == t) {
            out.extend(exts.iter().map(|e| e.to_string()));
        } else if UTIS.iter().any(|(_, u)| *u == t) {
            out.extend(
                UTIS.iter()
                    .filter(|(_, u)| *u == t)
                    .map(|(e, _)| e.to_string()),
            );
        } else if !t.is_empty() && t.len() <= 16 && t.chars().all(|c| c.is_ascii_alphanumeric()) {
            out.insert(t);
        } else {
            return Err(CapabilityError::invalid_params(
                format!("unknown content type {raw}"),
                Some("contentTypes"),
            ));
        }
    }
    Ok(Some(out))
}

/// A plain Windows file name: no separators or reserved characters, not `.`/`..`, no trailing dot
/// or space, not a reserved device name, at most 255 UTF-8 bytes.
pub fn check_name(name: &str, field: &str) -> Result<(), CapabilityError> {
    let n = name.trim();
    let stem = n.split('.').next().unwrap_or_default().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    let bad = n.is_empty()
        || n == "."
        || n == ".."
        || n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || n.chars().any(|c| c.is_control())
        || n.ends_with('.')
        || name.ends_with(' ')
        || n.len() > 255
        || reserved;
    if bad {
        Err(CapabilityError::invalid_params(
            format!("{field} is a plain file name"),
            Some(field),
        ))
    } else {
        Ok(())
    }
}

fn exists_no_follow(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// The item itself (a link is the link): its parent inside a granted root; a granted root itself
/// is never moved or trashed.
pub fn item(
    path: &str,
    roots: &FinderRoots,
    env: &Env,
    field: &str,
) -> Result<PathBuf, CapabilityError> {
    let expanded = expand_tilde(path, env);
    if !is_absolute(&expanded) {
        return Err(CapabilityError::invalid_params(
            format!("{field} must be absolute"),
            Some(field),
        ));
    }
    let p = PathBuf::from(&expanded);
    let name = p
        .file_name()
        .ok_or_else(|| {
            CapabilityError::invalid_params(format!("{field} must name an item"), Some(field))
        })?
        .to_owned();
    let parent = p.parent().ok_or_else(|| {
        CapabilityError::invalid_params(format!("{field} must name an item"), Some(field))
    })?;
    let full = roots.resolve(&parent.to_string_lossy(), env)?.join(name);
    if roots.contains_root(&full) {
        return Err(CapabilityError::policy_denied(
            "granted_root",
            format!("{path} is a granted folder itself"),
        )
        .with_detail("path", path));
    }
    if !exists_no_follow(&full) {
        return Err(
            CapabilityError::not_found("not_found", format!("{path} does not exist"))
                .with_detail("path", path),
        );
    }
    Ok(full)
}

/// A destination folder inside the granted roots that exists.
pub fn folder(path: &str, roots: &FinderRoots, env: &Env) -> Result<PathBuf, CapabilityError> {
    let dir = roots.resolve(path, env)?;
    if !dir.is_dir() {
        return Err(CapabilityError::not_found(
            "folder_not_found",
            format!("{path} is not a folder"),
        )
        .with_detail("path", path));
    }
    Ok(dir)
}

fn kind_of(meta: &std::fs::Metadata) -> &'static str {
    let t = meta.file_type();
    if t.is_symlink() {
        "symlink"
    } else if t.is_dir() {
        "directory"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    }
}

fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    name.starts_with('.') || meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

/// `AppleFileItem` shape: every key present (`null` when unknown).
pub fn file_item(path: &Path, added_override: Option<SystemTime>) -> Value {
    let meta = std::fs::symlink_metadata(path).ok();
    let kind = meta.as_ref().map_or("other", kind_of);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    json!({
        "name": name,
        "path": path.display().to_string(),
        "kind": kind,
        "size": if kind == "file" { meta.as_ref().map(|m| Value::from(m.len())) } else { None },
        "modified": meta.as_ref().and_then(|m| m.modified().ok()).map(iso8601),
        "added": added_override.or_else(|| meta.as_ref().and_then(|m| m.created().ok())).map(iso8601),
        "contentType": content_type(&name),
    })
}

/// Newest added first (falls back to modified), then by name.
pub fn newest_added(items: &mut [Value]) {
    let key = |v: &Value| {
        v["added"]
            .as_str()
            .or(v["modified"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    items.sort_by(|a, b| {
        let (x, y) = (key(a), key(b));
        if x == y {
            a["name"].as_str().cmp(&b["name"].as_str())
        } else {
            y.cmp(&x)
        }
    });
}

fn untrusted(mut o: Map<String, Value>) -> Value {
    o.insert("provenance".into(), "untrusted".into());
    Value::Object(o)
}

fn limit(v: Option<i64>, default: usize) -> Result<usize, CapabilityError> {
    let l = v.unwrap_or(default as i64);
    if !(1..=500).contains(&l) {
        return Err(CapabilityError::invalid_params(
            "limit must be 1–500",
            Some("limit"),
        ));
    }
    Ok(l as usize)
}

fn date_param(s: Option<&str>, field: &str) -> Result<Option<i64>, CapabilityError> {
    s.map(|v| {
        parse_iso8601_millis(v).ok_or_else(|| {
            CapabilityError::invalid_params(
                format!("{field} must be an ISO 8601 date-time"),
                Some(field),
            )
        })
    })
    .transpose()
}

// MARK: Recycle Bin

#[derive(Default)]
struct TrashState {
    refused: bool,
    recycled: Option<String>,
}

#[implement(IFileOperationProgressSink)]
struct TrashSink {
    state: Arc<Mutex<TrashState>>,
}

#[allow(non_snake_case)]
impl IFileOperationProgressSink_Impl for TrashSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _hr: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _n: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _n: &PCWSTR,
        _hr: HRESULT,
        _c: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
        _hr: HRESULT,
        _c: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _f: u32,
        _i: Ref<IShellItem>,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
        _hr: HRESULT,
        _c: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> windows::core::Result<()> {
        // Only recycling is allowed: an item the shell would destroy is refused.
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            self.state.lock().unwrap_or_else(|p| p.into_inner()).refused = true;
            return Err(E_ABORT.into());
        }
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        _f: u32,
        _item: Ref<IShellItem>,
        hr: HRESULT,
        created: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        if hr.is_ok()
            && let Some(item) = created.as_ref()
        {
            // SAFETY: the shell item is valid for the call; the string is freed after the copy.
            let path = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }
                .ok()
                .and_then(|p| unsafe {
                    let s = p.to_string().ok();
                    windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as *const _));
                    s
                });
            self.state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .recycled = path;
        }
        Ok(())
    }
    fn PreNewItem(&self, _f: u32, _d: Ref<IShellItem>, _n: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _f: u32,
        _d: Ref<IShellItem>,
        _n: &PCWSTR,
        _t: &PCWSTR,
        _a: u32,
        _hr: HRESULT,
        _i: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _total: u32, _done: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

/// Moves one item to the Recycle Bin; returns where it went. Never deletes permanently.
pub fn recycle(path: &Path) -> Result<Option<String>, CapabilityError> {
    let fail = |reason: &str| {
        CapabilityError::unavailable(
            reason,
            format!(
                "Could not move {} to the Recycle Bin",
                path.file_name()
                    .map(|n| n.to_string_lossy())
                    .unwrap_or_default()
            ),
        )
    };
    let state = Arc::new(Mutex::new(TrashState::default()));
    let sink: IFileOperationProgressSink = TrashSink {
        state: state.clone(),
    }
    .into();
    // SAFETY: COM calls on objects created here; the shell item and sink outlive the operation.
    let result = unsafe {
        (|| -> windows::core::Result<bool> {
            let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
            op.SetOperationFlags(
                FOF_ALLOWUNDO
                    | FOF_NOCONFIRMATION
                    | FOF_SILENT
                    | FOF_NOERRORUI
                    | FOF_WANTNUKEWARNING
                    | FOFX_RECYCLEONDELETE
                    | FOFX_EARLYFAILURE,
            )?;
            let item: IShellItem =
                SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)?;
            op.DeleteItem(&item, &sink)?;
            let performed = op.PerformOperations();
            let aborted = op
                .GetAnyOperationsAborted()
                .map(|b| b.as_bool())
                .unwrap_or(true);
            performed.map(|()| !aborted)
        })()
    };
    let s = state.lock().unwrap_or_else(|p| p.into_inner());
    if s.refused {
        return Err(fail("not_recyclable").with_detail(
            "why",
            "This location has no Recycle Bin; Psyche never deletes permanently",
        ));
    }
    match result {
        Ok(true) if !exists_no_follow(path) => Ok(s.recycled.clone()),
        _ => Err(fail("trash_failed")),
    }
}

// MARK: Params

#[derive(Deserialize)]
struct RecentParams {
    folder: String,
    #[serde(rename = "addedSince")]
    added_since: Option<String>,
    #[serde(rename = "addedBefore")]
    added_before: Option<String>,
    #[serde(rename = "contentTypes")]
    content_types: Option<Vec<String>>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct MoveItem {
    path: String,
    to: String,
    name: Option<String>,
}

#[derive(Deserialize)]
struct MoveParams {
    items: Vec<MoveItem>,
}

#[derive(Deserialize)]
struct RenameParams {
    path: String,
    name: String,
}

#[derive(Deserialize)]
struct TrashParams {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct ListParams {
    path: String,
    limit: Option<i64>,
    hidden: Option<bool>,
}

#[derive(Deserialize)]
struct PathParam {
    path: String,
}

fn recent_items(roots: &FinderRoots) -> Vec<(PathBuf, SystemTime)> {
    let Some(dir) = shell::known_folder(&FOLDERID_Recent) else {
        return vec![];
    };
    let mut out: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut seen = HashSet::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.extension().is_none_or(|x| !x.eq_ignore_ascii_case("lnk")) {
            continue;
        }
        let used = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let Some((Some(target), _)) = shell::read_shortcut(&p) else {
            continue;
        };
        let t = PathBuf::from(&target);
        if t.is_file()
            && roots.roots.iter().any(|r| is_within(&t, r))
            && seen.insert(target.to_lowercase())
        {
            out.push((t, used));
        }
    }
    out
}

fn list_entries(dir: &Path, limit: usize, hidden: bool) -> Result<Vec<Value>, CapabilityError> {
    let rd = std::fs::read_dir(dir).map_err(|_| {
        CapabilityError::not_found(
            "not_a_directory",
            format!("{} is not a readable folder", dir.display()),
        )
    })?;
    let mut items: Vec<(String, PathBuf, std::fs::Metadata)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let meta = std::fs::symlink_metadata(e.path()).ok()?;
            (hidden || !is_hidden(&name, &meta)).then(|| (name, e.path(), meta))
        })
        .collect();
    items.sort_by(|a, b| shell::natural_cmp(&a.0, &b.0));
    Ok(items
        .into_iter()
        .take(limit)
        .map(|(name, path, meta)| {
            let kind = kind_of(&meta);
            json!({
                "name": name,
                "path": path.display().to_string(),
                "kind": kind,
                "size": if kind == "file" { Some(meta.len()) } else { None },
                "modified": meta.modified().ok().map(iso8601),
            })
        })
        .collect())
}

fn iso_schema() -> Value {
    schema::string(Some("ISO 8601 date-time"))
}

pub fn register(reg: &mut CapabilityRegistry) {
    let env = reg.runtime().env.clone();

    let e = env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "files.recent",
            "Files in a granted folder (e.g. ~\\Downloads), newest first, optionally added since / before and of some types (UTType ids or extensions such as pdf). Not recursive; hidden files left out. folder \"shell:recent\" lists recently opened files inside granted folders. Read-only.",
            SideEffect::Read,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![
                ("folder", schema::string(Some("A granted folder, or shell:recent"))),
                ("addedSince", iso_schema()),
                ("addedBefore", iso_schema()),
                ("contentTypes", schema::array(schema::string_max(None, 100), None, Some(20))),
                ("limit", schema::integer(Some("Default 50"), Some(1), Some(500))),
            ],
            &["folder"],
        )),
        move |ctx| {
            let p: RecentParams = ctx.decode()?;
            let roots = FinderRoots::load(&e);
            let since = date_param(p.added_since.as_deref(), "addedSince")?;
            let before = date_param(p.added_before.as_deref(), "addedBefore")?;
            let wanted = wanted_extensions(p.content_types.as_deref())?;
            let candidates: Vec<(PathBuf, Option<SystemTime>)> = if p.folder.eq_ignore_ascii_case(RECENT_FOLDER) {
                if roots.roots.is_empty() {
                    return Err(CapabilityError::policy_denied("no_granted_folders", "No folders are granted. Add one in Settings → Permissions → Folders."));
                }
                recent_items(&roots).into_iter().map(|(p, t)| (p, Some(t))).collect()
            } else {
                let dir = folder(&p.folder, &roots, &e)?;
                std::fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|d| {
                        let name = d.file_name().to_string_lossy().into_owned();
                        std::fs::symlink_metadata(d.path()).is_ok_and(|m| !m.is_dir() && !is_hidden(&name, &m))
                    })
                    .map(|d| (d.path(), None))
                    .collect()
            };
            let mut items: Vec<Value> = candidates
                .into_iter()
                .filter(|(path, _)| {
                    wanted.as_ref().is_none_or(|w| path.extension().is_some_and(|x| w.contains(&x.to_string_lossy().to_lowercase())))
                })
                .filter_map(|(path, used)| {
                    let meta = std::fs::symlink_metadata(&path).ok()?;
                    let added = used.or_else(|| meta.created().ok()).or_else(|| meta.modified().ok()).map(unix_millis);
                    if since.is_some_and(|s| added.is_none_or(|a| a < s)) || before.is_some_and(|b| added.is_some_and(|a| a >= b)) {
                        return None;
                    }
                    Some(file_item(&path, used))
                })
                .collect();
            newest_added(&mut items);
            items.truncate(limit(p.limit, 20)?);
            let mut o = Map::new();
            o.insert("files".into(), Value::Array(items));
            Ok(CapabilityOutput::new(untrusted(o)))
        },
    );

    let e = env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "files.move",
            "Move up to 100 files or folders into granted folders, optionally renaming each. Never overwrites: an existing name is refused before anything moves.",
            SideEffect::Write,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![(
                "items",
                schema::array(
                    schema::object(
                        vec![
                            ("path", schema::string(None)),
                            ("to", schema::string(Some("Destination folder (granted)"))),
                            ("name", schema::string_max(Some("New file name"), 255)),
                        ],
                        &["path", "to"],
                    ),
                    None,
                    Some(MAX_MOVE as u64),
                ),
            )],
            &["items"],
        ))
        .receipt("connector_action"),
        move |ctx| {
            let p: MoveParams = ctx.decode()?;
            if !(1..=MAX_MOVE).contains(&p.items.len()) {
                return Err(CapabilityError::invalid_params("1–100 items", Some("items")));
            }
            let roots = FinderRoots::load(&e);
            // Check every item first, so a refusal moves nothing.
            let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
            let mut targets = HashSet::new();
            for it in &p.items {
                let from = item(&it.path, &roots, &e, "path")?;
                let dir = folder(&it.to, &roots, &e)?;
                let name = it.name.clone().unwrap_or_else(|| from.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                check_name(&name, "name")?;
                let to = dir.join(&name);
                if is_within(&dir, &from) {
                    return Err(CapabilityError::invalid_params("cannot move a folder into itself", Some("to")));
                }
                if to == from || exists_no_follow(&to) || !targets.insert(to.to_string_lossy().to_lowercase()) {
                    return Err(CapabilityError::new(ErrorCode::Conflict, "file_exists", format!("{name} already exists in {}", it.to))
                        .with_detail("path", to.display().to_string()));
                }
                plan.push((from, to));
            }
            let mut moved: Vec<Value> = Vec::new();
            for (from, to) in plan {
                if crate::win::fs::move_no_replace(&from, &to).is_err() {
                    return Err(CapabilityError::unavailable(
                        "move_failed",
                        format!("Could not move {}", from.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()),
                    )
                    .with_detail("moved", Value::Array(moved))
                    .with_detail("failed", from.display().to_string()));
                }
                moved.push(json!({ "from": from.display().to_string(), "to": to.display().to_string() }));
            }
            let n = moved.len();
            Ok(CapabilityOutput::with_receipt(json!({ "moved": moved }), ReceiptDraft::ok(format!("Moved {n} item(s)"))))
        },
    );

    let e = env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "files.rename",
            "Rename a file or folder inside a granted folder (never overwrites).",
            SideEffect::Write,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![
                ("path", schema::string(None)),
                ("name", schema::string_max(None, 255)),
            ],
            &["path", "name"],
        ))
        .receipt("connector_action"),
        move |ctx| {
            let p: RenameParams = ctx.decode()?;
            let roots = FinderRoots::load(&e);
            let from = item(&p.path, &roots, &e, "path")?;
            check_name(&p.name, "name")?;
            let to = from.with_file_name(&p.name);
            // A case-only rename is the same file on NTFS: allowed.
            let case_only =
                to.to_string_lossy().to_lowercase() == from.to_string_lossy().to_lowercase();
            if to == from || (exists_no_follow(&to) && !case_only) {
                return Err(CapabilityError::new(
                    ErrorCode::Conflict,
                    "file_exists",
                    format!("{} already exists", p.name),
                )
                .with_detail("path", to.display().to_string()));
            }
            let renamed = if case_only {
                std::fs::rename(&from, &to).is_ok()
            } else {
                crate::win::fs::move_no_replace(&from, &to).is_ok()
            };
            if !renamed {
                return Err(CapabilityError::unavailable(
                    "rename_failed",
                    format!(
                        "Could not rename {}",
                        from.file_name()
                            .map(|n| n.to_string_lossy())
                            .unwrap_or_default()
                    ),
                ));
            }
            Ok(CapabilityOutput::with_receipt(
                json!({ "file": file_item(&to, None) }),
                ReceiptDraft::ok(format!("Renamed to {}", p.name)),
            ))
        },
    );

    let e = env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "files.trash",
            "Move up to 200 files or folders inside granted folders to the Recycle Bin (never empties it or deletes permanently; the owner can restore them). Always asks.",
            SideEffect::Destructive,
        )
        .target(TargetKind::Path)
        .input(schema::object(vec![("paths", schema::array(schema::string(None), None, Some(MAX_TRASH as u64)))], &["paths"]))
        .receipt("connector_action"),
        move |ctx| {
            let p: TrashParams = ctx.decode()?;
            if !(1..=MAX_TRASH).contains(&p.paths.len()) {
                return Err(CapabilityError::invalid_params("1–200 paths", Some("paths")));
            }
            let roots = FinderRoots::load(&e);
            let mut items: Vec<PathBuf> = p.paths.iter().map(|x| item(x, &roots, &e, "paths")).collect::<Result<_, _>>()?;
            items.sort();
            items.dedup_by(|a, b| a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()));
            let mut trashed: Vec<Value> = Vec::new();
            for path in items {
                if ctx.is_cancelled() {
                    return Err(CapabilityError::cancelled().with_detail("trashed", Value::Array(trashed)));
                }
                match recycle(&path) {
                    Ok(where_) => trashed.push(json!({ "path": path.display().to_string(), "trashPath": where_ })),
                    Err(err) => {
                        return Err(err.with_detail("trashed", Value::Array(trashed)).with_detail("failed", path.display().to_string()));
                    }
                }
            }
            let n = trashed.len();
            Ok(CapabilityOutput::with_receipt(json!({ "trashed": trashed }), ReceiptDraft::ok(format!("Moved {n} item(s) to the Recycle Bin"))))
        },
    );

    let e = env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "finder.list",
            "List a folder inside the folders granted in Settings → Permissions (links are listed, not followed).",
            SideEffect::Read,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![("path", schema::string(None)), ("limit", schema::integer(None, Some(1), Some(500))), ("hidden", schema::boolean(None))],
            &["path"],
        )),
        move |ctx| {
            let p: ListParams = ctx.decode()?;
            let roots = FinderRoots::load(&e);
            let dir = roots.resolve(&p.path, &e)?;
            let entries = list_entries(&dir, limit(p.limit, 200)?, p.hidden.unwrap_or(false))?;
            let mut o = Map::new();
            o.insert("path".into(), dir.display().to_string().into());
            o.insert("entries".into(), Value::Array(entries));
            Ok(CapabilityOutput::new(untrusted(o)))
        },
    );

    let e = env;
    reg.add_blocking(
        CapabilitySpec::new(
            "finder.reveal",
            "Show a file or folder in File Explorer (inside the granted folders).",
            SideEffect::Read,
        )
        .target(TargetKind::Path)
        .input(schema::object(
            vec![("path", schema::string(None))],
            &["path"],
        )),
        move |ctx| {
            let p: PathParam = ctx.decode()?;
            let roots = FinderRoots::load(&e);
            let path = roots.resolve(&p.path, &e)?;
            if !exists_no_follow(&path) {
                return Err(CapabilityError::not_found(
                    "not_found",
                    format!("{} does not exist", p.path),
                ));
            }
            shell::reveal(&path).map_err(|err| {
                CapabilityError::os(
                    "reveal_failed",
                    "File Explorer could not show the item",
                    &err,
                )
            })?;
            Ok(CapabilityOutput::new(
                json!({ "revealed": path.display().to_string() }),
            ))
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> (PathBuf, Env) {
        let base = std::env::temp_dir().join(format!("psyche-files-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        let granted = base.join("granted");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(granted.join("sub")).unwrap();
        let cfg = json!({"permissions": {"folders": [{"path": granted.display().to_string()}]}});
        std::fs::write(home.join("config.json"), cfg.to_string()).unwrap();
        let env = Env::default()
            .with("PSYCHE_HOME", home.display().to_string())
            .with("USERPROFILE", base.display().to_string());
        (base, env)
    }

    fn call(reg: &CapabilityRegistry, name: &str, params: Value) -> Result<Value, CapabilityError> {
        let cap = reg.get(name).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on((cap.handler)(crate::node::InvocationContext::detached(
            name, params,
        )))
        .map(|o| o.result)
    }

    #[test]
    fn names() {
        assert!(check_name("report.pdf", "name").is_ok());
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            r"a\b",
            "a:b",
            "x?",
            "CON",
            "com1.txt",
            "trailing.",
            "trailing ",
        ] {
            assert!(check_name(bad, "name").is_err(), "{bad:?}");
        }
        assert!(check_name("console.txt", "name").is_ok());
    }

    #[test]
    fn content_types_and_filters() {
        assert_eq!(content_type("A.PDF"), Some("com.adobe.pdf"));
        assert_eq!(content_type("noext"), None);
        let w = wanted_extensions(Some(&["public.image".into(), "pdf".into()]))
            .unwrap()
            .unwrap();
        assert!(w.contains("png") && w.contains("pdf") && !w.contains("txt"));
        assert!(
            wanted_extensions(Some(&["public.data".into()]))
                .unwrap()
                .is_none()
        );
        assert!(
            wanted_extensions(Some(&["com.adobe.pdf".into()]))
                .unwrap()
                .unwrap()
                .contains("pdf")
        );
        assert!(wanted_extensions(Some(&["not a type!".into()])).is_err());
    }

    #[test]
    fn list_recent_move_rename_inside_granted_folders() {
        let (base, env) = sandbox("ops");
        let granted = base.join("granted");
        std::fs::write(granted.join("b.txt"), "b").unwrap();
        std::fs::write(granted.join("a10.pdf"), "a").unwrap();
        std::fs::write(granted.join("a2.pdf"), "a").unwrap();
        std::fs::write(granted.join(".hidden"), "h").unwrap();
        let mut reg = CapabilityRegistry::new(crate::node::Runtime::offline(env));
        register(&mut reg);
        let g = granted.display().to_string();

        let list = call(&reg, "finder.list", json!({"path": g})).unwrap();
        let names: Vec<&str> = list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["a2.pdf", "a10.pdf", "b.txt", "sub"]);
        assert_eq!(list["provenance"], "untrusted");

        let recent = call(
            &reg,
            "files.recent",
            json!({"folder": g, "contentTypes": ["pdf"]}),
        )
        .unwrap();
        assert_eq!(recent["files"].as_array().unwrap().len(), 2);
        assert_eq!(recent["files"][0]["contentType"], "com.adobe.pdf");
        assert!(recent["files"][0]["size"].is_u64());

        let outside = base.join("home").display().to_string();
        assert_eq!(
            call(&reg, "finder.list", json!({"path": outside}))
                .unwrap_err()
                .reason,
            "outside_granted_folders"
        );

        let sub = granted.join("sub").display().to_string();
        let moved = call(&reg, "files.move", json!({"items": [{"path": granted.join("b.txt").display().to_string(), "to": sub, "name": "c.txt"}]})).unwrap();
        assert_eq!(moved["moved"].as_array().unwrap().len(), 1);
        assert!(granted.join("sub").join("c.txt").exists());
        std::fs::write(granted.join("dup.txt"), "x").unwrap();
        std::fs::write(granted.join("sub").join("dup.txt"), "y").unwrap();
        let e = call(
            &reg,
            "files.move",
            json!({"items": [{"path": granted.join("dup.txt").display().to_string(), "to": sub}]}),
        )
        .unwrap_err();
        assert_eq!(e.reason, "file_exists");
        assert_eq!(
            std::fs::read_to_string(granted.join("sub").join("dup.txt")).unwrap(),
            "y"
        );

        let renamed = call(
            &reg,
            "files.rename",
            json!({"path": granted.join("a2.pdf").display().to_string(), "name": "A2.pdf"}),
        )
        .unwrap();
        assert_eq!(renamed["file"]["name"], "A2.pdf");
        let e = call(
            &reg,
            "files.rename",
            json!({"path": granted.join("A2.pdf").display().to_string(), "name": "a10.pdf"}),
        )
        .unwrap_err();
        assert_eq!(e.reason, "file_exists");
        let e = call(&reg, "files.trash", json!({"paths": [g]})).unwrap_err();
        // As on the Mac, the parent must be granted first; a root itself is never trashed.
        assert_eq!(e.reason, "outside_granted_folders");
        let _ = std::fs::remove_dir_all(base);
    }

    /// Moves a temporary file to the real Recycle Bin: run with `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn trash_goes_to_the_recycle_bin() {
        crate::win::com::ensure_mta();
        let dir = std::env::temp_dir().join(format!("psyche-trash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("psyche-trash-test.txt");
        std::fs::write(&f, "x").unwrap();
        let where_ = recycle(&f).unwrap();
        assert!(!f.exists());
        assert!(where_.is_some_and(|w| w.to_lowercase().contains("$recycle.bin")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
