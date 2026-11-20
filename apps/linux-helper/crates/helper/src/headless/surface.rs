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

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use psyche_linux_computer::a11y::A11y;
use psyche_linux_computer::backend::AppInfo;
use psyche_linux_computer::engine::Engine;
use psyche_linux_computer::error::{code, CapError, CapResult};
use psyche_linux_computer::linux::{LinuxBackend, Path, SurfaceHooks};
use psyche_linux_computer::trust::SettingsSource;
use psyche_linux_computer::x11::X11;

use super::deny::DenyPolicy;
use super::focus::{decide, to_error, Scopes};
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

struct ManagerScopes(Arc<VscreenManager>);

impl Scopes for ManagerScopes {
    fn in_scope(&self, app_id: &str, pid: u32) -> bool {
        self.0.pid_in_app_scope(app_id, pid)
    }
    fn app_of(&self, pid: u32) -> Option<String> {
        self.0.app_of_pid(pid)
    }
}

pub struct VirtualHooks {
    manager: Arc<VscreenManager>,
    deny: DenyPolicy,
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

    fn launch(&self, id: &str, url: Option<&str>) -> CapResult<()> {
        if url.is_some() {
            return Err(CapError::new(
                code::NOT_IMPLEMENTED,
                "not_supported",
                "Opening a document or link is not available on the virtual screen yet",
            ));
        }
        self.manager.open_app(id).map(|_| ()).map_err(cap_error)
    }

    fn focus_pid(&self) -> Option<u32> {
        self.manager
            .display_handle()?
            .focused_window()
            .and_then(|w| w.pid)
    }

    fn check_input_target(&self, app: &AppInfo) -> CapResult<bool> {
        let deny = self.deny.current();
        decide(
            &app.id,
            self.focus_pid(),
            &ManagerScopes(Arc::clone(&self.manager)),
            &deny,
        )
        .map(|()| true)
        .map_err(|r| to_error(&r, app))
    }
}

pub struct HeadlessSurface {
    manager: Arc<VscreenManager>,
    hooks: Arc<VirtualHooks>,
    /// The engine and the display (its Xvfb pid) it was built for.
    engine: Mutex<Option<(u32, Arc<Engine<LinuxBackend>>)>>,
}

impl HeadlessSurface {
    pub fn new(manager: Arc<VscreenManager>) -> Arc<Self> {
        let hooks = Arc::new(VirtualHooks {
            manager: Arc::clone(&manager),
            deny: DenyPolicy::from_env(&ProcessEnv),
        });
        Arc::new(Self {
            manager,
            hooks,
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
        let a11y = Arc::new(connect_a11y(&bus)?);
        let backend = Arc::new(
            LinuxBackend::new(a11y, Path::X11(x11))
                .with_hooks(Arc::clone(&self.hooks) as Arc<dyn SurfaceHooks>),
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

/// The accessibility bus starts a moment after the session bus does.
fn connect_a11y(session_bus: &str) -> CapResult<A11y> {
    let start = Instant::now();
    loop {
        match A11y::connect_session_address(session_bus) {
            Ok(a) => return Ok(a),
            Err(e) if start.elapsed() >= A11Y_WAIT => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}
