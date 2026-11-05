//! One-element lookups for callers outside computer use (the helper's teach recorder): the UI
//! Automation element under a screen point or with keyboard focus, described with the same
//! mapping `computer.ax_tree` uses (AX roles and subroles, title or description as the label,
//! the automation id as the identifier), and a capture of an app's main window with the
//! screenshot hygiene of `computer.screenshot`.
//!
//! Never reads an element's value (field contents). Runs on the UIA worker pool with a short
//! deadline, so a hung app yields `None` instead of blocking the caller.

use crate::caps::{cu, psyche_pids};
use crate::hygiene::{self, AppRef};
use crate::snapshot::text;
use crate::win::apps::{self, TargetApp, WinInfo};
use crate::win::{capture, com, uia};
use std::time::Duration;
use windows::Win32::Foundation::POINT;

const LOOKUP_TIMEOUT: Duration = Duration::from_millis(1500);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// What an input landed on (the mac helper's `TeachTargetInfo` fields, plus the pid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ElementTarget {
    /// Lowercase executable name (the Windows bundle id), `pid.<n>` when unknown.
    pub app: String,
    pub app_name: String,
    /// The top-level window's title.
    pub window: Option<String>,
    /// AX role (`AXButton`, `AXTextField`, …).
    pub role: Option<String>,
    pub subrole: Option<String>,
    /// UIA Name (title), else HelpText (description).
    pub label: Option<String>,
    /// UIA AutomationId.
    pub identifier: Option<String>,
    pub pid: u32,
    /// The element is a password field, or a password field has keyboard focus (the mac
    /// helper's Secure Event Input rule): nothing typed there may be kept.
    pub secure: bool,
}

struct Raw {
    role: String,
    subrole: Option<String>,
    label: Option<String>,
    identifier: Option<String>,
    pid: u32,
    secure: bool,
    focus_secure: bool,
}

fn raw(u: &uia::Uia, e: windows::Win32::UI::Accessibility::IUIAutomationElement, app_pid: u32, hwnd: isize) -> Option<Raw> {
    let node = uia::node_for(e, None, false, app_pid, hwnd);
    let c = uia::compute(&node, false)?;
    let label = text::non_empty(c.info.title.as_deref()).or_else(|| text::non_empty(c.info.description.as_deref()));
    Some(Raw {
        secure: c.info.is_secure(),
        role: c.info.role.clone(),
        subrole: c.info.subrole.clone(),
        label,
        identifier: c.info.identifier.clone(),
        pid: c.pid,
        focus_secure: uia::keyboard_focus(u).1,
    })
}

fn target(app: Option<TargetApp>, pid: u32, window: Option<&WinInfo>, r: Raw) -> ElementTarget {
    let (id, name) = match app {
        Some(a) => (a.bundle_id.clone().unwrap_or_else(|| format!("pid.{}", a.pid)), a.name),
        None => (format!("pid.{pid}"), "App".to_string()),
    };
    ElementTarget {
        app: id,
        app_name: name,
        window: window.and_then(|w| text::non_empty(Some(&w.title))),
        role: Some(r.role),
        subrole: r.subrole,
        label: r.label,
        identifier: r.identifier,
        pid,
        secure: r.secure || r.focus_secure,
    }
}

/// The element under a screen point (physical virtual-desktop pixels, as low-level mouse hooks
/// report them).
pub fn element_at(x: i32, y: i32) -> Option<ElementTarget> {
    com::ensure_dpi_awareness();
    let win = apps::window_at(x as f64, y as f64)?;
    let (pid, hwnd) = (win.pid, win.hwnd);
    let r = com::pool()
        .run(LOOKUP_TIMEOUT, move || {
            let u = uia::uia()?;
            let e = unsafe { u.auto.ElementFromPointBuildCache(POINT { x, y }, &u.req_element) }
                .map_err(|_| crate::error::CapError::internal("no element"))?;
            raw(&u, e, pid, hwnd).ok_or_else(|| crate::error::CapError::internal("no element"))
        })
        .ok()?;
    Some(target(apps::app_for_window(&win), win.pid, Some(&win), r))
}

/// The element with keyboard focus (in the foreground window's app).
pub fn focused_element() -> Option<ElementTarget> {
    com::ensure_dpi_awareness();
    let fg = apps::foreground_window()?;
    let (pid, hwnd) = (fg.pid, fg.hwnd);
    let r = com::pool()
        .run(LOOKUP_TIMEOUT, move || {
            let u = uia::uia()?;
            let e =
                unsafe { u.auto.GetFocusedElementBuildCache(&u.req_element) }.map_err(|_| crate::error::CapError::internal("no focus"))?;
            raw(&u, e, pid, hwnd).ok_or_else(|| crate::error::CapError::internal("no focus"))
        })
        .ok()?;
    let app = apps::app_for_window(&fg);
    // Focus inside another process (a hosted control) names that process, without the window.
    match app {
        Some(a) if r.pid == 0 || a.owns(r.pid) => Some(target(Some(a), fg.pid, Some(&fg), r)),
        _ => {
            let pid = r.pid;
            Some(target(apps::app_for_pid(pid, None), pid, None, r))
        }
    }
}

/// A JPEG of `bundle_id`'s largest on-screen window, at most `max_w` × `max_h`; `None` while a
/// password field has focus, for Psyche, terminals/IDEs, password managers, finance and apps
/// whose tier is Off (unapproved apps count as Off), or when nothing can be captured.
pub fn app_window_image(bundle_id: &str, max_w: u32, max_h: u32) -> Option<(Vec<u8>, &'static str)> {
    com::ensure_dpi_awareness();
    let c = cu();
    c.reload_settings();
    let secure = com::pool().run(LOOKUP_TIMEOUT, || Ok(uia::focused_is_secure(&*uia::uia()?, None))).unwrap_or(true);
    if secure || apps::secure_desktop_active() {
        return None;
    }
    let apps_now = apps::windowed_apps();
    let app = apps_now.iter().find(|a| a.bundle_id.as_deref() == Some(bundle_id))?.clone();
    let running: Vec<AppRef> = apps_now.iter().map(|a| AppRef { bundle_id: a.bundle_id.clone(), pid: a.pid }).collect();
    let mut excluded = hygiene::excluded_pids(&running, apps::own_pid(), &c.policy);
    excluded.extend(psyche_pids());
    if excluded.contains(&app.pid) {
        return None;
    }
    let w = apps::top_windows()
        .into_iter()
        .filter(|w| w.pid == app.pid && w.layer() == 0 && !w.iconic)
        .max_by(|a, b| (a.rect.w * a.rect.h).partial_cmp(&(b.rect.w * b.rect.h)).unwrap_or(std::cmp::Ordering::Equal))?;
    let hwnd = w.hwnd;
    let frame = com::pool().run(CAPTURE_TIMEOUT, move || capture::capture_window(hwnd, false)).ok()?;
    let (sw, sh) = hygiene::scaled_size(frame.width, frame.height, max_w, max_h);
    let (data, mime, _, _) = com::pool().run(CAPTURE_TIMEOUT, move || capture::encode(&frame, sw, sh, false)).ok()?;
    Some((data, mime))
}
