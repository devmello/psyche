//! `apps.list`, `apps.open`, `apps.focus` (J2), Windows edition. `apps.applescript`, `apps.jxa`,
//! `apps.shortcut_run` and `apps.shortcuts_list` are Apple-only and not offered.
//!
//! App identity (`bundleId` in results and params) is the AppUserModelID when the app has one,
//! else the executable path; see `node::tiers`. Results add `exe` and `aumid`.

use std::path::{Path, PathBuf};

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
    AppInfo, all_processes, app_info, app_windows_by_pid, foreground_window, is_minimized,
    window_pid,
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
    if eq(&info.identity) || eq(&info.exe) || eq(&info.aumid) || info.name.eq_ignore_ascii_case(q) {
        return true;
    }
    let file = info.exe.as_deref().and_then(exe_name);
    let wanted = q.to_lowercase();
    file.is_some_and(|f| f == wanted || f.trim_end_matches(".exe") == wanted)
}

/// Finds a running app with windows by pid, or by identity / executable path / executable name /
/// display name (case-insensitive); with neither, the foreground app. Shared with `computer.*`.
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
        let pid = window_pid(fg);
        let windows = by_pid.get(&pid).cloned().unwrap_or_else(|| vec![fg]);
        return Ok(RunningApp {
            info: app_info(pid, Some(fg)),
            windows,
        });
    };
    // Front-most app first, so a name shared by several processes picks the one the user sees.
    let mut order: Vec<u32> = Vec::new();
    for h in crate::win::process::top_level_windows() {
        let pid = window_pid(h);
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
        "tier": policy.effective_tier(id).as_str(),
        "fixedCap": fixed_caps::cap(id).as_str(),
        "exe": info.exe,
        "aumid": info.aumid,
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

/// Resolves an installed app: AppUserModelID (`…!App`), an allowed executable path, a Start-menu
/// name or app id, or an App Paths entry (`chrome`, `notepad.exe`).
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
    let key = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{bare}.exe");
    if let Some(p) = read_string(Hive::CurrentUser, &key, "")
        .or_else(|| read_string(Hive::LocalMachine, &key, ""))
    {
        return checked(PathBuf::from(p.trim_matches('"')));
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
            "Running apps with a taskbar presence: bundleId (AppUserModelID or executable path), name, pid, frontmost, minimized, and the computer-use tier in effect.",
            SideEffect::Read,
        )
        .input(schema::object(vec![("all", schema::boolean(Some("Include background processes")))], &[])),
        move |ctx| {
            let p: ListParams = ctx.decode()?;
            p_list.reload(&env_list);
            let by_pid = app_windows_by_pid();
            let fg = foreground_window().map(window_pid);
            let mut seen = Vec::new();
            let mut apps = Vec::new();
            for h in crate::win::process::top_level_windows() {
                let pid = window_pid(h);
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
            "Open (launch or bring forward) an installed app by AppUserModelID, executable path, Start-menu name or executable name, optionally with a document or URL.",
            SideEffect::Write,
        )
        .target(TargetKind::App)
        .input(schema::object(
            vec![
                ("app", schema::string(Some("AppUserModelID, executable path or name"))),
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
            let identity = match &launch {
                Launch::Packaged(a) | Launch::Shell(a) => a.clone(),
                Launch::Exe(p) => p.display().to_string(),
            };
            let category = fixed_caps::category(Some(&identity));
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
            let name = pid
                .map(|pid| app_info(pid, None).name)
                .or_else(|| match &launch {
                    Launch::Exe(p) => crate::win::process::file_description(&p.display().to_string()),
                    _ => None,
                })
                .unwrap_or_else(|| identity.rsplit(['\\', '!']).next().unwrap_or(&identity).to_owned());
            Ok(CapabilityOutput::with_receipt(
                json!({ "bundleId": identity, "name": name, "pid": pid }),
                ReceiptDraft::ok(format!("Opened {name}")).with_ref("app", identity.clone()),
            ))
        },
    );

    let (p_focus, env_focus) = (policy, rt.env.clone());
    reg.add_blocking(
        with_approval_param(
            CapabilitySpec::new("apps.focus", "Bring a running app to the front, optionally raising one of its windows by index (front-most first).", SideEffect::Write)
                .target(TargetKind::App)
                .input(schema::object(vec![("app", schema::string(None)), ("window", schema::integer(None, Some(0), None))], &["app"]))
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
            p_focus.authorize(ComputerIntent::Read, id, &app.info.name, ApprovalBinding::from_context(&ctx).as_ref())?;
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
            identity: Some(r"C:\Windows\System32\notepad.exe".into()),
            exe: Some(r"C:\Windows\System32\notepad.exe".into()),
            aumid: None,
            name: "Notepad".into(),
        };
        assert!(matches_query(&info, "notepad"));
        assert!(matches_query(&info, "NOTEPAD.EXE"));
        assert!(matches_query(&info, "Notepad"));
        assert!(matches_query(&info, r"c:\windows\system32\notepad.exe"));
        assert!(!matches_query(&info, "note"));
    }
}
