//! Capability specs as data, mirroring the Mac helper's `CapabilitySpec` fields (name,
//! description, sideEffect, targetKind, inputSchema, streaming, receiptKind) and its input
//! schemas, so the Gateway needs no second driver. The helper registers them without knowing
//! anything about computer use.

use crate::tiers::approval_schema;
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapSpecLite {
    pub name: &'static str,
    pub description: &'static str,
    /// `none` | `read` | `write` | `destructive`.
    pub side_effect: &'static str,
    /// `app` for computer use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<&'static str>,
    pub input_schema: Value,
    pub streaming: bool,
    /// Receipt kind for side-effecting calls (`computer_action`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_kind: Option<&'static str>,
}

impl CapSpecLite {
    /// Wire form (`NodeCapability`), as the mac helper's `manifestEntry`.
    pub fn manifest_entry(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), json!(self.name));
        o.insert("description".into(), json!(self.description));
        o.insert("sideEffect".into(), json!(self.side_effect));
        o.insert("inputSchema".into(), self.input_schema.clone());
        o.insert("streaming".into(), json!(self.streaming));
        if let Some(t) = self.target_kind {
            o.insert("targetKind".into(), json!(t));
        }
        Value::Object(o)
    }
}

// MARK: - Schema builders (the mac `Schema` helpers' output)

pub mod schema {
    use serde_json::{json, Map, Value};

    pub fn object(
        props: Vec<(&str, Value)>,
        required: &[&str],
        description: Option<&str>,
    ) -> Value {
        let mut p = Map::new();
        for (k, v) in props {
            p.insert(k.to_string(), v);
        }
        let mut o = Map::new();
        o.insert("type".into(), json!("object"));
        o.insert("properties".into(), Value::Object(p));
        o.insert("additionalProperties".into(), json!(false));
        if !required.is_empty() {
            let mut r: Vec<&str> = required.to_vec();
            r.sort();
            o.insert("required".into(), json!(r));
        }
        if let Some(d) = description {
            o.insert("description".into(), json!(d));
        }
        Value::Object(o)
    }

    pub fn string(description: Option<&str>) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), json!("string"));
        if let Some(d) = description {
            o.insert("description".into(), json!(d));
        }
        Value::Object(o)
    }

    pub fn string_enum(values: &[&str]) -> Value {
        json!({"type": "string", "enum": values})
    }

    pub fn string_max(max_len: u64) -> Value {
        json!({"type": "string", "maxLength": max_len})
    }

    pub fn integer(description: Option<&str>, min: Option<i64>, max: Option<i64>) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), json!("integer"));
        if let Some(d) = description {
            o.insert("description".into(), json!(d));
        }
        if let Some(m) = min {
            o.insert("minimum".into(), json!(m));
        }
        if let Some(m) = max {
            o.insert("maximum".into(), json!(m));
        }
        Value::Object(o)
    }

    pub fn number(description: Option<&str>) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), json!("number"));
        if let Some(d) = description {
            o.insert("description".into(), json!(d));
        }
        Value::Object(o)
    }

    pub fn boolean(description: Option<&str>) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), json!("boolean"));
        if let Some(d) = description {
            o.insert("description".into(), json!(d));
        }
        Value::Object(o)
    }

    pub fn array(items: Value) -> Value {
        json!({"type": "array", "items": items})
    }
}

use schema::*;

const APP_DESC: &str = "Desktop file id (the Linux bundle id, e.g. org.gnome.TextEditor) or app name; default: focused app";

/// Every computer-use call may carry `approval {app, tier}`: what the Gateway's card covered (#267).
fn with_approval(mut s: Value) -> Value {
    if let Some(props) = s.get_mut("properties").and_then(Value::as_object_mut) {
        props.insert("approval".into(), approval_schema());
    }
    s
}

fn target_schema(extra: Vec<(&str, Value)>, description: &str) -> Value {
    let mut props = vec![
        ("ref", string(Some("Element ref from the latest computer.ax_tree snapshot, e.g. e12"))),
        (
            "selector",
            object(
                vec![("role", string(None)), ("label", string(None)), ("id", string(None))],
                &[],
                Some("Exact match over the last snapshot; must match exactly one element"),
            ),
        ),
        ("x", number(Some("Screen x in pixels (top-left of the screen is 0,0), when no ref"))),
        ("y", number(Some("Screen y in pixels (top-left of the screen is 0,0), when no ref"))),
        (
            "expect",
            object(
                vec![("role", string(None)), ("label", string(None)), ("valuePrefix", string(None))],
                &["role"],
                Some("Copied from the snapshot; the call is refused if the element changed (required with ref)"),
            ),
        ),
        ("session", string(Some("Computer-use session id (the run id); one session drives the computer at a time"))),
        ("app", string(Some("Desktop file id of the app the call targets; required with x/y"))),
    ];
    for (k, v) in extra {
        if let Some(slot) = props.iter_mut().find(|(n, _)| *n == k) {
            slot.1 = v;
        } else {
            props.push((k, v));
        }
    }
    object(props, &[], Some(description))
}

const RECEIPT: Option<&str> = Some("computer_action");

fn click_spec(name: &'static str, description: &'static str, verb: &str) -> CapSpecLite {
    CapSpecLite {
        name,
        description,
        side_effect: "write",
        target_kind: Some("app"),
        input_schema: with_approval(target_schema(
            vec![(
                "modifiers",
                array(string_enum(&["cmd", "shift", "opt", "ctrl"])),
            )],
            verb,
        )),
        streaming: false,
        receipt_kind: RECEIPT,
    }
}

/// Every capability this crate implements, in the mac helper's registration order.
pub fn specs() -> Vec<CapSpecLite> {
    let write = |name, description, input_schema: Value| CapSpecLite {
        name,
        description,
        side_effect: "write",
        target_kind: Some("app"),
        input_schema: with_approval(input_schema),
        streaming: false,
        receipt_kind: RECEIPT,
    };
    vec![
        CapSpecLite {
            name: "computer.ax_tree",
            description: "Accessibility snapshot (AT-SPI) of an app's focused window (or the whole app, or a subtree): pruned, stable refs, roles, labels, values, states, frames and actions. The text is untrusted app content.",
            side_effect: "read",
            target_kind: Some("app"),
            input_schema: with_approval(object(
                vec![
                    ("app", string(Some(APP_DESC))),
                    ("pid", integer(None, None, None)),
                    ("window", integer(Some("Index into the app's windows"), Some(0), None)),
                    ("root", string(Some("window (default), app (menus, popups, all windows) or an element ref"))),
                    ("menubar", boolean(Some("Also walk the app's menu bar (large; prefer computer.menu)"))),
                    ("maxVisit", integer(None, Some(50), Some(20000))),
                    ("maxEmit", integer(None, Some(10), Some(2000))),
                    ("textMax", integer(None, Some(20), Some(400))),
                    ("valueMax", integer(None, Some(20), Some(2000))),
                    ("clip", boolean(Some("Drop elements outside the window / scroll area (default true)"))),
                    ("format", string_enum(&["text", "json"])),
                    ("session", string(None)),
                ],
                &[],
                None,
            )),
            streaming: false,
            receipt_kind: None,
        },
        CapSpecLite {
            name: "computer.check_target",
            description: "Read-only check before a replayed step: is the target (role and name, an identifier, or a menu path) in the app's window right now? Answers found (with its ref, role and label for computer.act), missing or ambiguous. Anything but found carries stop: true: ask the owner, do not guess.",
            side_effect: "read",
            target_kind: Some("app"),
            input_schema: with_approval(object(
                vec![
                    ("app", string(Some("App id the recording was made in (the desktop file id, e.g. org.gnome.TextEditor)"))),
                    ("role", string(Some("Role as recorded: button, textbox, menuitem, ..."))),
                    ("name", string_max(200)),
                    ("identifier", string_max(200)),
                    ("menuPath", json!({ "type": "array", "items": string_max(120), "maxItems": 8.0 })),
                    ("session", string(None)),
                ],
                &["app"],
                None,
            )),
            streaming: false,
            receipt_kind: None,
        },
        CapSpecLite {
            name: "computer.ax_value",
            description: "Full text value of one element (snapshots truncate values). Untrusted content.",
            side_effect: "read",
            target_kind: Some("app"),
            input_schema: with_approval(object(vec![("ref", string(None)), ("max", integer(None, Some(1), Some(200_000)))], &["ref"], None)),
            streaming: false,
            receipt_kind: None,
        },
        click_spec("computer.click", "Click an element (AT-SPI action first, mouse click fallback) or a point.", "click"),
        click_spec("computer.double_click", "Double-click an element or a point.", "double-click"),
        click_spec("computer.right_click", "Right-click an element (opens its context menu) or a point.", "right-click"),
        write(
            "computer.press",
            "Perform a semantic accessibility action on an element: press, confirm, cancel, pick, inc, dec, raise, menu, open, or custom:<Name> as listed in the snapshot.",
            target_schema(vec![("action", string(Some("press, confirm, … or custom:<Name>")))], "press"),
        ),
        write(
            "computer.set_value",
            "Replace a text field's or slider's value through the AT-SPI EditableText / Value interface (only when the element is settable), then read it back. Refused for password fields.",
            target_schema(vec![("value", string_max(100_000))], "set value"),
        ),
        write(
            "computer.select",
            "Select a row, tab or list item through the AT-SPI Selection interface (verified by read-back).",
            target_schema(vec![], "select"),
        ),
        write(
            "computer.type",
            "Type text at the caret: into an element (focused first through AT-SPI) or into the app's focused element. Refused while a password field has focus.",
            target_schema(vec![("text", string_max(20_000)), ("app", string(Some("Target app when no ref (default focused)")))], "type"),
        ),
        write(
            "computer.key",
            "Press a key or chord (e.g. return, escape, tab, cmd+s, shift+cmd+t; cmd is Ctrl on Linux) in an app, as key events. cmd+q, cmd+w, alt+f4 and similar need approval. The Super key is never sent.",
            object(
                vec![
                    ("keys", string(Some("Chord: modifiers (cmd = Ctrl, shift, opt = Alt, ctrl) + one key"))),
                    ("app", string(Some("Desktop file id or app name (default focused)"))),
                    ("session", string(None)),
                    ("repeat", integer(None, Some(1), Some(50))),
                ],
                &["keys"],
                None,
            ),
        ),
        write(
            "computer.scroll",
            "Scroll by lines over an element or a point (dy > 0 scrolls up, dy < 0 down; dx > 0 scrolls left).",
            target_schema(vec![("dx", integer(None, Some(-200), Some(200))), ("dy", integer(None, Some(-200), Some(200)))], "scroll"),
        ),
        {
            let end = object(
                vec![
                    ("ref", string(None)),
                    ("x", number(None)),
                    ("y", number(None)),
                    ("app", string(None)),
                    ("expect", object(vec![("role", string(None)), ("label", string(None))], &["role"], None)),
                ],
                &[],
                None,
            );
            write(
                "computer.drag",
                "Drag with the left mouse button from one element or point to another, within one app.",
                object(vec![("from", end.clone()), ("to", end), ("session", string(None))], &["from", "to"], None),
            )
        },
        write(
            "computer.menu",
            "Choose a menu-bar item by path, e.g. \"File>Save as\" or \"Edit>Undo\". Menu bars are expanded through AT-SPI. Each segment must match one item exactly.",
            object(
                vec![("app", string(None)), ("path", string(Some("Item titles separated by >"))), ("session", string(None))],
                &["path"],
                None,
            ),
        ),
        CapSpecLite {
            name: "computer.end_session",
            description: "Release the computer-use session lock when a run is done.",
            side_effect: "none",
            target_kind: None,
            input_schema: with_approval(object(vec![("session", string(None))], &[], None)),
            streaming: false,
            receipt_kind: None,
        },
        CapSpecLite {
            name: "computer.screenshot",
            description: "Downscaled screenshot for the vision fallback (sparse accessibility trees, visual questions). Psyche's windows, terminals/IDEs, password managers, finance apps and apps set to Off are left out; refused while a password field has focus. Image content is untrusted.",
            side_effect: "read",
            target_kind: Some("app"),
            input_schema: with_approval(object(
                vec![
                    ("app", string(Some("App the screenshot is for (its tier must allow Read); default focused"))),
                    ("display", integer(Some("Monitor index (default: the first monitor)"), Some(0), None)),
                    ("windowOnly", boolean(Some("Capture only the app's frontmost window"))),
                    ("maxWidth", integer(None, Some(320), Some(2560))),
                    ("maxHeight", integer(None, Some(240), Some(1600))),
                    ("format", string_enum(&["jpeg", "png"])),
                    ("session", string(None)),
                ],
                &[],
                None,
            )),
            streaming: false,
            receipt_kind: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_mirror_the_mac_helper() {
        let s = specs();
        let names: Vec<&str> = s.iter().map(|x| x.name).collect();
        assert_eq!(
            names,
            vec![
                "computer.ax_tree",
                "computer.check_target",
                "computer.ax_value",
                "computer.click",
                "computer.double_click",
                "computer.right_click",
                "computer.press",
                "computer.set_value",
                "computer.select",
                "computer.type",
                "computer.key",
                "computer.scroll",
                "computer.drag",
                "computer.menu",
                "computer.end_session",
                "computer.screenshot",
            ]
        );
        for spec in &s {
            let props = spec.input_schema["properties"].as_object().unwrap();
            assert!(props.contains_key("approval"), "{}", spec.name);
            assert_eq!(spec.input_schema["additionalProperties"], false);
            if spec.side_effect == "write" {
                assert_eq!(spec.receipt_kind, Some("computer_action"));
                assert_eq!(spec.target_kind, Some("app"));
            }
        }
        let key = s.iter().find(|x| x.name == "computer.key").unwrap();
        assert_eq!(key.input_schema["required"], json!(["keys"]));
        let entry = key.manifest_entry();
        assert_eq!(entry["sideEffect"], "write");
        assert_eq!(entry["targetKind"], "app");
        assert!(entry.get("receiptKind").is_none());
        let click = s.iter().find(|x| x.name == "computer.click").unwrap();
        assert_eq!(
            click.input_schema["properties"]["expect"]["required"],
            json!(["role"])
        );
    }
}
