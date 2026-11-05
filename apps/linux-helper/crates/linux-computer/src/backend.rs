//! The seam between the platform-neutral engine and a desktop. The engine ([`crate::engine`])
//! implements every check (session, app, tier and approval, expectation, risky label, secure
//! field) once, against this trait; the Linux backends (AT-SPI + X11, AT-SPI + a portal session,
//! AT-SPI + wlroots) and the test fakes implement it. Nothing below the engine decides policy.
//!
//! All methods are synchronous and may block on D-Bus or X11 for a bounded time. Methods that
//! move the pointer or press keys take the [`StopSignal`] and must check it between steps
//! (at most every 20 ms) so a Stop (Escape on X11, a closed portal session on Wayland) cuts the
//! action short.

use crate::error::{code, CapError, CapResult};
use crate::keychord::KeyChord;
use crate::keychord::Mods;
use crate::roles::AtspiFacts;
use crate::snapshot::{ElementInfo, Rect, TreeSource};
use crate::tiers::StopSignal;
use serde_json::Value;
use std::time::Duration;

/// A running app that owns at least one top-level accessible.
#[derive(Debug, Clone, PartialEq)]
pub struct AppInfo {
    /// The desktop file id (lowercase, no `.desktop`): the one app identity of the helper.
    pub id: String,
    pub name: String,
    pub pid: u32,
    /// A Chromium or Electron app (its tree builds lazily and is sparse until it is asked for).
    pub electron: bool,
    pub frontmost: bool,
    /// Number of top-level windows.
    pub windows: usize,
}

impl AppInfo {
    pub fn owns(&self, pid: u32) -> bool {
        self.pid == pid
    }
}

/// A top-level window, front to back.
#[derive(Debug, Clone, PartialEq)]
pub struct WinInfo {
    pub id: u64,
    pub pid: u32,
    pub title: String,
    /// Screen bounds; `None` where the desktop does not tell clients (GNOME on Wayland).
    pub bounds: Option<Rect>,
    /// Normal (0) or floating / always on top (1).
    pub layer: i32,
    pub focused: bool,
    pub minimized: bool,
}

/// One element, read once: the snapshot's view, the AT-SPI facts, and its owner.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementData {
    pub info: ElementInfo,
    pub facts: AtspiFacts,
    pub pid: u32,
}

/// What a hit test found under a point.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub pid: u32,
    pub role: Option<String>,
    pub secure: bool,
    /// Labels of the element and its ancestors up to the window (for the risky-label check).
    pub labels: Vec<String>,
}

/// An action that did not work (the app's own refusal), kept apart from [`CapError`] so the
/// engine reports `ineffective` like the Mac helper instead of failing the call.
#[derive(Debug, Clone, PartialEq)]
pub struct ActError {
    pub detail: String,
    pub not_responding: bool,
}

impl ActError {
    pub fn new(detail: impl Into<String>) -> Self {
        ActError { detail: detail.into(), not_responding: false }
    }
}

/// A captured image: RGBA, `width * height * 4` bytes.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    /// Where the frame sits in screen points.
    pub screen: Rect,
    /// Device pixels per point.
    pub scale: f64,
}

impl Frame {
    /// Paints `r` (in frame-local pixels) black.
    pub fn fill_black(&mut self, r: Rect) {
        let x0 = r.x.max(0.0) as u32;
        let y0 = r.y.max(0.0) as u32;
        let x1 = (r.max_x().max(0.0) as u32).min(self.width);
        let y1 = (r.max_y().max(0.0) as u32).min(self.height);
        for y in y0..y1 {
            for x in x0..x1 {
                let i = ((y * self.width + x) * 4) as usize;
                if let Some(px) = self.rgba.get_mut(i..i + 4) {
                    px.copy_from_slice(&[0, 0, 0, 255]);
                }
            }
        }
    }

    /// Whether any pixel of `r` is not yet black (a test aid).
    pub fn any_lit(&self, r: Rect) -> bool {
        let x0 = r.x.max(0.0) as u32;
        let y0 = r.y.max(0.0) as u32;
        let x1 = (r.max_x().max(0.0) as u32).min(self.width);
        let y1 = (r.max_y().max(0.0) as u32).min(self.height);
        (y0..y1).any(|y| (x0..x1).any(|x| self.rgba[((y * self.width + x) * 4) as usize..][..3] != [0, 0, 0]))
    }
}

fn unsupported(what: &str) -> CapError {
    CapError::new(code::NOT_IMPLEMENTED, "not_supported", format!("{what} is not available on this desktop"))
}

/// A desktop the engine can drive.
pub trait Backend: TreeSource<Element: Send + 'static> + Send + Sync + 'static {
    // --- the session and the desktop ---------------------------------------------------------

    /// Refuses (`unavailable`) when there is no graphical session, no accessibility bus, or the
    /// input/capture path the owner has to allow (the portal dialog) is closed. Called before
    /// every action and screenshot; may open the portal session, which is when the owner sees
    /// the system dialog.
    fn check_desktop(&self) -> CapResult<()>;

    /// Whether window positions are known (X11, KDE with KWin scripting). Without them a full
    /// screenshot cannot hide protected windows, and refs without a frame are "no position".
    fn window_geometry_known(&self) -> bool;

    // --- apps and windows ---------------------------------------------------------------------

    fn apps(&self) -> Vec<AppInfo>;
    fn windows(&self) -> Vec<WinInfo>;
    /// The pid of the process that has keyboard focus, if the desktop says.
    fn keyboard_focus_pid(&self) -> Option<u32>;
    /// Brings the app (or one of its windows) forward. `Ok(true)` when focus moved, `Ok(false)`
    /// when it was only requested (GNOME on Wayland), an error for `focus_denied`.
    fn activate(&self, app: &AppInfo, window: Option<usize>, stop: &StopSignal) -> CapResult<bool>;
    /// Launches an app by desktop id, with an optional `file:` or `mailto:` URL.
    fn launch(&self, id: &str, url: Option<&str>) -> CapResult<Value>;

    // --- the tree -----------------------------------------------------------------------------

    /// Starts a snapshot walk with a wall-clock budget (the tree's `should_stop` follows it).
    fn begin_walk(&self, budget: Duration);
    /// The top-level accessibles of `app`, window order as the desktop lists them.
    fn window_elements(&self, app: &AppInfo) -> Vec<Self::Element>;
    /// The app's root accessible (menus, popups, all windows).
    fn app_element(&self, app: &AppInfo) -> Self::Element;
    /// The focused element of the app, if it can be found.
    fn focused_element(&self, app: Option<&AppInfo>) -> Option<Self::Element>;
    fn data(&self, e: &Self::Element) -> Option<ElementData>;
    fn set_focus(&self, e: &Self::Element) -> Result<(), ActError>;
    fn perform(&self, e: &Self::Element, ax_action: &str) -> Result<(), ActError>;
    fn set_value(&self, e: &Self::Element, value: &str) -> Result<(), ActError>;
    /// The current value as the snapshot would show it (not truncated by the snapshot caps).
    fn current_value(&self, e: &Self::Element) -> Option<String>;
    fn full_value(&self, e: &Self::Element, max: usize) -> Option<String>;
    fn select(&self, e: &Self::Element) -> Result<(), ActError>;
    fn is_selected(&self, e: &Self::Element) -> Option<bool>;
    /// Screen frame of the element, `None` for "no position".
    fn frame(&self, e: &Self::Element) -> Option<Rect>;
    fn hit_test(&self, x: f64, y: f64) -> Option<Hit>;
    /// Whether the keyboard focus is in a password field (any app).
    fn focused_is_secure(&self, app: Option<&AppInfo>) -> bool;
    /// The selected text of the focused element, never of a password field.
    fn selected_text(&self, _app: &AppInfo) -> Option<String> {
        None
    }

    // --- input --------------------------------------------------------------------------------

    fn click(&self, x: f64, y: f64, count: u32, right: bool, mods: Mods, stop: &StopSignal) -> CapResult<()>;
    /// Types `text`; `before_chunk` runs before every chunk and may refuse (focus moved, secure
    /// field).
    fn type_text(&self, text: &str, stop: &StopSignal, before_chunk: &mut dyn FnMut() -> CapResult<()>) -> CapResult<()>;
    fn key(&self, chord: &KeyChord, stop: &StopSignal) -> CapResult<()>;
    fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()>;
    fn drag(&self, from: (f64, f64), to: (f64, f64), stop: &StopSignal) -> CapResult<()>;
    /// A pause that returns early with `user_stopped` when stopped.
    fn pause(&self, ms: u64, stop: &StopSignal) -> CapResult<()> {
        let mut left = ms;
        while left > 0 {
            stop.check()?;
            let step = left.min(20);
            std::thread::sleep(Duration::from_millis(step));
            left -= step;
        }
        stop.check()
    }

    // --- capture ------------------------------------------------------------------------------

    /// The whole screen (display `index` when the desktop has several).
    fn capture(&self, _display: Option<usize>) -> CapResult<Frame> {
        Err(unsupported("Screen capture"))
    }
    /// Screens (monitors) in screen points.
    fn displays(&self) -> Vec<Rect> {
        Vec::new()
    }

    // --- stop ---------------------------------------------------------------------------------

    /// Installs the Stop source (Escape grab on X11, the portal's `Closed` on Wayland) once. The
    /// callback runs on a backend thread.
    fn start_stop_source(&self, _on_stop: Box<dyn Fn() + Send + Sync>) {}
    /// Called when the last session ended: the backend may close its portal session and capture
    /// stream (zero cost between sessions).
    fn session_idle(&self) {}
    /// When the owner last used the keyboard or pointer (not the helper's own events).
    fn last_owner_input(&self) -> Option<f64> {
        None
    }
}
