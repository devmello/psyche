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
//! - **Capped first.** The slice's memory, task and CPU caps are set before anything starts in
//!   it; the X server and the private bus run in scopes in the slice too. No caps, no screen.
//! - **Its own session.** Apps get a private runtime dir and session bus (`bus.rs`) and only the
//!   allowlisted environment (`recipes::app_environment`), never the owner's bus.
//! - **Nothing stays pressed.** Keys and buttons held through the take-over are released when it
//!   ends, when the pane loses focus, before the agent acts after the owner, and on stop.

use std::path::PathBuf;
use std::process::Child;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use super::bus;
use super::display::{DisplayConfig, VirtualDisplay};
use super::guard::{
    check_before_launch, resolve_exe, BusctlBus, ProcFs, Procs, Refusal, SessionBus,
};
use super::input::Button;
use super::recipes::{
    app_environment, application_dirs, find_desktop_entry, firefox_profile_from_ini,
    fresh_profile_copy, launch_spec, launches_snap, recipe_for, Family, LaunchContext, LaunchSpec,
    APP_ENV_ALLOW,
};
use super::scope::{
    parse_cpu_quota, parse_memory, parse_tasks_max, unit_name, ScopeRunner, SliceLimits,
    SystemdRunner,
};
use super::wm::WindowKind;
use super::wmdriver::WindowRecord;
use super::xauth;
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
        Self {
            reason,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub state_dir: PathBuf,
    pub home: PathBuf,
    pub xdg_runtime_dir: Option<String>,
    pub app_dirs: Vec<PathBuf>,
    pub path_var: String,
    /// The owner's values of `recipes::APP_ENV_ALLOW`: all an app gets of the environment.
    pub base_env: Vec<(String, String)>,
    /// The slice's caps, set before anything starts in it.
    pub limits: SliceLimits,
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
        let limits = limits_from(env, &state);
        let base_env = APP_ENV_ALLOW
            .iter()
            .filter_map(|k| env.get(k).map(|v| (k.to_string(), v)))
            .collect();
        Self {
            app_dirs: application_dirs(
                &home,
                env.get("XDG_DATA_HOME").as_deref(),
                env.get("XDG_DATA_DIRS").as_deref(),
            ),
            path_var: env
                .get("PATH")
                .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into()),
            xdg_runtime_dir: env.get("XDG_RUNTIME_DIR"),
            first_display: env
                .get("PSYCHE_VSCREEN_FIRST_DISPLAY")
                .and_then(|v| v.parse().ok())
                .unwrap_or(90),
            xvfb_path: env.get("PSYCHE_XVFB").unwrap_or_else(|| "Xvfb".into()),
            width: 1280,
            height: 800,
            idle_stop: Duration::from_secs(600),
            launch_wait: Duration::from_secs(10),
            close_grace: Duration::from_secs(4),
            watchdog_every: Duration::from_secs(2),
            base_env,
            limits,
            state_dir: state,
            home,
        }
    }
}

/// The slice's caps: `PSYCHE_VSCREEN_*` first, then `<state>/vscreen.json` (`{"memoryHigh":"2G",
/// "memoryMax":"3G","tasksMax":2048,"cpuQuota":"200%"}`, what the desktop writes), then the
/// defaults. A value that does not parse (`infinity` among them) falls back to the default.
pub fn limits_from(env: &dyn Env, state: &std::path::Path) -> SliceLimits {
    let file: serde_json::Value = std::fs::read_to_string(state.join("vscreen.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(serde_json::Value::Null);
    let setting = |env_key: &str, file_key: &str| -> Option<String> {
        env.get(env_key).or_else(|| match file.get(file_key)? {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
    };
    let d = SliceLimits::defaults();
    SliceLimits {
        memory_high: setting("PSYCHE_VSCREEN_MEMORY_HIGH", "memoryHigh")
            .and_then(|v| parse_memory(&v))
            .unwrap_or(d.memory_high),
        memory_max: setting("PSYCHE_VSCREEN_MEMORY_MAX", "memoryMax")
            .and_then(|v| parse_memory(&v))
            .unwrap_or(d.memory_max),
        tasks_max: setting("PSYCHE_VSCREEN_TASKS_MAX", "tasksMax")
            .and_then(|v| parse_tasks_max(&v))
            .unwrap_or(d.tasks_max),
        cpu_quota_percent: setting("PSYCHE_VSCREEN_CPU_QUOTA", "cpuQuota")
            .and_then(|v| parse_cpu_quota(&v))
            .unwrap_or(d.cpu_quota_percent),
    }
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

/// One display session's private runtime dir and bus (`bus.rs`), and the scopes around them.
struct Session {
    dir: PathBuf,
    /// The private bus, when `dbus-daemon` started; `None` means apps get `no_bus_address`.
    bus_address: Option<String>,
    bus: Option<(String, Child)>,
    /// `at-spi-bus-launcher` on the private bus, when one is installed.
    a11y: Option<(String, Child)>,
    display_unit: String,
}

struct Inner {
    display: Option<Arc<VirtualDisplay>>,
    session: Option<Session>,
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
    /// Whether this display session's Firefox profile copy is made. Its own lock: copying can
    /// take seconds and must not block frames and status. Taken after `inner`, never before.
    firefox_fresh: Mutex<bool>,
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
            firefox_fresh: Mutex::new(false),
            inner: Mutex::new(Inner {
                display: None,
                session: None,
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
    pub fn ensure_display(
        self: &Arc<Self>,
        size: Option<(u32, u32)>,
    ) -> Result<Arc<VirtualDisplay>, VsError> {
        let mut inner = lock(&self.inner);
        if let Some(d) = &inner.display {
            if d.is_alive() {
                return Ok(Arc::clone(d));
            }
            // The server died under us: clear the leftovers and start again.
            self.teardown_locked(&mut inner);
        }
        // The caps go on the slice before anything runs in it, and without them nothing does.
        if !inner.limited {
            self.deps
                .runner
                .limit_slice(&self.config.limits)
                .map_err(|e| {
                    VsError::new(
                        "limits_failed",
                        "The virtual screen could not be given its memory and CPU limits, so it did not start.",
                    )
                    .with_detail(&e)
                })?;
            inner.limited = true;
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
                if missing {
                    "xvfb_missing"
                } else {
                    "display_failed"
                },
                if missing {
                    "The virtual screen needs Xvfb, which is not installed."
                } else {
                    "The virtual screen could not start."
                },
            )
            .with_detail(&e)
        })?;
        let display = Arc::new(display);
        let session = self
            .start_session(&display)
            .inspect_err(|_| display.stop())?;
        inner.session = Some(session);
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

    /// The X server into its scope in the slice, then the private runtime dir and bus.
    fn start_session(&self, display: &VirtualDisplay) -> Result<Session, VsError> {
        let display_unit = format!(
            "psyche-vs-{}-display-{}-{}",
            super::sweep::own_tag_text(),
            display.display.trim_start_matches(':'),
            display.xvfb_pid()
        );
        self.deps
            .runner
            .adopt(
                &display_unit,
                "Psyche virtual screen display",
                display.xvfb_pid(),
            )
            .map_err(|e| {
                VsError::new(
                    "limits_failed",
                    "The virtual screen could not be placed under its memory and CPU limits, so it did not start.",
                )
                .with_detail(&e)
            })?;
        let fail = |e: std::io::Error| {
            VsError::new("display_failed", "The virtual screen could not start.")
                .with_detail(&e.to_string())
        };
        let base = xauth::runtime_dir(self.config.xdg_runtime_dir.as_deref()).map_err(fail)?;
        let dir = bus::make_session_dir(&base).map_err(fail)?;
        let mut session = Session {
            dir,
            bus_address: None,
            bus: None,
            a11y: None,
            display_unit,
        };
        bus::write_bus_config(&session.dir).map_err(fail)?;
        let address = bus::bus_address(&session.dir);
        let spec = LaunchSpec {
            argv: bus::dbus_daemon_argv(&session.dir),
            env: app_environment(&self.launch_context(display, &session.dir, &address, None)),
        };
        let unit = format!(
            "psyche-vs-{}-bus-{}-{}",
            super::sweep::own_tag_text(),
            display.display.trim_start_matches(':'),
            display.xvfb_pid()
        );
        match self
            .deps
            .runner
            .spawn_tied(&unit, "Psyche virtual screen session bus", &spec)
        {
            Ok(mut child) => {
                match bus::wait_for_bus(&session.dir, &mut child, Duration::from_secs(5)) {
                    Ok(()) => {
                        session.bus_address = Some(address.clone());
                        session.bus = Some((unit, child));
                        session.a11y = self.start_a11y(display, &session.dir, &address);
                    }
                    Err(e) => {
                        crate::log(&format!("vscreen: no private session bus: {e}"));
                        self.deps.runner.stop(&unit);
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
            Err(e) => crate::log(&format!("vscreen: no private session bus: {e}")),
        }
        Ok(session)
    }

    /// `at-spi-bus-launcher` on the private bus, best effort: without it the apps simply have no
    /// accessibility tree.
    fn start_a11y(
        &self,
        display: &VirtualDisplay,
        session_dir: &std::path::Path,
        address: &str,
    ) -> Option<(String, Child)> {
        let argv = bus::a11y_launcher_argv()?;
        let spec = LaunchSpec {
            argv,
            env: app_environment(&self.launch_context(display, session_dir, address, None)),
        };
        let unit = format!(
            "psyche-vs-{}-a11y-{}-{}",
            super::sweep::own_tag_text(),
            display.display.trim_start_matches(':'),
            display.xvfb_pid()
        );
        match self
            .deps
            .runner
            .spawn_tied(&unit, "Psyche virtual screen accessibility bus", &spec)
        {
            Ok(child) => Some((unit, child)),
            Err(e) => {
                crate::log(&format!("vscreen: no accessibility bus: {e}"));
                None
            }
        }
    }

    fn launch_context(
        &self,
        display: &VirtualDisplay,
        session_dir: &std::path::Path,
        bus_address: &str,
        firefox_profile: Option<PathBuf>,
    ) -> LaunchContext {
        LaunchContext {
            state_dir: self.config.state_dir.clone(),
            display: display.display.clone(),
            xauthority: display.xauthority.clone(),
            firefox_profile,
            runtime_dir: session_dir.to_path_buf(),
            bus_address: bus_address.to_string(),
            base_env: self.config.base_env.clone(),
        }
    }

    pub fn start(self: &Arc<Self>, size: Option<(u32, u32)>) -> Result<Status, VsError> {
        self.ensure_display(size)?;
        self.touch();
        Ok(self.status())
    }

    /// The display's authority file, while it runs (tests and diagnostics).
    pub fn xauthority(&self) -> Option<PathBuf> {
        lock(&self.inner)
            .display
            .as_ref()
            .map(|d| d.xauthority.clone())
    }

    /// The private session bus, while one runs (the AT-SPI work reads the apps' tree there).
    pub fn session_bus_address(&self) -> Option<String> {
        lock(&self.inner)
            .session
            .as_ref()
            .and_then(|s| s.bus_address.clone())
    }

    fn teardown_locked(&self, inner: &mut Inner) {
        let runner = &*self.deps.runner;
        for app in inner.apps.drain(..) {
            runner.stop(&app.unit);
            let mut child = app.child;
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(mut s) = inner.session.take() {
            for (unit, mut child) in s.a11y.take().into_iter().chain(s.bus.take()) {
                runner.stop(&unit);
                let _ = child.kill();
                let _ = child.wait();
            }
            if let Some(d) = inner.display.take() {
                d.stop();
            }
            runner.stop(&s.display_unit);
            super::rmtree::remove_tree_logged(&s.dir, "session dir");
            if self.config.xdg_runtime_dir.is_none() {
                // The display's auth file and the session dir are gone: the fallback dir is
                // empty now, and goes too.
                super::xauth::release_private_temp_dir();
            }
        } else if let Some(d) = inner.display.take() {
            d.stop();
        }
        // The next session's Firefox starts from a fresh copy; this one's goes.
        let mut fresh = lock(&self.firefox_fresh);
        *fresh = false;
        super::rmtree::remove_tree_logged(&self.firefox_profile_dir(), "Firefox profile copy");
        drop(fresh);
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
        let entry = find_desktop_entry(desktop_id, &self.config.app_dirs).ok_or_else(|| {
            VsError::new(
                "app_not_found",
                format!("No app called {desktop_id} is installed."),
            )
        })?;
        let exe = resolve_exe(&entry, &self.config.path_var);
        let head = exe.as_deref().and_then(script_head);
        if launches_snap(&entry, exe.as_deref(), head.as_deref()) {
            return Err(VsError::new(
                "snap_unsupported",
                "Snap apps can't run on the virtual screen yet; install the deb or Flatpak version.",
            ));
        }
        // Before anything starts: is it already open on the owner's screen?
        check_before_launch(&entry, exe.as_deref(), &*self.deps.bus, &*self.deps.procs).map_err(
            |r| match r {
                Refusal::AlreadyOpenOnYourScreen => VsError::new(
                    "already_open_on_your_screen",
                    format!(
                        "{} is already open on your screen. Use your own screen for it instead.",
                        entry.name
                    ),
                ),
                Refusal::CannotCheck => VsError::new(
                    "guard_unavailable",
                    format!(
                        "Psyche could not check whether {} is already open on your screen, so it did not open it.",
                        entry.name
                    ),
                ),
            },
        )?;
        let display = self.ensure_display(None)?;
        self.touch();
        let (session_dir, bus_address) = {
            let inner = lock(&self.inner);
            let s = inner
                .session
                .as_ref()
                .ok_or_else(|| VsError::new("not_running", "The virtual screen is not running."))?;
            (s.dir.clone(), s.bus_address.clone())
        };
        if bus_address.is_none() && bus::needs_session_bus(&entry) {
            return Err(VsError::new(
                "needs_private_bus",
                format!(
                    "{} needs its own session bus on the virtual screen, and dbus-daemon is not installed, so it was not opened.",
                    entry.name
                ),
            ));
        }
        let bus_address = bus_address.unwrap_or_else(|| bus::no_bus_address(&session_dir));

        let firefox_profile = if recipe_for(&entry.id).is_some_and(|r| r.family == Family::Firefox)
        {
            Some(self.firefox_profile_copy()?)
        } else {
            None
        };
        let ctx = self.launch_context(&display, &session_dir, &bus_address, firefox_profile);
        let spec = launch_spec(&entry, &ctx).map_err(|m| VsError::new("launch_failed", m))?;
        let (unit, serial) = {
            let mut inner = lock(&self.inner);
            let n = inner.next_unit;
            inner.next_unit += 1;
            (
                unit_name(&super::sweep::own_tag_text(), &entry.id, n),
                display.window_serial(),
            )
        };
        let child = self
            .deps
            .runner
            .spawn(
                &unit,
                &format!("Psyche virtual screen: {}", entry.name),
                &spec,
            )
            .map_err(|e| {
                VsError::new("launch_failed", "The app could not be started.").with_detail(&e)
            })?;
        let root_pid = child.id();
        {
            let mut inner = lock(&self.inner);
            inner.apps.push(AppRec {
                app_id: entry.id.clone(),
                unit: unit.clone(),
                child,
                root_pid,
                unsaved: false,
            });
        }
        let procs = &self.deps.procs;
        match display.wait_for_window(serial, self.config.launch_wait, |w| {
            is_main_window(w, &w.pid.map(|p| procs.comm(p)).unwrap_or_default())
        }) {
            Some(win) => Ok(Opened {
                app_id: entry.id,
                pid: win.pid.unwrap_or(root_pid),
                unit,
                window_title: win.title,
            }),
            None => {
                // No window on our display: the app handed its work to an instance somewhere
                // else, or it never opened one. Undo the launch so nothing is left behind.
                self.drop_app(&unit);
                Err(VsError::new(
                    "opened_elsewhere",
                    format!(
                        "{} did not open on the virtual screen, so it was stopped.",
                        entry.name
                    ),
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

    fn firefox_profile_dir(&self) -> PathBuf {
        self.config.state_dir.join("vscreen/firefox/profile")
    }

    /// The agent's Firefox profile: a fresh copy of the owner's default profile once per display
    /// session, without saved passwords, cookies, sessions or form history (`recipes::FIREFOX_COPY` is an allowlist).
    fn firefox_profile_copy(&self) -> Result<PathBuf, VsError> {
        let dest = self.firefox_profile_dir();
        let mut fresh = lock(&self.firefox_fresh);
        if *fresh && dest.is_dir() {
            return Ok(dest);
        }
        let bases = [
            self.config.home.join(".mozilla/firefox"),
            self.config
                .home
                .join("snap/firefox/common/.mozilla/firefox"),
            self.config
                .home
                .join(".var/app/org.mozilla.firefox/.mozilla/firefox"),
        ];
        let source = bases.iter().find_map(|base| {
            let ini = std::fs::read_to_string(base.join("profiles.ini")).ok()?;
            firefox_profile_from_ini(&ini, base).filter(|p| p.is_dir())
        });
        let result = match source {
            Some(src) => fresh_profile_copy(&src, &dest),
            None => {
                super::rmtree::remove_tree_logged(&dest, "old Firefox profile copy");
                std::fs::create_dir_all(&dest)
            }
        };
        result.map_err(|e| {
            VsError::new("launch_failed", "Firefox's profile could not be prepared.")
                .with_detail(&e.to_string())
        })?;
        *fresh = true;
        Ok(dest)
    }

    // ---- reading ----

    fn app_of_window(&self, apps: &[AppRec], win: &WindowRecord) -> Option<usize> {
        if let Some(pid) = win.pid {
            let cg = self.deps.procs.cgroup_text(pid);
            if let Some(i) = apps
                .iter()
                .position(|a| cg.contains(&format!("{}.scope", a.unit)))
            {
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
            (
                inner.display.clone(),
                apps,
                inner.started_at_wall,
                inner.owner_input_at,
            )
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
        let seq = display.frame_seq(age).map_err(|e| {
            VsError::new("capture_failed", "The screen could not be read.").with_detail(&e)
        })?;
        if since == Some(seq) {
            return Ok(Frame {
                changed: false,
                frame_seq: seq,
                jpeg: None,
                width: display.width,
                height: display.height,
            });
        }
        let (seq, jpeg, w, h) = display.frame(max_width, age).map_err(|e| {
            VsError::new("capture_failed", "The screen could not be read.").with_detail(&e)
        })?;
        lock(&self.inner).last_frame_width = Some(w);
        Ok(Frame {
            changed: true,
            frame_seq: seq,
            jpeg: Some(jpeg),
            width: w,
            height: h,
        })
    }

    fn current_display(&self) -> Result<Arc<VirtualDisplay>, VsError> {
        lock(&self.inner)
            .display
            .clone()
            .filter(|d| d.is_alive())
            .ok_or_else(|| VsError::new("not_running", "The virtual screen is not running."))
    }

    // ---- input ----

    /// The owner's take-over input, in the coordinates of the last frame handed out. With
    /// `release` (the take-over ended, or the pane lost focus) every held key and button is let
    /// go afterwards and the agent is no longer paused.
    pub fn owner_input(&self, events: &[InputEvent], release: bool) -> Result<(), VsError> {
        let display = self.current_display()?;
        let scale = {
            let mut inner = lock(&self.inner);
            inner.owner_input_at = Some(Instant::now());
            inner.last_activity = Instant::now();
            inner
                .last_frame_width
                .map(|w| f64::from(display.width) / f64::from(w.max(1)))
                .unwrap_or(1.0)
        };
        self.idle.touch();
        let at = |x: f64, y: f64| ((x * scale).round() as i32, (y * scale).round() as i32);
        let fail = |e: String| {
            VsError::new("input_failed", "The input could not be sent.").with_detail(&e)
        };
        let apply = |event: &InputEvent| -> Result<(), String> {
            match event {
                InputEvent::Move { x, y } => {
                    let (x, y) = at(*x, *y);
                    display.with_input(|i| i.move_to(x, y))
                }
                InputEvent::Down { x, y, button } | InputEvent::Up { x, y, button } => {
                    let (x, y) = at(*x, *y);
                    let down = matches!(event, InputEvent::Down { .. });
                    display.with_input(|i| i.move_to(x, y).and_then(|_| i.button(*button, down)))
                }
                InputEvent::Scroll { x, y, dx, dy } => {
                    let (x, y) = at(*x, *y);
                    display.with_input(|i| i.scroll(x, y, *dx, *dy))
                }
                InputEvent::KeyDown(k) => display.with_input(|i| i.key(k, true)),
                InputEvent::KeyUp(k) => display.with_input(|i| i.key(k, false)),
                InputEvent::Text(t) => display.with_input(|i| i.type_text(t)),
            }
        };
        let skipped =
            run_input_batch(events, release, apply, || display.release_input()).map_err(fail)?;
        if skipped > 0 {
            crate::log(&format!(
                "vscreen: release batch skipped {skipped} event(s)"
            ));
        }
        if release {
            lock(&self.inner).owner_input_at = None;
        }
        Ok(())
    }

    /// Before the agent acts after the owner drove: let go of whatever the owner left pressed.
    fn release_after_owner(&self, display: &VirtualDisplay) -> Result<(), VsError> {
        let owner_was_here = lock(&self.inner).owner_input_at.take().is_some();
        if owner_was_here {
            display.release_input().map_err(|e| {
                VsError::new("input_failed", "The input could not be sent.").with_detail(&e)
            })?;
        }
        Ok(())
    }

    /// The agent's input (`computer.act` on this surface), in screen coordinates. Refused while
    /// the owner is driving.
    pub fn agent_click(&self, x: i32, y: i32, button: Button) -> Result<(), VsError> {
        self.refuse_if_owner_drives()?;
        self.touch();
        let display = self.current_display()?;
        self.release_after_owner(&display)?;
        display.click(x, y, button).map_err(|e| {
            VsError::new("input_failed", "The click could not be sent.").with_detail(&e)
        })
    }

    pub fn agent_type(&self, text: &str) -> Result<(), VsError> {
        self.refuse_if_owner_drives()?;
        self.touch();
        let display = self.current_display()?;
        self.release_after_owner(&display)?;
        display.type_text(text).map_err(|e| {
            VsError::new("input_failed", "The text could not be typed.").with_detail(&e)
        })
    }

    fn refuse_if_owner_drives(&self) -> Result<(), VsError> {
        if self.owner_is_driving() {
            Err(VsError::new(
                "taken_over",
                "You are driving the virtual screen, so Psyche is paused.",
            ))
        } else {
            Ok(())
        }
    }

    // ---- stopping ----

    /// Ends the Task's use of the screen. With `close_apps` each window is asked to close; an app
    /// that keeps its window (a "Save changes?" dialog) is not forced and the screen stays up.
    pub fn stop(&self, close_apps: bool, force: bool) -> Result<StopOutcome, VsError> {
        let Some(display) = lock(&self.inner).display.clone() else {
            return Ok(StopOutcome {
                stopped: true,
                unsaved: Vec::new(),
            });
        };
        self.touch();
        // Nothing the owner held may stay down, whether the screen stops or stays for a dialog.
        if let Err(e) = display.release_input() {
            crate::log(&format!("vscreen: release on stop: {e}"));
        }
        lock(&self.inner).owner_input_at = None;
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
                return Ok(StopOutcome {
                    stopped: false,
                    unsaved,
                });
            }
        }
        let mut inner = lock(&self.inner);
        self.teardown_locked(&mut inner);
        crate::log("vscreen: stopped");
        Ok(StopOutcome {
            stopped: true,
            unsaved: Vec::new(),
        })
    }

    /// Clears what a crashed helper left: its `psyche-vs-<pid>-*` scopes and `vs-<pid>-*` session
    /// dirs (and, without a runtime dir, its `psyche-vscreen-<pid>-*` temp dir), for every pid
    /// that is no longer running. A live helper's are left alone.
    pub fn sweep_leftovers(&self) {
        // Without our own tag (no /proc) nothing can be judged safely.
        let Some(me) = super::sweep::own_tag() else {
            return;
        };
        let me = &me;
        let alive = super::sweep::tag_alive;
        let scopes = self.deps.runner.list_scopes();
        for unit in super::sweep::stale(
            scopes.iter().map(String::as_str),
            |n| super::sweep::tag_of(n, "psyche-vs-"),
            me,
            &alive,
        ) {
            crate::log(&format!("vscreen: stopping leftover {unit}"));
            self.deps.runner.stop(unit.trim_end_matches(".scope"));
        }
        if let Ok(base) = super::xauth::runtime_dir(self.config.xdg_runtime_dir.as_deref()) {
            super::sweep::sweep_dirs(&base, "vs-", me, &alive);
            super::sweep::sweep_files(&base, "xauth-", me, &alive);
        }
        if self.config.xdg_runtime_dir.is_none() {
            // The sweep made a fallback dir to look in; nothing runs, so it goes again.
            super::xauth::release_private_temp_dir();
        }
        if self.config.xdg_runtime_dir.is_none() {
            super::sweep::sweep_dirs(&std::env::temp_dir(), "psyche-vscreen-", me, &alive);
        }
    }

    /// Stops everything now (the helper is exiting).
    pub fn shutdown(&self) {
        let mut inner = lock(&self.inner);
        self.teardown_locked(&mut inner);
    }
}

/// Processes that put up a splash or start window before the app's real one.
pub const SPLASH_PROCESSES: &[&str] = &["oosplash"];

/// Whether a newly mapped window is the app's own: an ordinary window or a dialog, not a splash
/// screen, a popup, a dock or a desktop, and not one shown by a splash process (LibreOffice's
/// `oosplash` maps its window before `soffice.bin` opens the document).
pub fn is_main_window(w: &WindowRecord, comm: &str) -> bool {
    matches!(w.kind, WindowKind::Normal | WindowKind::Dialog)
        && !SPLASH_PROCESSES.contains(&comm.trim())
}

/// The first 4 KiB of a launcher, to see whether a script hands off to `snap`.
fn script_head(exe: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::with_capacity(4096);
    std::fs::File::open(exe)
        .ok()?
        .take(4096)
        .read_to_end(&mut head)
        .ok()?;
    Some(head)
}

/// Runs one input batch. An ordinary batch stops at the first event that fails. A release batch
/// (the take-over ended or the pane lost focus) skips the events that fail, an unmappable key
/// such as `Unidentified`, `Dead` or `Process` among them, and always ends with `release`: one bad
/// key must not leave Ctrl held for the agent. Returns how many events were skipped.
pub fn run_input_batch(
    events: &[InputEvent],
    release_after: bool,
    mut apply: impl FnMut(&InputEvent) -> Result<(), String>,
    release: impl FnOnce() -> Result<(), String>,
) -> Result<usize, String> {
    let mut skipped = 0;
    for event in events {
        if let Err(e) = apply(event) {
            if !release_after {
                return Err(e);
            }
            skipped += 1;
        }
    }
    if release_after {
        release()?;
    }
    Ok(skipped)
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
            m.teardown_locked(&mut inner);
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
            let has_window = windows.iter().any(|w| {
                w.pid == Some(app.root_pid)
                    || w.pid.is_some_and(|p| {
                        m.deps
                            .procs
                            .cgroup_text(p)
                            .contains(&format!("{}.scope", app.unit))
                    })
            });
            let _ = (&snapshot, idx);
            if exited && !has_window {
                m.deps.runner.stop(&app.unit);
                continue;
            }
            keep.push(app);
        }
        inner.apps = keep;
        if inner.apps.is_empty() && inner.last_activity.elapsed() >= m.config.idle_stop {
            m.teardown_locked(&mut inner);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn key(k: &str) -> InputEvent {
        InputEvent::KeyUp(k.into())
    }

    /// Fails for keys the helper cannot map, like `Input::key` does.
    fn apply_log(log: &mut Vec<String>) -> impl FnMut(&InputEvent) -> Result<(), String> + '_ {
        move |e| match e {
            InputEvent::KeyUp(k) if matches!(k.as_str(), "Unidentified" | "Dead" | "Process") => {
                Err(format!("unknown key {k}"))
            }
            InputEvent::KeyUp(k) => {
                log.push(format!("up {k}"));
                Ok(())
            }
            _ => Ok(()),
        }
    }

    #[test]
    fn a_release_batch_skips_unmappable_keys_and_always_releases() {
        let mut log = Vec::new();
        let mut released = false;
        let events = [
            key("Shift"),
            key("Unidentified"),
            key("Dead"),
            key("Control"),
            key("Process"),
        ];
        let skipped = run_input_batch(&events, true, apply_log(&mut log), || {
            released = true;
            Ok(())
        })
        .unwrap();
        assert_eq!(skipped, 3);
        assert!(released, "release ran despite the bad keys");
        assert_eq!(
            log,
            ["up Shift", "up Control"],
            "the good keys still went through"
        );
        // A release batch made only of bad keys still releases.
        let mut released = false;
        let mut log = Vec::new();
        assert_eq!(
            run_input_batch(&[key("Unidentified")], true, apply_log(&mut log), || {
                released = true;
                Ok(())
            }),
            Ok(1)
        );
        assert!(released);
    }

    #[test]
    fn an_ordinary_batch_stops_at_the_first_failure_and_releases_nothing() {
        let mut log = Vec::new();
        let mut released = false;
        let r = run_input_batch(
            &[key("a"), key("Dead"), key("b")],
            false,
            apply_log(&mut log),
            || {
                released = true;
                Ok(())
            },
        );
        assert_eq!(r, Err("unknown key Dead".to_string()));
        assert_eq!(log, ["up a"]);
        assert!(!released);
    }

    #[test]
    fn a_failing_release_is_reported() {
        let mut log = Vec::new();
        assert_eq!(
            run_input_batch(&[], true, apply_log(&mut log), || Err("x gone".into())),
            Err("x gone".to_string())
        );
    }

    fn win(kind: WindowKind) -> WindowRecord {
        WindowRecord {
            id: 1,
            title: Some("LibreOffice".into()),
            pid: Some(7),
            kind,
            transient_for: None,
            rect: super::super::wm::Rect {
                x: 0,
                y: 0,
                w: 100,
                h: 100,
            },
            map_serial: 1,
        }
    }

    #[test]
    fn launches_wait_past_splash_windows() {
        // The app's own windows.
        assert!(is_main_window(&win(WindowKind::Normal), "soffice.bin"));
        assert!(is_main_window(&win(WindowKind::Normal), ""));
        assert!(is_main_window(&win(WindowKind::Dialog), "gnome-text-edit"));
        // Splash and start windows, and things that are not windows of the app.
        assert!(!is_main_window(&win(WindowKind::Normal), "oosplash"));
        assert!(!is_main_window(&win(WindowKind::Normal), "oosplash\n"));
        for kind in [
            WindowKind::Splash,
            WindowKind::Popup,
            WindowKind::Dock,
            WindowKind::Desktop,
        ] {
            assert!(!is_main_window(&win(kind), "soffice.bin"), "{kind:?}");
        }
    }
}
