//! Controller and capability tests (ports of the mac `TeachControllerTests`), plus a live
//! recording against a Win32 window the test owns.

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

/// Env var that turns [`live_window_host`] (run in a child process of this test binary) into the
/// owner of the window the live recording targets; its value is the window title.
const LIVE_WINDOW_ENV: &str = "PSYCHE_TEACH_LIVE_WINDOW";

/// A plain Win32 window with a multi-line EDIT control, run until it is closed. Used only by the
/// live test, in its own process: computer use never acts on its own process, and opening a
/// file in Notepad would land in a tab of the owner's existing Notepad window.
mod live_window {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, ES_AUTOVSCROLL,
        ES_MULTILINE, ES_WANTRETURN, GWLP_USERDATA, GetClientRect, GetMessageW, GetWindowLongPtrW,
        MSG, MoveWindow, PostQuitMessage, RegisterClassW, SW_SHOWNORMAL, SetForegroundWindow,
        SetWindowLongPtrW, ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CLOSE,
        WM_DESTROY, WM_SIZE, WNDCLASSW, WS_CHILD, WS_EX_CLIENTEDGE, WS_OVERLAPPEDWINDOW,
        WS_VISIBLE, WS_VSCROLL,
    };
    use windows::core::{HSTRING, w};

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_SIZE => {
                    let edit = HWND(GetWindowLongPtrW(h, GWLP_USERDATA) as *mut _);
                    let mut r = Default::default();
                    if !edit.0.is_null() && GetClientRect(h, &mut r).is_ok() {
                        let _ = MoveWindow(edit, 0, 0, r.right, r.bottom, true);
                    }
                    LRESULT(0)
                }
                WM_CLOSE => {
                    let _ = DestroyWindow(h);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(h, msg, wp, lp),
            }
        }
    }

    pub fn run(title: &str) {
        unsafe {
            let instance = GetModuleHandleW(None).expect("module").into();
            let class = w!("PsycheTeachLiveWindow");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(proc),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&wc), 0, "RegisterClassW");
            let main = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                &HSTRING::from(title),
                WS_OVERLAPPEDWINDOW,
                160,
                160,
                640,
                420,
                None,
                None,
                Some(instance),
                None,
            )
            .expect("window");
            let edit = CreateWindowExW(
                WS_EX_CLIENTEDGE,
                w!("EDIT"),
                w!("teach live test\r\n"),
                WS_CHILD
                    | WS_VISIBLE
                    | WS_VSCROLL
                    | WINDOW_STYLE((ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN) as u32),
                0,
                0,
                100,
                100,
                Some(main),
                None,
                Some(instance),
                None,
            )
            .expect("edit");
            SetWindowLongPtrW(main, GWLP_USERDATA, edit.0 as isize);
            let _ = ShowWindow(main, SW_SHOWNORMAL);
            let _ = SetForegroundWindow(main);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

/// Not a test of its own: the window [`live_records_an_owned_window_and_ignores_injected_input`]
/// starts in a child process of this binary (`LIVE_WINDOW_ENV` set). Returns at once otherwise.
#[test]
#[ignore]
fn live_window_host() {
    if let Ok(title) = std::env::var(LIVE_WINDOW_ENV) {
        live_window::run(&title);
    }
}

/// Ends the window host: WM_CLOSE to its window, then the process if it lingers.
struct WindowHostGuard(std::process::Child);
impl Drop for WindowHostGuard {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
        let pid = self.0.id();
        for w in psyche_win_computer::win::apps::top_windows() {
            if w.pid == pid {
                unsafe {
                    let _ =
                        PostMessageW(Some(HWND(w.hwnd as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
            }
        }
        for _ in 0..30 {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Live: the real hooks record a window this test owns (a plain Win32 window with an EDIT
/// control, in a child process of this binary). Hardware input cannot be produced by a test, so
/// the owner's clicks and keys are simulated at the hook boundary (the same channel the hooks
/// feed), while real injected input (a click and a key through `SendInput`) is sent to the same
/// window, only after checking it is in front, to prove the hooks ignore it. Targets come from
/// live UI Automation lookups. The window is closed afterwards; no other window is touched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
// The crate's errors are big.
#[allow(clippy::result_large_err)]
async fn live_records_an_owned_window_and_ignores_injected_input() {
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
    let name = format!("Psyche teach live {}", std::process::id());
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "teach::tests::live_window_host",
            "--exact",
            "--ignored",
            "--test-threads=1",
        ])
        .env(LIVE_WINDOW_ENV, &name)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("window host");
    let host_pid = child.id();
    let guard = WindowHostGuard(child);
    let mine = |w: &apps::WinInfo| w.pid == host_pid && w.title == name;
    let mut window = None;
    for _ in 0..60 {
        window = apps::top_windows().into_iter().find(|w| mine(w));
        if window.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let window = window.expect("the test window opened");
    let app = apps::app_for_window(&window).expect("the test window's app");
    let app_id = app.bundle_id.clone().expect("app id");
    assert_eq!(app.pid, host_pid);

    // Bring it forward (the foreground lock may refuse a background process) and check.
    let hwnd = window.hwnd;
    let a = app.clone();
    let activated = tokio::task::spawn_blocking(move || {
        apps::activate(&a, Some(hwnd), &wc::tiers::StopSignal::new())
    })
    .await
    .unwrap();
    let ours = move || apps::foreground_window().filter(|w| w.pid == host_pid && w.hwnd == hwnd);
    assert!(
        activated.is_ok() && ours().is_some(),
        "the test window is the foreground window: {activated:?}"
    );
    let fg = ours().unwrap();
    let (cx, cy) = (
        (fg.rect.x + fg.rect.w / 2.0) as i32,
        (fg.rect.y + fg.rect.h * 0.6) as i32,
    );
    const SESSION: &str = "teach-live";
    let approval = json!({ "app": app_id, "tier": "interact" });

    let events = Events::default();
    let teach = TeachController::new(
        || Box::new(recorder::LiveTeachInput::default()),
        no_shots(),
        HelperLog::quiet(),
    );
    let id = teach.begin(StartParams::default(), events.emit()).unwrap();
    assert!(recorder::is_recording());
    let started = std::time::Instant::now();

    // Injected input into our window, which is in front (checked above, and again by
    // computer.click): a click in the editor and End (moves the caret, edits nothing).
    assert!(ours().is_some(), "our window in front before any input");
    let target = app_id.clone();
    let clicked = tokio::task::spawn_blocking(move || {
        wc::computer_click(json!({ "x": cx, "y": cy, "app": target, "session": SESSION, "approvalId": "teach-live", "approval": approval.clone() }))
            .and_then(|_| wc::computer_key(json!({ "keys": "end", "app": target, "session": SESSION, "approvalId": "teach-live", "approval": approval })))
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
    assert!(ours().is_some(), "still our window in front");
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
    let _ = wc::computer_end_session(json!({ "session": SESSION }));
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
        assert_eq!(s["target"]["app"], json!(app_id), "{s}");
        assert_eq!(s["target"]["window"], json!(name), "{s}");
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
    assert!(
        md.contains(&format!("(`{app_id}`)")) && md.contains("Type \"hi\" into the"),
        "{md}"
    );

    // Cleanup: close our window and end its process.
    drop(guard);
    assert!(
        !apps::top_windows().iter().any(|w| w.pid == host_pid),
        "the test window was closed"
    );
}
