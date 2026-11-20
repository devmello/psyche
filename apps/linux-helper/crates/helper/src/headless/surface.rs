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
use psyche_linux_computer::tiers::AppGate;
use psyche_linux_computer::trust::SettingsSource;
use psyche_linux_computer::x11::X11;

use super::focus::{blocked_by, decide_app, to_error, Denies, Identity, Scopes};
use crate::paths::{psyche_home, Env, ProcessEnv};
use crate::remote::config::config_dir;
use crate::remote::policy::PolicySource;
use crate::vscreen::manager::VsError;
use crate::vscreen::VscreenManager;

/// How long the accessibility bus gets to appear after the display starts.
const A11Y_WAIT: Duration = Duration::from_secs(8);

/// The machine ceiling (`policy.json`, `/etc` first), read again at every use.
pub fn policy_source() -> Arc<PolicySource> {
    let home = ProcessEnv
        .get("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"));
    Arc::new(PolicySource::standard(&config_dir(&ProcessEnv), home, None))
}

/// Whether the process is an app the ceiling puts out of reach (see [`blocked_by`]).
pub fn pid_denied(policy: &crate::remote::policy::Policy, scopes: &dyn Scopes, pid: u32) -> bool {
    blocked_by(policy, scopes, pid).is_some()
}

/// The ceiling's gate for the engine: asked of every authorization with the app's id and the
/// other ids it carries. `load` reads the policy afresh each time.
pub fn ceiling_gate(
    load: impl Fn() -> crate::remote::policy::Policy + Send + Sync + 'static,
) -> AppGate {
    Arc::new(move |id, also| {
        if load().permits(id, also) {
            Ok(())
        } else {
            Err(app_denied(id))
        }
    })
}

/// The pre-send check of the app the last input check was made for: the pid the focused client
/// must be, or the refusal. Same predicate as the gate.
pub fn send_allowed(policy: &crate::remote::policy::Policy, app: &AppInfo) -> CapResult<u32> {
    if policy.permits(&app.id, &app.also_ids) {
        Ok(app.pid)
    } else {
        Err(app_denied(&app.id))
    }
}

pub fn app_denied(id: &str) -> CapError {
    CapError::new(
        code::POLICY_DENIED,
        "app_denied",
        "This computer's owner has put that app out of Psyche's reach",
    )
    .detail("app", id)
}

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
    /// Read once per question: `/proc` and the desktop index are touched here and nowhere else.
    fn identity(&self, pid: u32) -> Identity {
        // The scope is read once and handed down: the holder and the facts agree.
        let holder = self.manager.app_of_pid(pid);
        let facts = self
            .a11y
            .as_ref()
            .map(|a| a.id_facts_for_pid(pid, holder.as_deref()))
            .unwrap_or_default();
        Identity { holder, facts }
    }
}

thread_local! {
    /// The app the last input check on **this thread** was made for. A call runs on one thread
    /// from its check to its send, so another call's check cannot refill it.
    static PREPARED: std::cell::RefCell<Option<AppInfo>> = const { std::cell::RefCell::new(None) };
}

pub struct VirtualHooks {
    manager: Arc<VscreenManager>,
    policy: Arc<PolicySource>,
    a11y: OnceLock<Arc<A11y>>,
    x11: OnceLock<Arc<X11>>,
}

impl VirtualHooks {
    fn scopes(&self) -> ManagerScopes {
        ManagerScopes {
            manager: Arc::clone(&self.manager),
            a11y: self.a11y.get().cloned(),
        }
    }

    /// Run before the X server is grabbed for a send (`X11::guarded`): everything slow is done
    /// here, and the pid the focused client must be is returned. The app is the one the last
    /// check (`check_input_target`) was made for, and is **consumed**: each send needs its own
    /// check, and a send with none is refused. Inside the grab only that pid is compared, so the
    /// grab waits for no file, lock or bus.
    fn prepare_send(&self) -> CapResult<u32> {
        let Some(app) = PREPARED.with(|p| p.borrow_mut().take()) else {
            return Err(CapError::new(
                code::CONFLICT,
                "focus_unknown",
                "No app is the target of this input",
            ));
        };
        send_allowed(&self.policy.load().policy, &app)
    }
}

impl SurfaceHooks for VirtualHooks {
    fn check_launch(&self, id: &str) -> CapResult<()> {
        if !self.policy.load().policy.app_permitted(id) {
            return Err(app_denied(id));
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
        PREPARED.with(|p| *p.borrow_mut() = Some(app.clone()));
        let deny = self.policy.load().policy;
        decide_app(
            &app.id,
            &app.also_ids,
            self.focus_pid(),
            &self.scopes(),
            &deny,
        )
        .map_err(|r| to_error(&r, app))
    }

    /// Windows of apps the machine ceiling does not permit, by what the process itself is and by
    /// the scope it was started in: blacked out of other apps' screenshots, as a password
    /// manager is.
    fn excluded_pids(&self) -> Vec<u32> {
        let Some(x11) = self.x11.get() else {
            return Vec::new();
        };
        let policy = self.policy.load().policy;
        let scopes = self.scopes();
        // One question per process, however many windows it has.
        let mut pids: Vec<u32> = x11
            .stacked_windows()
            .into_iter()
            .map(|w| w.pid)
            .filter(|&pid| pid != 0)
            .collect();
        pids.sort_unstable();
        pids.dedup();
        pids.retain(|&pid| pid_denied(&policy, &scopes, pid));
        pids
    }

    fn point_clients_ok(&self, x: f64, y: f64, app: &AppInfo) -> CapResult<()> {
        match self
            .x11
            .get()
            .and_then(|x11| x11.client_at_point(x as i32, y as i32))
        {
            Some(pid) if app.owns(pid) => Ok(()),
            _ => Err(CapError::new(
                code::CONFLICT,
                "occluded",
                format!(
                    "Another window is at {},{}; bring {} forward and re-snapshot",
                    x as i64, y as i64, app.name
                ),
            )),
        }
    }

    /// The server's own stacking order (top first) with the pids it recorded: what a hit test,
    /// a window-only capture and the redaction of protected windows are judged by. A window it
    /// cannot attribute (an override-redirect popup, say) is a blocker with pid 0.
    fn windows(&self) -> Option<Vec<WinInfo>> {
        Some(self.x11.get()?.stacked_windows())
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
        // The scope that holds a process names it when its executable is shared by entries.
        let manager = Arc::clone(&self.manager);
        a11y.set_holder_hint(Box::new(move |pid| manager.app_of_pid(pid)));
        // A new display gets new hooks state; the cells are set once per surface, so build the
        // hooks again when the display changes.
        let hooks_policy = policy_source();
        let hooks = Arc::new(VirtualHooks {
            manager: Arc::clone(&self.manager),
            policy: Arc::clone(&hooks_policy),
            a11y: OnceLock::new(),
            x11: OnceLock::new(),
        });
        let _ = hooks.a11y.set(Arc::clone(&a11y));
        let _ = hooks.x11.set(Arc::clone(&x11));
        // Weak: the X connection holds the guard and the hooks hold the connection.
        let weak = Arc::downgrade(&hooks);
        x11.set_tap_guard(Arc::new(move || match weak.upgrade() {
            Some(h) => h.prepare_send(),
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
        // Every authorization of an app the engine resolved (a pid, a display name, the focus)
        // asks the machine ceiling first, so clicks, accessibility actions, snapshots and
        // screenshots are covered as well as keys.
        let source = Arc::clone(&hooks_policy);
        engine
            .policy
            .set_app_gate(ceiling_gate(move || source.load().policy));
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
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::remote::policy::{Apps, Policy};
    use psyche_linux_computer::app_id::IdFacts;
    use std::path::Path as P;

    /// Every gate of the ceiling answers the same for one program. Rows: a system-installed
    /// Flatpak whose id is in no cap table, capped by its host id (`sublime_text`), and ordinary
    /// apps; under allow and deny lists that name either id, both, or neither.
    #[test]
    fn every_gate_agrees_about_one_program() {
        use super::super::focus::decide_app;
        use psyche_linux_computer::error::code;
        struct Ident(Identity);
        impl Scopes for Ident {
            fn in_scope(&self, _: &str, _: u32) -> bool {
                true
            }
            fn identity(&self, _: u32) -> Identity {
                self.0.clone()
            }
        }
        let flatpak = "com.sublimetext.three";
        let host = "sublime_text";
        let capped = || {
            (
                Identity {
                    holder: Some(flatpak.into()),
                    facts: IdFacts {
                        own: Some(host.into()),
                        resolved: vec![flatpak.into()],
                        candidates: vec![host.into(), flatpak.into()],
                        flatpak: Some(flatpak.into()),
                        ..Default::default()
                    },
                },
                AppInfo {
                    id: host.into(),
                    name: "Sublime".into(),
                    pid: 7,
                    electron: false,
                    frontmost: true,
                    windows: 1,
                    also_ids: vec![flatpak.into()],
                },
            )
        };
        let plain = || {
            (
                Identity {
                    holder: Some("org.gnome.TextEditor".into()),
                    facts: IdFacts {
                        own: Some("org.gnome.texteditor".into()),
                        resolved: vec!["org.gnome.texteditor".into()],
                        trusted: vec!["org.gnome.texteditor".into()],
                        candidates: vec!["org.gnome.texteditor".into()],
                        ..Default::default()
                    },
                },
                AppInfo {
                    id: "org.gnome.texteditor".into(),
                    name: "Text Editor".into(),
                    pid: 8,
                    electron: false,
                    frontmost: true,
                    windows: 1,
                    also_ids: Vec::new(),
                },
            )
        };
        // (program, allow, deny, expected: in reach)
        let rows: Vec<(bool, Vec<&str>, Vec<&str>, bool)> = vec![
            // S1: the owner names the Flatpak's own id.
            (true, vec![flatpak], vec![], true),
            // S2: the owner names the host id; the same program.
            (true, vec![host], vec![], true),
            // S3: both.
            (true, vec![flatpak, host], vec![], true),
            // Neither, or something else.
            (true, vec!["org.other.App"], vec![], false),
            (true, vec!["*"], vec![], true),
            // Denied under either id, whichever the allow list names.
            (true, vec!["*"], vec![flatpak], false),
            (true, vec!["*"], vec![host], false),
            (true, vec![flatpak], vec![host], false),
            // An ordinary app.
            (false, vec!["org.gnome.TextEditor"], vec![], true),
            (false, vec![flatpak], vec![], false),
            (false, vec!["*"], vec!["org.gnome.TextEditor"], false),
        ];
        for (is_capped, allow, deny, want) in rows {
            let mut policy = Policy::default();
            policy.apps = Apps {
                allow: allow.iter().map(|s| s.to_string()).collect(),
                deny: deny.iter().map(|s| s.to_string()).collect(),
            };
            let (identity, app) = if is_capped { capped() } else { plain() };
            let row = format!("capped={is_capped} allow={allow:?} deny={deny:?}");
            // 1. What is shown in screenshots and judged on the focused window.
            let scopes = Ident(identity);
            assert_eq!(
                blocked_by(&policy, &scopes, 1).is_none(),
                want,
                "blocked_by {row}"
            );
            // 2. The engine gate every Read, Click and Type authorization asks.
            let gate = ceiling_gate({
                let policy = policy.clone();
                move || policy.clone()
            });
            assert_eq!(gate(&app.id, &app.also_ids).is_ok(), want, "gate {row}");
            // 3. The check made as keys are sent.
            assert_eq!(send_allowed(&policy, &app).is_ok(), want, "send {row}");
            // 4. The check made before a batch is typed.
            let typed = decide_app(&app.id, &app.also_ids, Some(1), &scopes, &policy);
            assert_eq!(
                !matches!(typed, Err(super::super::focus::Refusal::Denied { .. })),
                want,
                "decide {row}"
            );
            // And the refusal is a policy refusal, not a focus one.
            if !want {
                assert_eq!(
                    gate(&app.id, &app.also_ids).unwrap_err().code,
                    code::POLICY_DENIED
                );
            }
        }
        // 5. Launching names a desktop id and carries no others: it is judged on that id.
        let mut policy = Policy::default();
        policy.apps = Apps {
            allow: vec![flatpak.into()],
            deny: vec![],
        };
        assert!(policy.app_permitted(flatpak));
        assert!(!policy.app_permitted("org.gnome.TextEditor"));
    }

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
