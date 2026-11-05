//! Live integration tests against Notepad and Calculator. They move the mouse, type and press
//! keys, so they are `#[ignore]`d by default; run them on an unlocked desktop with:
//!
//! ```text
//! cargo test --test integration -- --ignored --test-threads=1
//! ```
//!
//! Safety: Notepad opens files in tabs of existing windows, so the Notepad tests open a dedicated
//! temp file and act only after checking that the foreground window's title names it; keys are
//! only sent after the capability itself verified its target is in the foreground.
#![cfg(windows)]
// Notepad and Calculator are launched and left running on purpose (the launcher may *be* the app).
#![allow(clippy::zombie_processes)]

use psyche_win_computer as wc;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Once;
use std::time::{Duration, Instant};
use wc::win::apps;

const SESSION: &str = "integration-run";

fn setup() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let home = std::env::temp_dir().join(format!("psyche-wc-it-{}", std::process::id()));
        std::fs::create_dir_all(home.join("config")).unwrap();
        std::fs::write(
            home.join("config").join("computer-use.json"),
            r#"{"version":1,"default":"ask","apps":{"notepad.exe":"interact","calculatorapp.exe":"interact"}}"#,
        )
        .unwrap();
        std::env::set_var("PSYCHE_HOME", &home);
        assert!(wc::start_hooks(), "the Esc / attention hooks must install");
        wake_display();
    });
}

/// Wakes the display (a suspended UWP app does not draw while it is off).
fn wake_display() {
    let (x, y) = wc::win::input::cursor();
    let _ = wc::win::input::move_to(x + 1.0, y);
    std::thread::sleep(Duration::from_millis(50));
    let _ = wc::win::input::move_to(x, y);
    std::thread::sleep(Duration::from_millis(500));
}

/// Releases a session when a test ends, passed or failed.
struct SessionGuard(&'static str);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        let _ = wc::computer_end_session(json!({"session": self.0}));
    }
}

/// A system prompt (UAC, firewall, file picker) dims the screen: mouse input cannot reach apps,
/// and the helper (correctly) refuses clicks as occluded. Such prompts are never touched here.
fn screen_dimmed() -> bool {
    let m = wc::win::capture::monitors().into_iter().find(|m| m.primary).unwrap();
    // A corner: the prompt itself sits in the middle of the dimmed screen.
    apps::window_at(m.rect.x + 40.0, m.rect.y + 40.0).map(|w| w.class == "Shell_SystemDim").unwrap_or(false)
}

fn wait_for<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if Instant::now() > deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// `[eN] role "label"` lines of a snapshot: (ref, role, label).
fn elements(text: &str) -> Vec<(String, String, Option<String>)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim_start();
            let rest = l.strip_prefix('[')?;
            let (r, rest) = rest.split_once("] ")?;
            let (role, rest) = rest.split_once(' ').unwrap_or((rest, ""));
            let label = rest.strip_prefix('"').and_then(|s| s.split_once('"')).map(|(l, _)| l.to_string());
            Some((r.to_string(), role.to_string(), label))
        })
        .collect()
}

fn find(text: &str, role: &str, label_has: &str) -> Option<(String, String, Option<String>)> {
    elements(text).into_iter().find(|(_, r, l)| r == role && l.as_deref().map(|l| l.contains(label_has)).unwrap_or(false))
}

/// `@x,y wxh` of the line for `r`.
fn frame_of(text: &str, r: &str) -> Option<[i64; 4]> {
    let line = text.lines().find(|l| l.trim_start().starts_with(&format!("[{r}]")))?;
    let at = line.rsplit_once(" @")?.1;
    let (xy, wh) = at.split_once(' ')?;
    let (x, y) = xy.split_once(',')?;
    let (w, h) = wh.split_once('x')?;
    Some([x.parse().ok()?, y.parse().ok()?, w.parse().ok()?, h.parse().ok()?])
}

fn snapshot(app: &str, window: Option<usize>) -> Value {
    let mut p = json!({"app": app, "session": SESSION, "maxEmit": 600});
    if let Some(w) = window {
        p["window"] = json!(w);
    }
    wc::computer_ax_tree(p).expect("ax_tree")
}

fn expect_of(e: &(String, String, Option<String>)) -> Value {
    match &e.2 {
        Some(l) => json!({"role": e.1, "label": l}),
        None => json!({"role": e.1}),
    }
}

// MARK: - Notepad

struct NotepadDoc {
    path: PathBuf,
    name: String,
}

impl NotepadDoc {
    fn open() -> NotepadDoc {
        close_test_tabs();
        let name = format!("psyche-wc-test-{}.txt", std::process::id());
        let path = std::env::temp_dir().join(&name);
        std::fs::write(&path, "").unwrap();
        std::process::Command::new("notepad.exe").arg(&path).spawn().expect("notepad");
        let doc = NotepadDoc { path, name };
        let ok = wait_for(Duration::from_secs(15), || doc.window_index());
        assert!(ok.is_some(), "Notepad did not show the test document");
        doc
    }

    /// Index of the Notepad window whose title (its active tab) names the test document.
    fn window_index(&self) -> Option<usize> {
        let app = apps::find_app(Some("notepad.exe"), None).ok()?;
        apps::app_windows(&app).iter().position(|w| w.title.contains(&self.name))
    }

    /// The test document's window must be the foreground window before any key goes out.
    fn assert_foreground(&self) {
        let fg = apps::foreground_window().expect("foreground");
        assert!(fg.title.contains(&self.name), "the foreground window is not the test document");
    }

    fn snapshot(&self) -> Value {
        snapshot("notepad.exe", self.window_index())
    }
}

/// Closes this test suite's own unmodified Notepad tabs (`psyche-wc-test-*`): selects each, then
/// clicks its own Close Tab button. Never touches any other tab.
fn close_test_tabs() {
    let click = |e: &(String, String, Option<String>)| {
        let _ = wc::computer_click(json!({"ref": e.0, "expect": expect_of(e), "session": SESSION}));
    };
    for _ in 0..40 {
        let Ok(app) = apps::find_app(Some("notepad.exe"), None) else { return };
        let mut acted = false;
        for (i, _) in apps::app_windows(&app).iter().enumerate() {
            let Ok(snap) = wc::computer_ax_tree(json!({"app": "notepad.exe", "window": i, "session": SESSION, "maxEmit": 400})) else {
                continue;
            };
            let text = snap["text"].as_str().unwrap_or("").to_string();
            let lines: Vec<&str> = text.lines().collect();
            // A Notepad dialog about one of this suite's files ("Cannot find …", "save changes
            // to …?"): dismiss it without saving. Dialogs about anything else are left alone.
            if let Some(d) = lines.iter().position(|l| l.contains("window:dialog")) {
                let depth = lines[d].len() - lines[d].trim_start().len();
                let body: Vec<&str> = lines[d + 1..].iter().take_while(|l| l.len() - l.trim_start().len() > depth).copied().collect();
                if body.iter().any(|l| l.contains("psyche-wc-test-")) {
                    let button = body.iter().map(|l| elements(l)).filter_map(|e| e.into_iter().next()).find(|(_, r, l)| {
                        let l = l.as_deref().unwrap_or("").to_lowercase();
                        r == "button" && (l == "ok" || (l.starts_with("don") && l.contains("save")))
                    });
                    if let Some(b) = button {
                        click(&b);
                        acted = true;
                        break;
                    }
                }
            }
            let Some(at) = lines.iter().position(|l| l.contains("radiobutton:tabButton \"psyche-wc-test-")) else { continue };
            let tab = elements(lines[at])[0].clone();
            if !lines[at].contains("=\"on\"") {
                let _ = wc::computer_press(json!({"ref": tab.0, "expect": expect_of(&tab), "action": "press", "session": SESSION}));
                acted = true;
                break;
            }
            if let Some(close) = lines[at + 1..].iter().take(2).find(|l| l.contains("button \"Close Tab\"")) {
                click(&elements(close)[0]);
                acted = true;
                break;
            }
            // Narrow tabs hide their Close button: Ctrl+W, only while the foreground window's
            // title (its active tab) is one of ours. Ctrl+W is a risky chord: approved here.
            let ours = apps::foreground_window().map(|w| w.title.contains("psyche-wc-test-") && w.pid == app.pid).unwrap_or(false);
            if ours {
                let _ = wc::computer_key(json!({
                    "keys": "cmd+w", "app": "notepad.exe", "session": SESSION,
                    "approvalId": "integration-cleanup", "approval": {"app": "notepad.exe", "tier": "interact"}
                }));
                acted = true;
                break;
            }
            // Bring that window forward first.
            if let Some(w) = apps::app_windows(&app).get(i) {
                let _ = apps::activate(&app, Some(w.hwnd), &wc::caps::cu().stop);
            }
            acted = true;
            break;
        }
        if !acted {
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

impl Drop for NotepadDoc {
    fn drop(&mut self) {
        close_test_tabs();
        // Keep the file while its tab is still open (closing then asks about a missing file).
        if self.window_index().is_none() {
            let _ = std::fs::remove_file(&self.path);
        }
        wc::computer_end_session(json!({"session": SESSION})).ok();
    }
}

#[test]
#[ignore]
fn notepad_tree_type_value_menu_and_screens() {
    setup();
    let doc = NotepadDoc::open();
    let snap = doc.snapshot();
    let text = snap["text"].as_str().unwrap();
    println!("{text}");
    assert!(snap["header"]["window"].as_str().unwrap().contains(&doc.name));
    assert_eq!(snap["provenance"], "untrusted");
    assert_eq!(snap["tier"], "interact");
    let area = find(text, "textarea", "Text editor").expect("text area");
    assert!(text.contains("menubaritem \"File\""));

    // 1. Type through SendInput (KEYEVENTF_UNICODE), then read back through ax_value.
    let typed = "Hello from Psyche: SendInput ✓ ünïcödé 😀";
    let r = wc::computer_type(json!({"ref": area.0, "expect": expect_of(&area), "text": typed, "session": SESSION})).expect("type");
    println!("type → {r}");
    assert_eq!(r["status"], "ok");
    assert_eq!(r["method"], "sendinput");
    doc.assert_foreground();
    let v = wc::computer_ax_value(json!({"ref": area.0})).expect("ax_value");
    assert_eq!(v["value"].as_str().unwrap().trim_end_matches(['\r', '\n']), typed);

    // 2. Replace through the Value pattern, verified by read-back.
    let set = "Set via ValuePattern: line one";
    let r =
        wc::computer_set_value(json!({"ref": area.0, "expect": expect_of(&area), "value": set, "session": SESSION})).expect("set_value");
    println!("set_value → {r}");
    assert_eq!(r["status"], "ok");
    assert!(r["detail"].as_str().unwrap().starts_with("verified after"));
    let v = wc::computer_ax_value(json!({"ref": area.0, "max": 10})).expect("ax_value");
    assert_eq!(v["value"], "Set via Va");

    // 3. A stale expectation is refused.
    let e =
        wc::computer_type(json!({"ref": area.0, "expect": {"role": "button", "label": "Text editor"}, "text": "x", "session": SESSION}))
            .unwrap_err();
    assert_eq!(e.reason, "expectation_failed");

    // 4. Menu through UI Automation (Notepad's XAML menu bar), then the selection in screen.context.
    doc.assert_foreground();
    let r = wc::computer_menu(json!({"app": "notepad.exe", "path": "Edit>Select all", "session": SESSION})).expect("menu");
    println!("menu → {r}");
    assert_eq!(r["status"], "ok");
    assert_eq!(r["method"], "menu");
    let e = wc::computer_menu(json!({"app": "notepad.exe", "path": "Edit>No such item", "session": SESSION})).unwrap_err();
    assert_eq!(e.reason, "menu_item_not_found");
    std::thread::sleep(Duration::from_millis(300));
    doc.assert_foreground();
    let ctx = wc::screen_context(json!({"mode": "window"})).expect("screen.context");
    let mut shown = ctx.clone();
    shown["image"] = json!("…");
    println!("screen.context → {shown}");
    assert_eq!(ctx["context"]["bundleId"], "notepad.exe");
    assert!(ctx["context"]["windowTitle"].as_str().unwrap().contains(&doc.name));
    assert_eq!(ctx["context"]["selectedText"], set);
    assert!(ctx["image"].as_str().map(|s| !s.is_empty()).unwrap_or(false));
    assert!(ctx["width"].as_u64().unwrap() > 0 && ctx["width"].as_u64().unwrap() <= 1600);
    assert!(ctx.get("refusal").is_none());

    // 5. Focus the text through UIA (typing with a ref), then chords through the mapping
    //    (cmd → Ctrl) and typed text with a line break (Return as a virtual key).
    let r = wc::computer_type(json!({"ref": area.0, "expect": expect_of(&area), "text": "x", "session": SESSION})).expect("type");
    assert_eq!(r["status"], "ok");
    doc.assert_foreground();
    let r = wc::computer_key(json!({"keys": "cmd+a", "app": "notepad.exe", "session": SESSION})).expect("key");
    assert_eq!(r["status"], "ok");
    let r = wc::computer_type(json!({"app": "notepad.exe", "text": format!("{set}\nsecond"), "session": SESSION})).expect("type");
    assert_eq!(r["status"], "ok");
    let r = wc::computer_key(json!({"keys": "cmd+end", "app": "notepad.exe", "session": SESSION})).expect("key");
    assert_eq!(r["status"], "ok");
    wc::computer_type(json!({"app": "notepad.exe", "text": " line", "session": SESSION})).expect("type");
    let v = wc::computer_ax_value(json!({"ref": area.0})).unwrap();
    let value = v["value"].as_str().unwrap().replace("\r\n", "\n").replace('\r', "\n");
    assert_eq!(value.trim_end(), format!("{set}\nsecond line"));

    // 6. Mouse: click, scroll, double-click (selects a word), drag (selects a range), right-click.
    //    Not while a system prompt dims the screen (clicks are refused as occluded then).
    if screen_dimmed() {
        println!("SKIPPED mouse steps: a system prompt (not ours) dims the screen; the helper refuses clicks as occluded");
        let e = wc::computer_click(json!({"ref": area.0, "expect": expect_of(&area), "session": SESSION})).unwrap_err();
        assert_eq!(e.reason, "occluded");
    } else {
        let r = wc::computer_click(json!({"ref": area.0, "expect": expect_of(&area), "session": SESSION})).expect("click");
        assert_eq!((r["status"].as_str(), r["method"].as_str()), (Some("ok"), Some("sendinput")), "{r}");
        let r = wc::computer_scroll(json!({"ref": area.0, "expect": expect_of(&area), "dy": -3, "session": SESSION})).expect("scroll");
        assert_eq!(r["status"], "ok");
        let r = wc::computer_double_click(json!({"ref": area.0, "expect": expect_of(&area), "session": SESSION})).expect("double_click");
        assert_eq!((r["status"].as_str(), r["method"].as_str()), (Some("ok"), Some("sendinput")));
        let frame = frame_of(doc.snapshot()["text"].as_str().unwrap(), &area.0).expect("text area frame");
        let (x0, y0) = (frame[0] as f64 + 20.0, frame[1] as f64 + 12.0);
        let r = wc::computer_drag(json!({
            "from": {"x": x0, "y": y0, "app": "notepad.exe"},
            "to": {"x": x0 + 120.0, "y": y0, "app": "notepad.exe"},
            "session": SESSION
        }))
        .expect("drag");
        assert_eq!(r["status"], "ok");
        let e = wc::computer_click(json!({"x": x0, "y": y0, "app": "calc.exe", "session": SESSION})).unwrap_err();
        assert_eq!(e.reason, "app_mismatch");
        let r = wc::computer_right_click(json!({"x": x0, "y": y0, "app": "notepad.exe", "session": SESSION})).expect("right_click");
        assert_eq!(r["status"], "ok");
        std::thread::sleep(Duration::from_millis(400));
        doc.assert_foreground();
        let r = wc::computer_key(json!({"keys": "escape", "app": "notepad.exe", "session": SESSION})).expect("escape closes the menu");
        assert_eq!(r["status"], "ok");
    }
    let frame = frame_of(doc.snapshot()["text"].as_str().unwrap(), &area.0).expect("text area frame");

    // 7. Screenshots: the window alone, and its monitor (both within the size bounds).
    let shot = wc::computer_screenshot(json!({"app": "notepad.exe", "windowOnly": true})).expect("window screenshot");
    let (w, h) = (shot["width"].as_f64().unwrap(), shot["height"].as_f64().unwrap());
    let screen = &shot["screen"];
    println!("window shot {w}x{h} of {screen} ppp={}", shot["pointsPerPixel"]);
    assert!(w <= 1372.0 && h <= 887.0 && w > 100.0);
    let aspect_img = w / h;
    let aspect_win = screen["width"].as_f64().unwrap() / screen["height"].as_f64().unwrap();
    assert!((aspect_img - aspect_win).abs() < 0.02, "aspect {aspect_img} vs {aspect_win}");
    assert_eq!(shot["mimeType"], "image/jpeg");
    let png =
        wc::computer_screenshot(json!({"app": "notepad.exe", "windowOnly": true, "format": "png", "maxWidth": 400, "maxHeight": 300}))
            .expect("png");
    assert!(png["width"].as_u64().unwrap() <= 400 && png["height"].as_u64().unwrap() <= 300);
    assert_eq!(png["mimeType"], "image/png");
    let full = wc::computer_screenshot(json!({"app": "notepad.exe"})).expect("monitor screenshot");
    let m = wc::win::capture::monitors().into_iter().find(|m| m.primary).unwrap();
    println!("monitor shot {}x{} of {} (monitor {:?} scale {})", full["width"], full["height"], full["screen"], m.rect, m.scale);
    assert_eq!(full["screen"]["width"].as_f64().unwrap(), m.rect.w);
    let expect = wc::hygiene::scaled_size(m.rect.w as u32, m.rect.h as u32, 1372, 887);
    assert_eq!((full["width"].as_u64().unwrap() as u32, full["height"].as_u64().unwrap() as u32), expect);
    let region =
        wc::screen_context(json!({"mode": "region", "rect": {"x": frame[0], "y": frame[1], "width": 300, "height": 200}})).expect("region");
    assert_eq!((region["width"].as_u64(), region["height"].as_u64()), (Some(300), Some(200)));

    // 8. Save and close only the test tab (its own Close Tab button).
    doc.assert_foreground();
    wc::computer_key(json!({"keys": "cmd+s", "app": "notepad.exe", "session": SESSION})).expect("save");
    std::thread::sleep(Duration::from_millis(500));
    assert_eq!(std::fs::read_to_string(&doc.path).unwrap().replace("\r\n", "\n").trim_end(), format!("{set}\nsecond line"));
    close_test_tabs();
    assert!(doc.window_index().is_none(), "the test tab is closed");
    wc::computer_end_session(json!({"session": SESSION})).unwrap();
}

// MARK: - Calculator

fn calculator() -> apps::TargetApp {
    let running = apps::find_app(Some("calculatorapp.exe"), None).ok().filter(|a| {
        apps::app_windows(a).iter().any(|w| !w.iconic)
            && snapshot("calculatorapp.exe", None)["text"].as_str().unwrap().contains("Display is")
    });
    if let Some(a) = running {
        return a;
    }
    std::process::Command::new("explorer.exe").arg("shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App").spawn().unwrap();
    wait_for(Duration::from_secs(20), || {
        let a = apps::find_app(Some("calculatorapp.exe"), None).ok()?;
        let snap = wc::computer_ax_tree(json!({"app": "calculatorapp.exe"})).ok()?;
        snap["text"].as_str()?.contains("Display is").then_some(a)
    })
    .expect("Calculator did not finish starting")
}

fn display(text: &str) -> String {
    text.lines().find_map(|l| l.split("\"Display is ").nth(1)).map(|s| s.split('"').next().unwrap_or("").to_string()).unwrap_or_default()
}

#[test]
#[ignore]
fn calculator_buttons_keys_and_window_shot() {
    let _session = SessionGuard(SESSION);
    setup();
    let app = calculator();
    let snap = snapshot("calculatorapp.exe", None);
    let text = snap["text"].as_str().unwrap();
    println!("{}", text.lines().take(40).collect::<Vec<_>>().join("\n"));
    assert_eq!(snap["header"]["bundleId"], "calculatorapp.exe");
    let button = |label: &str| {
        let t = snapshot("calculatorapp.exe", None);
        elements(t["text"].as_str().unwrap())
            .into_iter()
            .find(|(_, r, l)| r == "button" && l.as_deref() == Some(label))
            .unwrap_or_else(|| panic!("button {label}"))
    };
    // "Clear" is a risky label (mac RiskLabels): refused without an approval, done with one.
    let clear = button("Clear");
    let e = wc::computer_click(json!({"ref": clear.0, "expect": expect_of(&clear), "session": SESSION})).unwrap_err();
    assert_eq!((e.code, e.reason.as_str()), ("approval_required", "risky_label"));
    assert_eq!(e.details["label"], "Clear");
    let approved = json!({"app": "calculatorapp.exe", "tier": "interact"});
    let r = wc::computer_click(
        json!({"ref": clear.0, "expect": expect_of(&clear), "session": SESSION, "approvalId": "ap-clear", "approval": approved}),
    )
    .unwrap();
    assert_eq!(r["status"], "ok");
    // 7 + 8 = through UIA Invoke (computer.click's semantic path).
    for label in ["Seven", "Plus", "Eight", "Equals"] {
        let b = button(label);
        let r = wc::computer_click(json!({"ref": b.0, "expect": expect_of(&b), "session": SESSION})).expect(label);
        assert_eq!((r["status"].as_str(), r["method"].as_str()), (Some("ok"), Some("ax")), "{label}: {r}");
    }
    let t = snapshot("calculatorapp.exe", None);
    assert_eq!(display(t["text"].as_str().unwrap()), "15");

    // computer.press, then keys typed into the foreground Calculator (cmd vocabulary → VKs).
    let b = button("Nine");
    let e = wc::computer_press(json!({"ref": b.0, "expect": expect_of(&b), "action": "inc", "session": SESSION})).unwrap_err();
    assert_eq!(e.reason, "action_not_supported");
    let r = wc::computer_key(json!({"keys": "escape", "app": "calculatorapp.exe", "session": SESSION})).expect("escape clears");
    assert_eq!(r["status"], "ok");
    let r = wc::computer_press(json!({"ref": b.0, "expect": expect_of(&b), "action": "press", "session": SESSION})).unwrap();
    assert_eq!(r["status"], "ok");
    for k in ["-", "4", "return"] {
        let r = wc::computer_key(json!({"keys": k, "app": "calculatorapp.exe", "session": SESSION})).expect(k);
        assert_eq!(r["status"], "ok");
        assert!(apps::is_frontmost(&app));
    }
    let t = snapshot("calculatorapp.exe", None);
    assert_eq!(display(t["text"].as_str().unwrap()), "5");
    // A risky chord needs an approval; an approval for another app approves nothing.
    let e = wc::computer_key(json!({"keys": "alt+f4", "app": "calculatorapp.exe", "session": SESSION})).unwrap_err();
    assert_eq!(e.reason, "risky_chord");
    let e = wc::computer_key(json!({"keys": "alt+f4", "app": "calculatorapp.exe", "session": SESSION, "approvalId": "ap1", "approval": {"app": "notepad.exe", "tier": "interact"}})).unwrap_err();
    assert_eq!(e.reason, "approval_app_mismatch");

    let shot = wc::computer_screenshot(json!({"app": "calculatorapp.exe", "windowOnly": true})).expect("window shot");
    let w = apps::app_windows(&app).into_iter().find(|w| w.layer() == 0).unwrap();
    let expect = wc::hygiene::scaled_size(w.rect.w as u32, w.rect.h as u32, 1372, 887);
    let got = (shot["width"].as_u64().unwrap() as i64, shot["height"].as_u64().unwrap() as i64);
    println!("calculator shot {got:?}, window {:?}", w.rect);
    assert!((got.0 - expect.0 as i64).abs() <= 2 && (got.1 - expect.1 as i64).abs() <= 2, "{got:?} vs {expect:?}");

    // Close through the frame's own Close button (an ApplicationFrameHost element).
    let close = button("Close Calculator");
    let r = wc::computer_click(json!({"ref": close.0, "expect": expect_of(&close), "session": SESSION})).expect("close");
    assert_eq!(r["status"], "ok");
    wc::computer_end_session(json!({"session": SESSION})).unwrap();
}

// MARK: - Esc stop, policy

fn send_foreign_escape() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let ev = |up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                wScan: 1,
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe { SendInput(&[ev(false), ev(true)], std::mem::size_of::<INPUT>() as i32) };
}

#[test]
#[ignore]
fn esc_hook_stops_the_session_and_in_flight_actions() {
    let _session = SessionGuard(SESSION);
    let _ = wc::computer_end_session(json!({"session": SESSION}));
    setup();
    let app = calculator();
    let session = "esc-test-run";
    // The helper's own Esc (marked) never trips the stop.
    let before = wc::win::hooks::esc_stop_count();
    wc::computer_key(json!({"keys": "escape", "app": "calculatorapp.exe", "session": session})).expect("own escape");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(wc::win::hooks::esc_stop_count(), before, "the helper's own Esc must not stop it");
    assert!(apps::is_frontmost(&app), "Esc below must reach Calculator only if the hook fails");

    // An in-flight action is stopped by the user's Esc within one step.
    let worker =
        std::thread::spawn(move || wc::computer_key(json!({"keys": "1", "app": "calculatorapp.exe", "session": session, "repeat": 50})));
    std::thread::sleep(Duration::from_millis(400));
    let pressed = Instant::now();
    send_foreign_escape();
    let r = worker.join().unwrap();
    let stopped_in = pressed.elapsed();
    let e = r.expect_err("the in-flight key repeat must stop");
    println!("stopped in {stopped_in:?}: {}", e.to_wire());
    assert_eq!((e.code, e.reason.as_str()), ("cancelled", "user_stopped"));
    assert!(stopped_in < Duration::from_millis(400), "Esc must stop within a few steps ({stopped_in:?})");
    assert_eq!(wc::win::hooks::esc_stop_count(), before + 1);
    // The session is over for good; a new run (new session id) starts clean.
    let e = wc::computer_key(json!({"keys": "1", "app": "calculatorapp.exe", "session": session})).unwrap_err();
    assert_eq!(e.reason, "user_stopped");
    wc::computer_key(json!({"keys": "escape", "app": "calculatorapp.exe", "session": "esc-test-run-2"})).expect("a new session works");
    wc::computer_end_session(json!({"session": "esc-test-run-2"})).unwrap();
    // Outside a session the user's Esc passes through untouched.
    send_foreign_escape();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(wc::win::hooks::esc_stop_count(), before + 1);
    // The attention monitor saw no owner input from any of this (all injected).
    println!("last owner input: {:?}", wc::win::hooks::last_owner_input());
}

#[test]
#[ignore]
fn policy_uipi_and_refusals() {
    let _session = SessionGuard(SESSION);
    setup();
    // UIPI: our own integrity is medium (or higher); a system process is refused.
    let mine = apps::integrity_level(apps::own_pid()).expect("own integrity level");
    assert!(mine >= 0x2000);
    let pid =
        std::process::Command::new("tasklist").args(["/FI", "IMAGENAME eq winlogon.exe", "/FO", "CSV", "/NH"]).output().ok().and_then(
            |o| {
                let s = String::from_utf8_lossy(&o.stdout).to_string();
                s.split(',').nth(1).and_then(|p| p.trim_matches('"').parse::<u32>().ok())
            },
        );
    if let Some(pid) = pid {
        let app = apps::TargetApp {
            pid,
            host_pid: None,
            bundle_id: Some("winlogon.exe".into()),
            name: "winlogon".into(),
            electron: false,
            exe_path: None,
        };
        let e = apps::check_uipi(&app).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), ("forbidden", "target_elevated"));
    }
    // A session is required for actions; tiers refuse apps that are off.
    let e = wc::computer_key(json!({"keys": "a", "app": "notepad.exe"})).unwrap_err();
    assert_eq!(e.reason, "invalid_params");
    let e = wc::computer_ax_tree(json!({"app": "explorer.exe"})).unwrap_err();
    assert_eq!((e.code, e.reason.as_str()), ("approval_required", "tier_ask"));
    let e = wc::computer_ax_value(json!({"ref": "e999999"})).unwrap_err();
    assert_eq!(e.reason, "unknown_ref");
    let e = wc::computer_type(json!({"app": "notepad.exe", "text": "{{cred:github}}", "session": SESSION})).unwrap_err();
    assert_eq!(e.reason, "credential_placeholder");
    // Specs are data the core maps 1:1.
    assert_eq!(wc::specs().len(), 17);
    wc::computer_end_session(json!({"session": SESSION})).unwrap();
}
