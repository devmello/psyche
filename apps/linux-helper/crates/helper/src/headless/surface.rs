//! The computer-use engine (L5) on the virtual display (L6): `apps.open`, `apps.list`,
//! `computer.snapshot|act|type|key|screenshot…` on a box that has no other screen.
//!
//! The engine is the one the desktop path uses (`LinuxBackend` over AT-SPI and X11), with
//! three differences, all in [`SurfaceHooks`]:
//! - **Launch.** `apps.open` goes through `VscreenManager::open_app` (a transient scope in
//!   `psyche-vscreen.slice`, the X11 and accessibility environment, the single-instance
//!   recipes, the window-in-scope check), after the same desktop-entry trust checks the
//!   desktop path makes (`trust.rs`), and after the deny list.
//! - **Focus.** Before each typed batch the focused window's X-Resource pid must be in the
//!   target app's scope (`focus.rs`).
//! - **Where it connects.** X11 to the private Xvfb with its cookie held in memory, and AT-SPI
//!   on the private session bus's accessibility bus: never `$DISPLAY`, never the owner's bus.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use psyche_linux_computer::a11y::A11y;
use psyche_linux_computer::backend::{AppInfo, WinInfo};
use psyche_linux_computer::engine::Engine;
use psyche_linux_computer::error::{code, CapError, CapResult};
use psyche_linux_computer::linux::{LinuxBackend, Path, SurfaceHooks};
use psyche_linux_computer::snapshot::Rect;
use psyche_linux_computer::trust::SettingsSource;
use psyche_linux_computer::x11::X11;

use super::deny::DenyPolicy;
use super::focus::{at_send, decide, to_error, Scopes};
use crate::paths::{psyche_home, ProcessEnv};
use crate::vscreen::manager::VsError;
use crate::vscreen::VscreenManager;

/// How long the accessibility bus gets to appear after the display starts.
const A11Y_WAIT: Duration = Duration::from_secs(8);

pub fn cap_error(e: VsError) -> CapError {
    let code = match e.reason {
        "already_open_on_your_screen" | "opened_elsewhere" | "taken_over" => code::CONFLICT,
        "app_not_found" => code::NOT_FOUND,
        _ => code::UNAVAILABLE,
    };
    CapError::new(code, e.reason, e.message)
}

struct ManagerScopes {
    manager: Arc<VscreenManager>,
    a11y: Option<Arc<A11y>>,
}

impl Scopes for ManagerScopes {
    fn in_scope(&self, app_id: &str, pid: u32) -> bool {
        self.manager.pid_in_app_scope(app_id, pid)
    }
    fn app_of(&self, pid: u32) -> Option<String> {
        self.manager.app_of_pid(pid)
    }
    fn own_id(&self, pid: u32) -> Option<String> {
        self.a11y.as_ref().and_then(|a| a.app_id_for_pid(pid))
    }
}

pub struct VirtualHooks {
    manager: Arc<VscreenManager>,
    deny: DenyPolicy,
    a11y: OnceLock<Arc<A11y>>,
    x11: OnceLock<Arc<X11>>,
    /// The app the last input check was made for: the guard that runs with the server grabbed
    /// judges the focus against it.
    target: Mutex<Option<AppInfo>>,
}

impl VirtualHooks {
    fn scopes(&self) -> ManagerScopes {
        ManagerScopes {
            manager: Arc::clone(&self.manager),
            a11y: self.a11y.get().cloned(),
        }
    }

    /// The last line, run with the X server grabbed right before keys are sent (`X11::guarded`):
    /// the focused client must be the app the last check was made for, exactly, and still pass
    /// the scope and deny checks. No D-Bus here: the apps cannot answer while the server is held.
    fn tap_guard(&self, focus_pid: Option<u32>) -> CapResult<()> {
        let Some(app) = self
            .target
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        else {
            return Err(CapError::new(
                code::CONFLICT,
                "focus_unknown",
                "No app is the target of this input",
            ));
        };
        let deny = self.deny.current();
        at_send(&app, focus_pid, &self.scopes(), &deny).map_err(|r| to_error(&r, &app))
    }
}

impl SurfaceHooks for VirtualHooks {
    fn check_launch(&self, id: &str) -> CapResult<()> {
        if self.deny.is_denied(id) {
            return Err(CapError::new(
                code::POLICY_DENIED,
                "app_denied",
                "This computer's owner has put that app out of Psyche's reach",
            )
            .detail("app", id));
        }
        Ok(())
    }

    fn launch(&self, desktop_file: &std::path::Path, url: Option<&str>) -> CapResult<()> {
        if url.is_some() {
            return Err(CapError::new(
                code::NOT_IMPLEMENTED,
                "not_supported",
                "Opening a document or link is not available on the virtual screen yet",
            ));
        }
        self.manager
            .open_trusted_file(desktop_file)
            .map(|_| ())
            .map_err(cap_error)
    }

    fn focus_pid(&self) -> Option<u32> {
        self.x11.get()?.focused_client_pid()
    }

    fn check_input_target(&self, app: &AppInfo) -> CapResult<()> {
        *self.target.lock().unwrap_or_else(|e| e.into_inner()) = Some(app.clone());
        let deny = self.deny.current();
        decide(&app.id, self.focus_pid(), &self.scopes(), &deny).map_err(|r| to_error(&r, app))
    }

    /// The window manager's own table: windows it manages, with the pid the server recorded.
    fn windows(&self) -> Option<Vec<WinInfo>> {
        let display = self.manager.display_handle()?;
        Some(
            display
                .windows()
                .into_iter()
                .rev()
                .map(|w| WinInfo {
                    id: u64::from(w.id),
                    // 0 matches no app: a window the server could not attribute is nobody's.
                    pid: w.pid.unwrap_or(0),
                    title: w.title.unwrap_or_default(),
                    bounds: Some(Rect::new(
                        f64::from(w.rect.x),
                        f64::from(w.rect.y),
                        f64::from(w.rect.w),
                        f64::from(w.rect.h),
                    )),
                    layer: 0,
                    focused: false,
                    minimized: false,
                })
                .collect(),
        )
    }
}

pub struct HeadlessSurface {
    manager: Arc<VscreenManager>,
    /// The engine and the display (its Xvfb pid) it was built for.
    engine: Mutex<Option<(u32, Arc<Engine<LinuxBackend>>)>>,
}

impl HeadlessSurface {
    pub fn new(manager: Arc<VscreenManager>) -> Arc<Self> {
        Arc::new(Self {
            manager,
            engine: Mutex::new(None),
        })
    }

    /// The engine for the running display, starting the display (and its bus) when none is up.
    /// A new display (the old one stopped idle, or died) gets a new engine: the old one holds
    /// connections to a server that is gone.
    pub fn engine(&self) -> CapResult<Arc<Engine<LinuxBackend>>> {
        let display = self.manager.ensure_display(None).map_err(cap_error)?;
        let key = display.xvfb_pid();
        let mut guard = self.engine.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((k, e)) = guard.as_ref() {
            if *k == key {
                return Ok(Arc::clone(e));
            }
        }
        let (conn, screen) = display.connect_client().map_err(|e| {
            CapError::unavailable("display_failed", format!("Cannot reach the screen: {e}"))
        })?;
        let x11 = X11::from_connection(conn, screen, display.display.clone())?;
        let bus = self.manager.session_bus_address().ok_or_else(|| {
            CapError::unavailable(
                "no_a11y_bus",
                "The virtual screen has no session bus, so apps have no accessibility tree",
            )
        })?;
        let a11y = Arc::new(connect_a11y(&self.manager, &bus)?);
        // A new display gets new hooks state; the cells are set once per surface, so build the
        // hooks again when the display changes.
        let hooks = Arc::new(VirtualHooks {
            manager: Arc::clone(&self.manager),
            deny: DenyPolicy::from_env(&ProcessEnv),
            a11y: OnceLock::new(),
            x11: OnceLock::new(),
            target: Mutex::new(None),
        });
        let _ = hooks.a11y.set(Arc::clone(&a11y));
        let _ = hooks.x11.set(Arc::clone(&x11));
        // Weak: the X connection holds the guard and the hooks hold the connection.
        let weak = Arc::downgrade(&hooks);
        x11.set_tap_guard(Arc::new(move |pid| match weak.upgrade() {
            Some(h) => h.tap_guard(pid),
            None => Err(CapError::unavailable("display_failed", "The screen ended")),
        }));
        let backend = Arc::new(
            LinuxBackend::new(a11y, Path::X11(x11)).with_hooks(hooks as Arc<dyn SurfaceHooks>),
        );
        let env_get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        // SAFETY: geteuid has no preconditions and cannot fail.
        let own_uid = unsafe { libc::geteuid() };
        let settings = SettingsSource::choose(false, &env_get, &psyche_home(&ProcessEnv), own_uid);
        let engine = Engine::with_settings(backend, settings);
        *guard = Some((key, Arc::clone(&engine)));
        Ok(engine)
    }
}

/// The accessibility bus starts a moment after the session bus does. The address its owner
/// gives must lead into the screen's own session dir, and that owner must be the launcher
/// started for this screen: an app on the private bus could otherwise take the name `org.a11y.Bus`
/// and point the engine at the owner's accessibility bus.
fn connect_a11y(manager: &Arc<VscreenManager>, session_bus: &str) -> CapResult<A11y> {
    let accept = |address: &str, owner: Option<u32>| -> bool {
        let Some(dir) = manager.session_dir() else {
            return false;
        };
        address_in_dir(address, &dir) && owner.is_some() && owner == manager.a11y_launcher_pid()
    };
    let start = Instant::now();
    loop {
        match A11y::connect_session_address(session_bus, &accept) {
            Ok(a) => return Ok(a),
            Err(e) if start.elapsed() >= A11Y_WAIT => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Whether a D-Bus address is a unix socket inside `dir`.
pub fn address_in_dir(address: &str, dir: &std::path::Path) -> bool {
    let Some(rest) = address.strip_prefix("unix:path=") else {
        return false;
    };
    let path = rest.split(',').next().unwrap_or("");
    let p = std::path::Path::new(path);
    p.is_absolute()
        && p.starts_with(dir)
        && !p
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path as P;

    #[test]
    fn the_accessibility_address_must_lead_into_the_session_dir() {
        let dir = P::new("/run/user/1000/psyche/vs-abc");
        for ok in [
            "unix:path=/run/user/1000/psyche/vs-abc/at-spi/bus_90,guid=ff",
            "unix:path=/run/user/1000/psyche/vs-abc/at-spi/bus",
        ] {
            assert!(address_in_dir(ok, dir), "{ok}");
        }
        for bad in [
            // The owner's own accessibility bus.
            "unix:path=/run/user/1000/at-spi/bus_0",
            // A sibling that shares the prefix, a traversal, abstract and tcp addresses.
            "unix:path=/run/user/1000/psyche/vs-abcd/at-spi/bus",
            "unix:path=/run/user/1000/psyche/vs-abc/../../at-spi/bus_0",
            "unix:abstract=/tmp/dbus-x",
            "tcp:host=127.0.0.1,port=1",
            "",
        ] {
            assert!(!address_in_dir(bad, dir), "{bad}");
        }
    }
}
