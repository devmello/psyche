//! The five `vscreen.*` capabilities (linux-desktop design §11). Shapes follow
//! `packages/protocol/src/methods/screen.ts`.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use psyche_protocol::{ErrorCode, SideEffect};
use serde::Deserialize;
use serde_json::{json, Value};

use super::input::Button;
use super::manager::{InputEvent, Status, VsError, VscreenManager};
use crate::capability::{Capability, CapabilitySpec, CapabilityError, InvocationContext};

fn error(e: VsError) -> CapabilityError {
    let code = match e.reason {
        "already_open_on_your_screen" | "opened_elsewhere" | "taken_over" => ErrorCode::Conflict,
        "app_not_found" => ErrorCode::NotFound,
        _ => ErrorCode::Unavailable,
    };
    CapabilityError::new(code, e.reason, &e.message)
}

fn bad_params(message: &str) -> CapabilityError {
    CapabilityError::new(ErrorCode::InvalidParams, "invalid_params", message)
}

fn parse<T: for<'de> Deserialize<'de>>(params: &Value) -> Result<T, CapabilityError> {
    // Absent params mean "all defaults".
    let value = if params.is_null() { json!({}) } else { params.clone() };
    serde_json::from_value(value).map_err(|e| bad_params(&e.to_string()))
}

/// RFC 3339 UTC, to the second.
pub fn iso8601(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn status_json(s: &Status) -> Value {
    let apps: Vec<Value> = s
        .apps
        .iter()
        .map(|a| {
            let mut v = json!({
                "appId": a.app_id,
                "pid": a.pid.max(1),
                "windowTitle": a.window_title,
            });
            if a.has_unsaved_changes {
                v["hasUnsavedChanges"] = json!(true);
            }
            v
        })
        .collect();
    json!({
        "state": if s.running { "running" } else { "stopped" },
        "display": s.display,
        "width": s.width,
        "height": s.height,
        "apps": apps,
        "takenOver": s.taken_over,
        "frameSeq": s.frame_seq,
        "startedAt": s.started_at.map(iso8601),
    })
}

struct Spec {
    name: &'static str,
    description: &'static str,
    side_effect: SideEffect,
}

macro_rules! capability {
    ($ty:ident, $spec:expr, |$m:ident, $ctx:ident| $body:expr) => {
        pub struct $ty(pub Arc<VscreenManager>);
        impl Capability for $ty {
            fn spec(&self) -> CapabilitySpec {
                let s: Spec = $spec;
                CapabilitySpec {
                    name: s.name,
                    description: s.description,
                    side_effect: s.side_effect,
                    target_kind: None,
                    streaming: false,
                }
            }
            fn invoke(&self, $ctx: &InvocationContext) -> Result<Value, CapabilityError> {
                let $m = &self.0;
                $body
            }
        }
    };
}

#[derive(Deserialize, Default)]
struct StartParams {
    width: Option<u32>,
    height: Option<u32>,
}

capability!(
    Start,
    Spec {
        name: "vscreen.start",
        description: "Starts the virtual screen: a private display where Psyche can use apps without touching yours.",
        side_effect: SideEffect::Write,
    },
    |m, ctx| {
        let p: StartParams = parse(&ctx.params)?;
        let size = match (p.width, p.height) {
            (Some(w), Some(h)) if (640..=3840).contains(&w) && (480..=2160).contains(&h) => Some((w, h)),
            (None, None) => None,
            _ => return Err(bad_params("width and height go together, 640x480 to 3840x2160")),
        };
        m.start(size).map(|s| status_json(&s)).map_err(error)
    }
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopParams {
    close_apps: Option<bool>,
    /// Not in the wire schema yet: the Gateway's "Discard" sends it.
    force: Option<bool>,
}

capability!(
    Stop,
    Spec {
        name: "vscreen.stop",
        description: "Stops the virtual screen. Apps are asked to close first; one with unsaved changes stays open.",
        side_effect: SideEffect::Write,
    },
    |m, ctx| {
        let p: StopParams = parse(&ctx.params)?;
        let out = m
            .stop(p.close_apps.unwrap_or(true), p.force.unwrap_or(false))
            .map_err(error)?;
        let mut v = json!({ "ok": out.stopped });
        if !out.stopped {
            v["reason"] = json!("unsaved_changes");
        }
        Ok(v)
    }
);

capability!(
    StatusCap,
    Spec {
        name: "vscreen.status",
        description: "Says whether the virtual screen is running and which apps are open on it.",
        side_effect: SideEffect::None,
    },
    |m, _ctx| Ok(status_json(&m.status()))
);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameParams {
    since: Option<u64>,
    max_width: Option<u32>,
}

capability!(
    FrameCap,
    Spec {
        name: "vscreen.frame",
        description: "Returns the virtual screen as a JPEG, only if it changed since the sequence number you pass.",
        side_effect: SideEffect::Read,
    },
    |m, ctx| {
        let p: FrameParams = parse(&ctx.params)?;
        if p.max_width.is_some_and(|w| !(160..=3840).contains(&w)) {
            return Err(bad_params("maxWidth is 160 to 3840"));
        }
        let f = m.frame(p.since, p.max_width).map_err(error)?;
        Ok(json!({
            "changed": f.changed,
            "frameSeq": f.frame_seq,
            "image": f.jpeg.map(|j| base64::engine::general_purpose::STANDARD.encode(j)),
            "width": f.width,
            "height": f.height,
        }))
    }
);

#[derive(Deserialize)]
struct WireEvent {
    #[serde(rename = "type")]
    kind: String,
    x: Option<f64>,
    y: Option<f64>,
    dx: Option<f64>,
    dy: Option<f64>,
    button: Option<String>,
    key: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct InputParams {
    events: Vec<WireEvent>,
}

fn button(name: Option<&str>) -> Result<Button, CapabilityError> {
    match name.unwrap_or("left") {
        "left" => Ok(Button::Left),
        "middle" => Ok(Button::Middle),
        "right" => Ok(Button::Right),
        other => Err(bad_params(&format!("unknown button {other}"))),
    }
}

pub fn parse_events(params: &Value) -> Result<Vec<InputEvent>, CapabilityError> {
    let p: InputParams = parse(params)?;
    if p.events.len() > 100 {
        return Err(bad_params("at most 100 events"));
    }
    p.events
        .into_iter()
        .map(|e| {
            let xy = |e: &WireEvent| Ok::<_, CapabilityError>((
                e.x.ok_or_else(|| bad_params("x is missing"))?,
                e.y.ok_or_else(|| bad_params("y is missing"))?,
            ));
            Ok(match e.kind.as_str() {
                "move" => {
                    let (x, y) = xy(&e)?;
                    InputEvent::Move { x, y }
                }
                "down" | "up" => {
                    let (x, y) = xy(&e)?;
                    let b = button(e.button.as_deref())?;
                    if e.kind == "down" { InputEvent::Down { x, y, button: b } } else { InputEvent::Up { x, y, button: b } }
                }
                "scroll" => {
                    let (x, y) = xy(&e)?;
                    InputEvent::Scroll { x, y, dx: e.dx.unwrap_or(0.0), dy: e.dy.unwrap_or(0.0) }
                }
                "key_down" => InputEvent::KeyDown(e.key.ok_or_else(|| bad_params("key is missing"))?),
                "key_up" => InputEvent::KeyUp(e.key.ok_or_else(|| bad_params("key is missing"))?),
                "text" => {
                    let t = e.text.ok_or_else(|| bad_params("text is missing"))?;
                    if t.chars().count() > 1000 {
                        return Err(bad_params("text is at most 1000 characters"));
                    }
                    InputEvent::Text(t)
                }
                other => return Err(bad_params(&format!("unknown event type {other}"))),
            })
        })
        .collect()
}

capability!(
    InputCap,
    Spec {
        name: "vscreen.input",
        description: "The owner's clicks and keys from the watch view while they take over; the agent pauses meanwhile.",
        side_effect: SideEffect::Write,
    },
    |m, ctx| {
        let events = parse_events(&ctx.params)?;
        m.owner_input(&events).map_err(error)?;
        Ok(json!({ "ok": true }))
    }
);

pub fn all(manager: &Arc<VscreenManager>) -> Vec<Arc<dyn Capability>> {
    vec![
        Arc::new(Start(Arc::clone(manager))),
        Arc::new(Stop(Arc::clone(manager))),
        Arc::new(StatusCap(Arc::clone(manager))),
        Arc::new(FrameCap(Arc::clone(manager))),
        Arc::new(InputCap(Arc::clone(manager))),
    ]
}

/// Keeps the compiler honest about the unused import when only tests use it.
#[allow(dead_code)]
const _: Duration = Duration::from_secs(0);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_rfc3339() {
        assert_eq!(iso8601(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(UNIX_EPOCH + Duration::from_secs(1_793_836_800)), "2026-11-05T00:00:00.000Z");
        assert_eq!(iso8601(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn events_are_parsed_and_checked() {
        let ev = parse_events(&json!({ "events": [
            { "type": "move", "x": 1.5, "y": 2 },
            { "type": "down", "x": 1, "y": 2, "button": "right" },
            { "type": "scroll", "x": 1, "y": 2, "dx": 0, "dy": 120 },
            { "type": "key_down", "key": "Enter" },
            { "type": "text", "text": "hi" },
        ]}))
        .unwrap();
        assert_eq!(ev.len(), 5);
        assert_eq!(ev[1], InputEvent::Down { x: 1.0, y: 2.0, button: Button::Right });
        assert!(parse_events(&json!({ "events": [{ "type": "warp" }] })).is_err());
        assert!(parse_events(&json!({ "events": [{ "type": "move", "x": 1 }] })).is_err());
        assert!(parse_events(&json!({ "events": [{ "type": "down", "x": 1, "y": 1, "button": "side" }] })).is_err());
        assert!(parse_events(&json!({ "events": vec![json!({"type":"key_up","key":"a"}); 101] })).is_err());
        assert!(parse_events(&json!({})).is_err());
    }

    #[test]
    fn a_stopped_screen_has_the_wire_shape() {
        let s = Status {
            running: false,
            display: None,
            width: 0,
            height: 0,
            apps: vec![],
            taken_over: false,
            frame_seq: 0,
            started_at: None,
        };
        let v = status_json(&s);
        assert_eq!(v["state"], "stopped");
        assert!(v["display"].is_null());
        assert!(v["startedAt"].is_null());
        assert_eq!(v["takenOver"], false);
    }

    #[test]
    fn errors_carry_the_helper_reason() {
        let e = error(VsError { reason: "already_open_on_your_screen", message: "x".into() });
        assert_eq!(e.reason, "already_open_on_your_screen");
        assert_eq!(e.code, ErrorCode::Conflict);
        assert_eq!(error(VsError { reason: "not_running", message: "x".into() }).code, ErrorCode::Unavailable);
    }
}
