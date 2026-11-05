//! Policy, mapper, controller and capability tests (ports of the mac `AppTeachTests` and
//! `AppTeachControllerTests`), plus a live recording against a Win32 window the test owns.
//! Secret-looking values are built at run time.
#![allow(clippy::result_large_err, clippy::type_complexity)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use psyche_win_computer::tiers::{SettingValue, TierSettings};
use serde_json::{Value, json};

use super::controller::{Scope, Source};
use super::policy::{self, Element, Event, Mapper, Refusal, Sensitive};
use super::*;
use crate::node::log::HelperLog;
use crate::node::paths::Env;
use crate::node::{InvocationContext, Runtime};

const NOTEPAD: &str = "notepad.exe";

fn el(role: &str, title: Option<&str>) -> Element {
    Element {
        bundle_id: NOTEPAD.into(),
        app_name: "Notepad".into(),
        role: role.into(),
        title: title.map(str::to_owned),
        path: vec!["New Message".into()],
        pid: 100,
        ..Default::default()
    }
}

fn with(mut e: Element, f: impl FnOnce(&mut Element)) -> Element {
    f(&mut e);
    e
}

fn settings(apps: &[(&str, SettingValue)]) -> TierSettings {
    TierSettings {
        default_value: SettingValue::Ask,
        apps: apps
            .iter()
            .map(|(k, v)| ((*k).to_owned(), *v))
            .collect::<HashMap<_, _>>(),
        caps: HashMap::new(),
        sensitive: Vec::new(),
    }
}

fn granted() -> TierSettings {
    settings(&[(NOTEPAD, SettingValue::Interact)])
}

fn mapper() -> Mapper {
    Mapper::new(NOTEPAD, "Notepad", 200)
}

/// A Luhn-valid 16-digit number, computed so no card-looking literal sits in the source.
fn card_number() -> String {
    let mut digits: Vec<u32> = "4111111111111"
        .chars()
        .filter_map(|c| c.to_digit(10))
        .chain([0, 0, 0])
        .collect();
    for last in 0..=9 {
        digits[15] = last;
        let sum: u32 = digits
            .iter()
            .rev()
            .enumerate()
            .map(|(i, d)| {
                let mut n = *d;
                if i % 2 == 1 {
                    n *= 2;
                    if n > 9 {
                        n -= 9;
                    }
                }
                n
            })
            .sum();
        if sum % 10 == 0 {
            break;
        }
    }
    digits.iter().map(u32::to_string).collect()
}

fn json_of(steps: &[policy::Step]) -> String {
    serde_json::to_string(steps).unwrap()
}

// MARK: - Policy

#[test]
fn granted_apps_only() {
    assert_eq!(policy::refusal(NOTEPAD, &granted()), None);
    assert_eq!(
        policy::refusal(NOTEPAD, &settings(&[(NOTEPAD, SettingValue::Click)])),
        None
    );
    // Read alone is not enough: the agent could not act in the app anyway.
    for v in [SettingValue::Read, SettingValue::Off, SettingValue::Ask] {
        assert_eq!(
            policy::refusal(NOTEPAD, &settings(&[(NOTEPAD, v)])),
            Some(Refusal::NotGranted)
        );
    }
    assert_eq!(
        policy::refusal(NOTEPAD, &settings(&[])),
        Some(Refusal::NotGranted)
    ); // default: ask
    assert_eq!(
        policy::refusal("calc.exe", &granted()),
        Some(Refusal::NotGranted)
    );
    // An explicit entry compares without case.
    assert_eq!(policy::refusal("NOTEPAD.EXE", &granted()), None);
}

#[test]
fn never_psyche_or_system_security_ui() {
    let ids = [
        "psyche.exe",
        "psyche-helper.exe",
        "psyche-win-helper.exe",
        "consent.exe",
        "credentialuibroker.exe",
        "logonui.exe",
        "lockapp.exe",
        "winlogon.exe",
        "sechealthui.exe",
        "windowsdefender.exe",
        "systemsettings.exe",
        "1password.exe",
        "keepassxc.exe",
        "bitwarden.exe",
    ];
    let all: Vec<(&str, SettingValue)> = ids.iter().map(|i| (*i, SettingValue::Interact)).collect();
    let s = settings(&all);
    assert_eq!(policy::refusal("psyche.exe", &s), Some(Refusal::Psyche));
    assert_eq!(
        policy::refusal("psyche-win-helper.exe", &s),
        Some(Refusal::Psyche)
    );
    assert_eq!(
        policy::refusal("consent.exe", &s),
        Some(Refusal::SecurityPrompt)
    );
    assert_eq!(
        policy::refusal("credentialuibroker.exe", &s),
        Some(Refusal::SecurityPrompt)
    );
    assert_eq!(
        policy::refusal("logonui.exe", &s),
        Some(Refusal::SecurityPrompt)
    );
    assert_eq!(
        policy::refusal("windowsdefender.exe", &s),
        Some(Refusal::SecurityPrompt)
    );
    assert_eq!(
        policy::refusal("1password.exe", &s),
        Some(Refusal::PasswordManager)
    );
    assert_eq!(
        policy::refusal("keepassxc.exe", &s),
        Some(Refusal::PasswordManager)
    );
    for id in ids {
        assert!(policy::refusal(id, &s).is_some(), "{id}");
        // Case does not matter on Windows.
        assert!(policy::refusal(&id.to_uppercase(), &s).is_some(), "{id}");
    }
}

#[test]
fn apps_that_cannot_be_driven_are_not_recorded() {
    let s = settings(&[
        ("chrome.exe", SettingValue::Interact),
        ("msedge.exe", SettingValue::Interact),
        ("windowsterminal.exe", SettingValue::Interact),
        ("code.exe", SettingValue::Interact),
        ("tradingview.exe", SettingValue::Interact),
    ]);
    for id in [
        "chrome.exe",
        "msedge.exe",
        "windowsterminal.exe",
        "code.exe",
        "tradingview.exe",
    ] {
        assert_eq!(policy::refusal(id, &s), Some(Refusal::OffLimits), "{id}");
    }
}

#[test]
fn the_shared_never_list_covers_managers_authenticators_wallets_banking_and_dev_electron() {
    let ids = [
        "authy desktop.exe",
        "winauth.exe",
        "yubico authenticator.exe",
        "exodus.exe",
        "electrum-4.5.exe",
        "sparrow.exe",
        "trezor suite.exe",
        "ledger live.exe",
        "electron.exe",
        "ELECTRON.EXE",
        "coinbase wallet.exe",
        "revolut.exe",
        "roboform.exe",
        "nordpass.exe",
    ];
    let all: Vec<(&str, SettingValue)> = ids.iter().map(|i| (*i, SettingValue::Interact)).collect();
    let s = settings(&all);
    for id in ids {
        assert!(policy::refusal(id, &s).is_some(), "{id}");
    }
    // A neighbour with a similar name is not caught by an exact entry.
    assert_eq!(
        policy::refusal(
            "electron-notes.exe",
            &settings(&[("electron-notes.exe", SettingValue::Interact)])
        ),
        None
    );
    assert!(!never_apps::PATTERNS.is_empty());
    assert!(never_apps::PATTERNS.iter().all(|p| *p == p.to_lowercase()));
}

/// The list is generated from the protocol package; this fails if someone edits one side by hand.
#[test]
fn the_generated_list_matches_the_protocol_source() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/src/browser-teach.ts");
    let Ok(text) = std::fs::read_to_string(src) else {
        return;
    }; // a source tree without the monorepo
    let start = text
        .find("TEACH_NEVER_APPS_WINDOWS: readonly string[] = [")
        .expect("the list");
    let block = &text[start..start + text[start..].find("];").unwrap()];
    for p in never_apps::PATTERNS {
        assert!(
            block.contains(&format!("\"{p}\"")),
            "{p} is not in TEACH_NEVER_APPS_WINDOWS"
        );
    }
    let quoted = block.matches('"').count() / 2;
    assert_eq!(
        quoted,
        never_apps::PATTERNS.len(),
        "run `pnpm protocol:gen`"
    );
}

#[test]
fn secret_fields_are_recognised_by_role_input_state_and_words() {
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Anything")),
        |e| e.subrole = Some("AXSecureTextField".into())
    )));
    assert!(policy::is_secret(&el(
        "AXSecureTextField",
        Some("Anything")
    )));
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Subject")),
        |e| e.secure_input = true
    )));
    for words in [
        "Password",
        "Passwort",
        "Contrase\u{00F1}a",
        "Card number",
        "CVV",
        "Verification code",
        "One-time code",
        "SSN",
        "API key",
        "Recovery phrase",
        "\u{5BC6}\u{7801}",
    ] {
        assert!(
            policy::is_secret(&el("AXTextField", Some(words))),
            "{words}"
        );
    }
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Field")),
        |e| e.identifier = Some("passwordField".into())
    )));
    assert!(policy::is_secret(&with(el("AXTextField", None), |e| e
        .placeholder =
        Some("Enter your PIN".into()))));
    for ok in ["Subject", "To", "Cc", "Search", "Name", "Amount"] {
        assert!(!policy::is_secret(&el("AXTextField", Some(ok))), "{ok}");
    }
}

#[test]
fn path_nearby_labels_and_context_count_for_the_secret_words() {
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Field")),
        |e| e.path = vec!["Enter your verification code".into()]
    )));
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Field")),
        |e| e.label_text = Some("Recovery phrase".into())
    )));
    assert!(policy::is_secret(&with(
        el("AXTextField", Some("Field")),
        |e| e.nearby = vec!["Recovery phrase".into()]
    )));
    assert!(!policy::is_secret(&el("AXTextField", Some("Field"))));
}

#[test]
fn more_secret_shapes() {
    let phrase = ["abandon"; 12].join(" ");
    assert_eq!(policy::value_reason(&phrase, ""), Some(Sensitive::Secret));
    assert_eq!(
        policy::value_reason(&["zoo"; 24].join(" "), ""),
        Some(Sensitive::Secret)
    );
    assert_eq!(policy::value_reason(&["abandon"; 11].join(" "), ""), None);
    assert_eq!(
        policy::value_reason(&format!("https://{}:{}@example.com/x", "dana", "pw"), ""),
        Some(Sensitive::Secret)
    );
    assert_eq!(policy::value_reason("https://example.com/x", ""), None);
    assert_eq!(
        policy::value_reason("123456", "Code"),
        Some(Sensitive::OneTimeCode)
    );
    // Any bare 4 to 8 digit number is treated as a code: one Keep click is too easy.
    assert_eq!(
        policy::value_reason("123456", "Quantity"),
        Some(Sensitive::OneTimeCode)
    );
    assert_eq!(
        policy::value_reason("4821", ""),
        Some(Sensitive::OneTimeCode)
    );
    assert_eq!(policy::value_reason("123", ""), None);
    assert_eq!(policy::value_reason("2026-11-04", ""), None);
}

#[test]
fn values_that_look_like_secrets_are_caught() {
    assert_eq!(
        policy::value_reason(&card_number(), ""),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        policy::value_reason(&format!("pay {} now", card_number()), ""),
        Some(Sensitive::Payment)
    );
    assert_eq!(
        policy::value_reason(
            &[123.to_string(), 45.to_string(), 6789.to_string()].join("-"),
            ""
        ),
        Some(Sensitive::Identity)
    );
    assert_eq!(
        policy::value_reason(&"a1B2".repeat(10), ""),
        Some(Sensitive::Secret)
    );
    assert_eq!(
        policy::value_reason(&format!("ghp_{}", "x9".repeat(12)), ""),
        Some(Sensitive::Secret)
    );
    assert_eq!(policy::value_reason("Quarterly report", ""), None);
}

#[test]
fn text_is_one_line_and_capped() {
    assert_eq!(
        policy::clean(Some("  a\r\nb\tc  "), 120).as_deref(),
        Some("a b c")
    );
    assert_eq!(policy::clean(Some("\u{2028}"), 120), None);
    assert_eq!(policy::clean(None, 120), None);
    let long = "x".repeat(300);
    let c = policy::clean(Some(&long), 120).unwrap();
    assert_eq!(c.chars().count(), 120);
    assert!(c.ends_with('…'));
}

#[test]
fn roles_map_to_the_protocols_fixed_list() {
    use policy::roles::map;
    assert_eq!(map("AXButton", None), "button");
    assert_eq!(map("AXMenuButton", None), "button");
    assert_eq!(map("AXTextField", None), "textbox");
    assert_eq!(map("AXTextField", Some("AXSearchField")), "searchbox");
    assert_eq!(map("AXTextArea", None), "textbox");
    assert_eq!(map("AXCheckBox", Some("AXSwitch")), "switch");
    assert_eq!(map("AXCheckBox", Some("AXToggle")), "checkbox");
    assert_eq!(map("AXMenuBarItem", None), "menuitem");
    assert_eq!(map("AXIncrementor", None), "generic");
}

// MARK: - Events to steps

#[test]
fn click_type_and_menu_become_semantic_steps() {
    let m = mapper();
    let button = with(el("AXButton", Some("New Message")), |e| {
        e.identifier = Some("newMessage".into());
        e.path = vec!["Inbox".into()];
    });
    let subject = with(el("AXTextField", Some("Subject")), |e| {
        e.identifier = Some("subjectField".into())
    });
    assert_eq!(
        m.handle(&Event::Press(button))
            .iter()
            .map(|s| s.kind.as_str())
            .collect::<Vec<_>>(),
        ["app_click"]
    );
    m.handle(&Event::Focus(subject.clone(), None));
    for v in ["Q", "Quarterly", "Quarterly report"] {
        m.handle(&Event::ValueChanged(subject.clone(), Some(v.into())));
    }
    let menu = with(el("AXMenuItem", Some("Export")), |e| {
        e.path = vec![];
        e.menu_path = vec!["File".into(), "Export".into()];
    });
    let out = m.handle(&Event::MenuChosen(menu));
    // Typing flushes before the next step.
    assert_eq!(
        out.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(),
        ["app_type", "app_menu"]
    );
    let steps = m.finish();
    assert_eq!(
        steps.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(),
        ["app_click", "app_type", "app_menu"]
    );

    assert_eq!(
        steps[0].app,
        policy::AppRef {
            bundle_id: NOTEPAD.into(),
            name: "Notepad".into()
        }
    );
    assert_eq!(
        (steps[0].role.as_deref(), steps[0].name.as_deref()),
        (Some("button"), Some("New Message"))
    );
    assert_eq!(
        steps[0].path.as_deref(),
        Some(&["Inbox".to_owned(), "New Message".to_owned()][..])
    );
    assert_eq!(steps[0].fallback.as_deref(), Some("identifier:newMessage"));

    assert_eq!(
        (steps[1].role.as_deref(), steps[1].name.as_deref()),
        (Some("textbox"), Some("Subject"))
    );
    // The whole value, not each keystroke.
    assert_eq!(steps[1].sample.as_deref(), Some("Quarterly report"));
    assert_eq!(steps[1].sensitive, None);

    assert_eq!(
        steps[2].path.as_deref(),
        Some(&["File".to_owned(), "Export".to_owned()][..])
    );
    assert_eq!(
        (steps[2].name.as_deref(), steps[2].role.as_deref()),
        (Some("Export"), Some("menuitem"))
    );
    assert_eq!(
        steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
        ["a1", "a2", "a3"]
    );
}

#[test]
fn the_wire_shape_is_the_protocols_captured_step() {
    let m = mapper();
    m.handle(&Event::Press(el("AXButton", Some("Archive"))));
    let v: Value = serde_json::to_value(m.finish()).unwrap();
    assert_eq!(
        v[0],
        json!({ "id": "a1", "kind": "app_click", "app": { "bundleId": NOTEPAD, "name": "Notepad" }, "role": "button", "name": "Archive", "path": ["New Message", "Archive"] })
    );
}

#[test]
fn typing_is_one_step_per_field_and_an_emptied_field_is_none() {
    let m = mapper();
    let to = el("AXTextField", Some("To"));
    let cc = el("AXTextField", Some("Cc"));
    m.handle(&Event::Focus(to.clone(), None));
    m.handle(&Event::ValueChanged(to.clone(), Some("a".into())));
    m.handle(&Event::ValueChanged(to, Some("ana@example.com".into())));
    m.handle(&Event::Focus(cc.clone(), None)); // leaving the field flushes it
    m.handle(&Event::ValueChanged(cc.clone(), Some("x".into())));
    m.handle(&Event::ValueChanged(cc, Some(String::new())));
    let steps = m.finish();
    assert_eq!(steps.len(), 1);
    assert_eq!(
        (steps[0].name.as_deref(), steps[0].sample.as_deref()),
        (Some("To"), Some("ana@example.com"))
    );
}

#[test]
fn secure_fields_are_skipped_and_their_value_is_never_kept() {
    let m = mapper();
    let pw = with(el("AXSecureTextField", Some("Password")), |e| {
        e.identifier = Some("pw".into())
    });
    m.handle(&Event::Focus(pw.clone(), None));
    // Even if a source wrongly handed the value over, it never reaches a step.
    m.handle(&Event::ValueChanged(pw.clone(), Some("hunter2".into())));
    m.handle(&Event::ValueChanged(pw, Some("hunter22".into())));
    let steps = m.finish();
    assert_eq!(steps.len(), 1);
    assert_eq!(
        (steps[0].kind.as_str(), steps[0].sensitive),
        ("app_type", Some(true))
    );
    assert_eq!(steps[0].sample, None);
    assert!(!json_of(&steps).contains("hunter"));
}

#[test]
fn a_password_field_with_focus_and_secret_words_mark_a_field_sensitive() {
    let m = mapper();
    let subject = with(el("AXTextField", Some("Subject")), |e| {
        e.secure_input = true
    });
    let code = el("AXTextField", Some("Verification code"));
    m.handle(&Event::Focus(subject.clone(), None));
    m.handle(&Event::ValueChanged(subject, Some("secret subject".into())));
    m.handle(&Event::Focus(code.clone(), None));
    m.handle(&Event::ValueChanged(code, Some("123456".into())));
    let steps = m.finish();
    assert_eq!(
        steps.iter().map(|s| s.sensitive).collect::<Vec<_>>(),
        [Some(true), Some(true)]
    );
    assert!(steps.iter().all(|s| s.sample.is_none()));
}

#[test]
fn a_secret_shaped_value_in_an_ordinary_field_is_dropped() {
    let m = mapper();
    let note = el("AXTextArea", Some("Body"));
    let card = card_number();
    m.handle(&Event::Focus(note.clone(), None));
    m.handle(&Event::ValueChanged(note, Some(card.clone())));
    let steps = m.finish();
    assert_eq!(steps.len(), 1);
    assert_eq!(
        (steps[0].sensitive, steps[0].sample.clone()),
        (Some(true), None)
    );
    assert!(!json_of(&steps).contains(&card));
    assert_eq!(m.skipped(), 1);
}

#[test]
fn value_changes_are_accepted_from_the_focused_field_only() {
    let m = mapper();
    let subject = el("AXTextField", Some("Subject"));
    let other = el("AXTextField", Some("Search"));
    // No focus yet: nothing counts.
    m.handle(&Event::ValueChanged(subject.clone(), Some("early".into())));
    m.handle(&Event::Focus(subject.clone(), None));
    m.handle(&Event::ValueChanged(other, Some("typed elsewhere".into())));
    m.handle(&Event::ValueChanged(subject, Some("Weekly".into())));
    let steps = m.finish();
    assert_eq!(
        steps.iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
        [Some("Subject".to_owned())]
    );
    assert_eq!(steps[0].sample.as_deref(), Some("Weekly"));
}

#[test]
fn the_recording_is_bound_to_the_process() {
    let m = mapper();
    m.bind(100);
    let mine = el("AXButton", Some("Archive"));
    // The same app id string from another process.
    let imposter = with(el("AXButton", Some("Delete")), |e| e.pid = 200);
    assert!(m.handle(&Event::Press(imposter)).is_empty());
    assert_eq!(m.handle(&Event::Press(mine)).len(), 1);
    // A scope can name several processes (the app and its frame host).
    let m = mapper();
    m.bind_scope(Arc::new(|p| p == 100 || p == 300));
    assert_eq!(
        m.handle(&Event::Press(with(el("AXButton", Some("Open")), |e| e
            .pid =
            300)))
            .len(),
        1
    );
}

#[test]
fn rows_and_cells_are_recorded_by_role_never_by_content() {
    let m = mapper();
    let row = with(el("AXRow", Some("Invoice from dana@example.com")), |e| {
        e.description = Some("Re: layoffs".into());
        e.identifier = Some("row7".into());
        e.path = vec!["Inbox".into(), "Quiet subject".into()];
    });
    let step = m.handle(&Event::Press(row)).into_iter().next().unwrap();
    assert_eq!(
        (
            step.role.as_deref(),
            step.name.clone(),
            step.fallback.clone()
        ),
        (Some("row"), None, None)
    );
    assert_eq!(step.path.as_deref(), Some(&["row".to_owned()][..]));
    let json = json_of(&m.finish());
    assert!(!json.contains("dana") && !json.contains("layoffs") && !json.contains("Quiet"));
}

#[test]
fn a_window_title_and_the_label_before_a_field_decide_it_but_are_never_kept() {
    // "Two-factor authentication" window, a sibling label, and a field with no words of its own.
    let code = with(el("AXTextField", None), |e| {
        e.path = vec![];
        e.context = vec![
            "Two-factor authentication".into(),
            "We sent a verification code to your phone".into(),
        ];
    });
    assert!(policy::is_secret(&code));
    let m = mapper();
    m.handle(&Event::Focus(code.clone(), None));
    m.handle(&Event::ValueChanged(code, Some("x".into())));
    let steps = m.finish();
    assert_eq!(
        (steps.len(), steps[0].sensitive, steps[0].sample.clone()),
        (1, Some(true), None)
    );
    let json = json_of(&steps);
    assert!(!json.contains("Two-factor") && !json.contains("verification"));
    // A plain window is not secret.
    let plain = with(el("AXTextField", Some("Subject")), |e| {
        e.context = vec!["New Message".into(), "Subject:".into()]
    });
    assert!(!policy::is_secret(&plain));
}

#[test]
fn a_bare_code_number_is_sensitive_even_in_a_plain_field() {
    let m = mapper();
    let f = el("AXTextField", Some("Amount"));
    m.handle(&Event::Focus(f.clone(), None));
    m.handle(&Event::ValueChanged(f, Some("482913".into())));
    let s = m.finish();
    assert_eq!(
        (s.len(), s[0].sensitive, s[0].sample.clone()),
        (1, Some(true), None)
    );
}

#[test]
fn only_what_was_typed_after_focus_is_kept() {
    let m = mapper();
    let f = el("AXTextField", Some("Subject"));
    // Pre-filled "Re: " plus what the owner added: only the addition.
    m.handle(&Event::Focus(f.clone(), Some("Re: ".into())));
    m.handle(&Event::ValueChanged(f, Some("Re: Weekly".into())));
    assert_eq!(m.finish()[0].sample.as_deref(), Some("Weekly"));
    // Autofilled and untouched: nothing.
    let m2 = mapper();
    let g = el("AXTextField", Some("Name"));
    m2.handle(&Event::Focus(g.clone(), Some("Dana Example".into())));
    m2.handle(&Event::ValueChanged(g, Some("Dana Example".into())));
    assert!(m2.finish().is_empty());
    // A pre-filled secret-looking value that is appended to: the appended part decides.
    let m3 = mapper();
    let h = el("AXTextField", Some("Notes"));
    m3.handle(&Event::Focus(h.clone(), Some("ref ".into())));
    m3.handle(&Event::ValueChanged(
        h,
        Some(format!("ref {}", card_number())),
    ));
    assert_eq!(m3.finish()[0].sensitive, Some(true));
}

#[test]
fn unnamed_controls_and_secret_controls_are_left_out_and_counted() {
    let m = mapper();
    assert!(
        m.handle(&Event::Press(
            with(el("AXButton", None), |e| e.path = vec![])
        ))
        .is_empty()
    );
    let show = with(el("AXButton", Some("Show password")), |e| e.path = vec![]);
    assert!(m.handle(&Event::Press(show)).is_empty());
    assert_eq!(m.skipped(), 2);
    assert_eq!(m.step_count(), 0);
}

#[test]
fn a_double_press_on_the_same_control_is_one_step() {
    let m = mapper();
    let b = el("AXButton", Some("Archive"));
    assert_eq!(m.handle(&Event::Press(b.clone())).len(), 1);
    assert!(m.handle(&Event::Press(b)).is_empty());
}

#[test]
fn moving_into_a_field_is_not_a_step() {
    let m = mapper();
    assert!(
        m.handle(&Event::Press(el("AXTextField", Some("Subject"))))
            .is_empty()
    );
    assert_eq!(m.step_count(), 0);
}

#[test]
fn dynamic_menus_stop_at_the_menu() {
    let m = mapper();
    let recent = with(el("AXMenuItem", Some("report.docx")), |e| {
        e.menu_path = vec!["File".into(), "Open Recent".into(), "report.docx".into()]
    });
    let step = m
        .handle(&Event::MenuChosen(recent))
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(
        step.path.as_deref(),
        Some(&["File".to_owned(), "Open Recent".to_owned()][..])
    );
    assert!(!json_of(&m.finish()).contains("report.docx"));
}

#[test]
fn events_from_never_recorded_apps_are_counted_and_dropped() {
    let m = mapper();
    let uac = with(el("AXButton", Some("Yes")), |e| {
        e.bundle_id = "consent.exe".into()
    });
    assert!(m.handle(&Event::Press(uac)).is_empty());
    assert_eq!(m.skipped(), 1);
    // Another ordinary app: ignored without a count.
    let other = with(el("AXButton", Some("Go")), |e| {
        e.bundle_id = "calc.exe".into()
    });
    assert!(m.handle(&Event::Press(other)).is_empty());
    assert_eq!(m.skipped(), 1);
    // A mapper for a never-recorded app records nothing.
    let psyche = Mapper::new("psyche.exe", "Psyche", 200);
    let own = with(el("AXButton", Some("Approve")), |e| {
        e.bundle_id = "psyche.exe".into()
    });
    assert!(psyche.handle(&Event::Press(own)).is_empty());
    assert_eq!(psyche.skipped(), 1);
}

// MARK: - Live element conversion and menu trails

#[test]
fn live_elements_split_ancestors_into_path_and_menu_chain() {
    let te = psyche_win_computer::TeachElement {
        pid: 100,
        role: "AXMenuItem".into(),
        title: Some("Export".into()),
        path: vec![
            ("AXWindow".into(), "Quarterly.docx - Word".into()),
            ("AXMenuBar".into(), String::new()),
            ("AXMenu".into(), "File".into()),
            ("AXGroup".into(), "Ribbon".into()),
            ("AXRow".into(), "a user's data".into()),
        ],
        ..Default::default()
    };
    let e = live::element_of(NOTEPAD, "Notepad", te);
    // The window's title (a document's name) and a row's text are never path.
    assert_eq!(e.path, ["Ribbon"]);
    assert_eq!(e.menu_path, ["File", "Export"]);
    assert_eq!((e.bundle_id.as_str(), e.pid), (NOTEPAD, 100));
}

#[test]
fn a_popup_menu_chain_is_completed_from_the_menu_bar_trail() {
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    // No trail: the popup's own chain.
    assert_eq!(
        live::merge_menu(&[], &s(&["File", "Save"])),
        s(&["File", "Save"])
    );
    // The popup is named after its opener: no duplicate.
    assert_eq!(
        live::merge_menu(&s(&["File"]), &s(&["File", "Save"])),
        s(&["File", "Save"])
    );
    // An unnamed popup: the trail is the prefix.
    assert_eq!(
        live::merge_menu(&s(&["File"]), &s(&["Save"])),
        s(&["File", "Save"])
    );
    // A submenu.
    assert_eq!(
        live::merge_menu(&s(&["File", "Export"]), &s(&["Export", "PDF"])),
        s(&["File", "Export", "PDF"])
    );
}

// MARK: - Controller

#[derive(Default)]
struct SourceState {
    on_event: Mutex<Option<Arc<dyn Fn(Event) + Send + Sync>>>,
    on_end: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    bundle: Mutex<String>,
    started: AtomicBool,
    stopped: AtomicBool,
    deny: AtomicBool,
    /// When set, `start` waits here before it returns: a Stop or Cancel can land mid-start.
    gate: Mutex<Option<Receiver<()>>>,
    entered: Mutex<Option<Sender<()>>>,
}

#[derive(Clone, Default)]
struct FakeSource(Arc<SourceState>);

impl Source for FakeSource {
    fn start(
        &mut self,
        bundle_id: &str,
        bind: Arc<dyn Fn(Scope) + Send + Sync>,
        on_event: Arc<dyn Fn(Event) + Send + Sync>,
        on_end: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<(), CapabilityError> {
        if self.0.deny.load(Ordering::SeqCst) {
            return Err(CapabilityError::permission_missing(
                OsPermission::Accessibility,
            ));
        }
        bind(Arc::new(|pid| pid == 100));
        if let Some(tx) = self.0.entered.lock().unwrap().take() {
            let _ = tx.send(());
        }
        if let Some(rx) = self.0.gate.lock().unwrap().take() {
            let _ = rx.recv();
        }
        *self.0.on_event.lock().unwrap() = Some(on_event);
        *self.0.on_end.lock().unwrap() = Some(on_end);
        *self.0.bundle.lock().unwrap() = bundle_id.to_owned();
        self.0.started.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn stop(&mut self) {
        self.0.stopped.store(true, Ordering::SeqCst);
    }
}

impl FakeSource {
    fn send(&self, e: Event) {
        let f = self.0.on_event.lock().unwrap().clone();
        if let Some(f) = f {
            f(e);
        }
    }
    fn end(&self) {
        let f = self.0.on_end.lock().unwrap().clone();
        if let Some(f) = f {
            f();
        }
    }
    fn started(&self) -> bool {
        self.0.started.load(Ordering::SeqCst)
    }
    fn stopped(&self) -> bool {
        self.0.stopped.load(Ordering::SeqCst)
    }
}

#[derive(Default)]
struct FakeIndicator {
    shown: Mutex<Option<String>>,
    hidden: AtomicUsize,
    stop: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Indicator for FakeIndicator {
    fn show(&self, app_name: &str, on_stop: Arc<dyn Fn() + Send + Sync>) {
        *self.shown.lock().unwrap() = Some(app_name.to_owned());
        *self.stop.lock().unwrap() = Some(on_stop);
    }
    fn hide(&self) {
        self.hidden.fetch_add(1, Ordering::SeqCst);
    }
}

/// Lets spawned timers run (the clock is paused).
async fn settle() {
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
}

fn press(title: &str) -> Event {
    Event::Press(with(el("AXButton", Some(title)), |e| {
        e.path = vec!["Inbox".into()]
    }))
}

struct Rig {
    teach: Arc<AppTeachController>,
    source: FakeSource,
    indicator: Arc<FakeIndicator>,
}

fn rig_with(tiers: TierSettings, running: bool, max_seconds: u64, unclaimed: u64) -> Rig {
    let source = FakeSource::default();
    let indicator = Arc::new(FakeIndicator::default());
    let s = source.clone();
    let teach = AppTeachController::new(
        move || Box::new(s.clone()),
        indicator.clone(),
        move || tiers.clone(),
        move |id| (running && id == NOTEPAD).then(|| "Notepad".to_owned()),
        max_seconds,
        unclaimed,
        HelperLog::quiet(),
    );
    Rig {
        teach,
        source,
        indicator,
    }
}

fn rig() -> Rig {
    rig_with(granted(), true, 900, 1800)
}

#[tokio::test]
async fn records_one_granted_app_shows_the_indicator_and_hands_over_once() {
    let r = rig();
    let (_, app) = r.teach.begin(NOTEPAD).unwrap();
    assert_eq!(app.name, "Notepad");
    assert!(r.source.started() && *r.source.0.bundle.lock().unwrap() == NOTEPAD);
    // Visible while it records.
    assert_eq!(
        r.indicator.shown.lock().unwrap().as_deref(),
        Some("Notepad")
    );
    assert_eq!(r.teach.status()["active"], true);
    // One at a time.
    assert_eq!(r.teach.begin(NOTEPAD).unwrap_err().reason, "teach_busy");

    r.source.send(press("New Message"));
    // Not the recorded process, and not the recorded app.
    r.source
        .send(Event::Press(with(el("AXButton", Some("Other")), |e| {
            e.pid = 999
        })));
    r.source
        .send(Event::Press(with(el("AXButton", Some("Other")), |e| {
            e.bundle_id = "calc.exe".into()
        })));
    let out = r.teach.collect().unwrap();
    assert!(r.source.stopped() && r.indicator.hidden.load(Ordering::SeqCst) == 1);
    assert_eq!(
        (out["endedBy"].as_str(), out["app"]["bundleId"].as_str()),
        (Some("stop"), Some(NOTEPAD))
    );
    assert_eq!(out["steps"].as_array().unwrap().len(), 1);
    assert_eq!(out["steps"][0]["kind"], "app_click");
    assert_eq!(out["skipped"], 0);
    // Handed over once; the helper keeps nothing.
    assert_eq!(r.teach.collect().unwrap_err().reason, "teach_not_found");
    assert_eq!(r.teach.status()["active"], false);
}

#[tokio::test]
async fn stop_is_always_available_from_the_indicator() {
    let r = rig();
    r.teach.begin(NOTEPAD).unwrap();
    r.source.send(press("Archive"));
    let stop = r.indicator.stop.lock().unwrap().clone().unwrap();
    stop(); // the pill's Stop
    assert!(r.source.stopped() && r.teach.active_id().is_none());
    // Steps stay until the owner's Stop in Psyche collects them.
    assert_eq!(
        r.teach.collect().unwrap()["steps"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn refuses_apps_that_are_not_granted_or_never_recorded() {
    let none = rig_with(settings(&[]), true, 900, 1800);
    let e = none.teach.begin(NOTEPAD).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::PolicyDenied, "app_not_granted")
    );
    for (app, why) in [
        ("psyche.exe", "psyche_app"),
        ("consent.exe", "security_prompt"),
        ("credentialuibroker.exe", "security_prompt"),
        ("logonui.exe", "security_prompt"),
        ("1password.exe", "password_manager"),
        ("tradingview.exe", "app_off_limits"),
        ("chrome.exe", "app_off_limits"),
    ] {
        let r = rig_with(settings(&[(app, SettingValue::Interact)]), true, 900, 1800);
        let e = r.teach.begin(app).unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (ErrorCode::PolicyDenied, why),
            "{app}"
        );
        // Nothing was watched.
        assert!(!r.source.started(), "{app}");
    }
    let bad = rig().teach.begin("").unwrap_err();
    assert_eq!(bad.code, ErrorCode::InvalidParams);
}

#[tokio::test]
async fn needs_the_hooks_and_a_running_app() {
    let denied = rig();
    denied.source.0.deny.store(true, Ordering::SeqCst);
    let e = denied.teach.begin(NOTEPAD).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::Forbidden, "permission_missing")
    );
    assert!(denied.teach.active_id().is_none());
    let not_running = rig_with(granted(), false, 900, 1800);
    let e = not_running.teach.begin(NOTEPAD).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str(), e.retryable),
        (ErrorCode::Unavailable, "app_not_running", true)
    );
}

#[tokio::test]
async fn the_app_quitting_ends_the_recording_and_keeps_what_was_caught() {
    let r = rig();
    r.teach.begin(NOTEPAD).unwrap();
    r.source.send(press("Archive"));
    r.source.end();
    assert_eq!(r.indicator.hidden.load(Ordering::SeqCst), 1);
    assert_eq!(r.teach.status()["ended"], "interrupted");
    assert_eq!(r.teach.status()["active"], false);
    assert_eq!(r.teach.collect().unwrap()["endedBy"], "interrupted");
}

#[tokio::test]
async fn the_step_limit_ends_it() {
    let r = rig();
    r.teach.begin(NOTEPAD).unwrap();
    for i in 0..250 {
        r.source.send(press(&format!("B{i}")));
    }
    assert_eq!(r.teach.status()["ended"], "limit");
    assert_eq!(
        r.teach.collect().unwrap()["steps"]
            .as_array()
            .unwrap()
            .len(),
        200
    );
}

#[tokio::test]
async fn the_time_limit_ends_it_and_an_unclaimed_recording_is_forgotten() {
    tokio::time::pause();
    let r = rig_with(granted(), true, 900, 1800);
    r.teach.begin(NOTEPAD).unwrap();
    // Let the limit timer register its deadline before the clock moves.
    settle().await;
    r.source.send(press("Archive"));
    tokio::time::advance(Duration::from_secs(899)).await;
    settle().await;
    assert_eq!(r.teach.status()["active"], true);
    tokio::time::advance(Duration::from_secs(2)).await;
    settle().await;
    assert_eq!(r.teach.status()["ended"], "timeout");
    assert!(r.source.stopped());
    // Nobody collects it: gone on a timer, without anyone asking.
    tokio::time::advance(Duration::from_secs(1802)).await;
    settle().await;
    assert_eq!(r.teach.status(), json!({ "active": false }));
    assert_eq!(r.teach.collect().unwrap_err().reason, "teach_not_found");
}

#[tokio::test]
async fn an_ended_recording_nobody_collected_makes_way_for_a_new_one() {
    let r = rig();
    r.teach.begin(NOTEPAD).unwrap();
    r.source.end();
    let (id, _) = r.teach.begin(NOTEPAD).unwrap();
    assert_eq!(r.teach.active_id().as_deref(), Some(id.as_str()));
}

#[tokio::test]
async fn cancel_drops_everything() {
    let r = rig();
    r.teach.begin(NOTEPAD).unwrap();
    r.source.send(press("Archive"));
    assert!(r.teach.cancel());
    assert!(r.source.stopped() && r.indicator.hidden.load(Ordering::SeqCst) == 1);
    assert_eq!(r.teach.status(), json!({ "active": false }));
    assert_eq!(r.teach.collect().unwrap_err().reason, "teach_not_found");
    assert!(!r.teach.cancel());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_that_lands_while_the_source_is_starting_wins() {
    let r = rig();
    let (gate_tx, gate_rx) = channel::<()>();
    let (entered_tx, entered_rx) = channel::<()>();
    *r.source.0.gate.lock().unwrap() = Some(gate_rx);
    *r.source.0.entered.lock().unwrap() = Some(entered_tx);
    let teach = r.teach.clone();
    let starting = tokio::task::spawn_blocking(move || teach.begin(NOTEPAD));
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // The owner presses Cancel while the hooks come up.
    assert!(r.teach.cancel());
    gate_tx.send(()).unwrap();
    let e = starting.await.unwrap().unwrap_err();
    assert_eq!(e.reason, "teach_cancelled");
    assert!(r.source.stopped(), "the source is torn down again");
    assert!(
        r.indicator.shown.lock().unwrap().is_none(),
        "no indicator for a recording that did not start"
    );
    assert!(r.teach.active_id().is_none());
}

// MARK: - Capabilities

async fn call(
    reg: &CapabilityRegistry,
    name: &str,
    params: Value,
) -> Result<crate::node::CapabilityOutput, CapabilityError> {
    (reg.get(name).unwrap().handler)(InvocationContext::detached(name, params)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_capabilities_are_exactly_teach_record_start_stop_status_cancel() {
    let r = rig();
    let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
    register_with(&mut reg, r.teach.clone());
    assert_eq!(
        reg.names(),
        [
            "teach.record.start",
            "teach.record.stop",
            "teach.record.cancel",
            "teach.record.status"
        ]
    );
    let start = reg.get("teach.record.start").unwrap();
    assert_eq!(start.spec.receipt_kind.as_deref(), Some("teach"));
    assert_eq!(start.spec.permissions, [OsPermission::Accessibility]);
    assert_eq!(start.spec.side_effect, SideEffect::Write);
    assert_eq!(
        reg.get("teach.record.stop").unwrap().spec.side_effect,
        SideEffect::None
    );
    assert_eq!(
        reg.get("teach.record.cancel").unwrap().spec.side_effect,
        SideEffect::None
    );
    assert_eq!(
        reg.get("teach.record.status").unwrap().spec.side_effect,
        SideEffect::Read
    );
    let m = start.spec.manifest_entry();
    assert_eq!(m["inputSchema"]["required"], json!(["bundleId"]));
    assert_eq!(
        m["inputSchema"]["properties"]["bundleId"]["maxLength"].as_f64(),
        Some(200.0)
    );
    assert_eq!(m["inputSchema"]["additionalProperties"], false);
    // Nothing of the old `teach.*` names, and no streaming: steps never leave the helper until stop.
    assert!(reg.get("teach.start").is_none() && !start.spec.streaming);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn start_status_stop_round_trip_through_the_capabilities() {
    let r = rig();
    let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
    register_with(&mut reg, r.teach.clone());
    assert_eq!(
        call(&reg, "teach.record.status", json!({}))
            .await
            .unwrap()
            .result,
        json!({ "active": false })
    );
    let started = call(&reg, "teach.record.start", json!({ "bundleId": NOTEPAD }))
        .await
        .unwrap();
    assert_eq!(
        started.result["app"],
        json!({ "bundleId": NOTEPAD, "name": "Notepad" })
    );
    assert!(
        started.result["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("app-teach-")
    );
    assert_eq!(
        started.receipt.unwrap().summary,
        "Started recording in Notepad"
    );
    r.source.send(press("Archive"));
    let status = call(&reg, "teach.record.status", json!({}))
        .await
        .unwrap()
        .result;
    assert_eq!(
        (
            status["active"].clone(),
            status["steps"].clone(),
            status["app"]["bundleId"].clone()
        ),
        (json!(true), json!(1), json!(NOTEPAD))
    );
    assert!(status["startedAt"].is_string() && status.get("ended").is_none());
    let stopped = call(&reg, "teach.record.stop", json!({})).await.unwrap();
    assert_eq!(stopped.result["steps"][0]["name"], "Archive");
    assert_eq!(stopped.receipt.unwrap().summary, "Recorded 1 steps");
    let gone = call(&reg, "teach.record.stop", json!({}))
        .await
        .unwrap_err();
    assert_eq!(gone.reason, "teach_not_found");
    // Cancel with nothing running says so; a refusal is a policy denial.
    assert_eq!(
        call(&reg, "teach.record.cancel", json!({}))
            .await
            .unwrap()
            .result,
        json!({ "cancelled": false })
    );
    let denied = call(
        &reg,
        "teach.record.start",
        json!({ "bundleId": "consent.exe" }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        (denied.code, denied.reason.as_str()),
        (ErrorCode::PolicyDenied, "security_prompt")
    );
    assert_eq!(denied.details["app"], "consent.exe");
    let bad = call(&reg, "teach.record.start", json!({}))
        .await
        .unwrap_err();
    assert_eq!(bad.code, ErrorCode::InvalidParams);
}

/// `recording_active` follows the live controller `register` made; this test stands one in (the
/// only test that does: the controller is process-wide) and checks that `computer.*` is refused
/// while it records, and that releasing a session lock is not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn computer_use_is_refused_while_recording() {
    assert!(
        !recording_active(),
        "nothing records before a controller is registered"
    );
    let r = rig();
    LIVE.set(r.teach.clone())
        .ok()
        .expect("the only test that sets the live controller");
    let mut reg = CapabilityRegistry::new(Runtime::offline(Env::default()));
    crate::computer::register(&mut reg);
    assert!(refuse_while_recording().is_ok());
    r.teach.begin(NOTEPAD).unwrap();
    assert!(recording_active());
    let e = refuse_while_recording().unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str(), e.retryable),
        (ErrorCode::Conflict, "recording_active", true)
    );
    for name in [
        "computer.ax_tree",
        "computer.check_target",
        "computer.click",
        "computer.type",
        "computer.key",
        "computer.screenshot",
    ] {
        let e = call(&reg, name, json!({ "app": NOTEPAD, "role": "button", "name": "x", "x": 1, "y": 1, "text": "a", "keys": "a", "session": "s" }))
            .await
            .unwrap_err();
        assert_eq!(e.reason, "recording_active", "{name}");
    }
    // Releasing a session lock is never blocked.
    assert!(
        call(&reg, "computer.end_session", json!({ "session": "s" }))
            .await
            .is_ok()
    );
    // Once the recording ends, computer use is available again.
    r.teach.collect().unwrap();
    assert!(!recording_active());
    assert!(refuse_while_recording().is_ok());
    let e = call(
        &reg,
        "computer.check_target",
        json!({ "app": NOTEPAD, "name": "x", "session": "s" }),
    )
    .await
    .unwrap_err();
    assert_eq!(
        e.reason, "invalid_params",
        "the capability runs again (here: refused for its missing role)"
    );
}

// MARK: - Live

mod live_window {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        BS_PUSHBUTTON, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        ES_AUTOHSCROLL, ES_PASSWORD, GetMessageW, MSG, PostQuitMessage, RegisterClassW,
        SW_SHOWNORMAL, SetForegroundWindow, ShowWindow, TranslateMessage, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WNDCLASSW, WS_CHILD, WS_EX_CLIENTEDGE,
        WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE,
    };
    use windows::core::{HSTRING, w};

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        unsafe {
            match msg {
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

    /// A plain Win32 window: "Subject" and a text box, "Password" and a password box, an
    /// "Archive" button. Runs until it is closed.
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
            let child =
                |class: windows::core::PCWSTR, text: &str, style: u32, ex: u32, y: i32, h: i32| {
                    CreateWindowExW(
                        WINDOW_EX_STYLE(ex),
                        class,
                        &HSTRING::from(text),
                        WS_CHILD | WS_VISIBLE | WS_TABSTOP | WINDOW_STYLE(style),
                        20,
                        y,
                        360,
                        h,
                        Some(main),
                        None,
                        Some(instance),
                        None,
                    )
                    .expect("child")
                };
            child(w!("STATIC"), "Subject", 0, 0, 10, 20);
            child(
                w!("EDIT"),
                "",
                ES_AUTOHSCROLL as u32,
                WS_EX_CLIENTEDGE.0,
                32,
                26,
            );
            child(w!("STATIC"), "Password", 0, 0, 70, 20);
            child(
                w!("EDIT"),
                "",
                (ES_AUTOHSCROLL | ES_PASSWORD) as u32,
                WS_EX_CLIENTEDGE.0,
                92,
                26,
            );
            child(w!("BUTTON"), "Archive", BS_PUSHBUTTON as u32, 0, 130, 32);
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

/// Env var that turns [`live_window_host`] (run in a child process of this test binary) into the
/// owner of the window the live recording targets; its value is the window title.
const LIVE_WINDOW_ENV: &str = "PSYCHE_TEACH_LIVE_WINDOW";

/// Not a test of its own: the window [`live_records_an_owned_window`] starts in a child process
/// of this binary (`LIVE_WINDOW_ENV` set). Returns at once otherwise.
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

/// The window's child controls, top to bottom, with their centres in screen pixels.
fn child_centres(hwnd: isize) -> Vec<(String, i32, i32, isize)> {
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, GetWindowRect};
    use windows::core::BOOL;
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> BOOL {
        unsafe {
            let out = &mut *(lp.0 as *mut Vec<(String, RECT, isize)>);
            let mut class = [0u16; 64];
            let n = GetClassNameW(h, &mut class) as usize;
            let mut r = RECT::default();
            let _ = GetWindowRect(h, &mut r);
            out.push((String::from_utf16_lossy(&class[..n]), r, h.0 as isize));
        }
        BOOL(1)
    }
    let mut found: Vec<(String, RECT, isize)> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            Some(HWND(hwnd as *mut _)),
            Some(each),
            LPARAM(&mut found as *mut _ as isize),
        );
    }
    found.sort_by_key(|(_, r, _)| r.top);
    found
        .into_iter()
        .map(|(c, r, h)| (c, (r.left + r.right) / 2, (r.top + r.bottom) / 2, h))
        .collect()
}

/// Live: the real source records a window this test owns (a plain Win32 window in a child process
/// of this binary). Typing is real input into the window (computer use's `SendInput`, which the
/// hooks ignore as presses but UI Automation still reads as a value change, as AXValueChanged is
/// on the Mac); the owner's mouse press and key signal are fed at the hook boundary, because a
/// test cannot produce hardware input. The password field's value is never read. Nothing outside
/// the test's window is touched, and the window is closed afterwards.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn live_records_an_owned_window() {
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
    let mut window = None;
    for _ in 0..60 {
        window = apps::top_windows()
            .into_iter()
            .find(|w| w.pid == host_pid && w.title == name);
        if window.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let window = window.expect("the test window opened");
    let app = apps::app_for_window(&window).expect("the test window's app");
    let app_id = app.bundle_id.clone().expect("app id");
    assert_eq!(app.pid, host_pid);

    // Computer use reads its tiers from `%PSYCHE_HOME%\config\computer-use.json` once per process:
    // point it at a home of this test's that grants the test window's app (never the owner's own
    // settings, which may say "off").
    let home = std::env::temp_dir().join(format!("psyche-teach-live-{}", std::process::id()));
    std::fs::create_dir_all(home.join("config")).unwrap();
    std::fs::write(
        home.join("config").join("computer-use.json"),
        json!({ "version": 1, "default": "ask", "apps": { app_id.clone(): "interact" } })
            .to_string(),
    )
    .unwrap();
    // SAFETY: set before computer use first reads it; the live tests run one at a time.
    unsafe { std::env::set_var("PSYCHE_HOME", &home) };
    assert_eq!(
        wc::tiers::TierSettings::path(),
        home.join("config").join("computer-use.json")
    );

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
    let controls = child_centres(hwnd);
    let classes: Vec<&str> = controls.iter().map(|c| c.0.as_str()).collect();
    assert_eq!(
        classes,
        ["Static", "Edit", "Static", "Edit", "Button"],
        "{controls:?}"
    );
    let (subject, password, button) = (&controls[1], &controls[3], &controls[4]);

    // The pill is covered by `live_indicator_has_a_working_stop`: it is a window of this process, which shares
    // its executable name with the window host, so it would be found first by app id.
    let indicator = Arc::new(FakeIndicator::default());
    let granted_to_test = settings(&[(app_id.as_str(), SettingValue::Interact)]);
    let ind = indicator.clone();
    let teach = AppTeachController::new(
        || Box::new(live::LiveSource::default()),
        ind,
        move || granted_to_test.clone(),
        move |id| {
            apps::windowed_apps()
                .into_iter()
                .find(|a| a.bundle_id.as_deref() == Some(id))
                .map(|a| a.name)
        },
        900,
        1800,
        HelperLog::quiet(),
    );
    let started = std::time::Instant::now();
    let (id, rec_app) = teach.begin(&app_id).unwrap();
    assert!(live::is_recording());
    assert_eq!(rec_app.bundle_id, app_id);

    const SESSION: &str = "teach-live";
    let act = |what: &'static str, params: Value| {
        let params = {
            let mut p = params;
            p["app"] = json!(app_id);
            p["session"] = json!(SESSION);
            p
        };
        tokio::task::spawn_blocking(move || match what {
            "click" => wc::computer_click(params),
            _ => wc::computer_type(params),
        })
    };
    // The recorder reads the focused element once at start; let that first UI Automation use finish
    // before computer use makes its own (two first uses at once can fail to create the client).
    tokio::time::sleep(Duration::from_millis(1200)).await;
    // Real input into the subject box: it takes focus, then the text arrives.
    assert!(ours().is_some(), "our window in front before any input");
    let r = act("click", json!({ "x": subject.1, "y": subject.2 }))
        .await
        .unwrap();
    assert!(r.is_ok(), "{r:?}");
    tokio::time::sleep(Duration::from_millis(900)).await;
    let r = act("type", json!({ "text": "Weekly report" }))
        .await
        .unwrap();
    assert!(r.is_ok(), "{r:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    // The owner presses "Archive" (at the hook boundary).
    assert!(ours().is_some(), "still our window in front");
    live::simulate_down(button.1, button.2);
    live::simulate_up();
    tokio::time::sleep(Duration::from_millis(800)).await;
    // Then moves to the password box and types there. Computer use refuses password fields, so the
    // test moves focus and sets the text with window messages; the owner's key press is the signal.
    // The value is never read.
    {
        use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
        use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
        use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowThreadProcessId, SendMessageW, WM_SETTEXT,
        };
        let edit = HWND(password.3 as *mut _);
        unsafe {
            let (me, them) = (GetCurrentThreadId(), GetWindowThreadProcessId(edit, None));
            let _ = AttachThreadInput(me, them, true);
            let _ = SetFocus(Some(edit));
            let _ = AttachThreadInput(me, them, false);
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let text = windows::core::HSTRING::from("hunter2-live");
        unsafe {
            SendMessageW(
                edit,
                WM_SETTEXT,
                Some(WPARAM(0)),
                Some(LPARAM(text.as_ptr() as isize)),
            );
        }
    }
    live::simulate_key();
    for _ in 0..40 {
        if teach.status()["steps"].as_u64() == Some(3) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let status = teach.status();
    assert_eq!(status["active"], true);
    let out = teach.collect().unwrap();
    let elapsed = started.elapsed();
    assert!(!live::is_recording(), "hooks removed");
    let _ = wc::computer_end_session(json!({ "session": SESSION }));
    let steps = out["steps"].as_array().unwrap().clone();
    println!("{}", serde_json::to_string_pretty(&steps).unwrap());
    println!(
        "session {id}: recorded {} steps in {elapsed:?}, skipped {}",
        steps.len(),
        out["skipped"]
    );
    let kinds: Vec<&str> = steps.iter().map(|s| s["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["app_type", "app_click", "app_type"], "{steps:?}");
    for s in &steps {
        assert_eq!(s["app"]["bundleId"], json!(app_id), "{s}");
        // The window's title (a document's name) is never in a step.
        assert!(!s.to_string().contains(&name), "{s}");
    }
    assert_eq!(
        (steps[0]["role"].as_str(), steps[0]["sample"].as_str()),
        (Some("textbox"), Some("Weekly report"))
    );
    assert_eq!(
        (steps[1]["role"].as_str(), steps[1]["name"].as_str()),
        (Some("button"), Some("Archive"))
    );
    assert_eq!(
        (
            steps[2]["role"].as_str(),
            steps[2]["sensitive"].as_bool(),
            steps[2].get("sample")
        ),
        (Some("textbox"), Some(true), None)
    );
    assert!(
        !out.to_string().contains("hunter"),
        "the password never leaves the helper"
    );

    // Replay: the recorded steps are found again by exact role and name (`computer.check_target`),
    // a near miss is not, and a password field is never a target.
    let check = |role: &'static str, name: &'static str| {
        let (app, session) = (app_id.clone(), SESSION);
        tokio::task::spawn_blocking(move || {
            wc::computer_check_target(
                json!({ "app": app, "role": role, "name": name, "session": session }),
            )
        })
    };
    let found = check("button", "Archive")
        .await
        .unwrap()
        .expect("check_target");
    assert_eq!(
        (
            found["status"].as_str(),
            found["stop"].as_bool(),
            found["role"].as_str()
        ),
        (Some("found"), Some(false), Some("button")),
        "{found}"
    );
    assert!(
        found["ref"].as_str().is_some_and(|r| r.starts_with('e')),
        "{found}"
    );
    let missing = check("button", "Archives")
        .await
        .unwrap()
        .expect("check_target");
    assert_eq!(
        (missing["status"].as_str(), missing["stop"].as_bool()),
        (Some("missing"), Some(true)),
        "{missing}"
    );
    let textbox = check("textbox", "Subject")
        .await
        .unwrap()
        .expect("check_target");
    assert_eq!(textbox["status"], "found", "{textbox}");
    let password = check("textbox", "Password")
        .await
        .unwrap()
        .expect("check_target");
    assert_eq!(password["status"], "missing", "{password}");
    let other_app = tokio::task::spawn_blocking(|| {
        wc::computer_check_target(
            json!({ "app": "no-such-app.exe", "role": "button", "name": "x" }),
        )
    })
    .await
    .unwrap();
    assert!(other_app.is_err());
    let no_role = tokio::task::spawn_blocking({
        let app = app_id.clone();
        move || wc::computer_check_target(json!({ "app": app, "name": "Archive" }))
    })
    .await
    .unwrap();
    assert_eq!(no_role.unwrap_err().reason, "invalid_params");

    // Cleanup: close our window and end its process.
    drop(guard);
    let _ = std::fs::remove_dir_all(&home);
    assert!(
        !apps::top_windows().iter().any(|w| w.pid == host_pid),
        "the test window was closed"
    );
}

/// Live: the Stop on the pill ends the recording; hiding removes the window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn live_indicator_has_a_working_stop() {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SendMessageW, WM_COMMAND};
    let indicator = indicator::LiveIndicator::default();
    let stopped = Arc::new(AtomicBool::new(false));
    let s = stopped.clone();
    indicator.show("Notepad", Arc::new(move || s.store(true, Ordering::SeqCst)));
    let pill = indicator.window().expect("the indicator window");
    // Topmost, visible, named, with a Stop; it does not take focus.
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_EXSTYLE, GetWindowLongW, IsWindowVisible, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
        };
        unsafe {
            let h = HWND(pill as *mut _);
            assert!(IsWindowVisible(h).as_bool());
            let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
            assert_ne!(ex & WS_EX_TOPMOST.0, 0, "topmost");
            assert_ne!(ex & WS_EX_NOACTIVATE.0, 0, "no focus");
        }
        assert_eq!(
            child_centres(pill)
                .iter()
                .map(|c| c.0.as_str())
                .collect::<Vec<_>>(),
            ["Static", "Button"]
        );
    }
    // A click on the Stop button sends the parent WM_COMMAND with the button's id (1001).
    unsafe {
        SendMessageW(
            HWND(pill as *mut _),
            WM_COMMAND,
            Some(WPARAM(1001)),
            Some(LPARAM(0)),
        );
    }
    for _ in 0..40 {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(stopped.load(Ordering::SeqCst));
    indicator.hide();
    for _ in 0..40 {
        if !unsafe { IsWindow(Some(HWND(pill as *mut _))) }.as_bool() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the indicator window is gone after hide");
}
