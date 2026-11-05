//! Engine tests against the fake desktop: every check below the model, in the order a call meets
//! it. The fake logs each backend call, so "nothing was sent" is asserted, not assumed.

use crate::engine::{Engine, Invocation};
use crate::fake::*;
use crate::roles::role;
use crate::snapshot::Rect;
use serde_json::{json, Value};
use std::sync::Arc;

struct Rig {
    fake: Arc<Fake>,
    engine: Arc<Engine<Fake>>,
    _dir: tempfile::TempDir,
}

fn rig(settings: Value) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("computer-use.json");
    std::fs::write(&path, serde_json::to_vec(&settings).unwrap()).unwrap();
    let fake = Arc::new(Fake::new());
    let engine = Engine::new(fake.clone(), path);
    Rig { fake, engine, _dir: dir }
}

fn all_interact() -> Value {
    json!({"version": 1, "default": "interact"})
}

fn inv() -> Invocation {
    Invocation::default()
}

fn approved() -> Invocation {
    Invocation { approval_id: Some("ap1".into()), cancel: None }
}

fn call(r: &Rig, name: &str, params: Value, i: &Invocation) -> Result<Value, (String, String)> {
    r.engine.invoke(name, &params, i).map(|o| o.result).map_err(|e| (e.code.to_string(), e.reason))
}

/// A Text Editor window: a text view, a Save button, a Delete button, a password entry.
struct Editor {
    win: u32,
    text: u32,
    save: u32,
    password: u32,
}

fn editor(r: &Rig) -> Editor {
    let f = &r.fake;
    let win = f.window(EDITOR_PID, "Untitled");
    let text = f.child(win, role::TEXT, "Document", Some(Rect::new(10.0, 40.0, 180.0, 100.0)), |f, i| {
        f.editable = true;
        f.multi_line = true;
        f.has_editable_text = true;
        i.value = Some("hello".into());
    });
    let save = f.child(win, role::PUSH_BUTTON, "Save", Some(Rect::new(10.0, 150.0, 60.0, 30.0)), |f, _| f.action_names = vec!["click".into()]);
    let _delete = f.child(win, role::PUSH_BUTTON, "Delete", Some(Rect::new(80.0, 150.0, 60.0, 30.0)), |f, _| f.action_names = vec!["click".into()]);
    let password = f.child(win, role::PASSWORD_TEXT, "Password", Some(Rect::new(10.0, 10.0, 180.0, 20.0)), |f, i| {
        f.editable = true;
        f.has_editable_text = true;
        i.value = Some("hunter2-not-a-real-secret".into());
    });
    Editor { win, text, save, password }
}

fn snapshot(r: &Rig, app: &str) -> Value {
    call(r, "computer.ax_tree", json!({"app": app, "session": "s1"}), &inv()).unwrap()
}

/// The ref the snapshot gave a labelled element (`text` is the rendered snapshot).
fn ref_of(snap: &Value, label: &str) -> String {
    let text = snap["text"].as_str().unwrap();
    let line = text.lines().find(|l| l.contains(&format!("\"{label}\""))).unwrap_or_else(|| panic!("{label} not in\n{text}"));
    let start = line.find("[e").unwrap() + 1;
    line[start..line.find(']').unwrap()].to_string()
}

#[test]
fn a_snapshot_redacts_the_password_and_never_shows_its_value() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let text = snap["text"].as_str().unwrap();
    assert!(!text.contains("hunter2"), "{text}");
    assert!(text.contains("textfield:secureTextField"), "{text}");
    assert!(text.contains("•••"), "{text}");
    assert!(text.contains("secure"), "{text}");
    assert_eq!(snap["provenance"], "untrusted");
    assert_eq!(snap["header"]["bundleId"], "org.gnome.texteditor");
}

#[test]
fn password_fields_are_refused_by_every_write_path() {
    let r = rig(all_interact());
    let e = editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let pw = ref_of(&snap, "Password");
    let expect = json!({"role": "textfield:secureTextField", "label": "Password"});
    for (cap, extra) in [
        ("computer.set_value", json!({"value": "x"})),
        ("computer.type", json!({"text": "x"})),
        ("computer.click", json!({})),
        ("computer.press", json!({"action": "press"})),
    ] {
        let mut p = json!({"ref": pw, "expect": expect, "session": "s1", "app": "org.gnome.TextEditor"});
        p.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let err = call(&r, cap, p, &inv()).unwrap_err();
        assert_eq!(err.1, "secure_field", "{cap}");
    }
    let err = call(&r, "computer.ax_value", json!({"ref": pw}), &inv()).unwrap_err();
    assert_eq!(err.1, "secure_field");
    let log = r.fake.log().join("\n");
    assert!(!log.contains("set_value") && !log.contains("typed") && !log.contains("click") && !log.contains(&format!("perform {}", e.password)), "{log}");
}

#[test]
fn typing_stops_the_moment_a_password_field_takes_focus() {
    let r = rig(all_interact());
    editor(&r);
    snapshot(&r, "org.gnome.TextEditor");
    r.fake.s.lock().unwrap().focus_secure = true;
    let err = call(&r, "computer.type", json!({"text": "abcdefgh", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "secure_field");
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    // Keys too, except Escape and Tab, which let the owner leave the field.
    assert_eq!(call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err().1, "secure_field");
    call(&r, "computer.key", json!({"keys": "tab", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap();
}

#[test]
fn focus_leaving_the_app_stops_typing_before_a_single_key() {
    let r = rig(all_interact());
    editor(&r);
    {
        let mut s = r.fake.s.lock().unwrap();
        s.focus_pid = Some(TERMINAL_PID);
        s.focus_denied = true;
    }
    let err = call(&r, "computer.type", json!({"text": "echo hi", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!((err.0.as_str(), err.1.as_str()), ("conflict", "focus_moved"));
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    assert_eq!(call(&r, "computer.key", json!({"keys": "return", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err().1, "focus_moved");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
}

#[test]
fn a_click_presses_by_the_action_without_coordinates() {
    let r = rig(all_interact());
    let e = editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let save = ref_of(&snap, "Save");
    let out = call(&r, "computer.click", json!({"ref": save, "expect": {"role": "button", "label": "Save"}, "session": "s1"}), &inv()).unwrap();
    assert_eq!((out["status"].as_str(), out["method"].as_str()), (Some("ok"), Some("ax")));
    assert!(r.fake.log().iter().any(|l| l == &format!("perform {} AXPress", e.save)));
    assert!(!r.fake.log().iter().any(|l| l.starts_with("click ")));
}

#[test]
fn a_changed_element_is_refused_and_risky_labels_need_approval() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let save = ref_of(&snap, "Save");
    let err = call(&r, "computer.click", json!({"ref": save, "expect": {"role": "button", "label": "Open"}, "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "expectation_failed");
    let del = ref_of(&snap, "Delete");
    let p = json!({"ref": del, "expect": {"role": "button", "label": "Delete"}, "session": "s1"});
    let err = call(&r, "computer.click", p.clone(), &inv()).unwrap_err();
    assert_eq!((err.0.as_str(), err.1.as_str()), ("approval_required", "risky_label"));
    let mut with_approval = p;
    with_approval["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    call(&r, "computer.click", with_approval, &approved()).unwrap();
}

#[test]
fn tiers_and_fixed_caps_apply_below_the_model() {
    let r = rig(all_interact());
    let f = &r.fake;
    let tw = f.window(TERMINAL_PID, "Terminal");
    f.child(tw, role::PUSH_BUTTON, "Run", Some(Rect::new(210.0, 10.0, 50.0, 20.0)), |f, _| f.action_names = vec!["click".into()]);
    let kw = f.window(KEEPASS_PID, "KeePassXC");
    f.child(kw, role::LABEL, "Vault", None, |_, _| {});
    // Terminals are click-only: typing and keys are refused, a snapshot is fine.
    snapshot(&r, "gnome-terminal");
    assert_eq!(call(&r, "computer.type", json!({"text": "rm -rf ~", "app": "gnome-terminal", "session": "s1"}), &inv()).unwrap_err().1, "tier_click");
    assert_eq!(call(&r, "computer.key", json!({"keys": "return", "app": "gnome-terminal", "session": "s1"}), &inv()).unwrap_err().1, "tier_click");
    // Password managers are off, even to read.
    assert_eq!(call(&r, "computer.ax_tree", json!({"app": "keepassxc", "session": "s1"}), &inv()).unwrap_err().1, "tier_off");
    assert!(f.s.lock().unwrap().typed.is_empty());
}

#[test]
fn ask_apps_need_an_approval_for_that_app() {
    let r = rig(json!({"version": 1, "default": "ask"}));
    editor(&r);
    let err = call(&r, "computer.ax_tree", json!({"app": "org.gnome.TextEditor"}), &inv()).unwrap_err();
    assert_eq!((err.0.as_str(), err.1.as_str()), ("approval_required", "tier_ask"));
    let mut p = json!({"app": "org.gnome.TextEditor", "approval": {"app": "org.gnome.TextEditor", "tier": "read"}});
    call(&r, "computer.ax_tree", p.clone(), &approved()).unwrap();
    // An approval for another app does not carry over.
    p["approval"]["app"] = json!("firefox");
    // (Read is allowed now by the allowance; a type needs interact and is refused.)
    let err = call(&r, "computer.type", json!({"text": "x", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "tier_ask");
}

#[test]
fn actions_need_a_session_and_one_session_drives_at_a_time() {
    let r = rig(all_interact());
    editor(&r);
    let err = call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor"}), &inv()).unwrap_err();
    assert_eq!(err.1, "invalid_params");
    call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}), &inv()).unwrap();
    let err = call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}), &inv()).unwrap_err();
    assert_eq!(err.1, "computer_busy");
    call(&r, "computer.end_session", json!({"session": "run1"}), &inv()).unwrap();
    call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}), &inv()).unwrap();
}

#[test]
fn a_stop_ends_the_session_for_good() {
    let r = rig(all_interact());
    editor(&r);
    let stopped = Arc::new(std::sync::Mutex::new(None));
    let s2 = stopped.clone();
    r.engine.set_on_user_stop(move |id| *s2.lock().unwrap() = id);
    call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}), &inv()).unwrap();
    r.engine.user_stopped();
    assert_eq!(stopped.lock().unwrap().as_deref(), Some("run1"));
    let err = call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}), &inv()).unwrap_err();
    assert_eq!((err.0.as_str(), err.1.as_str()), ("cancelled", "user_stopped"));
    // A new session is fine.
    call(&r, "computer.key", json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}), &inv()).unwrap();
}

#[test]
fn risky_chords_and_sends_need_approval() {
    let r = rig(all_interact());
    editor(&r);
    let mail = r.fake.window(MAIL_PID, "Inbox");
    r.fake.child(mail, role::PUSH_BUTTON, "Compose", Some(Rect::new(610.0, 10.0, 50.0, 20.0)), |_, _| {});
    for keys in ["cmd+q", "alt+f4", "cmd+w", "ctrl+alt+forwarddelete"] {
        let err = call(&r, "computer.key", json!({"keys": keys, "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
        assert_eq!((err.0.as_str(), err.1.as_str()), ("approval_required", "risky_chord"), "{keys}");
    }
    // The Super key is never sent.
    assert_eq!(call(&r, "computer.key", json!({"keys": "super+l", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err().1, "invalid_params");
    // Return and a typed newline send in a mail app.
    let err = call(&r, "computer.key", json!({"keys": "return", "app": "thunderbird", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "send_key");
    let err = call(&r, "computer.type", json!({"text": "hi\n", "app": "thunderbird", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "send_text");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")), "{:?}", r.fake.log());
}

#[test]
fn credential_placeholders_are_never_typed() {
    let r = rig(all_interact());
    editor(&r);
    let err = call(&r, "computer.type", json!({"text": "{{cred:bank}}", "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "credential_placeholder");
}

#[test]
fn a_point_must_land_in_the_named_app() {
    let r = rig(all_interact());
    editor(&r);
    // x=250 is inside the terminal's window (200..400), not the editor's.
    let err = call(&r, "computer.click", json!({"x": 250.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "app_mismatch");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("click ")));
    call(&r, "computer.click", json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap();
    assert!(r.fake.log().iter().any(|l| l.starts_with("click 50,50")));
}

#[test]
fn without_window_positions_a_point_needs_an_approval_and_the_focused_app() {
    let r = rig(all_interact());
    editor(&r);
    r.fake.s.lock().unwrap().geometry_known = false;
    let p = json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"});
    assert_eq!(call(&r, "computer.click", p.clone(), &inv()).unwrap_err().1, "point_unverified");
    let mut ok = p.clone();
    ok["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    call(&r, "computer.click", ok, &approved()).unwrap();
    // Not the focused app: refused even with an approval.
    r.fake.s.lock().unwrap().windows[0].focused = false;
    r.fake.s.lock().unwrap().windows[1].focused = true;
    let mut again = p;
    again["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    assert_eq!(call(&r, "computer.click", again, &approved()).unwrap_err().1, "focus_moved");
}

#[test]
fn a_ref_without_a_position_falls_back_to_keyboard_focus_then_says_no_position() {
    let r = rig(all_interact());
    let e = editor(&r);
    r.fake.s.lock().unwrap().geometry_known = false;
    r.fake.s.lock().unwrap().element_focus_ignored = true;
    // A button with no action and no frame.
    let b = r.fake.child(e.win, role::PUSH_BUTTON, "Apply", None, |_, _| {});
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let rf = ref_of(&snap, "Apply");
    // Focus does not land on the element, so the keyboard route is refused honestly.
    let err = call(&r, "computer.click", json!({"ref": rf, "expect": {"role": "button", "label": "Apply"}, "session": "s1"}), &inv()).unwrap_err();
    assert_eq!(err.1, "no_position");
    assert!(r.fake.log().iter().all(|l| l != "key space"));
    // Once focus lands on it, Space is sent and the outcome is reported as unverified.
    r.fake.s.lock().unwrap().focused_element = Some(b);
    let out = call(&r, "computer.click", json!({"ref": rf, "expect": {"role": "button", "label": "Apply"}, "session": "s1"}), &inv()).unwrap();
    assert_eq!((out["status"].as_str(), out["method"].as_str()), (Some("unverified"), Some("keyboard")));
}

#[test]
fn screenshots_black_out_protected_windows_and_refuse_when_that_is_impossible() {
    let r = rig(all_interact());
    editor(&r);
    snapshot(&r, "org.gnome.TextEditor");
    let out = call(&r, "computer.screenshot", json!({"app": "org.gnome.TextEditor", "session": "s1"}), &inv()).unwrap();
    assert_eq!(out["mimeType"], "image/jpeg");
    assert_eq!(out["provenance"], "untrusted");
    assert!(out["excludedApps"].as_u64().unwrap() >= 3);
    // The excluded app itself is never captured.
    assert_eq!(call(&r, "computer.screenshot", json!({"app": "gnome-terminal"}), &inv()).unwrap_err().1, "app_excluded");
    // A focused password field suppresses it.
    r.fake.s.lock().unwrap().focus_secure = true;
    assert_eq!(call(&r, "computer.screenshot", json!({"app": "org.gnome.TextEditor"}), &inv()).unwrap_err().1, "secure_field_focused");
    r.fake.s.lock().unwrap().focus_secure = false;
    // No window positions and a protected window open: refused rather than showing it.
    r.fake.s.lock().unwrap().geometry_known = false;
    assert_eq!(call(&r, "computer.screenshot", json!({"app": "org.gnome.TextEditor"}), &inv()).unwrap_err().1, "redaction_unavailable");
    // Once the protected windows are minimized it works.
    for w in r.fake.s.lock().unwrap().windows.iter_mut().filter(|w| w.pid != EDITOR_PID) {
        w.minimized = true;
    }
    call(&r, "computer.screenshot", json!({"app": "org.gnome.TextEditor"}), &inv()).unwrap();
}

#[test]
fn redaction_geometry_blanks_exactly_the_protected_windows() {
    use crate::hygiene::{redactions, WindowRef};
    use std::collections::HashSet;
    let windows = vec![
        WindowRef { id: 1, pid: EDITOR_PID, layer: 0, bounds: Rect::new(0.0, 0.0, 200.0, 200.0), alpha: 1.0 },
        WindowRef { id: 2, pid: KEEPASS_PID, layer: 0, bounds: Rect::new(400.0, 0.0, 200.0, 200.0), alpha: 1.0 },
    ];
    let red = redactions(&windows, &HashSet::from([KEEPASS_PID]), Rect::new(0.0, 0.0, 1000.0, 200.0));
    assert_eq!(red, vec![Rect::new(400.0, 0.0, 200.0, 200.0)]);
    let mut f = crate::backend::Frame { width: 1000, height: 200, rgba: vec![255; 1000 * 200 * 4], screen: Rect::new(0.0, 0.0, 1000.0, 200.0), scale: 1.0 };
    for r in red {
        f.fill_black(r);
    }
    assert!(!f.any_lit(Rect::new(400.0, 0.0, 200.0, 200.0)));
    assert!(f.any_lit(Rect::new(0.0, 0.0, 200.0, 200.0)));
}

#[test]
fn check_target_reports_found_missing_and_wrong_app() {
    let r = rig(all_interact());
    editor(&r);
    let found = call(&r, "computer.check_target", json!({"app": "org.gnome.TextEditor", "role": "button", "name": "Save"}), &inv()).unwrap();
    assert_eq!((found["status"].as_str(), found["stop"].as_bool()), (Some("found"), Some(false)));
    let missing = call(&r, "computer.check_target", json!({"app": "org.gnome.TextEditor", "role": "button", "name": "Nope"}), &inv()).unwrap();
    assert_eq!((missing["status"].as_str(), missing["stop"].as_bool()), (Some("missing"), Some(true)));
    // A password field is never a replay target.
    let pw = call(&r, "computer.check_target", json!({"app": "org.gnome.TextEditor", "role": "textbox", "name": "Password"}), &inv()).unwrap();
    assert_eq!(pw["status"], "missing");
    assert_eq!(call(&r, "computer.check_target", json!({"app": "org.gnome.TextEditor", "name": "Save"}), &inv()).unwrap_err().1, "invalid_params");
}

#[test]
fn set_value_reads_back() {
    let r = rig(all_interact());
    let e = editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let doc = ref_of(&snap, "Document");
    let out = call(
        &r,
        "computer.set_value",
        json!({"ref": doc, "value": "new", "expect": {"role": "textarea", "label": "Document", "valuePrefix": ""}, "session": "s1"}),
        &inv(),
    );
    // The fake echoes the value, so the read-back verifies.
    assert_eq!(out.unwrap()["status"], "ok", "node {}", e.text);
}

#[test]
fn unknown_refs_and_capabilities_fail_cleanly() {
    let r = rig(all_interact());
    editor(&r);
    assert_eq!(call(&r, "computer.ax_value", json!({"ref": "e999"}), &inv()).unwrap_err().1, "unknown_ref");
    assert_eq!(call(&r, "computer.nope", json!({}), &inv()).unwrap_err().1, "unknown_capability");
    assert_eq!(call(&r, "computer.ax_tree", json!({"app": "does.not.run"}), &inv()).unwrap_err().1, "app_not_running");
}
