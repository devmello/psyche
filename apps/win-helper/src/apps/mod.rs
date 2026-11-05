//! `apps.list`, `apps.open`, `apps.focus` (J2), Windows edition. `apps.applescript`, `apps.jxa`,
//! `apps.shortcut_run` and `apps.shortcuts_list` are Apple-only and not offered.
//!
//! App identity (`bundleId` in results, `app` in params) is the helper-wide app id
//! (`psyche_win_computer::app_id`): the lowercase executable file name, with frame-host windows
//! attributed to the hosted packaged app, the same id `computer.*`, `screen.context`, `teach.*`
//! and `dictation.target` report. Results add `exe` (full path), `aumid` and `packageFamilyName`.
//! `apps.open` / `apps.focus` take that id, and still a full executable path, an AppUserModelID,
//! a package family name (focus) or a display name.

use std::path::{Path, PathBuf};

use psyche_win_computer::{app_id_from_exe, is_app_id};

use serde::Deserialize;
use serde_json::{Value, json};
use windows::Win32::Foundation::HWND;

use crate::node::capability::{
    CapabilityError, CapabilityOutput, CapabilitySpec, ReceiptDraft, SideEffect, TargetKind,
};
use crate::node::paths::Env;
use crate::node::roots::{is_absolute, is_within, strip_verbatim};
use crate::node::tiers::{
    ApprovalBinding, Category, ComputerIntent, exe_name, fixed_caps, shared_policy,
    with_approval_param,
};
use crate::node::{CapabilityRegistry, schema};
use crate::win::process::{
    AppInfo, all_processes, app_info, app_pid, app_windows_by_pid, foreground_window, is_minimized,
    package_family_name, top_level_app_windows,
};
use crate::win::registry::{Hive, read_string};
use crate::win::{foreground, shell};

/// A running app and its Alt-Tab windows, front-most first.
pub struct RunningApp {
    pub info: AppInfo,
    pub windows: Vec<HWND>,
}

fn matches_query(info: &AppInfo, q: &str) -> bool {
    let q = q.trim();
    let eq = |s: &Option<String>| s.as_deref().is_some_and(|v| v.eq_ignore_ascii_case(q));
    if eq(&info.identity)
        || eq(&info.exe)
        || eq(&info.aumid)
        || eq(&info.package_family_name)
        || info.name.eq_ignore_ascii_case(q)
    {
        return true;
    }
    let file = info.exe.as_deref().and_then(exe_name);
    let wanted = q.to_lowercase();
    file.is_some_and(|f| f == wanted || f.trim_end_matches(".exe") == wanted)
}

/// Finds a running app with windows by pid, or by app id / executable path / AppUserModelID /
/// package family name / executable name / display name (case-insensitive); with neither, the
/// foreground app. Pids are app pids (frame-host windows count for the hosted app).
pub fn find_running_app(
    query: Option<&str>,
    pid: Option<u32>,
) -> Result<RunningApp, CapabilityError> {
    let by_pid = app_windows_by_pid();
    if let Some(pid) = pid {
        let windows = by_pid.get(&pid).cloned().unwrap_or_default();
        if windows.is_empty() && crate::win::process::image_path(pid).is_none() {
            return Err(CapabilityError::not_found(
                "app_not_running",
                format!("No running app with pid {pid}"),
            ));
        }
        return Ok(RunningApp {
            info: app_info(pid, windows.first().copied()),
            windows,
        });
    }
    let q = query.map(str::trim).filter(|q| !q.is_empty());
    let Some(q) = q else {
        let fg = foreground_window()
            .ok_or_else(|| CapabilityError::not_found("no_frontmost_app", "No app is frontmost"))?;
        let pid = app_pid(fg);
        let windows = by_pid.get(&pid).cloned().unwrap_or_else(|| vec![fg]);
        return Ok(RunningApp {
            info: app_info(pid, Some(fg)),
            windows,
        });
    };
    // Front-most app first, so a name shared by several processes picks the one the user sees.
    let mut order: Vec<u32> = Vec::new();
    for (_, pid) in top_level_app_windows() {
        if by_pid.contains_key(&pid) && !order.contains(&pid) {
            order.push(pid);
        }
    }
    for pid in order {
        let windows = by_pid.get(&pid).cloned().unwrap_or_default();
        let info = app_info(pid, windows.first().copied());
        if matches_query(&info, q) {
            return Ok(RunningApp { info, windows });
        }
    }
    Err(CapabilityError::not_found(
        "app_not_running",
        format!("{q} is not running. Open it with apps.open first."),
    )
    .with_detail("app", q))
}

fn app_json(
    info: &AppInfo,
    windows: &[HWND],
    active: bool,
    policy: &crate::node::tiers::TierPolicy,
) -> Value {
    let id = info.identity.as_deref();
    json!({
        "bundleId": info.identity,
        "name": info.name,
        "pid": info.pid,
        "active": active,
        "hidden": !windows.is_empty() && windows.iter().all(|h| is_minimized(*h)),
        "tier": policy.effective_tier_app(id, info.aumid.as_deref()).as_str(),
        "fixedCap": fixed_caps::cap(id).min(fixed_caps::cap(info.aumid.as_deref())).as_str(),
        "exe": info.exe,
        "aumid": info.aumid,
        "packageFamilyName": info.package_family_name,
        "windows": windows.len(),
    })
}

// MARK: apps.open resolution

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// A packaged app, activated by AppUserModelID.
    Packaged(String),
    /// A Win32 executable.
    Exe(PathBuf),
    /// A Start-menu entry with neither (launched through `shell:AppsFolder`).
    Shell(String),
}

/// Folders apps may be launched from (the Mac's "Applications folders"): Program Files, the
/// per-user Programs folder, Windows itself and the app execution aliases.
pub fn app_roots(env: &Env) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "SystemRoot",
    ] {
        if let Some(v) = env.get(var) {
            roots.push(PathBuf::from(v));
        }
    }
    if let Some(local) = env.get("LOCALAPPDATA") {
        roots.push(Path::new(local).join("Programs"));
        roots.push(Path::new(local).join("Microsoft").join("WindowsApps"));
    }
    roots
}

pub fn launch_allowed(exe: &Path, roots: &[PathBuf]) -> bool {
    let canonical = std::fs::canonicalize(exe)
        .map(strip_verbatim)
        .unwrap_or_else(|_| exe.to_path_buf());
    roots.iter().any(|r| is_within(&canonical, r))
}

fn plain_name(q: &str) -> bool {
    !q.is_empty() && !q.contains(['/', '\\']) && !q.contains("..")
}

/// `Executable` of `<Application Id="{app}">` in an `AppxManifest.xml`, as written (relative to
/// the package folder).
pub fn manifest_executable(xml: &str, app: &str) -> Option<String> {
    fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
        let mut from = 0;
        while let Some(i) = tag[from..].find(name) {
            let at = from + i;
            from = at + name.len();
            let before = tag[..at].chars().next_back();
            let rest = tag[from..].trim_start();
            if !before.is_some_and(char::is_whitespace) || !rest.starts_with('=') {
                continue;
            }
            let rest = rest[1..].trim_start();
            let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''))?;
            let body = &rest[1..];
            return body.find(quote).map(|end| &body[..end]);
        }
        None
    }
    let mut from = 0;
    while let Some(i) = xml[from..].find("<Application") {
        let start = from + i + "<Application".len();
        from = start;
        // `<Applications>` is the container, not an entry.
        if !xml[start..].starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let tag = &xml[start..start + xml[start..].find('>')?];
        if attr(tag, "Id").is_some_and(|id| id.eq_ignore_ascii_case(app)) {
            return attr(tag, "Executable").map(str::to_owned);
        }
    }
    None
}

/// The app id (lowercase executable name) a packaged app's AppUserModelID runs as, from its
/// package manifest (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` → `calculatorapp.exe`).
pub fn packaged_app_id(aumid: &str) -> Option<String> {
    let (family, app) = aumid.split_once('!')?;
    crate::win::process::package_paths(family)
        .into_iter()
        .find_map(|dir| {
            let xml = std::fs::read_to_string(dir.join("AppxManifest.xml")).ok()?;
            manifest_executable(&xml, app).and_then(|e| app_id_from_exe(&e))
        })
}

/// `<name>.exe` in the `PATH` folders: the first allowed one, else the first one found.
fn path_lookup(exe: &str, env: &Env, roots: &[PathBuf]) -> Option<PathBuf> {
    let found: Vec<PathBuf> = env
        .get("PATH")?
        .split(';')
        .map(|d| d.trim().trim_matches('"'))
        .filter(|d| is_absolute(d))
        .map(|d| Path::new(d).join(exe))
        .filter(|p| p.is_file())
        .collect();
    found
        .iter()
        .find(|p| launch_allowed(p, roots))
        .or(found.first())
        .cloned()
}

/// Resolves an installed app: AppUserModelID (`…!App`), an allowed executable path, the app id
/// `apps.list` reports (`notepad.exe`, `calculatorapp.exe`: a running app's own AUMID or
/// executable, a Start-menu app whose shortcut or package runs that executable, an App Paths
/// entry or `PATH`), or a Start-menu name.
pub fn resolve(q: &str, env: &Env) -> Result<Launch, CapabilityError> {
    let q = q.trim();
    let roots = app_roots(env);
    let checked = |p: PathBuf| -> Result<Launch, CapabilityError> {
        if !p.exists() {
            return Err(CapabilityError::not_found(
                "app_not_found",
                format!("No installed app matches {q}"),
            ));
        }
        if !launch_allowed(&p, &roots) {
            return Err(CapabilityError::policy_denied(
                "app_outside_applications",
                "Only installed apps (Program Files, Windows, per-user Programs) can be opened",
            ));
        }
        Ok(Launch::Exe(p))
    };
    if q.contains('!') && plain_name(q) {
        return Ok(Launch::Packaged(q.to_owned()));
    }
    if is_absolute(q) {
        return checked(PathBuf::from(q));
    }
    if !plain_name(q) {
        return Err(CapabilityError::invalid_params(
            "app name must be a plain name",
            Some("name"),
        ));
    }
    let lower = q.to_lowercase();
    let bare = lower.trim_end_matches(".exe");
    let exe = format!("{bare}.exe");
    // A running app with this id: launch what it runs (packaged apps by their AUMID).
    if is_app_id(q)
        && let Ok(app) = find_running_app(Some(q), None)
        && app.info.identity.as_deref() == Some(lower.as_str())
    {
        if let Some(a) = app.info.aumid.as_ref().filter(|a| a.contains('!')) {
            return Ok(Launch::Packaged(a.clone()));
        }
        if let Some(e) = &app.info.exe {
            return checked(PathBuf::from(e));
        }
    }
    let apps = shell::start_apps();
    let found = apps
        .iter()
        .find(|a| a.app_id.eq_ignore_ascii_case(q))
        .or_else(|| {
            apps.iter()
                .find(|a| a.name.eq_ignore_ascii_case(q) || a.name.eq_ignore_ascii_case(bare))
        })
        .or_else(|| {
            apps.iter().find(|a| {
                a.target
                    .as_deref()
                    .and_then(exe_name)
                    .is_some_and(|f| f == lower || f.trim_end_matches(".exe") == bare)
            })
        });
    if let Some(a) = found {
        if a.app_id.contains('!') {
            return Ok(Launch::Packaged(a.app_id.clone()));
        }
        if let Some(t) = &a.target
            && t.to_lowercase().ends_with(".exe")
        {
            return checked(PathBuf::from(t));
        }
        return Ok(Launch::Shell(a.app_id.clone()));
    }
    // A packaged Start-menu app whose manifest runs this executable (Calculator: calculatorapp.exe).
    if is_app_id(q)
        && let Some(a) = apps
            .iter()
            .filter(|a| a.app_id.contains('!'))
            .find(|a| packaged_app_id(&a.app_id).as_deref() == Some(lower.as_str()))
    {
        return Ok(Launch::Packaged(a.app_id.clone()));
    }
    let key = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
    if let Some(p) = read_string(Hive::CurrentUser, &key, "")
        .or_else(|| read_string(Hive::LocalMachine, &key, ""))
    {
        return checked(PathBuf::from(p.trim_matches('"')));
    }
    if let Some(p) = path_lookup(&exe, env, &roots) {
        return checked(p);
    }
    Err(CapabilityError::not_found(
        "app_not_found",
        format!("No installed app matches {q}"),
    ))
}

/// Documents that run code when opened.
pub const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "psd1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "msix",
    "msixbundle",
    "appx",
    "appxbundle",
    "appinstaller",
    "lnk",
    "url",
    "scr",
    "pif",
    "hta",
    "cpl",
    "jar",
    "py",
    "pyw",
    "reg",
    "application",
    "appref-ms",
    "gadget",
    "msc",
    "inf",
    "sh",
    "rb",
    "pl",
    "dll",
    "sys",
    "iso",
    "vhd",
    "vhdx",
];

/// `file:///C:/a%20b.pdf` → `C:\a b.pdf`.
pub fn file_url_path(url: &str) -> Option<PathBuf> {
    let rest = url
        .strip_prefix("file:///")
        .or_else(|| url.strip_prefix("file://localhost/"))?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(rest.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out).ok()?.replace('/', "\\");
    is_absolute(&s).then(|| PathBuf::from(s))
}

pub fn url_scheme(url: &str) -> Option<String> {
    let (scheme, _) = url.split_once(':')?;
    (!scheme.is_empty()
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then(|| scheme.to_lowercase())
}

#[derive(Deserialize)]
struct ListParams {
    all: Option<bool>,
}

#[derive(Deserialize)]
struct OpenParams {
    app: Option<String>,
    #[serde(rename = "bundleId")]
    bundle_id: Option<String>,
    name: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct FocusParams {
    app: String,
    window: Option<i64>,
}

pub fn register(reg: &mut CapabilityRegistry) {
    let rt = reg.runtime().clone();
    let policy = shared_policy(&rt);

    let (p_list, env_list) = (policy.clone(), rt.env.clone());
    reg.add_blocking(
        CapabilitySpec::new(
            "apps.list",
            "Running apps with a taskbar presence: bundleId (lowercase executable name, the id computer.* uses), name, pid, frontmost, minimized, the computer-use tier in effect, and exe / aumid / packageFamilyName.",
            SideEffect::Read,
        )
        .input(schema::object(vec![("all", schema::boolean(Some("Include background processes")))], &[])),
        move |ctx| {
            let p: ListParams = ctx.decode()?;
            p_list.reload(&env_list);
            let by_pid = app_windows_by_pid();
            let fg = foreground_window().map(app_pid);
            let mut seen = Vec::new();
            let mut apps = Vec::new();
            for (_, pid) in top_level_app_windows() {
                if let Some(windows) = by_pid.get(&pid)
                    && !seen.contains(&pid)
                {
                    seen.push(pid);
                    apps.push(app_json(&app_info(pid, windows.first().copied()), windows, fg == Some(pid), &p_list));
                }
            }
            if p.all == Some(true) {
                for (pid, _) in all_processes() {
                    if pid <= 4 || seen.contains(&pid) {
                        continue;
                    }
                    seen.push(pid);
                    apps.push(app_json(&app_info(pid, None), &[], false, &p_list));
                }
            }
            Ok(CapabilityOutput::new(json!({ "apps": apps })))
        },
    );

    let env_open = rt.env.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "apps.open",
            "Open (launch or bring forward) an installed app by app id (executable name, as apps.list reports), AppUserModelID, executable path or Start-menu name, optionally with a document or URL.",
            SideEffect::Write,
        )
        .target(TargetKind::App)
        .input(schema::object(
            vec![
                ("app", schema::string(Some("App id (notepad.exe), AppUserModelID, executable path or Start-menu name"))),
                ("bundleId", schema::string(None)),
                ("name", schema::string(None)),
                ("url", schema::string(Some("file:// or https:// URL to open with the app"))),
            ],
            &[],
        ))
        .receipt("app_open"),
        move |ctx| {
            let p: OpenParams = ctx.decode()?;
            let q = p
                .bundle_id
                .as_deref()
                .or(p.app.as_deref())
                .or(p.name.as_deref())
                .ok_or_else(|| CapabilityError::invalid_params("app, bundleId or name is required", Some("app")))?;
            let launch = resolve(q, &env_open)?;
            // What gets launched (AUMID, path or AppsFolder id) and the app id it runs as.
            let (target, id_hint) = match &launch {
                Launch::Packaged(a) => (a.clone(), packaged_app_id(a)),
                Launch::Shell(a) => (a.clone(), None),
                Launch::Exe(p) => {
                    let s = p.display().to_string();
                    let id = app_id_from_exe(&s);
                    (s, id)
                }
            };
            let category = fixed_caps::category(Some(&target)).or_else(|| fixed_caps::category(id_hint.as_deref()));
            if matches!(category, Some(Category::PasswordManager | Category::Finance)) {
                return Err(CapabilityError::policy_denied("tier_off", "Psyche does not open password managers or finance apps"));
            }
            if let Some(u) = &p.url {
                let scheme = url_scheme(u).filter(|s| matches!(s.as_str(), "file" | "http" | "https" | "mailto"));
                if scheme.is_none() {
                    return Err(CapabilityError::invalid_params("url must be file, http(s) or mailto", Some("url")));
                }
                if scheme.as_deref() == Some("file") {
                    let path = file_url_path(u).ok_or_else(|| CapabilityError::invalid_params("url must be an absolute file URL", Some("url")))?;
                    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
                    // Opening a document in a terminal, IDE or script runner runs it.
                    if category == Some(Category::TerminalOrIde) || EXECUTABLE_EXTENSIONS.contains(&ext.as_str()) {
                        return Err(CapabilityError::policy_denied("executable_document", "Psyche does not open scripts or apps as documents"));
                    }
                }
            }
            let arg = p.url.as_ref().map(|u| match file_url_path(u) {
                Some(path) => format!("\"{}\"", path.display()),
                None => format!("\"{u}\""),
            });
            let os = |e: windows::core::Error| CapabilityError::os("launch_failed", "Windows could not open the app", &e);
            let pid = match &launch {
                Launch::Packaged(aumid) => Some(shell::activate_packaged(aumid, arg.as_deref()).map_err(os)?),
                Launch::Exe(path) => shell::shell_open(&path.display().to_string(), arg.as_deref()).map_err(os)?,
                Launch::Shell(id) => {
                    if arg.is_some() {
                        return Err(CapabilityError::invalid_params("this Start-menu entry cannot be opened with a url", Some("url")));
                    }
                    shell::shell_open(&format!(r"shell:AppsFolder\{id}"), None).map_err(os)?
                }
            };
            let info = pid.map(|pid| app_info(pid, None));
            let id = info.as_ref().and_then(|i| i.identity.clone()).or(id_hint);
            let name = info
                .as_ref()
                .map(|i| i.name.clone())
                .or_else(|| match &launch {
                    Launch::Exe(p) => crate::win::process::file_description(&p.display().to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| target.rsplit(['\\', '!']).next().unwrap_or(&target).to_owned());
            let exe = info.as_ref().and_then(|i| i.exe.clone()).or_else(|| match &launch {
                Launch::Exe(p) => Some(p.display().to_string()),
                _ => None,
            });
            let aumid = match &launch {
                Launch::Packaged(a) => Some(a.clone()),
                _ => info.as_ref().and_then(|i| i.aumid.clone()),
            };
            let family = pid.and_then(package_family_name).or_else(|| match &launch {
                Launch::Packaged(a) => a.split_once('!').map(|(f, _)| f.to_owned()),
                _ => None,
            });
            let receipt_app = id.clone().unwrap_or_else(|| target.clone());
            Ok(CapabilityOutput::with_receipt(
                json!({ "bundleId": id, "name": name, "pid": pid, "exe": exe, "aumid": aumid, "packageFamilyName": family }),
                ReceiptDraft::ok(format!("Opened {name}")).with_ref("app", receipt_app),
            ))
        },
    );

    let (p_focus, env_focus) = (policy, rt.env.clone());
    reg.add_blocking(
        with_approval_param(
            CapabilitySpec::new("apps.focus", "Bring a running app to the front, optionally raising one of its windows by index (front-most first).", SideEffect::Write)
                .target(TargetKind::App)
                .input(schema::object(
                    vec![
                        ("app", schema::string(Some("App id (notepad.exe), executable path, AppUserModelID, package family name or app name"))),
                        ("window", schema::integer(None, Some(0), None)),
                    ],
                    &["app"],
                ))
                .receipt("computer_action"),
        ),
        move |ctx| {
            let p: FocusParams = ctx.decode()?;
            if p.window.is_some_and(|w| w < 0) {
                return Err(CapabilityError::invalid_params("window must be ≥ 0", Some("window")));
            }
            let app = find_running_app(Some(&p.app), None)?;
            p_focus.reload(&env_focus);
            let id = app.info.identity.as_deref();
            p_focus.authorize_app(ComputerIntent::Read, id, app.info.aumid.as_deref(), &app.info.name, ApprovalBinding::from_context(&ctx).as_ref())?;
            let index = p.window.unwrap_or(0) as usize;
            let hwnd = *app
                .windows
                .get(index)
                .ok_or_else(|| CapabilityError::not_found("window_not_found", format!("{} has no window {index}", app.info.name)))?;
            let focused = foreground::force_foreground(hwnd);
            Ok(CapabilityOutput::with_receipt(
                json!({ "focused": focused, "app": app.info.identity.clone().unwrap_or_else(|| app.info.name.clone()) }),
                ReceiptDraft::ok(format!("Focused {}", app.info.name)),
            ))
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> Env {
        Env::default()
            .with("ProgramFiles", r"C:\Program Files")
            .with("SystemRoot", r"C:\Windows")
            .with("LOCALAPPDATA", r"C:\Users\x\AppData\Local")
    }

    #[test]
    fn launch_roots() {
        let roots = app_roots(&env());
        assert!(launch_allowed(
            Path::new(r"C:\Program Files\App\app.exe"),
            &roots
        ));
        assert!(launch_allowed(
            Path::new(r"C:\Users\x\AppData\Local\Programs\Psyche\Psyche.exe"),
            &roots
        ));
        assert!(!launch_allowed(
            Path::new(r"C:\Users\x\Downloads\evil.exe"),
            &roots
        ));
        assert!(!launch_allowed(
            Path::new(r"C:\Program Files2\x.exe"),
            &roots
        ));
    }

    #[test]
    fn resolve_refuses_paths_outside_and_odd_names() {
        let e = Env::current();
        assert_eq!(resolve(r"..\x", &e).unwrap_err().reason, "invalid_params");
        let tmp = std::env::temp_dir().join(format!("psyche-open-{}.exe", std::process::id()));
        std::fs::write(&tmp, b"MZ").unwrap();
        assert_eq!(
            resolve(&tmp.display().to_string(), &e).unwrap_err().reason,
            "app_outside_applications"
        );
        let _ = std::fs::remove_file(tmp);
        assert_eq!(
            resolve("Contoso.App_123!App", &e).unwrap(),
            Launch::Packaged("Contoso.App_123!App".into())
        );
        // notepad is registered everywhere (App Paths or the AppsFolder).
        assert!(resolve("notepad", &e).is_ok());
    }

    #[test]
    fn file_urls_and_schemes() {
        assert_eq!(
            file_url_path("file:///C:/Users/x/a%20b.pdf"),
            Some(PathBuf::from(r"C:\Users\x\a b.pdf"))
        );
        assert_eq!(file_url_path("file:///relative"), None);
        assert_eq!(file_url_path("https://x"), None);
        assert_eq!(url_scheme("HTTPS://example.com").as_deref(), Some("https"));
        assert_eq!(url_scheme("C:\\x").as_deref(), Some("c"));
        assert_eq!(url_scheme("nothing"), None);
    }

    #[test]
    fn query_matching() {
        let info = AppInfo {
            pid: 1,
            identity: Some("notepad.exe".into()),
            exe: Some(r"C:\Windows\System32\notepad.exe".into()),
            aumid: None,
            package_family_name: None,
            name: "Notepad".into(),
        };
        assert!(matches_query(&info, "notepad"));
        assert!(matches_query(&info, "NOTEPAD.EXE"));
        assert!(matches_query(&info, "Notepad"));
        assert!(matches_query(&info, r"c:\windows\system32\notepad.exe"));
        assert!(!matches_query(&info, "note"));
        // A packaged app: the id, and still its AUMID, family name and path.
        let calc = AppInfo {
            pid: 2,
            identity: Some("calculatorapp.exe".into()),
            exe: Some(r"C:\Program Files\WindowsApps\Microsoft.WindowsCalculator_11.2_x64__8wekyb3d8bbwe\CalculatorApp.exe".into()),
            aumid: Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".into()),
            package_family_name: Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe".into()),
            name: "Calculator".into(),
        };
        for q in [
            "calculatorapp.exe",
            "CalculatorApp",
            "microsoft.windowscalculator_8wekyb3d8bbwe!app",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe",
            calc.exe.as_deref().unwrap(),
            "Calculator",
        ] {
            assert!(matches_query(&calc, q), "{q}");
        }
        assert!(!matches_query(&calc, "applicationframehost.exe"));
    }

    #[test]
    fn manifest_executables() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Applications>
    <Application Id="Helper" Executable="VFS\ProgramFilesX64\Contoso\helper.exe" EntryPoint="Windows.FullTrustApplication"/>
    <Application
        Id='App'
        Executable="CalculatorApp.exe"
        EntryPoint="CalculatorApp.App">
      <uap:VisualElements DisplayName="Calculator"/>
    </Application>
  </Applications>
</Package>"#;
        assert_eq!(
            manifest_executable(xml, "App").as_deref(),
            Some("CalculatorApp.exe")
        );
        assert_eq!(
            manifest_executable(xml, "app").as_deref(),
            Some("CalculatorApp.exe")
        );
        assert_eq!(
            manifest_executable(xml, "Helper")
                .and_then(|e| app_id_from_exe(&e))
                .as_deref(),
            Some("helper.exe")
        );
        assert_eq!(manifest_executable(xml, "Missing"), None);
        // `AppId=` is not `Id=`.
        assert_eq!(
            manifest_executable(r#"<Application AppId="App" Executable="x.exe">"#, "App"),
            None
        );
    }

    #[test]
    fn resolve_by_app_id_and_path() {
        let e = Env::current();
        // An id apps.list reports resolves for apps.open (cmd.exe: App Paths, the AppsFolder or
        // PATH), and so does a full path inside the allowed roots.
        let id_of = |l: Launch| match l {
            Launch::Exe(p) => app_id_from_exe(&p.display().to_string()),
            Launch::Packaged(_) | Launch::Shell(_) => None,
        };
        assert_eq!(
            resolve("cmd.exe", &e).ok().and_then(id_of).as_deref(),
            Some("cmd.exe")
        );
        let full = Path::new(e.get("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        assert_eq!(
            resolve(&full.display().to_string(), &e).unwrap(),
            Launch::Exe(full)
        );
        assert_eq!(
            resolve("no-such-app-psyche.exe", &e).unwrap_err().reason,
            "app_not_found"
        );
    }

    #[test]
    fn packaged_ids_resolve_from_the_manifest() {
        crate::win::com::ensure_mta();
        const CALC: &str = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
        if crate::win::process::package_paths("Microsoft.WindowsCalculator_8wekyb3d8bbwe")
            .is_empty()
        {
            eprintln!("Calculator is not installed; skipping");
            return;
        }
        assert_eq!(packaged_app_id(CALC).as_deref(), Some("calculatorapp.exe"));
        // apps.open takes the id apps.list reports for Calculator (no launch here).
        assert_eq!(
            resolve("calculatorapp.exe", &Env::current()).unwrap(),
            Launch::Packaged(CALC.into())
        );
    }

    #[test]
    fn path_lookup_prefers_allowed_folders() {
        let root = std::env::temp_dir().join(format!("psyche-path-{}", std::process::id()));
        let (outside, inside) = (root.join("outside"), root.join("apps"));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(outside.join("tool.exe"), b"MZ").unwrap();
        std::fs::write(inside.join("tool.exe"), b"MZ").unwrap();
        let env = Env::default().with(
            "PATH",
            format!("{};{}", outside.display(), inside.display()),
        );
        let roots = vec![inside.clone()];
        assert_eq!(
            path_lookup("tool.exe", &env, &roots),
            Some(inside.join("tool.exe"))
        );
        assert_eq!(
            path_lookup("tool.exe", &env, &[]),
            Some(outside.join("tool.exe"))
        );
        assert_eq!(path_lookup("none.exe", &env, &roots), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
