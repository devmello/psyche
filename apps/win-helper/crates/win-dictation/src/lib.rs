//! Windows dictation and on-device speech-to-text for the Psyche Windows helper: the Windows port
//! of the mac helper's `dictation.*` (`DictationCapabilities.swift`, `Dictation.swift`) and
//! `speech.*` (`SpeechCapabilities.swift` and friends) capability groups, with the same names,
//! input schemas, events, result shapes and error reasons.
//!
//! Every capability is one blocking function: `serde_json::Value` params in,
//! `Result<Value, CapError>` out. Streaming capabilities also take an [`Invocation`] whose `emit`
//! sink receives each `node.event` payload (the mac helper's `ctx.emit(data)`), always on the
//! calling thread, before the function returns. The core runs each invocation on its own thread.
//!
//! Text-to-speech is out of scope (owner decision): there is no `speech.synthesize`/`voices`.

// In the helper's workspace serde_json has `preserve_order` (the core's choice), which makes
// `Map`, and with it `CapError`, larger than clippy's 128-byte `Err` threshold. Errors are rare
// and returned once per call, so they stay unboxed.
#![allow(clippy::result_large_err)]

pub mod dictation;
pub mod error;
pub mod spec;
pub mod speech;
mod time;
mod win;

pub use error::{CapError, ErrorCode, Permission};
pub use spec::{CapabilitySpec, SideEffect, TargetKind, specs};

use serde_json::{Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// The event sink: `(event_name, payload)`. `payload` is exactly the mac helper's `node.event`
/// `data`; `event_name` is the payload's `type` for `speech.*` events and `"dictation.key"` for
/// `dictation.watch` (whose payload has no `type`). Called only on the invoking thread.
pub type EventSink<'a> = dyn Fn(&str, Value) + 'a;

/// Cooperative cancellation for one invocation (the mac helper's Swift task cancellation).
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelInner>);

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    hooks: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Idempotent. Runs the registered hooks once (e.g. stopping a microphone).
    pub fn cancel(&self) {
        if self.0.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooks = std::mem::take(&mut *self.0.hooks.lock().unwrap_or_else(|e| e.into_inner()));
        for h in hooks {
            h();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    /// Runs `f` on cancellation (at once when already cancelled).
    pub fn on_cancel(&self, f: impl FnOnce() + Send + 'static) {
        {
            let mut hooks = self.0.hooks.lock().unwrap_or_else(|e| e.into_inner());
            if !self.is_cancelled() {
                hooks.push(Box::new(f));
                return;
            }
        }
        f();
    }
}

/// Per-invocation context for streaming capabilities.
pub struct Invocation<'a> {
    /// The node `invocationId` (also the speech stream id, as on the mac).
    pub id: &'a str,
    pub emit: &'a EventSink<'a>,
    pub cancel: CancelToken,
}

impl<'a> Invocation<'a> {
    pub fn new(id: &'a str, emit: &'a EventSink<'a>) -> Self {
        Invocation { id, emit, cancel: CancelToken::new() }
    }

    pub(crate) fn emit(&self, payload: Value) {
        let name = payload.get("type").and_then(Value::as_str).unwrap_or("dictation.key").to_string();
        (self.emit)(&name, payload);
    }
}

/// The node-side half of a receipt (`ReceiptDraft`): only `dictation.insert` has one.
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptDraft {
    pub outcome: &'static str,
    pub summary: String,
    pub external_refs: Map<String, Value>,
}

/// What [`invoke`] returns (`CapabilityOutput`).
#[derive(Clone, Debug, PartialEq)]
pub struct CapOutput {
    pub result: Value,
    pub receipt: Option<ReceiptDraft>,
}

pub use dictation::{dictation_insert, dictation_target, dictation_watch};
pub use speech::{speech_audio_push, speech_status, speech_stop, speech_transcribe_file, speech_transcribe_stream};

/// Dispatches one capability by name (for the core's registry). `not_found/unknown_capability`
/// for a name this crate does not serve.
pub fn invoke(name: &str, params: Value, inv: &Invocation) -> Result<CapOutput, CapError> {
    let plain = |result: Value| CapOutput { result, receipt: None };
    match name {
        "dictation.target" => dictation_target(params).map(plain),
        "dictation.insert" => {
            let result = dictation_insert(params)?;
            let receipt = dictation::insert_receipt(&result);
            Ok(CapOutput { result, receipt: Some(receipt) })
        }
        "dictation.watch" => dictation_watch(params, inv).map(plain),
        "speech.transcribe_stream" => speech_transcribe_stream(params, inv).map(plain),
        "speech.transcribe_file" => speech_transcribe_file(params, inv).map(plain),
        "speech.audio_push" => speech_audio_push(params).map(plain),
        "speech.stop" => speech_stop(params).map(plain),
        "speech.status" => speech_status(params).map(plain),
        _ => Err(CapError::new(ErrorCode::NotFound, "unknown_capability", format!("{name} is not a dictation or speech capability"))),
    }
}

/// Hooks for this crate's integration tests (not part of the capability API).
#[doc(hidden)]
pub mod testing {
    pub use crate::dictation::keys::KeyEvent;

    /// SendInput of one key (arrives at hooks flagged injected).
    pub fn send_key(vk: u16, down: bool) -> bool {
        crate::win::input::send_vk(vk, down)
    }

    /// Delivers a hardware-looking (or injected) event to the running watch's hook handler.
    pub fn simulate_hook_event(ev: KeyEvent) -> bool {
        crate::win::hook::watcher().simulate(ev)
    }

    /// Injected events the hook has seen and ignored.
    pub fn injected_seen() -> u64 {
        crate::win::hook::INJECTED_SEEN.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn watch_active() -> bool {
        crate::win::hook::watcher().is_active()
    }

    /// The focused element's value (ValuePattern, else TextPattern document text).
    pub fn focused_value() -> Option<String> {
        crate::win::dictation::focused_value()
    }

    /// Starts (and at once cancels) a Windows.Media.SpeechRecognition dictation session: Ok
    /// when online recognition can serve `language`, else the mapped error.
    pub fn windows_speech_probe(language: &str) -> Result<String, crate::CapError> {
        let _com = crate::win::Com::init();
        let (tx, _rx) = std::sync::mpsc::channel();
        let s = crate::win::winrt_speech::Session::start(language, true, false, tx)?;
        s.cancel();
        Ok(s.language.clone())
    }

    /// The clipboard's saved formats (format id, bytes) as paste-and-restore sees them.
    pub fn clipboard_snapshot() -> Option<Vec<(u32, Vec<u8>)>> {
        crate::win::dictation::run(|b| b.clipboard_snapshot()).ok().flatten()
    }

    /// Inserts with one strategy only (`"uia"`, `"typed"` or `"paste"`), bypassing the order but
    /// not the guard: every chunk still requires focus in `expect_pid`.
    pub fn insert_with(strategy: &str, text: &str, expect_pid: u32) -> Result<bool, crate::CapError> {
        let text = text.to_string();
        let strategy = strategy.to_string();
        crate::win::dictation::run(move |b| {
            use crate::dictation::policy::{InsertBackend, PasteOutcome, Refusal, refusal, refusal_error};
            let mut guard = || match b.focus_now() {
                Some(f) if f.pid == expect_pid && !f.secure => Ok(()),
                now => Err(refusal_error(refusal(now.as_ref(), Some(expect_pid)).unwrap_or(Refusal::FocusChanged), None)),
            };
            guard()?;
            match strategy.as_str() {
                "uia" => Ok(b.uia_replace_selection(&text)),
                "typed" => b.type_text(&text, &mut guard).map(|_| true),
                _ => b.paste(&text, &mut guard).map(|o| o == PasteOutcome::Pasted),
            }
        })?
    }
}

/// Params `null` decode as `{}` (the mac helper's `InvocationContext.decode`).
pub(crate) fn decode<T: serde::de::DeserializeOwned>(params: Value) -> Result<T, CapError> {
    let value = if params.is_null() { Value::Object(Map::new()) } else { params };
    serde_json::from_value(value).map_err(|e| {
        let msg = e.to_string();
        // serde_json names the field in "missing field `x`" / "unknown field `x`" messages.
        let field = msg.split('`').nth(1).map(str::to_string);
        if msg.starts_with("missing field") {
            let f = field.unwrap_or_default();
            CapError::invalid_params(format!("missing parameter {f}"), Some(&f))
        } else {
            CapError::invalid_params(format!("invalid parameters: {msg}"), field.as_deref())
        }
    })
}
