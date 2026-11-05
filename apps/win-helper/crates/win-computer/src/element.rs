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

// MARK: - Teach by showing (phase 2): richer descriptions, scoped to one app

/// One element as the app recorder needs it (the mac `LiveAppTeachSource.element`): role, titles,
/// identifier, the labels around a field (judged for secret words, never kept), the titles of its
/// ancestors and, only when the caller's policy said the field is not a secret, its value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TeachElement {
    pub pid: u32,
    /// AX role (`AXButton`, `AXTextField`, …) and subrole.
    pub role: String,
    pub subrole: Option<String>,
    /// UIA Name (not the element's text for static text), HelpText, AutomationId, and the help
    /// text of a field (its placeholder).
    pub title: Option<String>,
    pub description: Option<String>,
    pub identifier: Option<String>,
    pub placeholder: Option<String>,
    /// The name of the element `LabeledBy` points at.
    pub label_text: Option<String>,
    /// `(role, title)` of the ancestors, outermost first, up to 12.
    pub path: Vec<(String, String)>,
    /// The window's title and the names of up to three text siblings just before a text field.
    /// Read only to judge whether the field is a secret; never put in a step.
    pub context: Vec<String>,
    /// A password field has keyboard focus (the mac's Secure Event Input).
    pub secure_focus: bool,
    /// A menu item that opens a submenu (it is not a choice).
    pub expandable: bool,
    /// The field's value, set only when `TeachScope::read_value` allowed it.
    pub value: Option<String>,
}

/// What a lookup may touch: the processes of one app, and the caller's decision whether a
/// described field's value may be read (made before any value is kept).
#[derive(Clone)]
pub struct TeachScope {
    pub owns: std::sync::Arc<dyn Fn(u32) -> bool + Send + Sync>,
    pub read_value: fn(&TeachElement) -> bool,
}

const MAX_VALUE_CHARS: usize = 2000;
const TEXT_ROLES: [&str; 4] = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];
/// Rows, cells and pop-up buttons hold the user's data: only their role is kept.
const DATA_ROLES: [&str; 5] = ["AXRow", "AXCell", "AXOutlineRow", "AXStaticText", "AXPopUpButton"];

fn teach_describe(u: &uia::Uia, e: windows::Win32::UI::Accessibility::IUIAutomationElement, scope: &TeachScope) -> Option<TeachElement> {
    let node = uia::node_for(e.clone(), None, false, 0, 0);
    let c = uia::compute(&node, false)?;
    // Anything outside the recorded app yields nothing.
    if !(scope.owns)(c.pid) {
        return None;
    }
    let secure_focus = uia::keyboard_focus(u).1;
    if DATA_ROLES.contains(&c.info.role.as_str()) {
        return Some(TeachElement {
            pid: c.pid,
            role: c.info.role.clone(),
            subrole: c.info.subrole.clone(),
            secure_focus,
            ..Default::default()
        });
    }
    let text_input = TEXT_ROLES.contains(&c.info.role.as_str());
    let mut out = TeachElement {
        pid: c.pid,
        role: c.info.role.clone(),
        subrole: c.info.subrole.clone(),
        title: c.info.title.clone(),
        description: c.info.description.clone(),
        identifier: c.info.identifier.clone(),
        placeholder: c.info.placeholder.clone(),
        label_text: c.info.title_element_value.clone(),
        secure_focus,
        expandable: c.facts.expand_collapse,
        ..Default::default()
    };
    // Ancestors: role and title, outermost first.
    let mut cur = e.clone();
    let mut chain = Vec::new();
    for _ in 0..12 {
        let Ok(parent) = (unsafe { u.walker.GetParentElementBuildCache(&cur, &u.req_element) }) else { break };
        let pn = uia::node_for(parent.clone(), None, false, 0, 0);
        if let Some(pc) = uia::compute(&pn, false) {
            if pc.pid == c.pid {
                chain.push((pc.info.role.clone(), pc.info.title.clone().unwrap_or_default()));
            }
        }
        cur = parent;
    }
    chain.reverse();
    // The top-level window's title is the document's name: context for the secret-word check only.
    let window_title = chain.iter().find(|(r, _)| r == "AXWindow").map(|(_, t)| t.clone()).filter(|t| !t.is_empty());
    out.path = chain;
    if text_input {
        if let Some(w) = window_title {
            out.context.push(w.chars().take(120).collect());
        }
        let mut sib = e.clone();
        for _ in 0..3 {
            let Ok(prev) = (unsafe { u.walker.GetPreviousSiblingElementBuildCache(&sib, &u.req_element) }) else { break };
            let sn = uia::node_for(prev.clone(), None, false, 0, 0);
            if let Some(sc) = uia::compute(&sn, false) {
                let t = sc.info.title.clone().or(sc.info.value.clone()).unwrap_or_default();
                if sc.info.role == "AXStaticText" && !t.is_empty() {
                    out.context.push(t.chars().take(120).collect());
                }
            }
            sib = prev;
        }
    }
    // The value only after the caller's policy cleared the field.
    if text_input && !c.info.is_secure() && (scope.read_value)(&out) {
        let mut v = c.info.value.clone();
        if v.is_none() && out.role == "AXTextArea" {
            v = uia::compute(&node, true).and_then(|l| l.info.value);
        }
        out.value = v.map(|s| s.chars().take(MAX_VALUE_CHARS).collect());
    }
    Some(out)
}

/// The element under a screen point, when it belongs to the scope's app.
pub fn teach_element_at(x: i32, y: i32, scope: &TeachScope) -> Option<TeachElement> {
    com::ensure_dpi_awareness();
    let win = apps::window_at(x as f64, y as f64)?;
    if !(scope.owns)(win.pid) {
        return None;
    }
    let scope = scope.clone();
    com::pool()
        .run(LOOKUP_TIMEOUT, move || {
            let u = uia::uia()?;
            let e = unsafe { u.auto.ElementFromPointBuildCache(POINT { x, y }, &u.req_element) }
                .map_err(|_| crate::error::CapError::internal("no element"))?;
            teach_describe(&u, e, &scope).ok_or_else(|| crate::error::CapError::internal("no element"))
        })
        .ok()
}

/// The element with keyboard focus, when it belongs to the scope's app.
pub fn teach_focused(scope: &TeachScope) -> Option<TeachElement> {
    com::ensure_dpi_awareness();
    let scope = scope.clone();
    com::pool()
        .run(LOOKUP_TIMEOUT, move || {
            let u = uia::uia()?;
            let e =
                unsafe { u.auto.GetFocusedElementBuildCache(&u.req_element) }.map_err(|_| crate::error::CapError::internal("no focus"))?;
            teach_describe(&u, e, &scope).ok_or_else(|| crate::error::CapError::internal("no focus"))
        })
        .ok()
}
