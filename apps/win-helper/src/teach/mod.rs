//! `teach.record.*` (J8 phase 2, docs/design/teach-by-showing-2026.md §13): the Windows half of
//! "Record in an app", a port of the mac helper's `AppTeachController` / `AppRecording.swift` /
//! `LiveAppTeach.swift`. The owner picks one app they already allowed for computer use, does the
//! task once and stops; the helper watches that app's UI Automation focus, values, mouse presses
//! and menu choices and returns semantic steps (`app_click`, `app_type`, `app_menu`).
//!
//! - `policy.rs`: every rule about what may be kept (never-recorded apps, secret fields, value
//!   shapes, the event-to-step mapper), pure and tested without a window.
//! - `controller.rs`: the one-recording-at-a-time state machine, limits and timers.
//! - `live.rs` / `indicator.rs`: the UI Automation + hook source and the topmost "Recording" pill
//!   with its own Stop.
//!
//! Security model (as on the Mac): the Gateway offers these only to the desktop shell
//! (`teach.app.*`); `nodes.invoke` and agent tools can never reach `teach.record.*`. One
//! recording at a time, refused while an agent's computer-use session holds the computer (and
//! `computer.*`, `apps.open` and `apps.focus` are refused while a recording runs:
//! `recording_active`). Only the owner's real input (injected input is ignored), secret fields,
//! Psyche, security prompts, password managers and every other app are never recorded; no
//! screenshots; nothing is written to disk and nothing streams: the steps wait in memory until
//! `teach.record.stop` hands them over once.

pub mod controller;
pub mod indicator;
pub mod live;
pub mod policy;

#[path = "never_apps.generated.rs"]
pub mod never_apps;

use std::sync::{Arc, OnceLock};

use psyche_win_computer::tiers::TierSettings;
use serde::Deserialize;
use serde_json::json;

pub use self::controller::{AppTeachController, End, Indicator, Source};
use crate::node::{
    CapabilityError, CapabilityOutput, CapabilityRegistry, CapabilitySpec, ErrorCode, OsPermission,
    ReceiptDraft, SideEffect, TargetKind, schema,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    bundle_id: String,
}

/// The live controller `register` made, for the `recording_active` guards of `computer.*` and
/// `apps.*`.
static LIVE: OnceLock<Arc<AppTeachController>> = OnceLock::new();

/// `true` while the owner is recording a demonstration: the agent does not drive the computer then.
pub fn recording_active() -> bool {
    LIVE.get().is_some_and(|c| c.active_id().is_some())
}

/// The refusal `computer.*`, `apps.open` and `apps.focus` give while a recording runs.
pub fn refuse_while_recording() -> Result<(), CapabilityError> {
    if recording_active() {
        return Err(CapabilityError::new(
            ErrorCode::Conflict,
            "recording_active",
            "The owner is recording a demonstration; computer use waits until they stop",
        )
        .retryable());
    }
    Ok(())
}

pub fn register_with(reg: &mut CapabilityRegistry, teach: Arc<AppTeachController>) {
    let t = teach.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.record.start",
            "Owner only. Watch one granted app's UI Automation events (focus, value changes, presses, menu choices) and turn them into semantic steps. Secure fields, Psyche, security prompts and other apps are never recorded; no screenshots; a pill on screen shows while it records, with its own Stop.",
            SideEffect::Write,
        )
        .target(TargetKind::App)
        .input(schema::object(vec![("bundleId", schema::string_max(Some("The granted app's id (its lowercase executable name, e.g. notepad.exe)"), 200))], &["bundleId"]))
        .permissions(&[OsPermission::Accessibility])
        .receipt("teach"),
        move |ctx| {
            let p: StartParams = ctx.decode()?;
            if crate::computer::session_active() {
                return Err(CapabilityError::new(
                    ErrorCode::Conflict,
                    "computer_busy",
                    "The agent is using the computer; recording waits until it is done",
                )
                .retryable());
            }
            let (id, app) = t.begin(&p.bundle_id)?;
            Ok(CapabilityOutput::with_receipt(
                json!({ "sessionId": id, "app": { "bundleId": app.bundle_id, "name": app.name } }),
                ReceiptDraft::ok(format!("Started recording in {}", app.name)),
            ))
        },
    );
    let t = teach.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.record.stop",
            "Owner only. Stop recording and hand over the steps, once.",
            SideEffect::None,
        ),
        move |_| {
            let out = t.collect()?;
            let n = out["steps"].as_array().map_or(0, Vec::len);
            Ok(CapabilityOutput::with_receipt(
                out,
                ReceiptDraft::ok(format!("Recorded {n} steps")),
            ))
        },
    );
    let t = teach.clone();
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.record.cancel",
            "Owner only. Stop recording and drop everything caught.",
            SideEffect::None,
        ),
        move |_| Ok(CapabilityOutput::new(json!({ "cancelled": t.cancel() }))),
    );
    reg.add_blocking(
        CapabilitySpec::new(
            "teach.record.status",
            "Whether an app is being recorded, and how many steps so far.",
            SideEffect::Read,
        ),
        move |_| Ok(CapabilityOutput::new(teach.status())),
    );
}

pub fn register(reg: &mut CapabilityRegistry) {
    let log = reg.runtime().log.clone();
    let teach = AppTeachController::new(
        || Box::new(live::LiveSource::default()),
        Arc::new(indicator::LiveIndicator::default()),
        || TierSettings::load(&TierSettings::path()),
        |id| {
            psyche_win_computer::win::apps::windowed_apps()
                .into_iter()
                .find(|a| a.bundle_id.as_deref() == Some(id))
                .map(|a| a.name)
        },
        controller::DEFAULT_MAX_SECONDS,
        controller::DEFAULT_UNCLAIMED_SECONDS,
        log,
    );
    let _ = LIVE.set(teach.clone());
    register_with(reg, teach);
}

#[cfg(test)]
mod tests;
