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
    Rig {
        fake,
        engine,
        _dir: dir,
    }
}

fn all_interact() -> Value {
    json!({"version": 1, "default": "interact"})
}

fn inv() -> Invocation {
    Invocation::default()
}

fn approved() -> Invocation {
    Invocation {
        approval_id: Some("ap1".into()),
        cancel: None,
    }
}

fn call(r: &Rig, name: &str, params: Value, i: &Invocation) -> Result<Value, (String, String)> {
    r.engine
        .invoke(name, &params, i)
        .map(|o| o.result)
        .map_err(|e| (e.code.to_string(), e.reason))
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
    let text = f.child(
        win,
        role::TEXT,
        "Document",
        Some(Rect::new(10.0, 40.0, 180.0, 100.0)),
        |f, i| {
            f.editable = true;
            f.multi_line = true;
            f.has_editable_text = true;
            i.value = Some("hello".into());
        },
    );
    let save = f.child(
        win,
        role::PUSH_BUTTON,
        "Save",
        Some(Rect::new(10.0, 150.0, 60.0, 30.0)),
        |f, _| f.action_names = vec!["click".into()],
    );
    let _delete = f.child(
        win,
        role::PUSH_BUTTON,
        "Delete",
        Some(Rect::new(80.0, 150.0, 60.0, 30.0)),
        |f, _| f.action_names = vec!["click".into()],
    );
    let password = f.child(
        win,
        role::PASSWORD_TEXT,
        "Password",
        Some(Rect::new(10.0, 10.0, 180.0, 20.0)),
        |f, i| {
            f.editable = true;
            f.has_editable_text = true;
            i.value = Some("hunter2-not-a-real-secret".into());
        },
    );
    Editor {
        win,
        text,
        save,
        password,
    }
}

fn snapshot(r: &Rig, app: &str) -> Value {
    call(
        r,
        "computer.ax_tree",
        json!({"app": app, "session": "s1"}),
        &inv(),
    )
    .unwrap()
}

/// The ref the snapshot gave a labelled element (`text` is the rendered snapshot).
fn ref_of(snap: &Value, label: &str) -> String {
    let text = snap["text"].as_str().unwrap();
    let line = text
        .lines()
        .find(|l| l.contains(&format!("\"{label}\"")))
        .unwrap_or_else(|| panic!("{label} not in\n{text}"));
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
        let mut p =
            json!({"ref": pw, "expect": expect, "session": "s1", "app": "org.gnome.TextEditor"});
        p.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let err = call(&r, cap, p, &inv()).unwrap_err();
        assert_eq!(err.1, "secure_field", "{cap}");
    }
    let err = call(&r, "computer.ax_value", json!({"ref": pw}), &inv()).unwrap_err();
    assert_eq!(err.1, "secure_field");
    let log = r.fake.log().join("\n");
    assert!(
        !log.contains("set_value")
            && !log.contains("typed")
            && !log.contains("click")
            && !log.contains(&format!("perform {}", e.password)),
        "{log}"
    );
}

#[test]
fn typing_stops_the_moment_a_password_field_takes_focus() {
    let r = rig(all_interact());
    editor(&r);
    snapshot(&r, "org.gnome.TextEditor");
    r.fake.s.lock().unwrap().focus_secure = true;
    let err = call(
        &r,
        "computer.type",
        json!({"text": "abcdefgh", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "secure_field");
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    // Keys too, except Escape and Tab, which let the owner leave the field.
    assert_eq!(
        call(
            &r,
            "computer.key",
            json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "secure_field"
    );
    call(
        &r,
        "computer.key",
        json!({"keys": "tab", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
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
    let err = call(
        &r,
        "computer.type",
        json!({"text": "echo hi", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("conflict", "focus_moved")
    );
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    assert_eq!(
        call(
            &r,
            "computer.key",
            json!({"keys": "return", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "focus_moved"
    );
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
}

#[test]
fn a_surface_that_refuses_the_focus_stops_typing_and_keys_before_anything_is_sent() {
    // The virtual screen: the focused window's server-recorded process is another app's, or an
    // app on the deny list. The pid the fake reports for the focus would have passed.
    for (code, reason) in [("conflict", "focus_moved"), ("policy_denied", "app_denied")] {
        let r = rig(all_interact());
        editor(&r);
        r.fake.s.lock().unwrap().input_target = Some((code, reason));
        let typed = call(
            &r,
            "computer.type",
            json!({"text": "hi", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!((typed.0.as_str(), typed.1.as_str()), (code, reason));
        let key = call(
            &r,
            "computer.key",
            json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(key.1, reason);
        assert!(r.fake.s.lock().unwrap().typed.is_empty());
        assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
    }
}

/// The machine ceiling's gate sees the app the engine resolved, however the call named it.
fn deny_keepass(r: &Rig) {
    r.engine.policy.set_app_gate(std::sync::Arc::new(|id| {
        if crate::app_id::normalize(id) == "keepassxc" {
            Err(crate::error::CapError::new(
                "policy_denied",
                "app_denied",
                "out of reach",
            ))
        } else {
            Ok(())
        }
    }));
}

#[test]
fn a_denied_app_is_refused_whether_the_call_names_its_id_its_display_name_or_its_pid() {
    let r = rig(all_interact());
    editor(&r);
    deny_keepass(&r);
    for params in [
        // An id.
        json!({"app": "keepassxc", "x": 10, "y": 10, "session": "s1"}),
        json!({"app": " KeePassXC.desktop", "x": 10, "y": 10, "session": "s1"}),
        // The display name.
        json!({"app": "KeePassXC", "x": 10, "y": 10, "session": "s1"}),
        // A pid, no app key at all.
        json!({"pid": KEEPASS_PID, "x": 10, "y": 10, "session": "s1"}),
    ] {
        for cap in ["computer.click", "computer.screenshot", "computer.ax_tree"] {
            let mut p = params.clone();
            // Only the tree takes a pid; the other calls name their app.
            if p.get("pid").is_some() && cap != "computer.ax_tree" {
                continue;
            }
            if cap != "computer.click" {
                p.as_object_mut()
                    .unwrap()
                    .retain(|k, _| matches!(k.as_str(), "app" | "pid"));
            }
            let err = call(&r, cap, p.clone(), &inv()).unwrap_err();
            // A point click can also be refused for landing in a different app than it
            // named; either way it is a policy refusal and nothing is sent.
            let reason_ok =
                err.1 == "app_denied" || (cap == "computer.click" && err.1 == "app_mismatch");
            assert!(err.0 == "policy_denied" && reason_ok, "{cap} {p}: {err:?}");
        }
    }
    assert!(r.fake.log().iter().all(|l| !l.starts_with("click")));
    // Another app still works.
    call(
        &r,
        "computer.ax_tree",
        json!({"app": "org.gnome.TextEditor"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn a_surface_that_allows_the_focus_does_not_replace_the_pid_comparison() {
    // A child process the app started sits in the app's scope and has the focus: the surface's
    // scope check passes, and the focused process still is not the app's own.
    let r = rig(all_interact());
    editor(&r);
    {
        let mut s = r.fake.s.lock().unwrap();
        s.focus_pid = Some(TERMINAL_PID);
        s.focus_denied = true;
        s.input_target = None;
    }
    let typed = call(
        &r,
        "computer.type",
        json!({"text": "no", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(typed.1, "focus_moved");
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    // resolve_target reads the same focus: it refuses too.
    let target = call(
        &r,
        "computer.resolve_target",
        json!({"app": "org.gnome.TextEditor", "focused": true, "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(target.1, "focus_moved");
}

#[test]
fn a_click_presses_by_the_action_without_coordinates() {
    let r = rig(all_interact());
    let e = editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let save = ref_of(&snap, "Save");
    let out = call(
        &r,
        "computer.click",
        json!({"ref": save, "expect": {"role": "button", "label": "Save"}, "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["method"].as_str()),
        (Some("ok"), Some("ax"))
    );
    assert!(r
        .fake
        .log()
        .iter()
        .any(|l| l == &format!("perform {} AXPress", e.save)));
    assert!(!r.fake.log().iter().any(|l| l.starts_with("click ")));
}

#[test]
fn a_changed_element_is_refused_and_risky_labels_need_approval() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let save = ref_of(&snap, "Save");
    let err = call(
        &r,
        "computer.click",
        json!({"ref": save, "expect": {"role": "button", "label": "Open"}, "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "expectation_failed");
    let del = ref_of(&snap, "Delete");
    let p = json!({"ref": del, "expect": {"role": "button", "label": "Delete"}, "session": "s1"});
    let err = call(&r, "computer.click", p.clone(), &inv()).unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("approval_required", "risky_label")
    );
    let mut with_approval = p;
    with_approval["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    call(&r, "computer.click", with_approval, &approved()).unwrap();
}

#[test]
fn tiers_and_fixed_caps_apply_below_the_model() {
    let r = rig(all_interact());
    let f = &r.fake;
    let tw = f.window(TERMINAL_PID, "Terminal");
    f.child(
        tw,
        role::PUSH_BUTTON,
        "Run",
        Some(Rect::new(210.0, 10.0, 50.0, 20.0)),
        |f, _| f.action_names = vec!["click".into()],
    );
    let kw = f.window(KEEPASS_PID, "KeePassXC");
    f.child(kw, role::LABEL, "Vault", None, |_, _| {});
    // Terminals are click-only: typing and keys are refused, a snapshot is fine.
    snapshot(&r, "gnome-terminal");
    assert_eq!(
        call(
            &r,
            "computer.type",
            json!({"text": "rm -rf ~", "app": "gnome-terminal", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "tier_click"
    );
    assert_eq!(
        call(
            &r,
            "computer.key",
            json!({"keys": "return", "app": "gnome-terminal", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "tier_click"
    );
    // Password managers are off, even to read.
    assert_eq!(
        call(
            &r,
            "computer.ax_tree",
            json!({"app": "keepassxc", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "tier_off"
    );
    assert!(f.s.lock().unwrap().typed.is_empty());
}

#[test]
fn ask_apps_need_an_approval_for_that_app() {
    let r = rig(json!({"version": 1, "default": "ask"}));
    editor(&r);
    let err = call(
        &r,
        "computer.ax_tree",
        json!({"app": "org.gnome.TextEditor"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("approval_required", "tier_ask")
    );
    let mut p = json!({"app": "org.gnome.TextEditor", "approval": {"app": "org.gnome.TextEditor", "tier": "read"}});
    call(&r, "computer.ax_tree", p.clone(), &approved()).unwrap();
    // An approval for another app does not carry over.
    p["approval"]["app"] = json!("firefox");
    // (Read is allowed now by the allowance; a type needs interact and is refused.)
    let err = call(
        &r,
        "computer.type",
        json!({"text": "x", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "tier_ask");
}

#[test]
fn actions_need_a_session_and_one_session_drives_at_a_time() {
    let r = rig(all_interact());
    editor(&r);
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "invalid_params");
    call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}),
        &inv(),
    )
    .unwrap();
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "computer_busy");
    call(
        &r,
        "computer.end_session",
        json!({"session": "run1"}),
        &inv(),
    )
    .unwrap();
    call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn a_stop_ends_the_session_for_good() {
    let r = rig(all_interact());
    editor(&r);
    let stopped = Arc::new(std::sync::Mutex::new(None));
    let s2 = stopped.clone();
    r.engine
        .set_on_user_stop(move |id| *s2.lock().unwrap() = id);
    call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}),
        &inv(),
    )
    .unwrap();
    r.engine.user_stopped();
    assert_eq!(stopped.lock().unwrap().as_deref(), Some("run1"));
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("cancelled", "user_stopped")
    );
    // A new session is fine.
    call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "run2"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn risky_chords_and_sends_need_approval() {
    let r = rig(all_interact());
    editor(&r);
    let mail = r.fake.window(MAIL_PID, "Inbox");
    r.fake.child(
        mail,
        role::PUSH_BUTTON,
        "Compose",
        Some(Rect::new(610.0, 10.0, 50.0, 20.0)),
        |_, _| {},
    );
    // (Ctrl+Alt+Delete used to be asked here; it is a desktop shortcut now, refused outright:
    // see desktop_shortcuts_are_refused_even_with_an_approval.)
    for keys in ["cmd+q", "alt+f4", "cmd+w", "shift+forwarddelete"] {
        let err = call(
            &r,
            "computer.key",
            json!({"keys": keys, "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(
            (err.0.as_str(), err.1.as_str()),
            ("approval_required", "risky_chord"),
            "{keys}"
        );
    }
    // The Super key is never sent.
    assert_eq!(
        call(
            &r,
            "computer.key",
            json!({"keys": "super+l", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "invalid_params"
    );
    // Return and a typed newline send in a mail app.
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "return", "app": "thunderbird", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "send_key");
    let err = call(
        &r,
        "computer.type",
        json!({"text": "hi\n", "app": "thunderbird", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "send_text");
    assert!(
        r.fake.log().iter().all(|l| !l.starts_with("key ")),
        "{:?}",
        r.fake.log()
    );
}

#[test]
fn credential_placeholders_are_never_typed() {
    let r = rig(all_interact());
    editor(&r);
    let err = call(
        &r,
        "computer.type",
        json!({"text": "{{cred:bank}}", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "credential_placeholder");
}

#[test]
fn a_point_must_land_in_the_named_app() {
    let r = rig(all_interact());
    editor(&r);
    // x=250 is inside the terminal's window (200..400), not the editor's.
    let err = call(
        &r,
        "computer.click",
        json!({"x": 250.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "app_mismatch");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("click ")));
    call(
        &r,
        "computer.click",
        json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert!(r.fake.log().iter().any(|l| l.starts_with("click 50,50")));
}

/// F3: without window positions a point could land in any app, so every x/y target is refused,
/// with or without an approval (this used to be allowed into the focused app on one approval).
#[test]
fn without_window_positions_a_point_is_refused_even_with_an_approval() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let doc = ref_of(&snap, "Document");
    r.fake.s.lock().unwrap().geometry_known = false;
    let base = json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"});
    let mut with_approval = base.clone();
    with_approval["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    for cap in [
        "computer.click",
        "computer.double_click",
        "computer.right_click",
        "computer.scroll",
        "computer.resolve_target",
    ] {
        for (mut p, i) in [(base.clone(), inv()), (with_approval.clone(), approved())] {
            if cap == "computer.scroll" {
                p["dy"] = json!(-3);
            }
            let err = call(&r, cap, p, &i).unwrap_err();
            assert_eq!(
                (err.0.as_str(), err.1.as_str()),
                ("policy_denied", "point_unverifiable"),
                "{cap}"
            );
        }
    }
    // A drag: both ends, a point to a point and a ref to a point.
    let approval = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
    for from in [
        json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor"}),
        json!({"ref": doc, "expect": {"role": "textarea", "label": "Document"}}),
    ] {
        let p = json!({
            "from": from,
            "to": {"x": 60.0, "y": 60.0, "app": "org.gnome.TextEditor"},
            "session": "s1",
            "approval": approval,
        });
        assert_eq!(
            call(&r, "computer.drag", p, &approved()).unwrap_err().1,
            "point_unverifiable"
        );
    }
    let log = r.fake.log().join("\n");
    assert!(
        !log.contains("click ") && !log.contains("scroll ") && !log.contains("drag "),
        "{log}"
    );
}

#[test]
fn a_ref_without_a_position_falls_back_to_keyboard_focus_then_says_no_position() {
    let r = rig(all_interact());
    let e = editor(&r);
    r.fake.s.lock().unwrap().geometry_known = false;
    r.fake.s.lock().unwrap().element_focus_ignored = true;
    // A button with no action and no frame.
    let b = r
        .fake
        .child(e.win, role::PUSH_BUTTON, "Apply", None, |_, _| {});
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let rf = ref_of(&snap, "Apply");
    // Focus does not land on the element, so the keyboard route is refused honestly.
    let err = call(
        &r,
        "computer.click",
        json!({"ref": rf, "expect": {"role": "button", "label": "Apply"}, "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "no_position");
    assert!(r.fake.log().iter().all(|l| l != "key space"));
    // Once focus lands on it, Space is sent and the outcome is reported as unverified.
    r.fake.s.lock().unwrap().focused_element = Some(b);
    let out = call(
        &r,
        "computer.click",
        json!({"ref": rf, "expect": {"role": "button", "label": "Apply"}, "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(
        (out["status"].as_str(), out["method"].as_str()),
        (Some("unverified"), Some("keyboard"))
    );
}

#[test]
fn screenshots_black_out_protected_windows_and_refuse_when_that_is_impossible() {
    let r = rig(all_interact());
    editor(&r);
    snapshot(&r, "org.gnome.TextEditor");
    let out = call(
        &r,
        "computer.screenshot",
        json!({"app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(out["mimeType"], "image/jpeg");
    assert_eq!(out["provenance"], "untrusted");
    assert!(out["excludedApps"].as_u64().unwrap() >= 3);
    // The excluded app itself is never captured.
    assert_eq!(
        call(
            &r,
            "computer.screenshot",
            json!({"app": "gnome-terminal"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "app_excluded"
    );
    // A focused password field suppresses it.
    r.fake.s.lock().unwrap().focus_secure = true;
    assert_eq!(
        call(
            &r,
            "computer.screenshot",
            json!({"app": "org.gnome.TextEditor"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "secure_field_focused"
    );
    r.fake.s.lock().unwrap().focus_secure = false;
    // No window positions and a protected window open: refused rather than showing it.
    r.fake.s.lock().unwrap().geometry_known = false;
    assert_eq!(
        call(
            &r,
            "computer.screenshot",
            json!({"app": "org.gnome.TextEditor"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "redaction_unavailable"
    );
    // Once the protected windows are minimized it works.
    for w in r
        .fake
        .s
        .lock()
        .unwrap()
        .windows
        .iter_mut()
        .filter(|w| w.pid != EDITOR_PID)
    {
        w.minimized = true;
    }
    call(
        &r,
        "computer.screenshot",
        json!({"app": "org.gnome.TextEditor"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn redaction_geometry_blanks_exactly_the_protected_windows() {
    use crate::hygiene::{redactions, WindowRef};
    use std::collections::HashSet;
    let windows = vec![
        WindowRef {
            id: 1,
            pid: EDITOR_PID,
            layer: 0,
            bounds: Rect::new(0.0, 0.0, 200.0, 200.0),
            alpha: 1.0,
        },
        WindowRef {
            id: 2,
            pid: KEEPASS_PID,
            layer: 0,
            bounds: Rect::new(400.0, 0.0, 200.0, 200.0),
            alpha: 1.0,
        },
    ];
    let red = redactions(
        &windows,
        &HashSet::from([KEEPASS_PID]),
        Rect::new(0.0, 0.0, 1000.0, 200.0),
    );
    assert_eq!(red, vec![Rect::new(400.0, 0.0, 200.0, 200.0)]);
    let mut f = crate::backend::Frame {
        width: 1000,
        height: 200,
        rgba: vec![255; 1000 * 200 * 4],
        screen: Rect::new(0.0, 0.0, 1000.0, 200.0),
        scale: 1.0,
    };
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
    let found = call(
        &r,
        "computer.check_target",
        json!({"app": "org.gnome.TextEditor", "role": "button", "name": "Save"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(
        (found["status"].as_str(), found["stop"].as_bool()),
        (Some("found"), Some(false))
    );
    let missing = call(
        &r,
        "computer.check_target",
        json!({"app": "org.gnome.TextEditor", "role": "button", "name": "Nope"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(
        (missing["status"].as_str(), missing["stop"].as_bool()),
        (Some("missing"), Some(true))
    );
    // A password field is never a replay target.
    let pw = call(
        &r,
        "computer.check_target",
        json!({"app": "org.gnome.TextEditor", "role": "textbox", "name": "Password"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(pw["status"], "missing");
    assert_eq!(
        call(
            &r,
            "computer.check_target",
            json!({"app": "org.gnome.TextEditor", "name": "Save"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "invalid_params"
    );
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
    assert_eq!(
        call(&r, "computer.ax_value", json!({"ref": "e999"}), &inv())
            .unwrap_err()
            .1,
        "unknown_ref"
    );
    assert_eq!(
        call(&r, "computer.nope", json!({}), &inv()).unwrap_err().1,
        "unknown_capability"
    );
    assert_eq!(
        call(
            &r,
            "computer.ax_tree",
            json!({"app": "does.not.run"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "app_not_running"
    );
}

// --- computer.resolve_target (F2) ----------------------------------------------------------------

/// A checkout page in the editor's window: document > form > "Pay $49".
fn checkout(r: &Rig) -> (u32, u32) {
    let f = &r.fake;
    let win = f.window(EDITOR_PID, "Checkout - Shop");
    let doc = f.child(
        win,
        role::DOCUMENT_WEB,
        "Shop",
        Some(Rect::new(0.0, 0.0, 200.0, 200.0)),
        |_, _| {},
    );
    f.set_url(doc, "https://shop.example/checkout");
    let form = f.child(
        doc,
        role::FORM,
        "  Payment  ",
        Some(Rect::new(0.0, 0.0, 200.0, 200.0)),
        |_, _| {},
    );
    let pay = f.child(
        form,
        role::PUSH_BUTTON,
        "Pay $49",
        Some(Rect::new(20.0, 100.0, 80.0, 30.0)),
        |f, _| f.action_names = vec!["click".into()],
    );
    (win, pay)
}

#[test]
fn resolve_target_reports_a_ref_its_parents_window_and_page_without_pressing() {
    let r = rig(all_interact());
    let (_, pay) = checkout(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let pay_ref = ref_of(&snap, "Pay $49");
    let p = json!({"ref": pay_ref, "expect": {"role": "button", "label": "Pay $49"}, "app": "org.gnome.TextEditor", "session": "s1"});
    let out = call(&r, "computer.resolve_target", p.clone(), &inv()).unwrap();
    assert_eq!(
        out,
        json!({
            "app": "org.gnome.texteditor",
            "provenance": "untrusted",
            "role": "button",
            "labels": ["Pay $49", "Payment", "Shop"],
            "label": "Pay $49",
            "window": "Checkout - Shop",
            "url": "https://shop.example/checkout",
        })
    );
    // Read-only: nothing was pressed, focused or clicked.
    assert!(r.fake.log().is_empty(), "{:?}", r.fake.log());
    // The session is required, as for the action it precedes.
    let mut no_session = p.clone();
    no_session.as_object_mut().unwrap().remove("session");
    assert_eq!(
        call(&r, "computer.resolve_target", no_session, &inv())
            .unwrap_err()
            .1,
        "invalid_params"
    );
    // A changed element is refused like any ref call.
    let mut changed = p.clone();
    changed["expect"]["label"] = json!("Cancel");
    assert_eq!(
        call(&r, "computer.resolve_target", changed, &inv())
            .unwrap_err()
            .1,
        "expectation_failed"
    );
    // So is one that is gone.
    r.fake.s.lock().unwrap().nodes.remove(&pay);
    assert_eq!(
        call(&r, "computer.resolve_target", p, &inv())
            .unwrap_err()
            .1,
        "stale_ref"
    );
}

#[test]
fn resolve_target_refuses_a_ref_of_another_app_and_reports_secure_fields_without_labels() {
    let r = rig(all_interact());
    editor(&r);
    let tw = r.fake.window(TERMINAL_PID, "Terminal");
    r.fake.child(
        tw,
        role::PUSH_BUTTON,
        "Run",
        Some(Rect::new(10.0, 10.0, 50.0, 20.0)),
        |f, _| f.action_names = vec!["click".into()],
    );
    let term = snapshot(&r, "gnome-terminal");
    let run = ref_of(&term, "Run");
    let err = call(
        &r,
        "computer.resolve_target",
        json!({"ref": run, "expect": {"role": "button", "label": "Run"}, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "ref_other_app");
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let pw = ref_of(&snap, "Password");
    let out = call(
        &r,
        "computer.resolve_target",
        json!({"ref": pw, "expect": {"role": "textfield:secureTextField", "label": "Password"}, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(out["secure"], true);
    assert_eq!(out["labels"], json!([]));
    assert!(out.get("label").is_none());
    assert_eq!(out["role"], "textfield");
    assert_eq!(out["subrole"], "AXSecureTextField");
    assert!(!out.to_string().contains("hunter2"));
}

#[test]
fn resolve_target_by_point_uses_the_click_hit_test_and_its_app_binding() {
    let r = rig(all_interact());
    checkout(&r);
    let out = call(
        &r,
        "computer.resolve_target",
        json!({"x": 60.0, "y": 115.0, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert_eq!(out["role"], "button");
    assert_eq!(out["label"], "Pay $49");
    assert_eq!(out["labels"], json!(["Pay $49", "Payment", "Shop"]));
    assert_eq!(out["window"], "Checkout - Shop");
    assert_eq!(out["url"], "https://shop.example/checkout");
    // A point in another app's window than the one named: refused like a click there.
    let err = call(
        &r,
        "computer.resolve_target",
        json!({"x": 250.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "app_mismatch");
    // An approval for another app does not carry over.
    let err = call(
        &r,
        "computer.resolve_target",
        json!({"x": 60.0, "y": 115.0, "app": "org.gnome.TextEditor", "session": "s1", "approval": {"app": "firefox", "tier": "read"}}),
        &approved(),
    )
    .unwrap_err();
    assert_eq!(err.1, "approval_app_mismatch");
    assert!(r.fake.log().is_empty(), "{:?}", r.fake.log());
}

#[test]
fn resolve_target_focused_reports_the_focus_or_nothing_and_refuses_another_apps_focus() {
    let r = rig(all_interact());
    let e = editor(&r);
    let p = json!({"focused": true, "app": "org.gnome.TextEditor", "session": "s1"});
    r.fake.s.lock().unwrap().focused_element = Some(e.text);
    let out = call(&r, "computer.resolve_target", p.clone(), &inv()).unwrap();
    assert_eq!(out["role"], "textarea");
    assert_eq!(out["label"], "Document");
    assert_eq!(out["window"], "Untitled");
    // Focus unknown: an empty report, the Gateway decides by context.
    r.fake.s.lock().unwrap().focus_pid = None;
    let out = call(&r, "computer.resolve_target", p.clone(), &inv()).unwrap();
    assert_eq!(
        out,
        json!({"app": "org.gnome.texteditor", "provenance": "untrusted", "labels": []})
    );
    // Focus known to be in another app: refused.
    r.fake.s.lock().unwrap().focus_pid = Some(TERMINAL_PID);
    let err = call(&r, "computer.resolve_target", p, &inv()).unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("conflict", "focus_moved")
    );
    // The app is required.
    let err = call(
        &r,
        "computer.resolve_target",
        json!({"focused": true, "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "invalid_params");
    // Read tier for the app, with the usual approval rules.
    let r = rig(json!({"version": 1, "default": "ask"}));
    editor(&r);
    let err = call(
        &r,
        "computer.resolve_target",
        json!({"focused": true, "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "tier_ask");
    assert!(r.fake.log().is_empty());
}

#[test]
fn target_report_labels_are_trimmed_capped_and_unique() {
    use crate::engine::{report_labels, target_report, TargetReport};
    let long = "x".repeat(300);
    let raw: Vec<String> = [
        " Pay ", "", "Pay", "  ", &long, "a", "b", "c", "d", "e", "f",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let out = report_labels(&raw);
    assert_eq!(out.len(), 6);
    assert_eq!(out[0], "Pay");
    assert_eq!(out[1].chars().count(), 200);
    assert_eq!(&out[2..], ["a", "b", "c", "d"]);
    let v = target_report(&TargetReport {
        app: "firefox",
        window: Some(format!("  {}  ", "w".repeat(500))),
        labels: vec!["  ".into()],
        ..TargetReport::default()
    });
    assert_eq!(v["window"].as_str().unwrap().chars().count(), 400);
    assert_eq!(v["labels"], json!([]));
    assert!(v.get("label").is_none() && v.get("role").is_none() && v.get("secure").is_none());
}

// --- Keyboard focus fails closed (F4) -------------------------------------------------------------

#[test]
fn focus_moving_to_an_app_without_accessibility_stops_typing_mid_text() {
    let r = rig(all_interact());
    editor(&r);
    // After the first chunk, focus goes to a terminal that reports nothing to AT-SPI.
    r.fake.s.lock().unwrap().focus_lost_after_chunks = Some(1);
    let err = call(
        &r,
        "computer.type",
        json!({"text": "abcdrm -rf ~\n", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("conflict", "focus_unknown")
    );
    assert_eq!(r.fake.s.lock().unwrap().typed, "abcd");
}

#[test]
fn unknown_focus_refuses_keys_and_typing_before_anything_is_sent() {
    let r = rig(all_interact());
    editor(&r);
    {
        let mut s = r.fake.s.lock().unwrap();
        s.focus_pid = None;
        // The desktop does not move focus either (activation only requested).
        s.focus_denied = true;
    }
    for keys in ["return", "space", "a"] {
        let err = call(
            &r,
            "computer.key",
            json!({"keys": keys, "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(err.1, "focus_unknown", "{keys}");
    }
    let err = call(
        &r,
        "computer.type",
        json!({"text": "x", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "focus_unknown");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
}

// --- Desktop shortcuts (F5) -----------------------------------------------------------------------

#[test]
fn desktop_shortcuts_are_refused_even_with_an_approval() {
    let r = rig(all_interact());
    editor(&r);
    for keys in [
        "alt+f2",
        "alt+space",
        "ctrl+alt+t",
        "alt+f1",
        "ctrl+alt+f3",
        "ctrl+alt+forwarddelete",
        "print",
        "shift+print",
    ] {
        let p = json!({"keys": keys, "app": "org.gnome.TextEditor", "session": "s1"});
        let mut with_approval = p.clone();
        with_approval["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
        for (p, i) in [(p, inv()), (with_approval, approved())] {
            let err = call(&r, "computer.key", p, &i).unwrap_err();
            assert_eq!(
                (err.0.as_str(), err.1.as_str()),
                ("policy_denied", "shell_chord"),
                "{keys}"
            );
        }
    }
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
    // Near misses: Alt+F4 is still asked, Ctrl+T is sent.
    assert_eq!(
        call(
            &r,
            "computer.key",
            json!({"keys": "alt+f4", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "risky_chord"
    );
    call(
        &r,
        "computer.key",
        json!({"keys": "ctrl+t", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
    assert!(r.fake.log().iter().any(|l| l == "key ctrl+t"));
}

// --- Kill switch (F6) -----------------------------------------------------------------------------

#[test]
fn without_a_kill_switch_nothing_is_sent() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let save = ref_of(&snap, "Save");
    r.fake.s.lock().unwrap().no_kill_switch = true;
    let calls = [
        (
            "computer.key",
            json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s1"}),
        ),
        (
            "computer.type",
            json!({"text": "hi", "app": "org.gnome.TextEditor", "session": "s1"}),
        ),
        (
            "computer.click",
            json!({"x": 50.0, "y": 50.0, "app": "org.gnome.TextEditor", "session": "s1"}),
        ),
        (
            "computer.click",
            json!({"ref": save, "expect": {"role": "button", "label": "Save"}, "session": "s1"}),
        ),
    ];
    for (cap, p) in calls.iter() {
        let mut with_approval = p.clone();
        with_approval["approval"] = json!({"app": "org.gnome.TextEditor", "tier": "interact"});
        for (p, i) in [(p.clone(), inv()), (with_approval, approved())] {
            let err = call(&r, cap, p, &i).unwrap_err();
            assert_eq!(
                (err.0.as_str(), err.1.as_str()),
                ("unavailable", "kill_switch_unavailable"),
                "{cap}"
            );
        }
    }
    assert!(r.fake.log().is_empty(), "{:?}", r.fake.log());
    // Reading needs no session and still works.
    snapshot(&r, "org.gnome.TextEditor");
    // Once the Stop is back, actions are too.
    r.fake.s.lock().unwrap().no_kill_switch = false;
    for (cap, p) in calls.iter().take(1) {
        call(&r, cap, p.clone(), &inv()).unwrap();
    }
}

// --- fileLocalLabel on the separate desktop's guest (F7) -----------------------------------------

#[test]
fn the_guest_honours_file_local_label_only_for_that_exact_risky_label() {
    let r = rig(all_interact());
    editor(&r);
    let snap = snapshot(&r, "org.gnome.TextEditor");
    let del = ref_of(&snap, "Delete");
    let by_ref = |label: &str| json!({"ref": del, "expect": {"role": "button", "label": "Delete"}, "session": "s1", "fileLocalLabel": label});
    let at_point = |label: &str| json!({"x": 110.0, "y": 165.0, "app": "org.gnome.TextEditor", "session": "s1", "fileLocalLabel": label});
    // The Host's own helper ignores the parameter.
    for p in [by_ref("Delete"), at_point("Delete")] {
        let err = call(&r, "computer.click", p, &inv()).unwrap_err();
        assert_eq!(
            (err.0.as_str(), err.1.as_str()),
            ("approval_required", "risky_label")
        );
    }
    r.engine.set_guest(true);
    // The guest: a different label still asks, and says which label it found.
    for p in [by_ref("Remove"), at_point("Save"), by_ref("")] {
        let err = r.engine.invoke("computer.click", &p, &inv()).unwrap_err();
        assert_eq!(err.reason, "risky_label");
        assert_eq!(err.details["label"], "Delete");
    }
    // (A point click brings the app forward before its hit test; nothing is pressed or clicked.)
    assert!(
        r.fake
            .log()
            .iter()
            .all(|l| !l.starts_with("perform ") && !l.starts_with("click ")),
        "{:?}",
        r.fake.log()
    );
    // The exact label (trimmed) passes the risky-label check, and only that check.
    call(&r, "computer.click", by_ref(" Delete "), &inv()).unwrap();
    call(&r, "computer.click", at_point("Delete"), &inv()).unwrap();
    assert!(r.fake.log().iter().any(|l| l.starts_with("perform ")));
    assert!(r.fake.log().iter().any(|l| l.starts_with("click 110,165")));
    // A menu path: same rule (the fake has no menu bar, so a pass reaches the walk).
    let menu = |label: &str| json!({"path": "File>Delete", "app": "org.gnome.TextEditor", "session": "s1", "fileLocalLabel": label});
    assert_eq!(
        call(&r, "computer.menu", menu("Quit"), &inv())
            .unwrap_err()
            .1,
        "risky_label"
    );
    assert_eq!(
        call(&r, "computer.menu", menu("Delete"), &inv())
            .unwrap_err()
            .1,
        "no_menu_bar"
    );
}

#[test]
fn file_local_label_is_never_an_approval() {
    let r = rig(all_interact());
    editor(&r);
    r.fake.window(MAIL_PID, "Inbox");
    r.engine.set_guest(true);
    // Risky chords and sends still ask.
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "cmd+q", "app": "org.gnome.TextEditor", "session": "s1", "fileLocalLabel": "cmd+q"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "risky_chord");
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "return", "app": "thunderbird", "session": "s1", "fileLocalLabel": "Send"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "send_key");
    let err = call(
        &r,
        "computer.type",
        json!({"text": "hi\n", "app": "thunderbird", "session": "s1", "fileLocalLabel": "Send"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "send_text");
    // Shell chords and unverifiable points are refused as always.
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "alt+f2", "app": "org.gnome.TextEditor", "session": "s1", "fileLocalLabel": "alt+f2"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "shell_chord");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
}

#[test]
fn file_local_label_records_no_allowance_on_ask_apps() {
    let r = rig(json!({"version": 1, "default": "ask"}));
    editor(&r);
    r.engine.set_guest(true);
    // With the old fabricated approval's binding but no approval id, plus the flag: still asks,
    // and nothing is remembered for later calls.
    let p = json!({
        "text": "x",
        "app": "org.gnome.TextEditor",
        "session": "s1",
        "fileLocalLabel": "Delete",
        "approval": {"app": "org.gnome.TextEditor", "tier": "interact"},
    });
    for _ in 0..2 {
        assert_eq!(
            call(&r, "computer.type", p.clone(), &inv()).unwrap_err().1,
            "tier_ask"
        );
    }
    assert_eq!(
        call(
            &r,
            "computer.ax_tree",
            json!({"app": "org.gnome.TextEditor"}),
            &inv()
        )
        .unwrap_err()
        .1,
        "tier_ask"
    );
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
}

// --- Window-only screenshots are an allowlist (F8) ------------------------------------------------

#[test]
fn a_window_only_screenshot_blacks_out_unknown_windows_in_front_and_not_behind() {
    use crate::backend::{Backend, WinInfo};
    use crate::engine::window_only;
    use crate::hygiene::WindowRef;
    let r = rig(all_interact());
    editor(&r);
    let unknown = |id: u64, b: Rect| WinInfo {
        id,
        pid: id as u32,
        title: String::new(),
        bounds: Some(b),
        layer: 0,
        focused: false,
        minimized: false,
    };
    {
        let mut s = r.fake.s.lock().unwrap();
        // A process AT-SPI does not know (no app id: a terminal without accessibility) in front
        // of the editor, over its right half; another one behind it.
        s.windows
            .insert(0, unknown(999, Rect::new(100.0, 0.0, 150.0, 100.0)));
        s.windows
            .push(unknown(998, Rect::new(0.0, 100.0, 150.0, 100.0)));
    }
    let out = call(
        &r,
        "computer.screenshot",
        json!({"app": "org.gnome.TextEditor", "windowOnly": true}),
        &inv(),
    )
    .unwrap();
    assert_eq!(out["screen"]["width"], 200.0);
    let refs: Vec<WindowRef> = r
        .fake
        .windows()
        .iter()
        .filter(|w| !w.minimized)
        .filter_map(|w| {
            w.bounds.map(|b| WindowRef {
                id: w.id,
                pid: w.pid,
                layer: w.layer,
                bounds: b,
                alpha: 1.0,
            })
        })
        .collect();
    let frame = r.fake.capture(None).unwrap();
    let (f, area) = window_only(frame, &refs, EDITOR_PID).unwrap();
    assert_eq!(area, Rect::new(0.0, 0.0, 200.0, 200.0));
    assert!(!f.any_lit(Rect::new(100.0, 0.0, 100.0, 100.0)));
    assert!(f.any_lit(Rect::new(0.0, 0.0, 100.0, 100.0)));
    assert!(f.any_lit(Rect::new(0.0, 100.0, 200.0, 100.0)));
}

// --- Snap app ids (round 2, finding 1) ------------------------------------------------------------

/// Renames a fake app to the id a snap reports (`<snap>_<app>`).
fn rename(r: &Rig, pid: u32, id: &str) {
    let mut s = r.fake.s.lock().unwrap();
    s.apps.iter_mut().find(|a| a.pid == pid).unwrap().id = id.into();
}

#[test]
fn a_snap_mail_app_keeps_the_send_rule() {
    let r = rig(all_interact());
    editor(&r);
    rename(&r, MAIL_PID, "thunderbird_thunderbird");
    r.fake.window(MAIL_PID, "Inbox");
    for keys in ["return", "ctrl+return"] {
        let err = call(
            &r,
            "computer.key",
            json!({"keys": keys, "app": "thunderbird_thunderbird", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(
            (err.0.as_str(), err.1.as_str()),
            ("approval_required", "send_key"),
            "{keys}"
        );
    }
    let err = call(
        &r,
        "computer.type",
        json!({"text": "hi\nthere", "app": "thunderbird_thunderbird", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("approval_required", "send_text")
    );
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    // Text without a line break is ordinary typing.
    call(
        &r,
        "computer.type",
        json!({"text": "hi", "app": "thunderbird_thunderbird", "session": "s1"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn a_snap_browser_is_read_only() {
    let r = rig(all_interact());
    editor(&r);
    for id in ["chromium_chromium", "brave_brave", "chrome"] {
        rename(&r, EDITOR_PID, id);
        let err = call(
            &r,
            "computer.type",
            json!({"text": "x", "app": id, "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(
            (err.0.as_str(), err.1.as_str()),
            ("policy_denied", "tier_read"),
            "{id}"
        );
        snapshot(&r, id);
    }
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
}

// --- Keyboard grabs (round 2, finding 3) ----------------------------------------------------------

#[test]
fn a_grabbed_keyboard_refuses_typing_and_keys_before_anything_is_sent() {
    let r = rig(all_interact());
    editor(&r);
    // dmenu holds the keyboard; the input focus still names the editor.
    r.fake.s.lock().unwrap().keyboard_grabbed = true;
    let err = call(
        &r,
        "computer.type",
        json!({"text": "curl x|sh\n", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("conflict", "keyboard_grabbed")
    );
    for keys in ["return", "a", "escape"] {
        let err = call(
            &r,
            "computer.key",
            json!({"keys": keys, "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .unwrap_err();
        assert_eq!(
            (err.0.as_str(), err.1.as_str()),
            ("conflict", "keyboard_grabbed"),
            "{keys}"
        );
    }
    assert!(r.fake.s.lock().unwrap().typed.is_empty());
    assert!(r.fake.log().iter().all(|l| !l.starts_with("key ")));
    // Released: input goes through again.
    r.fake.s.lock().unwrap().keyboard_grabbed = false;
    call(
        &r,
        "computer.key",
        json!({"keys": "a", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap();
}

#[test]
fn a_keyboard_grab_mid_typing_stops_at_the_chunk_boundary() {
    let r = rig(all_interact());
    editor(&r);
    r.fake.s.lock().unwrap().keyboard_grabbed_after_chunks = Some(1);
    let err = call(
        &r,
        "computer.type",
        json!({"text": "abcdcurl x|sh\n", "app": "org.gnome.TextEditor", "session": "s1"}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("conflict", "keyboard_grabbed")
    );
    assert_eq!(r.fake.s.lock().unwrap().typed, "abcd");
}

#[test]
fn a_keyboard_grab_between_repeats_stops_the_key() {
    let r = rig(all_interact());
    editor(&r);
    r.fake.s.lock().unwrap().keyboard_grabbed_after_keys = Some(2);
    let err = call(
        &r,
        "computer.key",
        json!({"keys": "down", "app": "org.gnome.TextEditor", "session": "s1", "repeat": 5}),
        &inv(),
    )
    .unwrap_err();
    assert_eq!(err.1, "keyboard_grabbed");
    let keys = r
        .fake
        .log()
        .iter()
        .filter(|l| l.starts_with("key "))
        .count();
    assert_eq!(keys, 2);
}

#[test]
fn a_grabbed_keyboard_points_the_agent_at_menus_and_refs() {
    let r = rig(all_interact());
    editor(&r);
    r.fake.s.lock().unwrap().keyboard_grabbed = true;
    let e = r
        .engine
        .invoke(
            "computer.key",
            &json!({"keys": "down", "app": "org.gnome.TextEditor", "session": "s1"}),
            &inv(),
        )
        .err()
        .unwrap();
    assert_eq!(e.reason, "keyboard_grabbed");
    for want in [
        "computer.menu",
        "new snapshot",
        "ref",
        "dmenu or rofi",
        "owner",
    ] {
        assert!(e.message.contains(want), "{want}: {}", e.message);
    }
}

// --- apps.open (round 3, findings 1 and 4) -------------------------------------------------------

fn open(r: &Rig, params: Value) -> Result<Value, (String, String)> {
    let binding = crate::tiers::ApprovalBinding::from(Some("ap1"), &params);
    r.engine
        .open_app(&params, binding.as_ref())
        .map_err(|e| (e.code.to_string(), e.reason))
}

#[test]
fn apps_open_refuses_an_entry_the_agent_could_have_written_before_any_card() {
    // Default ask: a trusted entry would need a card, an untrusted one is refused first.
    let r = rig(json!({"version": 1, "default": "ask"}));
    r.fake
        .s
        .lock()
        .unwrap()
        .untrusted_entries
        .push("org.gnome.Notes2".into());
    let err = open(&r, json!({"bundleId": "org.gnome.Notes2"})).unwrap_err();
    assert_eq!(
        (err.0.as_str(), err.1.as_str()),
        ("policy_denied", "untrusted_desktop_entry")
    );
    // Even with an approval for that app.
    let err = open(
        &r,
        json!({"bundleId": "org.gnome.Notes2", "approval": {"app": "org.gnome.notes2", "tier": "interact"}}),
    )
    .unwrap_err();
    assert_eq!(err.1, "untrusted_desktop_entry");
    assert!(r.fake.log().iter().all(|l| !l.starts_with("launch ")));
    // A trusted entry asks, then launches once approved.
    let err = open(&r, json!({"bundleId": "org.gnome.TextEditor"})).unwrap_err();
    assert_eq!(err.0, "approval_required");
    open(
        &r,
        json!({"bundleId": "org.gnome.TextEditor", "approval": {"app": "org.gnome.texteditor", "tier": "click"}}),
    )
    .unwrap();
    assert!(r
        .fake
        .log()
        .contains(&"launch org.gnome.texteditor".to_string()));
}

#[test]
fn apps_open_refuses_a_url_for_apps_capped_at_click_or_lower() {
    let r =
        rig(json!({"version": 1, "default": "interact", "caps": {"org.example.capped": "click"}}));
    for id in ["org.gnome.Terminal", "code", "org.example.capped"] {
        let e = r
            .engine
            .open_app(
                &json!({"bundleId": id, "url": "file:///home/me/notes.txt"}),
                None,
            )
            .unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            ("policy_denied", "open_url_capped"),
            "{id}"
        );
        assert!(
            e.message
                .contains("is capped at click; Psyche does not open files or links with it"),
            "{}",
            e.message
        );
        let e = r
            .engine
            .open_app(
                &json!({"bundleId": id, "url": "mailto:a@example.com"}),
                None,
            )
            .unwrap_err();
        assert_eq!(e.reason, "open_url_capped", "{id}");
        // Without a URL the app opens as before.
        r.engine.open_app(&json!({"bundleId": id}), None).unwrap();
    }
    // A read-capped browser gets no URL either.
    let e = r
        .engine
        .open_app(
            &json!({"bundleId": "firefox", "url": "file:///tmp/x.html"}),
            None,
        )
        .unwrap_err();
    assert_eq!(e.reason, "open_url_capped");
    assert!(e.message.contains("capped at read"), "{}", e.message);
    // An ordinary app still opens a document.
    r.engine
        .open_app(
            &json!({"bundleId": "org.gnome.TextEditor", "url": "file:///home/me/notes.txt"}),
            None,
        )
        .unwrap();
    let with_url: Vec<String> = r
        .fake
        .log()
        .into_iter()
        .filter(|l| l.starts_with("launch ") && l.contains(':'))
        .collect();
    assert_eq!(
        with_url,
        vec!["launch org.gnome.texteditor file:///home/me/notes.txt".to_string()]
    );
    // The scheme rule still comes first.
    let e = r
        .engine
        .open_app(
            &json!({"bundleId": "org.gnome.TextEditor", "url": "https://x.example"}),
            None,
        )
        .unwrap_err();
    assert_eq!(e.reason, "url_scheme");
}

#[test]
fn apps_open_refuses_a_url_for_a_terminal_entry_once_indexed() {
    let dir = tempfile::tempdir().unwrap();
    let apps = dir.path().join("applications");
    std::fs::create_dir_all(&apps).unwrap();
    // An id no other test uses: the registry is process-wide.
    std::fs::write(
        apps.join("org.example.OpenTermTool.desktop"),
        "[Desktop Entry]\nType=Application\nExec=opentermtool %F\nTerminal=true\n",
    )
    .unwrap();
    let r = rig(all_interact());
    let params = json!({"bundleId": "org.example.OpenTermTool", "url": "file:///home/me/x.py"});
    // Before the index loads the entry is not known to run in a terminal (the Linux backend's
    // check_launch loads it before this check).
    r.engine.open_app(&params, None).unwrap();
    crate::app_id::DesktopIndex::load(&[dir.path().to_path_buf()]);
    let e = r.engine.open_app(&params, None).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        ("policy_denied", "open_url_capped")
    );
    assert!(e.message.contains("capped at click"), "{}", e.message);
    r.engine
        .open_app(&json!({"bundleId": "org.example.OpenTermTool"}), None)
        .unwrap();
}

#[test]
fn the_guest_ignores_a_settings_file_its_own_account_can_write() {
    use crate::trust::SettingsSource;
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("computer-use.json");
    std::fs::write(&path, br#"{"version":1,"default":"interact"}"#).unwrap();
    let me = std::fs::metadata(&path).unwrap().uid();
    let fake = Arc::new(Fake::new());
    let engine = Engine::with_settings(
        fake.clone(),
        SettingsSource::Trusted {
            path: path.clone(),
            own_uid: me,
        },
    );
    engine.reload_settings();
    assert_eq!(
        engine.policy.settings(),
        crate::tiers::TierSettings::default()
    );
    let e = engine
        .open_app(&json!({"bundleId": "org.gnome.TextEditor"}), None)
        .unwrap_err();
    assert_eq!(e.reason, "tier_ask");
    // The Host's file at the same place is read.
    let host = Engine::new(fake, path);
    host.open_app(&json!({"bundleId": "org.gnome.TextEditor"}), None)
        .unwrap();
}
