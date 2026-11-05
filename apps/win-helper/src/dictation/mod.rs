//! `dictation.*`: hold-to-talk key watch (`WH_KEYBOARD_LL`), the insertion target and text
//! insertion, served by `psyche_win_dictation` (which keeps the mac helper's names, schemas,
//! events and reasons). This module adapts the crate's specs and dispatches its `invoke`; `speech`
//! reuses the adapter.
//!
//! - **Events.** Each payload the crate emits goes out as one `node.event` with exactly that
//!   `data`, as on the Mac (`speech.*` payloads carry their `type`; `dictation.watch` payloads are
//!   `{key, down, at, role?}`).
//! - **Ids.** The node `invocationId` is the crate's invocation id, which doubles as the speech
//!   stream id (`speech.audio_push` / `speech.stop` name it).
//! - **Cancellation.** `node.cancel`, a dropped connection or a helper-side timeout cancel the
//!   crate's token, whose hooks stop the microphone or the key watch.

use std::time::Duration;

use psyche_win_dictation as wd;
use serde_json::{Value, json};

use crate::node::{
    CapabilityError, CapabilityOutput, CapabilityRegistry, CapabilitySpec, OsPermission,
    ReceiptDraft, SideEffect, TargetKind, capability::ReceiptOutcome,
};

/// Helper-side ceiling; `None` for streams that run until stopped (watch, transcription).
fn timeout_for(name: &str) -> Option<Duration> {
    match name {
        "dictation.watch" | "speech.transcribe_stream" | "speech.transcribe_file" => None,
        "dictation.insert" => Some(Duration::from_secs(60)),
        _ => Some(Duration::from_secs(30)),
    }
}

pub(crate) fn spec(s: &wd::CapabilitySpec) -> CapabilitySpec {
    let mut c = CapabilitySpec::new(
        s.name,
        &s.description,
        SideEffect::parse(s.side_effect.as_str()).unwrap_or(SideEffect::Write),
    )
    .input(s.input_schema.clone())
    .permissions(
        &s.permissions
            .iter()
            .filter_map(|p| serde_json::from_value::<OsPermission>(json!(p.as_str())).ok())
            .collect::<Vec<_>>(),
    );
    if let Some(t) = s.target_kind.and_then(|t| TargetKind::parse(t.as_str())) {
        c = c.target(t);
    }
    if let Some(k) = s.receipt_kind {
        c = c.receipt(k);
    }
    if s.streaming {
        c = c.streaming();
    }
    if let Some(d) = timeout_for(s.name) {
        c = c.timeout(d);
    }
    c
}

pub(crate) fn output(o: wd::CapOutput) -> CapabilityOutput {
    match o.receipt {
        Some(r) => CapabilityOutput::with_receipt(
            o.result,
            ReceiptDraft {
                outcome: ReceiptOutcome::parse(r.outcome),
                summary: r.summary,
                external_refs: r.external_refs,
            },
        ),
        None => CapabilityOutput::new(o.result),
    }
}

/// Registers one crate capability.
pub(crate) fn add(reg: &mut CapabilityRegistry, s: &wd::CapabilitySpec) {
    reg.add(spec(s), |ctx| async move {
        let token = wd::CancelToken::new();
        let abort = token.clone();
        let name = ctx.capability.clone();
        let id = ctx.invocation_id.clone();
        let params = ctx.params.clone();
        let r = crate::bridge::blocking(
            move || {
                let sink = |_event: &str, payload: Value| ctx.emit(payload);
                let inv = wd::Invocation {
                    id: &id,
                    emit: &sink,
                    cancel: token,
                };
                wd::invoke(&name, params, &inv)
                    .map(output)
                    .map_err(|e| CapabilityError::from_wire(&e.wire()))
            },
            move || abort.cancel(),
        );
        r.await?
    });
}

pub(crate) fn register_prefix(reg: &mut CapabilityRegistry, prefix: &str) {
    for s in wd::specs().iter().filter(|s| s.name.starts_with(prefix)) {
        add(reg, s);
    }
}

pub fn register(reg: &mut CapabilityRegistry) {
    register_prefix(reg, "dictation.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_map_one_to_one() {
        for s in wd::specs() {
            let c = spec(&s);
            assert_eq!(c.manifest_entry(), s.manifest_entry(), "{}", s.name);
            assert_eq!(c.receipt_kind.as_deref(), s.receipt_kind);
        }
    }

    #[test]
    fn errors_keep_reason_and_details() {
        let e = wd::CapError::new(wd::ErrorCode::Forbidden, "elevated_target", "x")
            .with_detail("pid", 4);
        let c = CapabilityError::from_wire(&e.wire());
        assert_eq!(c.code, crate::node::ErrorCode::Forbidden);
        assert_eq!(c.reason, "elevated_target");
        assert_eq!(c.details["pid"], 4);
        assert_eq!(serde_json::to_value(c.wire()).unwrap(), e.wire());
    }
}
