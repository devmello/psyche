//! The portal state machine against a fake `xdg-desktop-portal` on a private session bus:
//! the call order, the one dialog, restore tokens (single use, newest kept, a bad one ignored),
//! a denied dialog, `Closed` as the Stop, and the `Notify*` input. The real portals (GNOME, KDE)
//! need a real desktop; this pins everything the helper does around them. Needs `dbus-daemon`.
#![cfg(target_os = "linux")]

use psyche_linux_computer::keychord::KeyChord;
use psyche_linux_computer::linux::RemotePath;
use psyche_linux_computer::portal::{Portal, PortalPath};
use psyche_linux_computer::tiers::StopSignal;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use zbus::blocking::Connection;
use zbus::message::Header;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

/// What the fake portal does and has seen.
#[derive(Default)]
struct World {
    calls: Mutex<Vec<String>>,
    dialogs: AtomicUsize,
    /// Tokens the fake backend can restore (each works once).
    valid_tokens: Mutex<Vec<String>>,
    issued: AtomicUsize,
    deny: AtomicBool,
    /// The fake backend rejects an unknown restore token with an error instead of a dialog.
    bad_token_fails: AtomicBool,
    session_restored: AtomicBool,
    conn: OnceLock<Connection>,
}

impl World {
    fn log(&self, s: impl Into<String>) {
        self.calls.lock().unwrap().push(s.into());
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn request_path(h: &Header<'_>, token: &str) -> String {
    let sender = h
        .sender()
        .map(|s| s.as_str().trim_start_matches(':').replace('.', "_"))
        .unwrap_or_default();
    format!("/org/freedesktop/portal/desktop/request/{sender}/{token}")
}

fn token_of(opts: &HashMap<String, OwnedValue>) -> String {
    opts.get("handle_token")
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| String::try_from(v).ok())
        .unwrap_or_default()
}

/// Answers `path` with `Response(code, results)` shortly after the method returned.
fn respond(world: &Arc<World>, path: String, code: u32, results: HashMap<String, OwnedValue>) {
    let world = world.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        let conn = world.conn.get().unwrap();
        let _ = conn.emit_signal(
            None::<&str>,
            path.as_str(),
            "org.freedesktop.portal.Request",
            "Response",
            &(code, results),
        );
    });
}

struct Remote(Arc<World>);
struct Cast(Arc<World>);
struct SessionObj(Arc<World>, String);

#[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
impl Remote {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        2
    }

    fn create_session(
        &self,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        self.0.log("CreateSession");
        let token = token_of(&options);
        let path = request_path(&h, &token);
        let session = format!(
            "/org/freedesktop/portal/desktop/session/test/s{}",
            self.0.issued.load(Ordering::SeqCst)
        );
        let conn = self.0.conn.get().unwrap();
        conn.object_server()
            .at(
                session.as_str(),
                SessionObj(self.0.clone(), session.clone()),
            )
            .unwrap();
        let mut res = HashMap::new();
        res.insert(
            "session_handle".to_string(),
            OwnedValue::try_from(Value::from(session)).unwrap(),
        );
        respond(&self.0, path.clone(), 0, res);
        OwnedObjectPath::try_from(path).unwrap()
    }

    fn select_devices(
        &self,
        _session: OwnedObjectPath,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] h: Header<'_>,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        let path = request_path(&h, &token_of(&options));
        let persist = options
            .get("persist_mode")
            .and_then(|v| u32::try_from(v.try_clone().ok()?).ok());
        let types = options
            .get("types")
            .and_then(|v| u32::try_from(v.try_clone().ok()?).ok());
        let token = options
            .get("restore_token")
            .and_then(|v| String::try_from(v.try_clone().ok()?).ok());
        self.0.log(format!(
            "SelectDevices types={types:?} persist={persist:?} token={}",
            token.clone().unwrap_or_else(|| "-".into())
        ));
        self.0.session_restored.store(false, Ordering::SeqCst);
        if let Some(t) = &token {
            let mut valid = self.0.valid_tokens.lock().unwrap();
            if let Some(i) = valid.iter().position(|v| v == t) {
                valid.remove(i); // single use
                self.0.session_restored.store(true, Ordering::SeqCst);
            } else if self.0.bad_token_fails.load(Ordering::SeqCst) {
                respond(&self.0, path.clone(), 2, HashMap::new());
                return Ok(OwnedObjectPath::try_from(path).unwrap());
            }
        }
        respond(&self.0, path.clone(), 0, HashMap::new());
        Ok(OwnedObjectPath::try_from(path).unwrap())
    }

    fn start(
        &self,
        _session: OwnedObjectPath,
        _parent: String,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        let path = request_path(&h, &token_of(&options));
        self.0.log("Start");
        if !self.0.session_restored.load(Ordering::SeqCst) {
            self.0.dialogs.fetch_add(1, Ordering::SeqCst);
            if self.0.deny.load(Ordering::SeqCst) {
                respond(&self.0, path.clone(), 1, HashMap::new());
                return OwnedObjectPath::try_from(path).unwrap();
            }
        }
        let n = self.0.issued.fetch_add(1, Ordering::SeqCst) + 1;
        let token = format!("token-{n}");
        self.0.valid_tokens.lock().unwrap().push(token.clone());
        let mut props: HashMap<String, OwnedValue> = HashMap::new();
        props.insert(
            "position".into(),
            OwnedValue::try_from(Value::from((0i32, 0i32))).unwrap(),
        );
        props.insert(
            "size".into(),
            OwnedValue::try_from(Value::from((1920i32, 1080i32))).unwrap(),
        );
        let streams: Vec<(u32, HashMap<String, OwnedValue>)> = vec![(77, props)];
        let mut res = HashMap::new();
        res.insert(
            "restore_token".to_string(),
            OwnedValue::try_from(Value::from(token)).unwrap(),
        );
        res.insert(
            "streams".to_string(),
            OwnedValue::try_from(Value::from(streams)).unwrap(),
        );
        res.insert(
            "devices".to_string(),
            OwnedValue::try_from(Value::from(3u32)).unwrap(),
        );
        respond(&self.0, path.clone(), 0, res);
        OwnedObjectPath::try_from(path).unwrap()
    }

    fn notify_keyboard_keysym(
        &self,
        _s: OwnedObjectPath,
        _o: HashMap<String, OwnedValue>,
        keysym: i32,
        state: u32,
    ) {
        self.0.log(format!(
            "key {keysym:#x} {}",
            if state == 1 { "down" } else { "up" }
        ));
    }

    fn notify_pointer_motion_absolute(
        &self,
        _s: OwnedObjectPath,
        _o: HashMap<String, OwnedValue>,
        stream: u32,
        x: f64,
        y: f64,
    ) {
        self.0.log(format!("move stream={stream} {x},{y}"));
    }

    fn notify_pointer_button(
        &self,
        _s: OwnedObjectPath,
        _o: HashMap<String, OwnedValue>,
        button: i32,
        state: u32,
    ) {
        self.0.log(format!(
            "button {button:#x} {}",
            if state == 1 { "down" } else { "up" }
        ));
    }

    fn notify_pointer_axis_discrete(
        &self,
        _s: OwnedObjectPath,
        _o: HashMap<String, OwnedValue>,
        axis: u32,
        steps: i32,
    ) {
        self.0.log(format!("axis {axis} {steps}"));
    }
}

#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl Cast {
    #[zbus(property, name = "version")]
    fn version(&self) -> u32 {
        4
    }

    fn select_sources(
        &self,
        _session: OwnedObjectPath,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] h: Header<'_>,
    ) -> OwnedObjectPath {
        let path = request_path(&h, &token_of(&options));
        let cursor = options
            .get("cursor_mode")
            .and_then(|v| u32::try_from(v.try_clone().ok()?).ok());
        self.0.log(format!("SelectSources cursor={cursor:?}"));
        respond(&self.0, path.clone(), 0, HashMap::new());
        OwnedObjectPath::try_from(path).unwrap()
    }
}

#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl SessionObj {
    fn close(&self) {
        self.0
            .log(format!("Close {}", self.1.rsplit('/').next().unwrap_or("")));
    }
}

struct Rig {
    daemon: Child,
    world: Arc<World>,
    portal: Arc<Portal>,
    path: PortalPath,
    dir: tempfile::TempDir,
    _server: Connection,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

fn rig() -> Rig {
    let mut daemon = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("dbus-daemon");
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    let address = address.trim().to_string();
    let world = Arc::new(World::default());
    let server = zbus::blocking::connection::Builder::address(address.as_str())
        .unwrap()
        .serve_at("/org/freedesktop/portal/desktop", Remote(world.clone()))
        .unwrap()
        .serve_at("/org/freedesktop/portal/desktop", Cast(world.clone()))
        .unwrap()
        .name("org.freedesktop.portal.Desktop")
        .unwrap()
        .build()
        .unwrap();
    world.conn.set(server.clone()).ok();
    let client = zbus::blocking::connection::Builder::address(address.as_str())
        .unwrap()
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let portal = Arc::new(
        Portal::new(client, dir.path().join("psyche-helper").join("portal.json"))
            .with_dialog_timeout(Duration::from_secs(10)),
    );
    let path = PortalPath {
        portal: portal.clone(),
        frames: Box::new(|_| {
            Err(psyche_linux_computer::error::CapError::unavailable(
                "no_frames",
                "no pipewire in this test",
            ))
        }),
    };
    Rig {
        daemon,
        world,
        portal,
        path,
        dir,
        _server: server,
    }
}

fn token_file(r: &Rig) -> std::path::PathBuf {
    r.dir.path().join("psyche-helper").join("portal.json")
}

#[test]
fn the_first_session_asks_once_and_stores_the_token_privately() {
    let r = rig();
    r.path.ready().expect("session");
    assert_eq!(r.world.dialogs.load(Ordering::SeqCst), 1);
    let calls = r.world.calls();
    assert_eq!(calls[0], "CreateSession");
    assert_eq!(
        calls[1],
        "SelectDevices types=Some(3) persist=Some(2) token=-"
    );
    assert_eq!(calls[2], "SelectSources cursor=Some(2)");
    assert_eq!(calls[3], "Start");
    assert_eq!(r.portal.stored_token().as_deref(), Some("token-1"));
    let mode = std::fs::metadata(token_file(&r))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(
        std::fs::metadata(token_file(&r).parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    // A second call while the session is open opens nothing.
    r.path.ready().unwrap();
    assert_eq!(
        r.world
            .calls()
            .iter()
            .filter(|c| *c == "CreateSession")
            .count(),
        1
    );
    assert_eq!(r.path.displays().len(), 1);
}

#[test]
fn a_stored_token_restores_without_a_dialog_and_the_newest_token_is_kept() {
    let r = rig();
    r.path.ready().unwrap();
    r.path.close();
    assert!(
        r.world.calls().iter().any(|c| c.starts_with("Close ")),
        "closing the session reaches the portal"
    );
    r.path.ready().unwrap();
    assert_eq!(
        r.world.dialogs.load(Ordering::SeqCst),
        1,
        "no second dialog"
    );
    assert!(r
        .world
        .calls()
        .iter()
        .any(|c| c == "SelectDevices types=Some(3) persist=Some(2) token=token-1"));
    // The token is single use: the stored one is now the new one.
    assert_eq!(r.portal.stored_token().as_deref(), Some("token-2"));
    r.path.close();
    r.path.ready().unwrap();
    assert_eq!(r.portal.stored_token().as_deref(), Some("token-3"));
    assert_eq!(r.world.dialogs.load(Ordering::SeqCst), 1);
}

#[test]
fn a_token_the_backend_cannot_restore_is_dropped_and_the_owner_is_asked_again() {
    let r = rig();
    std::fs::create_dir_all(token_file(&r).parent().unwrap()).unwrap();
    std::fs::write(token_file(&r), br#"{"restoreToken":"stale-token"}"#).unwrap();
    r.world.bad_token_fails.store(true, Ordering::SeqCst);
    r.path.ready().expect("falls back to a fresh session");
    assert_eq!(r.world.dialogs.load(Ordering::SeqCst), 1);
    let calls = r.world.calls();
    assert!(calls.iter().any(|c| c.ends_with("token=stale-token")));
    assert!(calls.iter().any(|c| c.ends_with("token=-")), "{calls:?}");
    assert_eq!(r.portal.stored_token().as_deref(), Some("token-1"));
}

#[test]
fn a_token_the_backend_ignores_just_shows_the_dialog() {
    let r = rig();
    std::fs::create_dir_all(token_file(&r).parent().unwrap()).unwrap();
    std::fs::write(token_file(&r), br#"{"restoreToken":"unknown"}"#).unwrap();
    r.path.ready().unwrap();
    assert_eq!(r.world.dialogs.load(Ordering::SeqCst), 1);
    assert_eq!(r.portal.stored_token().as_deref(), Some("token-1"));
}

#[test]
fn damaged_token_files_are_ignored() {
    let r = rig();
    std::fs::create_dir_all(token_file(&r).parent().unwrap()).unwrap();
    for bad in [
        &b"not json"[..],
        b"{}",
        br#"{"restoreToken":""}"#,
        br#"{"restoreToken":123}"#,
    ] {
        std::fs::write(token_file(&r), bad).unwrap();
        assert_eq!(r.portal.stored_token(), None);
    }
    std::fs::write(
        token_file(&r),
        format!("{{\"restoreToken\":\"{}\"}}", "x".repeat(10_000)),
    )
    .unwrap();
    assert_eq!(r.portal.stored_token(), None);
}

#[test]
fn a_denied_dialog_is_a_refusal_and_nothing_is_stored() {
    let r = rig();
    r.world.deny.store(true, Ordering::SeqCst);
    let e = r.path.ready().unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        ("policy_denied", "portal_denied")
    );
    assert_eq!(r.portal.stored_token(), None);
    assert!(!r.portal.is_open());
    // The next call asks again.
    r.world.deny.store(false, Ordering::SeqCst);
    r.path.ready().unwrap();
    assert_eq!(r.world.dialogs.load(Ordering::SeqCst), 2);
}

#[test]
fn closing_the_session_from_the_shell_is_the_stop() {
    let r = rig();
    let stopped = Arc::new(AtomicBool::new(false));
    let s2 = stopped.clone();
    r.path
        .on_closed(Box::new(move || s2.store(true, Ordering::SeqCst)));
    r.path.ready().unwrap();
    // The compositor closes the session: the Session object emits Closed.
    let conn = r.world.conn.get().unwrap();
    conn.emit_signal(
        None::<&str>,
        "/org/freedesktop/portal/desktop/session/test/s0",
        "org.freedesktop.portal.Session",
        "Closed",
        &(HashMap::<String, OwnedValue>::new(),),
    )
    .unwrap();
    for _ in 0..100 {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(stopped.load(Ordering::SeqCst), "the run is cancelled");
    assert!(
        !r.portal.is_open(),
        "the session is gone; the next call opens a new one"
    );
    // Our own close() must not read as a Stop.
    let again = Arc::new(AtomicBool::new(false));
    let a2 = again.clone();
    r.path
        .on_closed(Box::new(move || a2.store(true, Ordering::SeqCst)));
    r.path.ready().unwrap();
    r.path.close();
    std::thread::sleep(Duration::from_millis(200));
    assert!(!again.load(Ordering::SeqCst));
}

#[test]
fn revoking_forgets_the_permission() {
    let r = rig();
    r.path.ready().unwrap();
    assert!(token_file(&r).exists());
    assert!(r.portal.revoke());
    assert!(!token_file(&r).exists());
    assert!(!r.portal.is_open());
    assert!(!r.portal.revoke(), "nothing left to revoke");
    r.path.ready().unwrap();
    assert_eq!(
        r.world.dialogs.load(Ordering::SeqCst),
        2,
        "asks again after a revoke"
    );
}

#[test]
fn input_goes_through_the_notify_methods_relative_to_the_stream() {
    let r = rig();
    r.path.ready().unwrap();
    let stop = StopSignal::new();
    r.path.click(100.0, 50.0, 1, false, &[], &stop).unwrap();
    r.path.type_text("a\n", &stop, &mut || Ok(())).unwrap();
    r.path
        .key(&KeyChord::parse("cmd+s").unwrap(), &stop)
        .unwrap();
    r.path.scroll(10.0, 10.0, 0, 3, &stop).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let calls: Vec<String> = r
        .world
        .calls()
        .into_iter()
        .skip_while(|c| c != "Start")
        .skip(1)
        .collect();
    assert_eq!(
        calls,
        vec![
            "move stream=77 100,50",
            "button 0x110 down",
            "button 0x110 up",
            "key 0x61 down",
            "key 0x61 up",
            "key 0xff0d down",
            "key 0xff0d up",
            "key 0xffe3 down",
            "key 0x73 down",
            "key 0x73 up",
            "key 0xffe3 up",
            "move stream=77 10,10",
            "axis 0 -3",
        ]
    );
}

#[test]
fn a_stop_cuts_input_short() {
    let r = rig();
    r.path.ready().unwrap();
    let stop = StopSignal::new();
    stop.run(None, || {
        stop.trip();
        assert_eq!(
            r.path
                .click(1.0, 1.0, 1, false, &[], &stop)
                .unwrap_err()
                .reason,
            "user_stopped"
        );
        assert_eq!(
            r.path
                .type_text("abc", &stop, &mut || Ok(()))
                .unwrap_err()
                .reason,
            "user_stopped"
        );
    });
    assert!(!r
        .world
        .calls()
        .iter()
        .any(|c| c.starts_with("button") || c.starts_with("key ")));
}

#[test]
fn a_desktop_without_the_portals_says_so() {
    let mut daemon = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    let client = zbus::blocking::connection::Builder::address(address.trim())
        .unwrap()
        .method_timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let portal = Arc::new(Portal::new(client, dir.path().join("portal.json")));
    let path = PortalPath {
        portal: portal.clone(),
        frames: Box::new(|_| unreachable!()),
    };
    let e = path.ready().unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        ("unavailable", "portal_unavailable")
    );
    assert!(!portal.available());
    let _ = daemon.kill();
    let _ = daemon.wait();
}
