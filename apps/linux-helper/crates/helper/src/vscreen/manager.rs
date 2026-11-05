//! The virtual screen as the helper's other code sees it: one display at most, the apps running
//! on it, and the rules around them (linux-desktop design §7).
//!
//! - **On demand.** Nothing runs until the first `start` or `open_app`.
//! - **Apps in scopes.** Every app is launched through `systemd-run --user --scope` in
//!   `psyche-vscreen.slice`, after the single-instance guard and with the app's launch recipe.
//! - **Never stray.** If an app's window did not appear on our display within 10 s, the launch
//!   is undone (`opened_elsewhere`).
//! - **Closing is polite.** Ending a Task asks each window to close; an app that answers with a
//!   "Save changes?" dialog stays, flagged, and the Task parks.
//! - **Stops on its own.** With no apps and no use for 10 minutes the display stops, and then the
//!   helper's idle timer runs again.

use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use super::display::{DisplayConfig, VirtualDisplay};
use super::guard::{
    check_before_launch, resolve_exe, BusctlBus, ProcFs, Procs, SessionBus,
};
use super::input::Button;
use super::recipes::{
    application_dirs, copy_profile, find_desktop_entry, firefox_profile_from_ini, launch_spec,
    recipe_for, Family, LaunchContext,
};
use super::scope::{parse_memory_high, unit_name, ScopeRunner, SystemdRunner, DEFAULT_MEMORY_HIGH};
use super::wmdriver::WindowRecord;
use crate::idle::{IdleHold, IdleTimer};
use crate::paths::{state_dir, Env};

/// Why a call failed: a short machine reason plus a sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VsError {
    pub reason: &'static str,
    pub message: String,
}

impl VsError {
    fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, message: message.into() }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub state_dir: PathBuf,
    pub home: PathBuf,
    pub xdg_runtime_dir: Option<String>,
    pub app_dirs: Vec<PathBuf>,
    pub path_var: String,
    pub memory_high: String,
    pub first_display: u32,
    pub xvfb_path: String,
    pub width: u32,
    pub height: u32,
    /// No apps and no use for this long: the display stops.
    pub idle_stop: Duration,
    /// A launch must map a window on our display within this long.
    pub launch_wait: Duration,
    /// How long a polite close gets before the app counts as "has unsaved changes".
    pub close_grace: Duration,
    pub watchdog_every: Duration,
}

impl Config {
    pub fn from_env(env: &dyn Env) -> Self {
        let home = PathBuf::from(env.get("HOME").unwrap_or_else(|| "/".into()));
        let state = state_dir(env);
        let memory_high = env
            .get("PSYCHE_VSCREEN_MEMORY_HIGH")
            .and_then(|v| parse_memory_high(&v))
            .or_else(|| memory_from_file(&state))
            .unwrap_or_else(|| DEFAULT_MEMORY_HIGH.to_string());
        Self {
            app_dirs: application_dirs(&home, env.get("XDG_DATA_HOME").as_deref(), env.get("XDG_DATA_DIRS").as_deref()),
            path_var: env.get("PATH").unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            xdg_runtime_dir: env.get("XDG_RUNTIME_DIR"),
            first_display: env.get("PSYCHE_VSCREEN_FIRST_DISPLAY").and_then(|v| v.parse().ok()).unwrap_or(90),
            xvfb_path: env.get("PSYCHE_XVFB").unwrap_or_else(|| "Xvfb".into()),
            width: 1280,
            height: 800,
            idle_stop: Duration::from_secs(600),
            launch_wait: Duration::from_secs(10),
            close_grace: Duration::from_secs(4),
            watchdog_every: Duration::from_secs(2),
            memory_high,
            state_dir: state,
            home,
        }
    }
}

/// `<state>/vscreen.json` with `{"memoryHigh":"2G"}`: the setting the desktop writes.
fn memory_from_file(state: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(state.join("vscreen.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    parse_memory_high(v.get("memoryHigh")?.as_str()?)
}

pub struct Deps {
    pub runner: Arc<dyn ScopeRunner>,
    pub bus: Arc<dyn SessionBus>,
    pub procs: Arc<dyn Procs>,
}

impl Deps {
    pub fn real() -> Self {
        Self {
            runner: Arc::new(SystemdRunner),
            bus: Arc::new(BusctlBus),
            procs: Arc::new(ProcFs),
        }
    }
}

struct AppRec {
    app_id: String,
    unit: String,
    child: Child,
    root_pid: u32,
    unsaved: bool,
}

struct Inner {
    display: Option<Arc<VirtualDisplay>>,
    apps: Vec<AppRec>,
    next_unit: u32,
    last_activity: Instant,
    owner_input_at: Option<Instant>,
    /// Width of the last frame handed out, to scale the pane's coordinates back to the screen.
    last_frame_width: Option<u32>,
    started_at_wall: Option<std::time::SystemTime>,
    hold: Option<IdleHold>,
    limited: bool,
    watchdog: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppStatus {
    pub app_id: String,
    pub pid: u32,
    pub window_title: Option<String>,
    pub has_unsaved_changes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub running: bool,
    pub display: Option<String>,
    pub width: u32,
    pub height: u32,
    pub apps: Vec<AppStatus>,
    pub taken_over: bool,
    pub frame_seq: u64,
    pub started_at: Option<std::time::SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    pub app_id: String,
    pub pid: u32,
    pub unit: String,
    pub window_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub changed: bool,
    pub frame_seq: u64,
    pub jpeg: Option<Vec<u8>>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum InputEvent {
    Move { x: f64, y: f64 },
    Down { x: f64, y: f64, button: Button },
    Up { x: f64, y: f64, button: Button },
    Scroll { x: f64, y: f64, dx: f64, dy: f64 },
    KeyDown(String),
    KeyUp(String),
    Text(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopOutcome {
    pub stopped: bool,
    /// Apps that kept their windows after a polite close.
    pub unsaved: Vec<String>,
}

/// How long after the owner's last input the agent counts as paused.
pub const OWNER_ACTIVE_FOR: Duration = Duration::from_secs(3);

pub struct VscreenManager {
    config: Config,
    deps: Deps,
    idle: Arc<IdleTimer>,
    inner: Mutex<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl VscreenManager {
    pub fn new(config: Config, deps: Deps, idle: Arc<IdleTimer>) -> Arc<Self> {
        Arc::new(Self {
            config,
            deps,
            idle,
            inner: Mutex::new(Inner {
                display: None,
                apps: Vec::new(),
                next_unit: 1,
                last_activity: Instant::now(),
                owner_input_at: None,
                last_frame_width: None,
                started_at_wall: None,
                hold: None,
                limited: false,
                watchdog: false,
            }),
        })
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    fn touch(&self) {
        lock(&self.inner).last_activity = Instant::now();
        self.idle.touch();
    }

    // ---- the display ----

    /// Starts the display if it is not up. The first caller pays for Xvfb.
    pub fn ensure_display(self: &Arc<Self>, size: Option<(u32, u32)>) -> Result<Arc<VirtualDisplay>, VsError> {
        let mut inner = lock(&self.inner);
        if let Some(d) = &inner.display {
            if d.is_alive() {
                return Ok(Arc::clone(d));
            }
            // The server died under us: clear the leftovers and start again.
            Self::teardown_locked(&mut inner, &*self.deps.runner);
        }
        let (w, h) = size.unwrap_or((self.config.width, self.config.height));
        let mut cfg = DisplayConfig::new(w, h);
        cfg.first_display = self.config.first_display;
        cfg.xvfb_path = self.config.xvfb_path.clone();
        if let Some(rt) = &self.config.xdg_runtime_dir {
            cfg.runtime_dir = Some(rt.clone());
        }
        let display = VirtualDisplay::start(&cfg).map_err(|e| {
            let missing = e.contains("could not start");
            VsError::new(
                if missing { "xvfb_missing" } else { "display_failed" },
                if missing {
                    "The virtual screen needs Xvfb, which is not installed."
                } else {
                    "The virtual screen could not start."
                },
            )
            .with_detail(&e)
        })?;
        let display = Arc::new(display);
        inner.display = Some(Arc::clone(&display));
        inner.started_at_wall = Some(std::time::SystemTime::now());
        inner.last_activity = Instant::now();
        inner.hold = Some(self.idle.hold());
        if !inner.watchdog {
            inner.watchdog = true;
            let weak = Arc::downgrade(self);
            let every = self.config.watchdog_every;
            std::thread::Builder::new()
                .name("vscreen-watchdog".into())
                .spawn(move || watchdog(weak, every))
                .ok();
        }
        crate::log(&format!("vscreen: started display {}", display.display));
        Ok(display)
    }

    pub fn start(self: &Arc<Self>, size: Option<(u32, u32)>) -> Result<Status, VsError> {
        self.ensure_display(size)?;
        self.touch();
        Ok(self.status())
    }

    fn teardown_locked(inner: &mut Inner, runner: &dyn ScopeRunner) {
        for app in inner.apps.drain(..) {
            runner.stop(&app.unit);
            let mut child = app.child;
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(d) = inner.display.take() {
            d.stop();
        }
        inner.hold = None;
        inner.started_at_wall = None;
        inner.owner_input_at = None;
        inner.last_frame_width = None;
        inner.limited = false;
    }

    // ---- apps ----

    /// Opens a desktop-file app on the virtual screen. This is what `apps.open { surface:
    /// "virtual_screen" }` calls.
    pub fn open_app(self: &Arc<Self>, desktop_id: &str) -> Result<Opened, VsError> {
        let entry = find_desktop_entry(desktop_id, &self.config.app_dirs)
            .ok_or_else(|| VsError::new("app_not_found", format!("No app called {desktop_id} is installed.")))?;
        let exe = resolve_exe(&entry, &self.config.path_var);
        // Before anything starts: is it already open on the owner's screen?
        check_before_launch(&entry, exe.as_deref(), &*self.deps.bus, &*self.deps.procs).map_err(|_| {
            VsError::new(
                "already_open_on_your_screen",
                format!("{} is already open on your screen. Use your own screen for it instead.", entry.name),
            )
        })?;
        let display = self.ensure_display(None)?;
        self.touch();

        let firefox_profile = if recipe_for(&entry.id).is_some_and(|r| r.family == Family::Firefox) {
            Some(self.firefox_profile_copy()?)
        } else {
            None
        };
        let ctx = LaunchContext {
            state_dir: self.config.state_dir.clone(),
            display: display.display.clone(),
            xauthority: display.xauthority.clone(),
            firefox_profile,
        };
        let spec = launch_spec(&entry, &ctx).map_err(|m| VsError::new("launch_failed", m))?;
        let (unit, serial) = {
            let mut inner = lock(&self.inner);
            let n = inner.next_unit;
            inner.next_unit += 1;
            (unit_name(&entry.id, n), display.window_serial())
        };
        let child = self
            .deps
            .runner
            .spawn(&unit, &format!("Psyche virtual screen: {}", entry.name), &spec)
            .map_err(|e| VsError::new("launch_failed", "The app could not be started.").with_detail(&e))?;
        let root_pid = child.id();
        {
            let mut inner = lock(&self.inner);
            inner.apps.push(AppRec { app_id: entry.id.clone(), unit: unit.clone(), child, root_pid, unsaved: false });
            if !inner.limited {
                inner.limited = true;
                self.deps.runner.limit_slice(&self.config.memory_high);
            }
        }
        match display.wait_for_window(serial, self.config.launch_wait, |_| true) {
            Some(win) => Ok(Opened { app_id: entry.id, pid: win.pid.unwrap_or(root_pid), unit, window_title: win.title }),
            None => {
                // No window on our display: the app handed its work to an instance somewhere
                // else, or it never opened one. Undo the launch so nothing is left behind.
                self.drop_app(&unit);
                Err(VsError::new(
                    "opened_elsewhere",
                    format!("{} did not open on the virtual screen, so it was stopped.", entry.name),
                ))
            }
        }
    }

    fn drop_app(&self, unit: &str) {
        let mut inner = lock(&self.inner);
        if let Some(i) = inner.apps.iter().position(|a| a.unit == unit) {
            let app = inner.apps.remove(i);
            self.deps.runner.stop(&app.unit);
            let mut child = app.child;
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn firefox_profile_copy(&self) -> Result<PathBuf, VsError> {
        let dest = self.config.state_dir.join("vscreen/firefox/profile");
        if dest.exists() {
            return Ok(dest);
        }
        let bases = [
            self.config.home.join(".mozilla/firefox"),
            self.config.home.join("snap/firefox/common/.mozilla/firefox"),
            self.config.home.join(".var/app/org.mozilla.firefox/.mozilla/firefox"),
        ];
        let source = bases.iter().find_map(|base| {
            let ini = std::fs::read_to_string(base.join("profiles.ini")).ok()?;
            firefox_profile_from_ini(&ini, base).filter(|p| p.is_dir())
        });
        let result = match source {
            Some(src) => copy_profile(&src, &dest),
            None => std::fs::create_dir_all(&dest),
        };
        result.map_err(|e| VsError::new("launch_failed", "Firefox's profile could not be prepared.").with_detail(&e.to_string()))?;
        Ok(dest)
    }

    // ---- reading ----

    fn app_of_window(&self, apps: &[AppRec], win: &WindowRecord) -> Option<usize> {
        if let Some(pid) = win.pid {
            let cg = self.deps.procs.cgroup_text(pid);
            if let Some(i) = apps.iter().position(|a| cg.contains(&format!("{}.scope", a.unit))) {
                return Some(i);
            }
            if let Some(i) = apps.iter().position(|a| a.root_pid == pid) {
                return Some(i);
            }
        }
        (apps.len() == 1).then_some(0)
    }

    pub fn status(&self) -> Status {
        let (display, apps_snapshot, since, owner) = {
            let inner = lock(&self.inner);
            let apps: Vec<(String, u32, bool, String)> = inner
                .apps
                .iter()
                .map(|a| (a.app_id.clone(), a.root_pid, a.unsaved, a.unit.clone()))
                .collect();
            (inner.display.clone(), apps, inner.started_at_wall, inner.owner_input_at)
        };
        let Some(display) = display else {
            return Status {
                running: false,
                display: None,
                width: 0,
                height: 0,
                apps: Vec::new(),
                taken_over: false,
                frame_seq: 0,
                started_at: None,
            };
        };
        let windows = display.windows();
        let inner = lock(&self.inner);
        let mut apps: Vec<AppStatus> = Vec::new();
        for (i, rec) in inner.apps.iter().enumerate() {
            let mine: Vec<&WindowRecord> = windows
                .iter()
                .filter(|w| self.app_of_window(&inner.apps, w) == Some(i))
                .collect();
            // The title of the newest ordinary window; a dialog only if there is nothing else.
            let title = mine
                .iter()
                .rev()
                .find(|w| w.transient_for.is_none())
                .or_else(|| mine.last())
                .and_then(|w| w.title.clone());
            let pid = mine.iter().find_map(|w| w.pid).unwrap_or(rec.root_pid);
            apps.push(AppStatus {
                app_id: rec.app_id.clone(),
                pid,
                window_title: title,
                has_unsaved_changes: rec.unsaved,
            });
        }
        drop(inner);
        let _ = apps_snapshot;
        Status {
            running: true,
            display: Some(display.display.clone()),
            width: display.width,
            height: display.height,
            apps,
            taken_over: owner.is_some_and(|t| t.elapsed() < OWNER_ACTIVE_FOR),
            frame_seq: display.frame_seq(Duration::from_millis(150)).unwrap_or(0),
            started_at: since,
        }
    }

    /// True while the owner drives through the watch pane; the agent's actions wait.
    pub fn owner_is_driving(&self) -> bool {
        lock(&self.inner)
            .owner_input_at
            .is_some_and(|t| t.elapsed() < OWNER_ACTIVE_FOR)
    }

    pub fn frame(&self, since: Option<u64>, max_width: Option<u32>) -> Result<Frame, VsError> {
        let display = self.current_display()?;
        let age = Duration::from_millis(100);
        let seq = display.frame_seq(age).map_err(|e| VsError::new("capture_failed", "The screen could not be read.").with_detail(&e))?;
        if since == Some(seq) {
            return Ok(Frame { changed: false, frame_seq: seq, jpeg: None, width: display.width, height: display.height });
        }
        let (seq, jpeg, w, h) = display
            .frame(max_width, age)
            .map_err(|e| VsError::new("capture_failed", "The screen could not be read.").with_detail(&e))?;
        lock(&self.inner).last_frame_width = Some(w);
        Ok(Frame { changed: true, frame_seq: seq, jpeg: Some(jpeg), width: w, height: h })
    }

    fn current_display(&self) -> Result<Arc<VirtualDisplay>, VsError> {
        lock(&self.inner)
            .display
            .clone()
            .filter(|d| d.is_alive())
            .ok_or_else(|| VsError::new("not_running", "The virtual screen is not running."))
    }

    // ---- input ----

    /// The owner's take-over input, in the coordinates of the last frame handed out.
    pub fn owner_input(&self, events: &[InputEvent]) -> Result<(), VsError> {
        let display = self.current_display()?;
        let scale = {
            let mut inner = lock(&self.inner);
            inner.owner_input_at = Some(Instant::now());
            inner.last_activity = Instant::now();
            inner.last_frame_width.map(|w| f64::from(display.width) / f64::from(w.max(1))).unwrap_or(1.0)
        };
        self.idle.touch();
        let at = |x: f64, y: f64| ((x * scale).round() as i32, (y * scale).round() as i32);
        let fail = |e: String| VsError::new("input_failed", "The input could not be sent.").with_detail(&e);
        for event in events {
            match event {
                InputEvent::Move { x, y } => {
                    let (x, y) = at(*x, *y);
                    display.with_input(|i| i.move_to(x, y)).map_err(fail)?;
                }
                InputEvent::Down { x, y, button } | InputEvent::Up { x, y, button } => {
                    let (x, y) = at(*x, *y);
                    let down = matches!(event, InputEvent::Down { .. });
                    display
                        .with_input(|i| i.move_to(x, y).and_then(|_| i.button(*button, down)))
                        .map_err(fail)?;
                }
                InputEvent::Scroll { x, y, dx, dy } => {
                    let (x, y) = at(*x, *y);
                    display.with_input(|i| i.scroll(x, y, *dx, *dy)).map_err(fail)?;
                }
                InputEvent::KeyDown(k) => display.with_input(|i| i.key(k, true)).map_err(fail)?,
                InputEvent::KeyUp(k) => display.with_input(|i| i.key(k, false)).map_err(fail)?,
                InputEvent::Text(t) => display.with_input(|i| i.type_text(t)).map_err(fail)?,
            }
        }
        Ok(())
    }

    /// The agent's input (`computer.act` on this surface), in screen coordinates. Refused while
    /// the owner is driving.
    pub fn agent_click(&self, x: i32, y: i32, button: Button) -> Result<(), VsError> {
        self.refuse_if_owner_drives()?;
        self.touch();
        self.current_display()?
            .click(x, y, button)
            .map_err(|e| VsError::new("input_failed", "The click could not be sent.").with_detail(&e))
    }

    pub fn agent_type(&self, text: &str) -> Result<(), VsError> {
        self.refuse_if_owner_drives()?;
        self.touch();
        self.current_display()?
            .type_text(text)
            .map_err(|e| VsError::new("input_failed", "The text could not be typed.").with_detail(&e))
    }

    fn refuse_if_owner_drives(&self) -> Result<(), VsError> {
        if self.owner_is_driving() {
            Err(VsError::new("taken_over", "You are driving the virtual screen, so Psyche is paused."))
        } else {
            Ok(())
        }
    }

    // ---- stopping ----

    /// Ends the Task's use of the screen. With `close_apps` each window is asked to close; an app
    /// that keeps its window (a "Save changes?" dialog) is not forced and the screen stays up.
    pub fn stop(&self, close_apps: bool, force: bool) -> Result<StopOutcome, VsError> {
        let Some(display) = lock(&self.inner).display.clone() else {
            return Ok(StopOutcome { stopped: true, unsaved: Vec::new() });
        };
        self.touch();
        if close_apps && !force {
            for w in display.windows() {
                if w.transient_for.is_none() {
                    display.request_close(w.id);
                }
            }
            let deadline = Instant::now() + self.config.close_grace;
            while Instant::now() < deadline && !display.windows().is_empty() {
                std::thread::sleep(Duration::from_millis(100));
            }
            let windows = display.windows();
            let mut inner = lock(&self.inner);
            let mut unsaved = Vec::new();
            for i in 0..inner.apps.len() {
                let has_window = windows
                    .iter()
                    .any(|w| self.app_of_window(&inner.apps, w) == Some(i));
                inner.apps[i].unsaved = has_window;
                if has_window {
                    unsaved.push(inner.apps[i].app_id.clone());
                }
            }
            if !unsaved.is_empty() {
                return Ok(StopOutcome { stopped: false, unsaved });
            }
        }
        let mut inner = lock(&self.inner);
        Self::teardown_locked(&mut inner, &*self.deps.runner);
        crate::log("vscreen: stopped");
        Ok(StopOutcome { stopped: true, unsaved: Vec::new() })
    }

    /// Stops everything now (the helper is exiting).
    pub fn shutdown(&self) {
        let mut inner = lock(&self.inner);
        Self::teardown_locked(&mut inner, &*self.deps.runner);
    }
}

/// Housekeeping while a display exists: forget apps that ended, notice a dead server, and stop
/// the display after `idle_stop` with nothing on it.
fn watchdog(weak: Weak<VscreenManager>, every: Duration) {
    loop {
        std::thread::sleep(every);
        let Some(m) = weak.upgrade() else { return };
        let mut inner = lock(&m.inner);
        let Some(display) = inner.display.clone() else {
            inner.watchdog = false;
            return;
        };
        if !display.is_alive() {
            VscreenManager::teardown_locked(&mut inner, &*m.deps.runner);
            crate::log("vscreen: the display ended");
            inner.watchdog = false;
            return;
        }
        let windows = display.windows();
        // An app whose process ended and left no window is gone.
        let mut keep = Vec::new();
        let apps = std::mem::take(&mut inner.apps);
        let snapshot: Vec<usize> = (0..apps.len()).collect();
        for (idx, mut app) in apps.into_iter().enumerate() {
            let exited = matches!(app.child.try_wait(), Ok(Some(_)));
            let has_window = windows
                .iter()
                .any(|w| w.pid == Some(app.root_pid) || w.pid.is_some_and(|p| m.deps.procs.cgroup_text(p).contains(&format!("{}.scope", app.unit))));
            let _ = (&snapshot, idx);
            if exited && !has_window {
                m.deps.runner.stop(&app.unit);
                continue;
            }
            keep.push(app);
        }
        inner.apps = keep;
        if inner.apps.is_empty() && inner.last_activity.elapsed() >= m.config.idle_stop {
            VscreenManager::teardown_locked(&mut inner, &*m.deps.runner);
            crate::log("vscreen: stopped (idle)");
            inner.watchdog = false;
            return;
        }
    }
}

impl VsError {
    /// Logs the technical detail (never params or content) and keeps the message plain.
    fn with_detail(self, detail: &str) -> Self {
        crate::log(&format!("vscreen: {}: {detail}", self.reason));
        self
    }
}
