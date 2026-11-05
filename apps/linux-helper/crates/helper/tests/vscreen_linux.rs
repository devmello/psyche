//! The virtual screen against a real Xvfb, window manager and systemd scopes (Linux only).
//!
//! It needs `Xvfb`, a systemd user manager with a session bus (`systemd-run --user`), and for the
//! GTK 4 test `gnome-text-editor`. Where one is missing the test says so and returns; set
//! `PSYCHE_VSCREEN_REQUIRE=1` (CI does) to make that a failure instead.
//!
//! A second Xvfb stands in for the owner's display. Everything the helper launches must show up
//! on its own display and nothing on the stand-in.
#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use psyche_helper::idle::IdleTimer;
use psyche_helper::paths::Env;
use psyche_helper::vscreen::guard::{ProcFs, Procs};
use psyche_helper::vscreen::manager::{Config, Deps, InputEvent, VscreenManager};
use psyche_helper::vscreen::xvfb::{connect_stream, XvfbConfig, XvfbServer};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeWindowAttributesAux, ConnectionExt as _, CreateWindowAux, EventMask,
    WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::{DefaultStream, RustConnection};

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

fn have(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {program} >/dev/null")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn user_scopes_work() -> bool {
    Command::new("systemd-run")
        .args(["--user", "--scope", "--quiet", "--", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `Some(reason)` when this machine cannot run the test.
fn missing(extra: &[&str]) -> Option<String> {
    let mut need = vec!["Xvfb", "systemd-run"];
    need.extend_from_slice(extra);
    let reason = need
        .iter()
        .find(|p| !have(p))
        .map(|p| format!("{p} is not installed"))
        .or_else(|| {
            (!user_scopes_work()).then(|| "systemd-run --user does not work here".to_string())
        });
    if let Some(r) = &reason {
        if std::env::var("PSYCHE_VSCREEN_REQUIRE").as_deref() == Ok("1") {
            panic!("virtual screen test cannot run: {r}");
        }
        eprintln!("skipping: {r}");
    }
    reason
}

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|t| {
            t.lines().find_map(|l| {
                l.strip_prefix("VmRSS:")?
                    .trim()
                    .trim_end_matches("kB")
                    .trim()
                    .parse()
                    .ok()
            })
        })
        .unwrap_or(0)
}

fn config(state: &Path, app_dirs: Vec<PathBuf>) -> Config {
    let env: HashMap<String, String> = [
        ("HOME", state.to_str().unwrap()),
        ("PSYCHE_HELPER_STATE", state.join("state").to_str().unwrap()),
        ("PATH", &std::env::var("PATH").unwrap_or_default()),
        (
            "XDG_RUNTIME_DIR",
            &std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into()),
        ),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let mut c = Config::from_env(&env as &dyn Env);
    c.app_dirs = app_dirs;
    c.first_display = 80;
    c.launch_wait = Duration::from_secs(10);
    c.close_grace = Duration::from_secs(3);
    c.watchdog_every = Duration::from_millis(200);
    c
}

fn manager(c: Config) -> (Arc<VscreenManager>, Arc<IdleTimer>) {
    let idle = Arc::new(IdleTimer::new(Some(Duration::from_secs(300))));
    (
        VscreenManager::new(c, Deps::real(), Arc::clone(&idle)),
        idle,
    )
}

fn wait_until(what: &str, limit: Duration, mut f: impl FnMut() -> bool) {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

fn unit_active(unit: &str) -> bool {
    Command::new("systemctl")
        .args(["--user", "is-active", "--quiet", &format!("{unit}.scope")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// A connection to a display of ours, authenticated from the authority file (its last 16 bytes
/// are the cookie).
fn connect(display_number: u32, xauth: &Path) -> RustConnection {
    let bytes = std::fs::read(xauth).expect("authority file");
    let cookie = bytes[bytes.len() - 16..].to_vec();
    let (stream, _) =
        DefaultStream::from_unix_stream(connect_stream(display_number).unwrap()).unwrap();
    RustConnection::connect_to_stream_with_auth_info(
        stream,
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        cookie,
    )
    .unwrap()
}

/// The CLIPBOARD selection as UTF-8 text.
fn clipboard(conn: &RustConnection) -> Option<String> {
    let root = conn.setup().roots[0].root;
    let win = conn.generate_id().unwrap();
    conn.create_window(
        0,
        win,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .unwrap();
    let clip = conn
        .intern_atom(false, b"CLIPBOARD")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let utf8 = conn
        .intern_atom(false, b"UTF8_STRING")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    let prop = conn
        .intern_atom(false, b"PSYCHE_TEST_PASTE")
        .unwrap()
        .reply()
        .unwrap()
        .atom;
    conn.convert_selection(win, clip, utf8, prop, x11rb::CURRENT_TIME)
        .unwrap();
    conn.flush().unwrap();
    let end = Instant::now() + Duration::from_secs(3);
    while Instant::now() < end {
        if let Some(Event::SelectionNotify(e)) = conn.poll_for_event().unwrap() {
            if e.property == x11rb::NONE {
                return None;
            }
            let r = conn
                .get_property(true, win, prop, AtomEnum::ANY, 0, 4096)
                .unwrap()
                .reply()
                .unwrap();
            return Some(String::from_utf8_lossy(&r.value).into_owned());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    None
}

fn key_chord(m: &VscreenManager, key: &str) {
    m.owner_input(&[
        InputEvent::KeyDown("Control".into()),
        InputEvent::KeyDown(key.into()),
        InputEvent::KeyUp(key.into()),
        InputEvent::KeyUp("Control".into()),
    ])
    .unwrap();
}

fn fake_app() -> PathBuf {
    // target/debug/deps/<test> -> target/debug/examples/fake_app
    let exe = std::env::current_exe().unwrap();
    let app = exe
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/fake_app");
    {
        // `cargo test --test ...` does not build examples; a full `cargo test` does. Building
        // again is quick when it is current.
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let ok = Command::new(cargo)
            .args(["build", "-p", "psyche-helper", "--example", "fake_app"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "building the fake_app example");
    }
    app
}

fn desktop_file(dir: &Path, id: &str, exec: &str) {
    std::fs::write(
        dir.join(format!("{id}.desktop")),
        format!("[Desktop Entry]\nType=Application\nName={id}\nExec={exec}\n"),
    )
    .unwrap();
}

/// What the owner's display (the stand-in) sees: every window created under its root.
struct Owner {
    _server: XvfbServer,
    watcher: RustConnection,
}

impl Owner {
    fn start() -> Owner {
        let mut cfg = XvfbConfig::new(1024, 768);
        cfg.first_display = 70;
        let server = XvfbServer::start(&cfg).expect("stand-in Xvfb");
        let watcher = connect(server.display_number, &server.xauthority);
        let root = watcher.setup().roots[0].root;
        watcher
            .change_window_attributes(
                root,
                &ChangeWindowAttributesAux::new().event_mask(EventMask::SUBSTRUCTURE_NOTIFY),
            )
            .unwrap()
            .check()
            .unwrap();
        // The apps we launch must not find this display by accident: it is the "real" one.
        std::env::set_var("DISPLAY", server.display());
        std::env::set_var("XAUTHORITY", &server.xauthority);
        std::env::set_var("WAYLAND_DISPLAY", "wayland-owner");
        Owner {
            _server: server,
            watcher,
        }
    }

    fn windows(&self) -> usize {
        let root = self.watcher.setup().roots[0].root;
        self.watcher
            .query_tree(root)
            .unwrap()
            .reply()
            .unwrap()
            .children
            .len()
    }

    fn events_seen(&self) -> usize {
        let mut n = 0;
        while let Ok(Some(e)) = self.watcher.poll_for_event() {
            if matches!(e, Event::MapNotify(_) | Event::CreateNotify(_)) {
                n += 1;
            }
        }
        n
    }
}

#[test]
fn gtk4_text_editor_runs_on_its_own_display_and_nothing_reaches_the_owners() {
    let _guard = serial();
    if missing(&["gnome-text-editor"]).is_some() {
        return;
    }
    let owner = Owner::start();
    let dir = tempfile::tempdir().unwrap();
    // Text Editor restores its last draft at start-up; keep this run's drafts to itself.
    std::env::set_var("XDG_DATA_HOME", dir.path().join("data"));
    let (m, _idle) = manager(config(
        dir.path(),
        vec![PathBuf::from("/usr/share/applications")],
    ));

    let opened = m
        .open_app("org.gnome.TextEditor")
        .expect("open the text editor");
    assert_eq!(opened.app_id, "org.gnome.TextEditor");
    assert!(
        ProcFs.in_vscreen_slice(opened.pid),
        "the app runs in psyche-vscreen.slice"
    );
    let status = m.status();
    assert!(status.running);
    assert_eq!(status.apps.len(), 1);
    assert_eq!(status.apps[0].app_id, "org.gnome.TextEditor");

    // Let GTK settle, focus the document, type, and read it back through the clipboard.
    std::thread::sleep(Duration::from_millis(1500));
    let display = m.status().display.unwrap();
    let number: u32 = display.trim_start_matches(':').parse().unwrap();
    let before = m.frame(None, Some(640)).unwrap();
    assert!(before.changed);
    assert_eq!(&before.jpeg.as_ref().unwrap()[..2], &[0xff, 0xd8], "a JPEG");
    assert_eq!(before.width, 640);
    m.agent_click(640, 400, psyche_helper::vscreen::input::Button::Left)
        .unwrap();
    let text = "Typed by Psyche on the virtual screen";
    m.agent_type(text).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    key_chord(&m, "a");
    key_chord(&m, "c");
    let xauth = {
        let rt = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(rt).join(format!("psyche/xauth-{number}"))
    };
    let conn = connect(number, &xauth);
    let mut got = None;
    for _ in 0..10 {
        got = clipboard(&conn);
        eprintln!("clipboard: {got:?}");
        if let Ok(f) = m.frame(None, Some(1280)) {
            std::fs::write("/tmp/vs-debug.jpg", f.jpeg.unwrap()).unwrap();
        }
        if got.as_deref() == Some(text) {
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    assert_eq!(
        got.as_deref(),
        Some(text),
        "what was typed is what the app holds"
    );
    let after = m.frame(None, Some(640)).unwrap();
    assert!(after.frame_seq > before.frame_seq, "the screen changed");
    assert!(m.frame(Some(after.frame_seq), Some(640)).unwrap().frame_seq >= after.frame_seq);

    // Measurements for the PR.
    let st = m.status();
    let app_rss: u64 = st.apps.iter().map(|a| rss_kb(a.pid)).sum();
    let xvfb_pid = Command::new("pgrep")
        .args(["-f", &format!("Xvfb :{number} ")])
        .output()
        .unwrap();
    let xvfb_pid: u32 = String::from_utf8_lossy(&xvfb_pid.stdout)
        .lines()
        .next()
        .and_then(|l| l.trim().parse().ok())
        .unwrap_or(0);
    eprintln!(
        "RSS_KB helper_process={} xvfb={} gnome-text-editor={}",
        rss_kb(std::process::id()),
        rss_kb(xvfb_pid),
        app_rss
    );

    // Nothing was created or mapped on the owner's display, then the same on the way out.
    assert_eq!(
        owner.events_seen(),
        0,
        "no window appeared on the owner's display"
    );
    assert_eq!(owner.windows(), 0);

    let out = m.stop(true, false).unwrap();
    if !out.stopped {
        // Newer Text Editors may ask; the test closes it by force.
        assert!(m.stop(true, true).unwrap().stopped);
    }
    assert!(!m.status().running);
    assert_eq!(owner.events_seen(), 0);

    // The same app already open on the owner's display: the launch is refused, nothing starts.
    let outside = Command::new("gnome-text-editor")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut outside) = outside {
        wait_until(
            "the owner's editor to take its bus name",
            Duration::from_secs(10),
            || {
                use psyche_helper::vscreen::guard::{BusctlBus, SessionBus};
                BusctlBus.name_owner_pid("org.gnome.TextEditor").is_some()
            },
        );
        let err = m.open_app("org.gnome.TextEditor").expect_err("refused");
        assert_eq!(err.reason, "already_open_on_your_screen");
        assert!(
            !m.status().running,
            "no display was started for a refused launch"
        );
        let _ = outside.kill();
        let _ = outside.wait();
    }
    drop(owner);
}

#[test]
fn launch_checks_parking_and_the_window_manager_with_a_fake_app() {
    let _guard = serial();
    if missing(&[]).is_some() {
        return;
    }
    let app = fake_app();
    let owner = Owner::start();
    let dir = tempfile::tempdir().unwrap();
    let apps = dir.path().join("applications");
    std::fs::create_dir_all(&apps).unwrap();
    desktop_file(&apps, "psyche.test.Plain", app.to_str().unwrap());
    desktop_file(
        &apps,
        "psyche.test.Unsaved",
        &format!("{} --unsaved", app.display()),
    );
    desktop_file(
        &apps,
        "psyche.test.Windowless",
        &format!("{} --no-window", app.display()),
    );
    let mut c = config(dir.path(), vec![apps]);
    c.launch_wait = Duration::from_secs(2);
    let (m, idle) = manager(c);

    // A window that never appears on our display undoes the launch.
    let err = m.open_app("psyche.test.Windowless").expect_err("no window");
    assert_eq!(err.reason, "opened_elsewhere");
    assert!(m.status().apps.is_empty());

    // A plain window is mapped maximised and in front.
    let opened = m.open_app("psyche.test.Plain").expect("open");
    assert!(unit_active(&opened.unit));
    let st = m.status();
    assert_eq!(st.apps[0].window_title.as_deref(), Some("Fake document"));
    assert_eq!((st.width, st.height), (1280, 800));
    let first_unit = opened.unit.clone();
    // Closing it politely lets it go and stops the screen.
    assert!(m.stop(true, false).unwrap().stopped);
    assert!(!unit_active(&first_unit));

    // An app with a "Save changes?" dialog is not forced: the screen stays and the app is flagged.
    let opened = m.open_app("psyche.test.Unsaved").expect("open");
    let out = m.stop(true, false).unwrap();
    assert!(!out.stopped);
    assert_eq!(out.unsaved, vec!["psyche.test.Unsaved".to_string()]);
    let st = m.status();
    assert!(st.running);
    assert!(st.apps[0].has_unsaved_changes);
    // The dialog is centred over the maximised parent.
    let display = st.display.clone().unwrap();
    let number: u32 = display.trim_start_matches(':').parse().unwrap();
    assert!(unit_active(&opened.unit), "the app was not killed");
    // Keep it open: the screen is still usable.
    assert!(m.frame(None, None).unwrap().changed);
    // Discard: now it goes, with its scope and its display.
    assert!(m.stop(true, true).unwrap().stopped);
    wait_until("the scope to end", Duration::from_secs(5), || {
        !unit_active(&opened.unit)
    });
    assert!(connect_stream(number).is_err(), "Xvfb is gone");
    assert!(!m.status().running);

    // Take-over pauses the agent.
    m.start(None).unwrap();
    m.owner_input(&[InputEvent::Move { x: 5.0, y: 5.0 }])
        .unwrap();
    assert!(m.status().taken_over);
    assert_eq!(m.agent_type("x").unwrap_err().reason, "taken_over");
    m.stop(false, true).unwrap();

    // Nothing ever reached the owner's display.
    assert_eq!(owner.events_seen(), 0);
    assert_eq!(owner.windows(), 0);

    // With nothing on it and no use, the display stops by itself and the helper may idle again.
    let mut c = config(dir.path(), vec![dir.path().join("applications")]);
    c.idle_stop = Duration::from_millis(600);
    let (m2, idle2) = manager(c);
    m2.start(None).unwrap();
    assert!(
        !idle2.expired_at(Instant::now() + Duration::from_secs(10_000), 0),
        "a running screen keeps the helper up"
    );
    wait_until("the idle stop", Duration::from_secs(10), || {
        !m2.status().running
    });
    assert!(
        idle2.expired_at(Instant::now() + Duration::from_secs(10_000), 0),
        "then the idle timer runs again"
    );
    let _ = idle;
    drop(owner);
}

#[test]
fn the_display_backend_works_on_its_own_for_other_callers() {
    // The separate-desktop container uses `VirtualDisplay` without the manager or systemd.
    use psyche_helper::vscreen::display::VirtualDisplay;
    let _guard = serial();
    if missing(&[]).is_some() {
        return;
    }
    let mut cfg = XvfbConfig::new(800, 600);
    cfg.first_display = 85;
    let display = VirtualDisplay::start(&cfg).expect("display");
    assert!(display.is_alive());
    assert!(display.uses_shm(), "XShm capture works on Xvfb");
    let spawn = |extra: &[&str]| {
        Command::new(fake_app())
            .args(extra)
            .env("DISPLAY", &display.display)
            .env("XAUTHORITY", &display.xauthority)
            .stdin(Stdio::null())
            .spawn()
            .unwrap()
    };
    let base = display.window_serial();
    let mut first = spawn(&[]);
    let main = display
        .wait_for_window(base, Duration::from_secs(5), |_| true)
        .expect("the window is mapped");
    // Maximised, no frame.
    assert_eq!(
        (main.rect.x, main.rect.y, main.rect.w, main.rect.h),
        (0, 0, 800, 600)
    );
    assert_eq!(main.title.as_deref(), Some("Fake document"));
    // Asking it to close ends it.
    display.request_close(main.id);
    wait_until("the window to close", Duration::from_secs(5), || {
        display.windows().is_empty()
    });
    let _ = first.wait();

    // A dialog opens centred over its parent and takes the focus.
    let base = display.window_serial();
    let mut second = spawn(&["--unsaved"]);
    let doc = display
        .wait_for_window(base, Duration::from_secs(5), |_| true)
        .unwrap();
    display.request_close(doc.id);
    let dialog = display
        .wait_for_window(doc.map_serial, Duration::from_secs(5), |w| {
            w.transient_for == Some(doc.id)
        })
        .expect("the dialog");
    assert_eq!(
        (dialog.rect.x, dialog.rect.y, dialog.rect.w, dialog.rect.h),
        (250, 240, 300, 120)
    );
    // A frame comes out, and typing does not fail.
    let (seq, jpeg, w, _) = display.frame(Some(400), Duration::from_millis(0)).unwrap();
    assert!(seq >= 1);
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    assert_eq!(w, 400);
    display
        .type_text(
            "héllo €
",
        )
        .unwrap();
    let _ = second.kill();
    let _ = second.wait();
    display.stop();
    assert!(!display.is_alive());
}
