//! `computer.*`: computer use through `psyche_win_computer` (UI Automation snapshots and
//! patterns, `SendInput`, Windows Graphics Capture screenshots, the Esc stop). The crate owns the
//! mac helper's names, schemas, checks and result shapes; this module adapts its specs to the
//! core's [`CapabilitySpec`] and dispatches through the core's invocation path:
//!
//! - **Approval.** The Gateway's `approvalId` goes to the crate, which binds it to
//!   `params.approval {app, tier}` (#267).
//! - **Cancellation and timeouts.** `node.cancel`, a dropped connection or the helper-side
//!   timeout set the crate's per-invocation cancel flag; input steps check it every 20 ms.
//! - **Receipts.** The crate's `computer_action` receipt drafts become the core's receipts (kind
//!   from the spec); a refused side effect gets the core's `failed` receipt.
//! - **Esc.** The Esc and attention hooks are installed at startup. As on the Mac, pressing Esc
//!   fails the in-flight call with `cancelled/user_stopped`, ends the session for good (later
//!   calls from it fail the same way) and is logged ("computer use stopped by Esc"); the mac
//!   helper sends no other wire event for it, and neither does this one. The Gateway cancels the
//!   run when it sees `user_stopped` (`apps/gateway/src/compose/computer.ts`).
//!
//! App identity here is the crate's: the lowercase executable name (`notepad.exe`,
//! `calculatorapp.exe`), not the AUMID / path identity `apps.*` reports.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use psyche_win_computer as wc;
use serde_json::json;

use crate::node::{
    CapabilityError, CapabilityOutput, CapabilityRegistry, CapabilitySpec, OsPermission,
    ReceiptDraft, SideEffect, TargetKind, capability::ReceiptOutcome,
};

/// Helper-side ceiling for one call (the crate has its own UIA / capture deadlines below these).
fn timeout_for(name: &str) -> Duration {
    match name {
        // The picker waits for the user (timeoutSeconds ≤ 300).
        "computer.screenshot_pick" => Duration::from_secs(330),
        // Up to 20 000 characters at the crate's typing pace.
        "computer.type" => Duration::from_secs(300),
        _ => Duration::from_secs(120),
    }
}

/// The crate's spec as the core's.
pub(crate) fn spec(s: &wc::CapSpecLite) -> CapabilitySpec {
    let mut c = CapabilitySpec::new(
        s.name,
        s.description,
        SideEffect::parse(s.side_effect).unwrap_or(SideEffect::Write),
    )
    .input(s.input_schema.clone())
    .permissions(
        &s.permissions
            .iter()
            .filter_map(|p| serde_json::from_value::<OsPermission>(json!(p)).ok())
            .collect::<Vec<_>>(),
    )
    .timeout(timeout_for(s.name));
    if let Some(t) = s.target_kind.and_then(TargetKind::parse) {
        c = c.target(t);
    }
    if let Some(k) = s.receipt_kind {
        c = c.receipt(k);
    }
    if s.streaming {
        c = c.streaming();
    }
    c
}

pub(crate) fn output(o: wc::CapOutput) -> CapabilityOutput {
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

pub(crate) fn error(e: &wc::CapError) -> CapabilityError {
    CapabilityError::from_wire(&e.to_wire())
}

/// Registers one crate capability.
pub(crate) fn add(reg: &mut CapabilityRegistry, s: &wc::CapSpecLite) {
    reg.add(spec(s), |ctx| async move {
        let flag = Arc::new(AtomicBool::new(false));
        let cancel = flag.clone();
        let name = ctx.capability.clone();
        let params = ctx.params.clone();
        let approval_id = ctx.approval_id.clone();
        let r = crate::bridge::blocking(
            move || {
                let inv = wc::Invocation {
                    approval_id,
                    cancel: Some(cancel),
                };
                wc::invoke(&name, &params, &inv)
                    .map(output)
                    .map_err(|e| error(&e))
            },
            move || flag.store(true, Ordering::SeqCst),
        );
        r.await?
    });
}

pub fn register(reg: &mut CapabilityRegistry) {
    for s in wc::specs()
        .iter()
        .filter(|s| s.name.starts_with("computer."))
    {
        add(reg, s);
    }
    if reg.runtime().live {
        let log = reg.runtime().log.clone();
        wc::set_on_user_stop(move |_session| log.info("computer use stopped by Esc"));
        let running = wc::start_hooks();
        reg.runtime()
            .log
            .info(format!("computer-use hooks running={running}"));
    }
}

/// `true` while an agent's computer-use session holds the lock (teach mode waits for it).
pub fn session_active() -> bool {
    wc::caps::cu().sessions.active_session().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_map_one_to_one() {
        for s in wc::specs() {
            let c = spec(&s);
            let m = c.manifest_entry();
            assert_eq!(m, s.manifest_entry(), "{}", s.name);
            assert_eq!(c.receipt_kind.as_deref(), s.receipt_kind);
            assert_eq!(c.permissions.len(), s.permissions.len(), "{}", s.name);
            assert!(c.timeout.is_some());
        }
    }

    #[test]
    fn errors_keep_code_reason_details_and_retryable() {
        let e = wc::CapError::new("not_found", "stale_ref", "e3 no longer exists")
            .detail("ref", "e3")
            .retryable();
        let c = error(&e);
        assert_eq!(c.code, crate::node::ErrorCode::NotFound);
        assert_eq!(c.reason, "stale_ref");
        assert_eq!(c.details["ref"], "e3");
        assert!(c.retryable);
        let w = c.wire();
        assert_eq!(serde_json::to_value(w).unwrap(), e.to_wire());
        let stopped = error(&wc::CapError::stopped());
        assert_eq!(stopped.code, crate::node::ErrorCode::Cancelled);
        assert_eq!(stopped.reason, "user_stopped");
    }

    #[test]
    fn receipts_map() {
        let o = output(wc::CapOutput {
            result: json!({"status": "ok"}),
            receipt: Some(wc::ReceiptDraft {
                outcome: "uncertain",
                summary: "click in Notepad: unverified".into(),
                external_refs: serde_json::Map::new(),
            }),
        });
        assert_eq!(o.receipt.unwrap().outcome, ReceiptOutcome::Uncertain);
    }
}
