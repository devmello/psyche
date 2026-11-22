//! The helper's own registry on the X11 path: the capabilities `direct::register` declares,
//! invoked the way the node session invokes them, against a real GTK 4 app under Xvfb. Run
//! through `scripts/ci/linux-helper-direct-x11.sh`.
#![cfg(target_os = "linux")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use psyche_helper::buildinfo::BuildInfo;
use psyche_helper::capability::{CapabilityError, InvocationContext, Registry};
use serde_json::{json, Value};

fn invoke(r: &Registry, name: &str, params: Value) -> Result<Value, CapabilityError> {
    let ctx = InvocationContext {
        invocation_id: "i1".into(),
        capability: name.into(),
        params,
        approval_id: None,
        emit: Arc::new(|_| {}),
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    r.get(name)
        .unwrap_or_else(|| panic!("{name} is not registered"))
        .invoke(&ctx)
}

#[test]
#[ignore = "needs Xvfb, a session bus with at-spi and gnome-text-editor: scripts/ci/linux-helper-direct-x11.sh"]
fn the_registry_drives_a_gtk4_app() {
    assert!(
        std::env::var_os("PSYCHE_E2E_X11").is_some(),
        "run through scripts/ci/linux-helper-direct-x11.sh"
    );
    // The helper reads its tiers from $PSYCHE_HOME/config/computer-use.json, like on the Mac.
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("config")).unwrap();
    std::fs::write(
        home.path().join("config/computer-use.json"),
        br#"{"version":1,"default":"interact"}"#,
    )
    .unwrap();
    std::env::set_var("PSYCHE_HOME", home.path());
    std::env::set_var("PSYCHE_HELPER_STATE", home.path().join("state"));

    let mut registry = Registry::standard(BuildInfo::current());
    psyche_helper::direct::register(&mut registry);

    // apps.list names the editor by its desktop file id and says which tier is in effect.
    let deadline = Instant::now() + Duration::from_secs(30);
    let app = loop {
        let list = invoke(&registry, "apps.list", json!({})).expect("apps.list");
        if let Some(a) = list["apps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["bundleId"] == "org.gnome.texteditor")
        {
            break a.clone();
        }
        assert!(Instant::now() < deadline, "the editor never listed: {list}");
        std::thread::sleep(Duration::from_millis(250));
    };
    assert_eq!(app["tier"], "interact");

    let snap = invoke(
        &registry,
        "computer.ax_tree",
        json!({"app": "org.gnome.TextEditor", "session": "s", "maxEmit": 100}),
    )
    .expect("snapshot");
    assert!(snap["text"].as_str().unwrap().contains("textarea"));

    // A second session cannot drive at the same time.
    let first = invoke(
        &registry,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s"}),
    );
    assert!(first.is_ok(), "{first:?}");
    let err = invoke(
        &registry,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "other"}),
    )
    .unwrap_err();
    let payload = serde_json::to_value(err.payload()).unwrap();
    assert_eq!(payload["details"]["reason"], "computer_busy");
    invoke(&registry, "computer.end_session", json!({"session": "s"})).unwrap();

    // A tier refusal carries the details the Gateway turns into a card.
    std::fs::write(
        home.path().join("config/computer-use.json"),
        br#"{"version":1,"default":"ask"}"#,
    )
    .unwrap();
    let ask = invoke(
        &registry,
        "computer.ax_tree",
        json!({"app": "org.gnome.TextEditor"}),
    )
    .unwrap_err();
    let p = serde_json::to_value(ask.payload()).unwrap();
    assert_eq!(p["code"], "approval_required");
    assert_eq!(p["details"]["app"], "org.gnome.texteditor");
    assert_eq!(p["details"]["tierRequired"], "read");

    // portal.status on X11: no portal, the X11 warning.
    let status = invoke(&registry, "portal.status", json!({})).unwrap();
    assert_eq!(status["backend"], "x11");
    assert_eq!(status["warnings"], json!(["x11"]));
}
