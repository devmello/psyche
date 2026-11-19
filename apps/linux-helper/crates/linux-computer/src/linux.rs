//! The Linux desktop: AT-SPI for structure ([`crate::a11y`]) plus one input-and-pixels path
//! chosen from the session: X11 (XTest + MIT-SHM, [`crate::x11`]), or a remote-desktop path on
//! Wayland (the portal's RemoteDesktop + ScreenCast session, or the wlroots protocols; see
//! [`RemotePath`]). Everything above this file is platform-neutral.

use crate::a11y::{A11y, Acc, Tree};
use crate::app_id::{self, DesktopIndex};
use crate::backend::{ActError, AppInfo, Backend, Described, ElementData, Frame, Hit, WinInfo};
use crate::error::{code, CapError, CapResult};
use crate::keychord::{KeyChord, Mods};
use crate::roles;
use crate::snapshot::{ElementInfo, Rect, TreeSource};
use crate::tiers::StopSignal;
use crate::x11::X11;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Where input goes and pixels come from on Wayland.
pub trait RemotePath: Send + Sync {
    /// `portal` or `wlroots`.
    fn kind(&self) -> &'static str;
    /// Makes the path usable: opens the portal session (the owner's one dialog) or connects to
    /// the compositor's protocols. Cheap when already open.
    fn ready(&self) -> CapResult<()>;
    fn click(
        &self,
        x: f64,
        y: f64,
        count: u32,
        right: bool,
        mods: &[u32],
        stop: &StopSignal,
    ) -> CapResult<()>;
    fn type_text(
        &self,
        text: &str,
        stop: &StopSignal,
        before_chunk: &mut dyn FnMut() -> CapResult<()>,
    ) -> CapResult<()>;
    fn key(&self, chord: &KeyChord, stop: &StopSignal) -> CapResult<()>;
    fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()>;
    fn drag(&self, from: (f64, f64), to: (f64, f64), stop: &StopSignal) -> CapResult<()>;
    fn capture(&self, display: Option<usize>) -> CapResult<Frame>;
    fn displays(&self) -> Vec<Rect>;
    /// Called when the compositor ends the session (the owner pressed Stop in the shell's
    /// sharing indicator): the run is cancelled.
    fn on_closed(&self, f: Box<dyn Fn() + Send + Sync>);
    /// Whether that Stop works now: a session is open and its end is being watched. A path that
    /// cannot say has no kill switch, and the engine refuses to act through it.
    fn stop_ready(&self) -> bool {
        false
    }
    /// Closes the session and the capture stream (between sessions the path costs nothing).
    fn close(&self);
    /// Window geometry the compositor can give (KWin scripting on KDE), else `None`.
    fn windows(&self) -> Option<Vec<WinInfo>> {
        None
    }
}

/// What kind of session this is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    X11,
    Wayland,
    Headless,
}

impl SessionKind {
    pub fn detect(env: &dyn Fn(&str) -> Option<String>) -> SessionKind {
        if env("WAYLAND_DISPLAY").is_some() {
            SessionKind::Wayland
        } else if env("DISPLAY").is_some() {
            SessionKind::X11
        } else {
            SessionKind::Headless
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            SessionKind::X11 => "x11",
            SessionKind::Wayland => "wayland",
            SessionKind::Headless => "headless",
        }
    }
}

pub enum Path {
    X11(Arc<X11>),
    Remote(Box<dyn RemotePath>),
}

pub struct LinuxBackend {
    pub a11y: Arc<A11y>,
    pub path: Path,
    index: Mutex<Option<DesktopIndex>>,
    env: crate::a11y::EnvFn,
}

impl LinuxBackend {
    pub fn new(a11y: Arc<A11y>, path: Path) -> LinuxBackend {
        if let Path::X11(x) = &path {
            let x = x.clone();
            a11y.set_origin_source(Box::new(move |pid, title| x.window_origin(pid, title)));
        }
        LinuxBackend {
            a11y,
            path,
            index: Mutex::new(None),
            env: Box::new(|k| std::env::var(k).ok().filter(|v| !v.is_empty())),
        }
    }

    fn x11(&self) -> Option<&Arc<X11>> {
        match &self.path {
            Path::X11(x) => Some(x),
            _ => None,
        }
    }

    fn all_windows(&self) -> Vec<WinInfo> {
        match &self.path {
            Path::X11(x) => x.windows(),
            Path::Remote(r) => r.windows().unwrap_or_default(),
        }
    }

    fn desktop_index(&self) -> DesktopIndex {
        let mut g = self.index.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(|| DesktopIndex::load(&DesktopIndex::default_dirs(&|k| (self.env)(k))))
            .clone()
    }

    /// The desktop entry `apps.open` may launch for `id` and the file to hand to `gio launch`:
    /// the entry must be indexed (else `not_found/app_not_installed`), and the file XDG lookup
    /// picks for it must be trusted (`policy_denied/untrusted_desktop_entry`, see
    /// [`crate::trust`]). Notes `Terminal=true` from that very file, so the cap applies even when
    /// the index parsed another one.
    fn trusted_desktop_file(
        &self,
        id: &str,
    ) -> CapResult<(app_id::DesktopEntry, std::path::PathBuf)> {
        let index = self.desktop_index();
        let entry = index.get(id).cloned().ok_or_else(|| {
            CapError::new(
                code::NOT_FOUND,
                "app_not_installed",
                format!(
                    "{id} is not an installed app. Use apps.list or the app's desktop file id."
                ),
            )
        })?;
        let dirs = DesktopIndex::default_dirs(&|k| (self.env)(k));
        // SAFETY: geteuid has no preconditions and cannot fail.
        let own_uid = unsafe { libc::geteuid() };
        let fs = crate::trust::RealFs;
        let file = crate::trust::launchable_desktop_file(&fs, &dirs, &entry.id, own_uid)?;
        if let Some(bytes) = crate::trust::FsView::read(&fs, &file) {
            if app_id::desktop_entry_runs_in_terminal(&String::from_utf8_lossy(&bytes)) {
                app_id::note_runs_in_terminal(&entry.id);
            }
        }
        Ok((entry, file))
    }

    /// For Settings (`portal.status`'s `killSwitch`): X11, the last Escape grab worked (or none
    /// was tried yet); a portal session, its `Closed` is watched while it is open.
    pub fn kill_switch_status(&self) -> bool {
        match &self.path {
            Path::X11(x) => !x.escape_grab_failed(),
            Path::Remote(r) => r.stop_ready(),
        }
    }

    fn active_pid(&self) -> Option<u32> {
        self.x11()
            .and_then(|x| x.windows().into_iter().find(|w| w.focused).map(|w| w.pid))
    }

    fn mods_syms(m: Mods) -> Vec<u32> {
        m.keysyms()
    }
}

impl TreeSource for LinuxBackend {
    type Element = Acc;
    fn info(&self, e: &Acc) -> Option<ElementInfo> {
        // Elements that are not on screen are not part of the picture (a closed menu's items
        // are read through `data`, by the menu walker).
        let t = Tree {
            a11y: &self.a11y,
            with_frame: self.window_geometry_known(),
        };
        let info = t.info(e)?;
        Some(info)
    }
    fn children(&self, e: &Acc) -> Vec<Acc> {
        self.a11y.children_of(e)
    }
    fn actions(&self, e: &Acc) -> Vec<String> {
        Tree {
            a11y: &self.a11y,
            with_frame: self.window_geometry_known(),
        }
        .actions(e)
    }
    fn is_value_settable(&self, e: &Acc) -> bool {
        Tree {
            a11y: &self.a11y,
            with_frame: self.window_geometry_known(),
        }
        .is_value_settable(e)
    }
    fn should_stop(&self) -> bool {
        Tree {
            a11y: &self.a11y,
            with_frame: false,
        }
        .should_stop()
    }
}

impl Backend for LinuxBackend {
    fn check_desktop(&self) -> CapResult<()> {
        match &self.path {
            Path::X11(x) => {
                x.touch();
                Ok(())
            }
            Path::Remote(r) => r.ready(),
        }
    }

    fn window_geometry_known(&self) -> bool {
        match &self.path {
            Path::X11(_) => true,
            Path::Remote(r) => r.windows().is_some(),
        }
    }

    fn apps(&self) -> Vec<AppInfo> {
        self.a11y.apps(self.active_pid())
    }

    fn windows(&self) -> Vec<WinInfo> {
        match &self.path {
            Path::X11(_) => self.all_windows(),
            Path::Remote(r) => r.windows().unwrap_or_else(|| {
                // No geometry: the accessibility tree still says which windows exist and which
                // one is active, so redaction can see that protected windows are open.
                let mut out = Vec::new();
                for app in self.a11y.apps(None) {
                    for (i, w) in self.a11y.windows_of(app.pid).iter().enumerate() {
                        let st = self.a11y.states_of(w);
                        out.push(WinInfo {
                            id: (u64::from(app.pid) << 16) | i as u64,
                            pid: app.pid,
                            title: self.a11y.name_of(w).unwrap_or_default(),
                            bounds: None,
                            layer: 0,
                            focused: crate::a11y::state::has(&st, crate::a11y::state::ACTIVE),
                            minimized: crate::a11y::state::has(&st, crate::a11y::state::ICONIFIED),
                        });
                    }
                }
                out
            }),
        }
    }

    fn keyboard_focus_pid(&self) -> Option<u32> {
        match &self.path {
            Path::X11(x) => x.focus_pid(),
            Path::Remote(_) => self
                .a11y
                .focused(None)
                .and_then(|a| self.a11y.pid_of_bus(&a.bus)),
        }
    }

    fn keyboard_free(&self) -> CapResult<bool> {
        match &self.path {
            Path::X11(x) => x.keyboard_free(),
            // The compositor routes input; a client cannot hold the keyboard. The focus checks
            // still apply.
            Path::Remote(_) => Ok(true),
        }
    }

    fn activate(
        &self,
        app: &AppInfo,
        window: Option<usize>,
        _stop: &StopSignal,
    ) -> CapResult<bool> {
        match &self.path {
            Path::X11(x) => x.activate(app.pid, window),
            Path::Remote(_) => {
                // A Wayland client cannot raise another app's window. Ask the app for focus
                // through its accessible window and report that it was only requested.
                let wins = self.a11y.windows_of(app.pid);
                let w = wins.get(window.unwrap_or(0)).ok_or_else(|| {
                    CapError::new(
                        code::NOT_FOUND,
                        "no_window",
                        "The app has no window to bring forward",
                    )
                })?;
                let _ = self.a11y.grab_focus(w);
                std::thread::sleep(Duration::from_millis(120));
                // The focus is read fresh (a cached focus whose window is no longer active is
                // dropped, see `A11y::focused`). Unknown is not "moved": portal input goes to the
                // real focus, which may be an app that reports nothing to AT-SPI.
                match self
                    .a11y
                    .focused(None)
                    .and_then(|a| self.a11y.pid_of_bus(&a.bus))
                {
                    Some(p) if p == app.pid => Ok(true),
                    None => Err(CapError::new(
                        code::CONFLICT,
                        "focus_unknown",
                        format!("This desktop cannot say which app has keyboard focus, so Psyche does not act in {}. Ask the owner to click its window, then retry.", app.name),
                    )
                    .detail("app", app.id.as_str())),
                    Some(_) => Err(CapError::new(
                        code::CONFLICT,
                        "focus_denied",
                        format!("This desktop does not let Psyche switch to {}. Ask the owner to click its window, then retry.", app.name),
                    )
                    .detail("app", app.id.as_str())
                    .retryable()),
                }
            }
        }
    }

    fn check_launch(&self, id: &str) -> CapResult<()> {
        self.trusted_desktop_file(id).map(|_| ())
    }

    fn launch(&self, id: &str, url: Option<&str>) -> CapResult<Value> {
        // Checked again here: the agent may have written a shadowing entry while a card waited.
        let (entry, file) = self.trusted_desktop_file(id)?;
        // Launch through GLib, which implements the Desktop Entry rules (field codes, DBus
        // activation, Terminal=true) and puts the app in its own scope. The accessibility
        // switches make Qt, GTK and Firefox export their trees (design §6.1). `file` is the
        // trusted entry XDG lookup picks; nothing on its path is writable by this account, so it
        // is what gio reads.
        // gio from the system dirs, and the system dirs as PATH: GLib resolves a bare `Exec=`
        // command (and the terminal) through PATH, which usually starts with ~/.local/bin.
        // SAFETY: geteuid has no preconditions and cannot fail.
        let own_uid = unsafe { libc::geteuid() };
        let fs = crate::trust::RealFs;
        let gio = crate::trust::trusted_program(&fs, "gio", own_uid).ok_or_else(|| {
            CapError::unavailable(
                "launch_failed",
                "gio (GLib) is not installed system-wide, so Psyche cannot open apps",
            )
        })?;
        let mut cmd = std::process::Command::new(gio);
        cmd.arg("launch").arg(&file);
        cmd.env("PATH", crate::trust::trusted_search_path(&fs, own_uid));
        if let Some(u) = url {
            cmd.arg(u);
        }
        cmd.env("ACCESSIBILITY_ENABLED", "1")
            .env("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1")
            .env("GNOME_ACCESSIBILITY", "1");
        let status = cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| {
                CapError::unavailable("launch_failed", format!("Cannot start gio: {e}"))
            })?;
        if !status.success() {
            return Err(CapError::unavailable(
                "launch_failed",
                format!(
                    "{} did not start",
                    entry.name.clone().unwrap_or_else(|| id.to_string())
                ),
            ));
        }
        // Wait briefly for the app to show up on the accessibility bus.
        for _ in 0..40 {
            if let Some(a) = self.apps().into_iter().find(|a| a.id == entry.id) {
                return Ok(json!({"bundleId": a.id, "name": a.name, "pid": a.pid}));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(json!({"bundleId": entry.id, "name": entry.name, "pid": Value::Null, "pending": true}))
    }

    fn begin_walk(&self, budget: Duration) {
        self.a11y.begin_walk(budget);
    }

    fn window_elements(&self, app: &AppInfo) -> Vec<Acc> {
        self.a11y.windows_of(app.pid)
    }

    fn app_element(&self, app: &AppInfo) -> Acc {
        self.a11y
            .app_root_for_pid(app.pid)
            .unwrap_or_else(|| Acc::new("", "/org/a11y/atspi/null"))
    }

    fn focused_element(&self, app: Option<&AppInfo>) -> Option<Acc> {
        self.a11y.focused(app.map(|a| a.pid))
    }

    fn data(&self, e: &Acc) -> Option<ElementData> {
        self.a11y.read(e, self.window_geometry_known(), 160)
    }

    fn set_focus(&self, e: &Acc) -> Result<(), ActError> {
        self.a11y.grab_focus(e)
    }

    fn perform(&self, e: &Acc, ax_action: &str) -> Result<(), ActError> {
        self.a11y.perform(e, ax_action)
    }

    fn set_value(&self, e: &Acc, value: &str) -> Result<(), ActError> {
        self.a11y.set_value(e, value)
    }

    fn current_value(&self, e: &Acc) -> Option<String> {
        self.a11y.current_value(e)
    }

    fn full_value(&self, e: &Acc, max: usize) -> Option<String> {
        self.a11y
            .current_value(e)
            .map(|v| v.chars().take(max).collect())
    }

    fn select(&self, e: &Acc) -> Result<(), ActError> {
        self.a11y.select(e)
    }

    fn is_selected(&self, e: &Acc) -> Option<bool> {
        self.a11y.is_selected(e)
    }

    fn frame(&self, e: &Acc) -> Option<Rect> {
        if !self.window_geometry_known() {
            return None;
        }
        self.a11y.read(e, true, 0).and_then(|d| d.info.frame)
    }

    fn hit_test(&self, x: f64, y: f64) -> Option<Hit> {
        let win = self
            .all_windows()
            .into_iter()
            .find(|w| !w.minimized && w.bounds.is_some_and(|b| b.contains(x, y)))?;
        let windows = self.a11y.windows_of(win.pid);
        // The accessible window that matches the X window: by title, else the active one.
        let w = windows
            .iter()
            .find(|w| self.a11y.name_of(w).as_deref().unwrap_or("") == win.title)
            .or_else(|| windows.first())?;
        self.a11y.hit(w, x, y).or(Some(Hit {
            pid: win.pid,
            window: Some(win.title.clone()).filter(|t| !t.is_empty()),
            ..Hit::default()
        }))
    }

    fn describe(&self, e: &Acc) -> Described {
        self.a11y.describe(e)
    }

    fn focused_is_secure(&self, app: Option<&AppInfo>) -> bool {
        match self.a11y.focused(app.map(|a| a.pid)) {
            Some(a) => self.a11y.is_password(&a),
            // No focused element found: nothing says it is a password field. Keyboard input does
            // not rely on this: the engine refuses it while the focused app is unknown
            // (`focus_unknown`), and checks the app owns the focus before every chunk.
            None => false,
        }
    }

    fn selected_text(&self, app: &AppInfo) -> Option<String> {
        let f = self.a11y.focused(Some(app.pid))?;
        if self.a11y.is_password(&f) {
            return None;
        }
        self.a11y.selected_text(&f)
    }

    fn click(
        &self,
        x: f64,
        y: f64,
        count: u32,
        right: bool,
        mods: Mods,
        stop: &StopSignal,
    ) -> CapResult<()> {
        let m = Self::mods_syms(mods);
        match &self.path {
            Path::X11(p) => p.click(x, y, count, right, &m, stop),
            Path::Remote(r) => r.click(x, y, count, right, &m, stop),
        }
    }

    fn type_text(
        &self,
        text: &str,
        stop: &StopSignal,
        before_chunk: &mut dyn FnMut() -> CapResult<()>,
    ) -> CapResult<()> {
        // A Tab or Return can move focus into a password field mid-chunk: re-check after each.
        let mut pending = String::new();
        let flush = |s: &mut String, before: &mut dyn FnMut() -> CapResult<()>| -> CapResult<()> {
            if s.is_empty() {
                return Ok(());
            }
            let chunk = std::mem::take(s);
            match &self.path {
                Path::X11(p) => p.type_text(&chunk, stop, before),
                Path::Remote(r) => r.type_text(&chunk, stop, before),
            }
        };
        for ch in text.chars() {
            pending.push(ch);
            if matches!(ch, '\n' | '\r' | '\t') {
                flush(&mut pending, before_chunk)?;
            }
        }
        flush(&mut pending, before_chunk)
    }

    fn key(&self, chord: &KeyChord, stop: &StopSignal) -> CapResult<()> {
        match &self.path {
            Path::X11(p) => p.key(chord, stop),
            Path::Remote(r) => r.key(chord, stop),
        }
    }

    fn scroll(&self, x: f64, y: f64, dx: i32, dy: i32, stop: &StopSignal) -> CapResult<()> {
        match &self.path {
            Path::X11(p) => p.scroll(x, y, dx, dy, stop),
            Path::Remote(r) => r.scroll(x, y, dx, dy, stop),
        }
    }

    fn drag(&self, from: (f64, f64), to: (f64, f64), stop: &StopSignal) -> CapResult<()> {
        match &self.path {
            Path::X11(p) => p.drag(from, to, stop),
            Path::Remote(r) => r.drag(from, to, stop),
        }
    }

    fn capture(&self, display: Option<usize>) -> CapResult<Frame> {
        match &self.path {
            Path::X11(p) => p.capture(),
            Path::Remote(r) => r.capture(display),
        }
    }

    fn displays(&self) -> Vec<Rect> {
        match &self.path {
            Path::X11(p) => p.displays(),
            Path::Remote(r) => r.displays(),
        }
    }

    fn kill_switch_ready(&self) -> bool {
        match &self.path {
            // `check_desktop` just touched the grab: it is held, or another client holds Escape.
            Path::X11(x) => x.escape_grabbed(),
            Path::Remote(r) => r.stop_ready(),
        }
    }

    fn start_stop_source(&self, on_stop: Box<dyn Fn() + Send + Sync>) {
        match &self.path {
            Path::X11(p) => p.set_on_stop(on_stop),
            Path::Remote(r) => r.on_closed(on_stop),
        }
    }

    fn session_idle(&self) {
        match &self.path {
            Path::X11(p) => p.ungrab(),
            Path::Remote(r) => r.close(),
        }
    }
}

/// `role` of an accessible by its Mac name (a convenience for the helper's `apps.list`).
pub fn ax_name(role: u32) -> &'static str {
    roles::map_role(&roles::AtspiFacts {
        role,
        ..Default::default()
    })
    .role
}
