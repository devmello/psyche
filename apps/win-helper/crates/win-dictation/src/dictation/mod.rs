//! The `dictation.*` capability group (features J9, Q2). The Gateway forwards its `dictation.*`
//! methods here for desktop callers only; `nodes.invoke` and agent tools cannot reach them,
//! because inserted text is the owner's keystrokes, not an agent action.
//!
//! Threading: UIA, typing and clipboard work run on one dedicated "dictation" thread (MTA COM,
//! a message-only window that owns the clipboard while pasting), like the mac's serial
//! `DictationQueue`; the key watch runs a low-level keyboard hook on its own message-loop thread.

pub mod clipboard;
pub mod keys;
pub mod policy;

use crate::error::CapError;
use crate::time::iso8601_now;
use crate::{Invocation, ReceiptDraft, decode, win};
use keys::{KeyChange, WatchParams, watch_plan};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// `dictation.target`: `{target: DictationTarget | null}`.
pub fn dictation_target(_params: Value) -> Result<Value, CapError> {
    let target = win::dictation::run(|b| policy::target(b.focus_now().as_ref(), None))?;
    Ok(json!({ "target": target.map(|t| t.wire()).unwrap_or(Value::Null) }))
}

#[derive(Deserialize)]
struct InsertParams {
    text: String,
    #[serde(rename = "expectPid")]
    expect_pid: Option<i64>,
}

/// `dictation.insert`: `{method, chars, target}`.
pub fn dictation_insert(params: Value) -> Result<Value, CapError> {
    let p: InsertParams = decode(params)?;
    let expect_pid = match p.expect_pid {
        None => None,
        Some(v) if (0..=i32::MAX as i64).contains(&v) => Some(v as u32),
        Some(_) => {
            return Err(CapError::invalid_params(
                "expectPid is a process id",
                Some("expectPid"),
            ));
        }
    };
    let outcome = win::dictation::run(move |b| policy::insert(&p.text, expect_pid, b))??;
    Ok(outcome.wire())
}

/// The receipt names the app and the length, never the text.
pub fn insert_receipt(result: &Value) -> ReceiptDraft {
    let chars = result["chars"].as_u64().unwrap_or(0);
    let app = result["target"]["appName"].as_str().unwrap_or("");
    let mut refs = Map::new();
    if let Some(b) = result["target"]["bundleId"].as_str() {
        refs.insert("bundleId".into(), json!(b));
    }
    ReceiptDraft {
        outcome: "ok",
        summary: format!("Dictated {chars} characters into {app}"),
        external_refs: refs,
    }
}

fn key_payload(change: &KeyChange, at: String) -> Value {
    let mut o = json!({ "at": at, "down": change.down, "key": change.key.as_str() });
    if let Some(r) = change.role {
        o["role"] = json!(r.as_str());
    }
    o
}

/// `dictation.watch`: streams `{key, down, at, role?}` until a newer watch, `key: null` or
/// cancellation ends it, then returns `{watching: false}`.
pub fn dictation_watch(params: Value, inv: &Invocation) -> Result<Value, CapError> {
    let p: WatchParams = decode(params)?;
    let keys = watch_plan(&p)?;
    let watcher = win::hook::watcher();
    if keys.is_empty() {
        watcher.stop();
        return Ok(json!({ "watching": false }));
    }
    let (id, changes) = watcher.start(keys.clone())?;
    // The first events are the keys' states once the hook is installed: the Gateway answers
    // `watching: true` on the first.
    for k in &keys {
        inv.emit(key_payload(
            &KeyChange {
                key: k.key,
                role: k.role,
                down: false,
            },
            iso8601_now(),
        ));
    }
    loop {
        match changes.recv_timeout(Duration::from_millis(100)) {
            Ok((change, at)) => inv.emit(key_payload(&change, at)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if inv.cancel.is_cancelled() {
            watcher.stop_if(id);
            break;
        }
    }
    Ok(json!({ "watching": false }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use keys::{DictationKey, KeyRole};

    #[test]
    fn payload_and_receipt_shapes() {
        let p = key_payload(
            &KeyChange {
                key: DictationKey::Fn,
                role: None,
                down: true,
            },
            "t".into(),
        );
        assert_eq!(p, json!({"at": "t", "down": true, "key": "fn"}));
        let p = key_payload(
            &KeyChange {
                key: DictationKey::RightCommand,
                role: Some(KeyRole::Voice),
                down: false,
            },
            "t".into(),
        );
        assert_eq!(p["role"], "voice");
        let r = insert_receipt(
            &json!({"chars": 12, "method": "typed", "target": {"appName": "Notepad", "bundleId": "notepad.exe"}}),
        );
        assert_eq!(r.summary, "Dictated 12 characters into Notepad");
        assert_eq!(r.external_refs["bundleId"], "notepad.exe");
    }

    #[test]
    fn insert_params_validate() {
        assert_eq!(
            dictation_insert(json!({})).unwrap_err().details["field"],
            "text"
        );
        assert_eq!(
            dictation_insert(json!({"text": "x", "expectPid": -1}))
                .unwrap_err()
                .details["field"],
            "expectPid"
        );
    }
}
