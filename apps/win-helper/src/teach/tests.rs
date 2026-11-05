//! Controller and capability tests (ports of the mac `TeachControllerTests`), plus a live
//! recording against a Notepad tab the test opens.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde_json::{Value, json};

use super::session::{KeyMods, TeachInput, TeachKey, TeachTarget};
use super::*;
use crate::node::paths::Env;
use crate::node::{InvocationContext, Runtime};

/// A fake input stream.
#[derive(Clone, Default)]
struct FakeSource {
    on_input: Arc<Mutex<Option<OnInput>>>,
    started: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    deny: bool,
}

impl InputSource for FakeSource {
    fn start(&mut self, on_input: OnInput) -> bool {
        if self.deny {
            return false;
        }
        *self.on_input.lock().unwrap() = Some(on_input);
        self.started.store(true, Ordering::SeqCst);
        true
    }
    fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}

impl FakeSource {
    fn send(&self, i: TeachInput) {
        let f = self.on_input.lock().unwrap().clone();
        if let Some(f) = f {
            f(i, SystemTime::now());
        }
    }
}

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<Value>>>);

impl Events {
    fn emit(&self) -> Emit {
        let e = self.0.clone();
        Arc::new(move |v| e.lock().unwrap().push(v))
    }
    fn steps(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "teach.step")
            .cloned()
            .collect()
    }
}

fn notes_button() -> TeachTarget {
    TeachTarget::new(
        "notepad.exe",
        "Notepad",
        Some("Notes"),
        Some("AXButton"),
        None,
        Some("New Note"),
        None,
    )
}
fn body() -> TeachTarget {
    TeachTarget::new(
        "notepad.exe",
        "Notepad",
        Some("Notes"),
        Some("AXTextArea"),
        None,
        Some("Body"),
        None,
    )
}
fn click(button: u8, t: TeachTarget) -> TeachInput {
    TeachInput::Click {
        button,
        click_count: 1,
        target: Some(t),
    }
}
fn char_key(c: char, t: TeachTarget) -> TeachInput {
    TeachInput::Key {
        key: TeachKey {
            vk: 0,
            extended: false,
            characters: c.to_string(),
            mods: KeyMods::default(),
        },
        target: Some(t),
    }
}
fn no_shots() -> Screenshotter {
    Arc::new(|_| None)
}
fn controller(source: FakeSource, shot: Screenshotter) -> Arc<TeachController> {
    TeachController::new(move || Box::new(source.clone()), shot, HelperLog::quiet())
}
async fn settle() {
    tokio::time::sleep(Duration::from_millis(150)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn record_stream_stop_and_review_draft() {
    let source = FakeSource::default();
    let shot: Screenshotter = Arc::new(|app| {
        (app == "notepad.exe").then(|| (vec![0xFF, 0xD8, 0xFF], "image/jpeg".to_owned()))
    });
    let teach = controller(source.clone(), shot);
    let events = Events::default();
    let p = StartParams {
        name: Some("new-note".into()),
        description: Some("Make a note".into()),
        screenshots: Some(true),
        ..Default::default()
    };
    let id = teach.begin(p, events.emit()).unwrap();
    assert!(
        id.starts_with("teach-") && id.len() == "teach-".len() + 12,
        "{id}"
    );
    let busy = teach
        .begin(StartParams::default(), events.emit())
        .unwrap_err();
    assert_eq!(busy.reason, "teach_busy");
    assert_eq!(teach.status()["active"], true);
    source.send(click(0, notes_button()));
    for c in "Groceries".chars() {
        source.send(char_key(c, body()));
    }
    settle().await;
    let t2 = teach.clone();
    let wid = id.clone();
    let waiter = tokio::spawn(async move { t2.wait(&wid).await });
    settle().await;
    let draft = teach.end(&id, End::Stop).unwrap();
    assert_eq!(waiter.await.unwrap(), draft);
    assert!(source.stopped.load(Ordering::SeqCst));
    assert_eq!(
        (
            draft["endedBy"].as_str(),
            draft["name"].as_str(),
            draft["description"].as_str()
        ),
        (Some("stop"), Some("new-note"), Some("Make a note"))
    );
    let steps = draft["steps"].as_array().unwrap();
    assert_eq!(
        steps
            .iter()
            .map(|s| s["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["click", "type"]
    );
    assert!(
        steps.iter().all(|s| s.get("screenshot").is_none()),
        "no bytes in the draft"
    );
    let files = draft["files"].as_array().unwrap();
    assert_eq!(files[0]["path"], "SKILL.md");
    assert!(
        files[0]["text"]
            .as_str()
            .unwrap()
            .contains(r#"Type "Groceries" into the textarea "Body"."#)
    );
    assert!(
        files
            .iter()
            .any(|f| f["path"] == "screens/step-1.jpg" && f["fromStep"] == 1),
        "{files:?}"
    );
    // The streamed click carried its screenshot bytes.
    let click_event = events
        .steps()
        .into_iter()
        .find(|e| e["step"]["kind"] == "click")
        .unwrap();
    assert_eq!(click_event["step"]["screenshot"]["base64"], "/9j/");
    assert_eq!(click_event["sessionId"], id);
    assert_eq!(teach.status()["active"], false);
    assert_eq!(teach.end(&id, End::Stop).unwrap(), draft, "idempotent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_keeps_nothing_and_limits_end() {
    let source = FakeSource::default();
    let teach = controller(source.clone(), no_shots());
    let id = teach
        .begin(StartParams::default(), Events::default().emit())
        .unwrap();
    source.send(click(0, notes_button()));
    settle().await;
    let draft = teach.end(&id, End::Cancel).unwrap();
    assert_eq!(draft["endedBy"], "cancel");
    assert!(
        draft["steps"].as_array().unwrap().is_empty()
            && draft["files"].as_array().unwrap().is_empty()
    );

    let limited = FakeSource::default();
    let teach2 = controller(limited.clone(), no_shots());
    let id2 = teach2
        .begin(
            StartParams {
                max_steps: Some(2),
                ..Default::default()
            },
            Events::default().emit(),
        )
        .unwrap();
    let t2 = teach2.clone();
    let wid = id2.clone();
    let waiter = tokio::spawn(async move { t2.wait(&wid).await });
    settle().await;
    limited.send(click(0, notes_button()));
    limited.send(click(1, notes_button()));
    let d = tokio::time::timeout(Duration::from_secs(5), waiter)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(d["endedBy"], "limit");
    assert_eq!(d["steps"].as_array().unwrap().len(), 2);
    assert!(limited.stopped.load(Ordering::SeqCst));
    // Input after the end is ignored.
    limited.send(click(0, notes_button()));
    assert_eq!(
        teach2.end(&id2, End::Stop).unwrap()["steps"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn refusals_timeout_and_capability_shapes() {
    let denied = controller(
        FakeSource {
            deny: true,
            ..Default::default()
        },
        no_shots(),
    );
    let e = denied
        .begin(StartParams::default(), Events::default().emit())
        .unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::Forbidden, "permission_missing")
    );
    assert_eq!(denied.status()["active"], false);
    let bad = denied
        .begin(
            StartParams {
                name: Some("Bad Name".into()),
                ..Default::default()
            },
            Events::default().emit(),
        )
        .unwrap_err();
    assert_eq!(bad.details["field"], "name");
    assert!(denied.wait("teach-nope").await.get("error").is_some());

    // maxSeconds is clamped to at least 10 s; the timer ends the session as `timeout`.
    tokio::time::pause();
    let source = FakeSource::default();
    let teach = controller(source, no_shots());
    let id = teach
        .begin(
            StartParams {
                max_seconds: Some(1),
                ..Default::default()
            },
            Events::default().emit(),
        )
        .unwrap();
    tokio::time::advance(Duration::from_secs(9)).await;
    tokio::task::yield_now().await;
    assert_eq!(teach.active_id().as_deref(), Some(id.as_str()));
    tokio::time::advance(Duration::from_secs(2)).await;
    let d = teach.wait(&id).await;
    assert_eq!(d["endedBy"], "timeout");
    tokio::time::resume();

    let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
    register_with(&mut reg, controller(FakeSource::default(), no_shots()));
    assert_eq!(
        reg.names(),
        ["teach.start", "teach.stop", "teach.cancel", "teach.status"]
    );
    let start = reg.get("teach.start").unwrap();
    assert!(start.spec.streaming);
    assert_eq!(start.spec.receipt_kind.as_deref(), Some("teach"));
    assert_eq!(start.spec.permissions, [OsPermission::Accessibility]);
    assert_eq!(start.spec.side_effect, SideEffect::Write);
    assert_eq!(
        reg.get("teach.stop").unwrap().spec.side_effect,
        SideEffect::None
    );
    assert_eq!(
        reg.get("teach.status").unwrap().spec.side_effect,
        SideEffect::Read
    );
    let m = start.spec.manifest_entry();
    assert_eq!(
        m["inputSchema"]["properties"]["maxSteps"]["maximum"].as_f64(),
        Some(200.0)
    );
    assert_eq!(m["inputSchema"]["additionalProperties"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_streams_and_dropping_the_invocation_cancels_the_recording() {
    let source = FakeSource::default();
    let teach = controller(source.clone(), no_shots());
    let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
    register_with(&mut reg, teach.clone());
    let start = reg.get("teach.start").unwrap();
    let events = Events::default();
    let e = events.0.clone();
    let ctx = InvocationContext::new(
        "inv1",
        "teach.start",
        json!({}),
        None,
        Arc::new(move |v| e.lock().unwrap().push(v)),
    );
    let running = tokio::spawn((start.handler)(ctx));
    settle().await;
    let id = teach.active_id().expect("recording");
    assert_eq!(
        events.0.lock().unwrap()[0],
        json!({ "type": "teach.started", "sessionId": id })
    );
    source.send(click(0, notes_button()));
    settle().await;
    assert_eq!(events.steps().len(), 1);
    // teach.stop through its capability returns the draft; teach.start resolves with it too.
    let stop = reg.get("teach.stop").unwrap();
    let stopped = (stop.handler)(InvocationContext::detached(
        "teach.stop",
        json!({ "sessionId": id }),
    ))
    .await
    .unwrap();
    let out = running.await.unwrap().unwrap();
    assert_eq!(out.result, stopped.result);
    assert_eq!(
        out.receipt.unwrap().summary,
        "Recorded a demonstration (1 steps)"
    );
    let gone = (stop.handler)(InvocationContext::detached(
        "teach.stop",
        json!({ "sessionId": "teach-x" }),
    ))
    .await
    .unwrap_err();
    assert_eq!(gone.reason, "teach_not_found");

    // The invocation goes away (node.cancel, a dropped connection): the recording is cancelled.
    let ctx = InvocationContext::new("inv2", "teach.start", json!({}), None, Arc::new(|_| {}));
    let running = tokio::spawn((start.handler)(ctx));
    settle().await;
    let id = teach.active_id().expect("recording");
    running.abort();
    let _ = running.await;
    assert_eq!(teach.active_id(), None);
    assert_eq!(teach.end(&id, End::Stop).unwrap()["endedBy"], "cancel");
}

// MARK: - Live

/// Live: the real hooks record a Notepad tab this test opens. Hardware input cannot be produced
/// by a test, so the owner's clicks and keys are simulated at the hook boundary (the same channel
/// the hooks feed), while real injected input (a click and a key through `SendInput`) is sent to
/// the same tab to prove the hooks ignore it. Targets come from live UI Automation lookups.
/// Nothing is typed into the document; the tab is closed and the file deleted afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
// Notepad keeps running (the launcher may be an existing instance); the crate's errors are big.
#[allow(clippy::zombie_processes, clippy::result_large_err)]
async fn live_records_a_notepad_tab_and_ignores_injected_input() {
    use psyche_win_computer as wc;
    use wc::win::apps;

    // A system prompt dims the screen: never touched.
    let m = wc::win::capture::monitors()
        .into_iter()
        .find(|m| m.primary)
        .unwrap();
    if apps::window_at(m.rect.x + 40.0, m.rect.y + 40.0)
        .is_some_and(|w| w.class == "Shell_SystemDim")
    {
        eprintln!("skipped: the screen is dimmed by a system prompt");
        return;
    }
    let name = format!("psyche-teach-live-{}.txt", std::process::id());
    let path = std::env::temp_dir().join(&name);
    std::fs::write(&path, "teach live test\n").unwrap();
    std::process::Command::new("notepad.exe")
        .arg(&path)
        .spawn()
        .expect("notepad");
    let ours = || apps::foreground_window().filter(|w| w.title.contains(&name));
    let mut fg = None;
    for _ in 0..60 {
        fg = ours();
        if fg.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let fg = fg.expect("the test document is the foreground window");
    let (cx, cy) = (
        (fg.rect.x + fg.rect.w / 2.0) as i32,
        (fg.rect.y + fg.rect.h * 0.6) as i32,
    );
    const SESSION: &str = "teach-live";
    let approval = json!({ "app": "notepad.exe", "tier": "interact" });

    let events = Events::default();
    let teach = TeachController::new(
        || Box::new(recorder::LiveTeachInput::default()),
        no_shots(),
        HelperLog::quiet(),
    );
    let id = teach.begin(StartParams::default(), events.emit()).unwrap();
    assert!(recorder::is_recording());
    let started = std::time::Instant::now();

    // Injected input into our tab: a click in the editor and End (moves the caret, edits nothing).
    let clicked = tokio::task::spawn_blocking(move || {
        wc::computer_click(json!({ "x": cx, "y": cy, "app": "notepad.exe", "session": SESSION, "approvalId": "teach-live", "approval": approval.clone() }))
            .and_then(|_| wc::computer_key(json!({ "keys": "end", "app": "notepad.exe", "session": SESSION, "approvalId": "teach-live", "approval": approval })))
    })
    .await
    .unwrap();
    assert!(clicked.is_ok(), "{clicked:?}");
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        teach.status()["steps"],
        0,
        "injected input is never recorded"
    );

    // The owner's input, at the hook boundary.
    assert!(ours().is_some(), "still our tab in front");
    recorder::simulate_click(0, cx, cy);
    for vk in [0x48u16, 0x49] {
        recorder::simulate_key(vk, KeyMods::default()); // h, i
    }
    recorder::simulate_key(0x0D, KeyMods::default()); // Return
    recorder::simulate_key(
        0x53,
        KeyMods {
            ctrl: true,
            ..Default::default()
        },
    ); // Ctrl+S
    for _ in 0..40 {
        if teach.status()["steps"].as_u64() == Some(4) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let draft = teach.end(&id, End::Stop).unwrap();
    let elapsed = started.elapsed();
    assert!(!recorder::is_recording(), "hooks removed");
    let steps = draft["steps"].as_array().unwrap().clone();
    println!("{}", serde_json::to_string_pretty(&steps).unwrap());
    println!(
        "recorded {} steps in {elapsed:?}; {} events",
        steps.len(),
        events.steps().len()
    );
    let kinds: Vec<&str> = steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["click", "type", "press", "press"]);
    for s in &steps {
        assert_eq!(s["target"]["app"], "notepad.exe", "{s}");
        assert!(s["target"]["window"].as_str().unwrap().contains(&name));
    }
    assert!(
        steps[0]["target"]["role"]
            .as_str()
            .unwrap()
            .starts_with("AX")
    );
    assert_eq!(steps[1]["text"], "hi");
    assert_eq!(
        (steps[2]["keys"].as_str(), steps[3]["keys"].as_str()),
        (Some("return"), Some("ctrl+s"))
    );
    assert_eq!(events.steps().len(), 4);
    let md = draft["files"][0]["text"].as_str().unwrap();
    assert!(md.contains("Notepad (`notepad.exe`)") && md.contains("Type \"hi\" into the"));

    // Cleanup: close our (unmodified) tab, only while its title is in front; delete the file.
    let approval = json!({ "app": "notepad.exe", "tier": "interact" });
    for _ in 0..10 {
        if ours().is_none() {
            break;
        }
        let a = approval.clone();
        let _ = tokio::task::spawn_blocking(move || {
            wc::computer_key(json!({ "keys": "cmd+w", "app": "notepad.exe", "session": SESSION, "approvalId": "teach-live", "approval": a }))
        })
        .await;
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    let _ = wc::computer_end_session(json!({ "session": SESSION }));
    let still_open = apps::find_app(Some("notepad.exe"), None)
        .ok()
        .is_some_and(|a| {
            apps::app_windows(&a)
                .iter()
                .any(|w| w.title.contains(&name))
        });
    assert!(!still_open, "the test tab was closed");
    let _ = std::fs::remove_file(&path);
}
