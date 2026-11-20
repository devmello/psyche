//! Direct computer use on X11 against a real GTK 4 app (gnome-text-editor) under Xvfb with the
//! real AT-SPI bus. Run through `scripts/ci/linux-helper-direct-x11.sh`, which provides the
//! display, the window manager, the session bus and the app. Ignored otherwise.
#![cfg(target_os = "linux")]

use psyche_linux_computer::a11y::A11y;
use psyche_linux_computer::backend::Backend;
use psyche_linux_computer::engine::{Engine, Invocation};
use psyche_linux_computer::linux::{LinuxBackend, Path};
use psyche_linux_computer::x11::X11;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};

const APP: &str = "org.gnome.TextEditor";

fn call(e: &Engine<LinuxBackend>, name: &str, params: Value) -> Result<Value, String> {
    e.invoke(name, &params, &Invocation::default())
        .map(|o| o.result)
        .map_err(|er| format!("{}/{}: {}", er.code, er.reason, er.message))
}

fn ref_of(snapshot: &str, role: &str) -> Option<String> {
    snapshot
        .lines()
        .find(|l| l.contains(&format!("] {role}")))
        .and_then(|l| {
            let s = l.find("[e")? + 1;
            Some(l[s..l.find(']')?].to_string())
        })
}

#[test]
#[ignore = "needs Xvfb, a session bus with at-spi and gnome-text-editor: scripts/ci/linux-helper-direct-x11.sh"]
fn drives_a_gtk4_app_under_xvfb() {
    assert!(
        std::env::var_os("PSYCHE_E2E_X11").is_some(),
        "run through scripts/ci/linux-helper-direct-x11.sh"
    );
    let a11y = Arc::new(A11y::connect().expect("the accessibility bus"));
    let x11 = X11::connect().expect("the X display");
    let backend = Arc::new(LinuxBackend::new(a11y, Path::X11(x11.clone())));
    let dir = tempfile::tempdir().unwrap();
    let settings = dir.path().join("computer-use.json");
    std::fs::write(&settings, br#"{"version":1,"default":"interact"}"#).unwrap();
    let engine = Engine::new(backend.clone(), settings);

    // The app shows up on the accessibility bus under its desktop file id.
    let deadline = Instant::now() + Duration::from_secs(30);
    let app = loop {
        if let Some(a) = backend
            .apps()
            .into_iter()
            .find(|a| a.id.eq_ignore_ascii_case(APP))
        {
            break a;
        }
        assert!(
            Instant::now() < deadline,
            "gnome-text-editor never appeared on the accessibility bus; apps: {:?}",
            backend.apps()
        );
        std::thread::sleep(Duration::from_millis(250));
    };
    assert!(app.windows >= 1);

    let snap = call(
        &engine,
        "computer.ax_tree",
        json!({"app": APP, "session": "e2e", "format": "json"}),
    )
    .expect("snapshot");
    let text = snap["text"].as_str().unwrap().to_string();
    eprintln!("{text}");
    assert_eq!(snap["provenance"], "untrusted");
    assert_eq!(snap["header"]["bundleId"], "org.gnome.texteditor");
    let editor = ref_of(&text, "textarea")
        .or_else(|| ref_of(&text, "textfield"))
        .expect("a text area in the snapshot");

    // Type into the focused document and read it back through AT-SPI.
    let sentence = "hello from psyche, typed through XTest";
    let typed = call(
        &engine,
        "computer.type",
        json!({"text": sentence, "app": APP, "session": "e2e"}),
    )
    .expect("type");
    assert_eq!(typed["status"], "ok");
    std::thread::sleep(Duration::from_millis(400));
    assert!(
        x11.escape_grabbed(),
        "the Escape kill switch is armed during a session"
    );
    let value = call(&engine, "computer.ax_value", json!({"ref": editor})).expect("read back");
    assert!(
        value["value"].as_str().unwrap_or("").contains(sentence),
        "document is {value}"
    );

    // A screenshot of the app: a JPEG, nothing protected is open.
    call(
        &engine,
        "computer.ax_tree",
        json!({"app": APP, "session": "e2e"}),
    )
    .unwrap();
    let shot = call(
        &engine,
        "computer.screenshot",
        json!({"app": APP, "session": "e2e", "maxWidth": 640, "maxHeight": 400}),
    )
    .expect("screenshot");
    assert_eq!(shot["mimeType"], "image/jpeg");
    assert!(shot["width"].as_u64().unwrap() > 0);

    // A chord that quits the app needs an approval, and nothing was sent.
    let quit = call(
        &engine,
        "computer.key",
        json!({"keys": "cmd+q", "app": APP, "session": "e2e"}),
    )
    .unwrap_err();
    assert!(quit.contains("risky_chord"), "{quit}");

    // Ending the session releases the Escape grab.
    call(&engine, "computer.end_session", json!({"session": "e2e"})).unwrap();
    assert!(
        !x11.escape_grabbed(),
        "the Escape grab is released when the session ends"
    );
}
