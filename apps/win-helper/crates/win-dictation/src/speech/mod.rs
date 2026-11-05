//! The `speech.*` capability group (speech-to-text only; ADR-014, ADR-016 on the mac).
//!
//! Threading: each `speech.transcribe_stream` invocation blocks its calling thread, which emits
//! every event; the audio source (push reader or WASAPI capture) and the engine (SAPI loop or
//! WinRT session) run on their own threads and report through a channel. `speech.audio_push`,
//! `speech.stop` and `speech.status` are quick calls from any thread.

pub mod engine;
pub mod longform;
pub mod params;
pub mod pcm;
pub mod registry;
pub mod timings;
pub mod transcript;

use crate::error::{CapError, ErrorCode, Permission};
use crate::win::{self, Com};
use crate::{Invocation, decode};
use engine::{Availability, EngineKind, best_locale, select};
use longform::{CHUNK_MS, Merger, OVERLAP_MS, Roots, TranscribeFileParams, plan};
use params::{AudioPushParams, PcmFormat, SpeechPreset, SpeechSource, StreamIdParams, TranscribeRequest, TranscribeStreamParams, validate_locale};
use pcm::{FrameAligner, ToEngine};
use registry::{Handle, Next, Registration, Registry};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use timings::{Metric, Timings};
use transcript::{Accumulator, Segment, StopReason, progress_event, segment_event, started_event};
use win::sapi::{self, Feed, Recognizer};

struct State {
    registry: Registry,
    timings: Timings,
}

fn state() -> &'static State {
    static S: OnceLock<State> = OnceLock::new();
    S.get_or_init(|| State { registry: Registry::default(), timings: Timings::default() })
}

/// The PC's locale (`GetUserDefaultLocaleName`), the mac's `Locale.current`.
pub fn default_locale() -> String {
    let mut buf = [0u16; 85];
    // SAFETY: LOCALE_NAME_MAX_LENGTH buffer.
    let n = unsafe { windows::Win32::Globalization::GetUserDefaultLocaleName(&mut buf) };
    if n > 1 { String::from_utf16_lossy(&buf[..n as usize - 1]) } else { "en-US".into() }
}

fn home_region() -> Option<String> {
    default_locale().rsplit('-').next().filter(|r| r.len() == 2).map(str::to_string)
}

/// Availability of every engine for one locale, plus the SAPI recognizer that serves it.
struct Probe {
    requested: String,
    availability: Availability,
    sapi: Option<Recognizer>,
    topic_languages: Vec<String>,
    sapi_languages: Vec<String>,
}

fn probe(locale: Option<&str>) -> Probe {
    let requested = locale.map(str::to_string).unwrap_or_else(default_locale);
    let region = home_region();
    let topic_languages = win::winrt_speech::topic_languages();
    let recognizers = sapi::recognizers();
    let sapi_languages: Vec<String> = recognizers.iter().flat_map(|r| r.languages.first().cloned()).collect();
    let windows_speech_language = best_locale(&requested, &topic_languages, region.as_deref());
    let sapi_language = best_locale(&requested, &sapi_languages, region.as_deref());
    let sapi = sapi_language.as_deref().and_then(sapi::recognizer_for);
    Probe {
        requested,
        availability: Availability { windows_speech_language, online_speech: win::privacy::online_speech_status() == "granted", sapi_language },
        sapi,
        topic_languages,
        sapi_languages,
    }
}

/// From the engine side to the invocation thread.
enum Msg {
    Segment(Segment),
    InputEnded,
    Finished(Result<(), CapError>),
}

/// A started engine: what the drive loop needs to finish or abandon it.
struct Running {
    kind: EngineKind,
    language: String,
    hit_limit: Arc<AtomicBool>,
    audio_ms: Arc<AtomicU64>,
    cancel: Box<dyn FnOnce()>,
    /// Kept alive until the stream ends (the microphone capture joins its thread on drop).
    _keep: Option<Box<dyn std::any::Any>>,
}

/// Frames → whole-frame gate at `max_frames` (the mac's duration gate). Returns how many of `n`
/// frames may pass and whether this hit the limit.
fn gate(total: &mut u64, n: u64, max_frames: u64) -> (u64, bool) {
    if *total + n >= max_frames {
        let pass = max_frames.saturating_sub(*total);
        *total += pass;
        (pass, true)
    } else {
        *total += n;
        (n, false)
    }
}

fn start_sapi(req: &TranscribeRequest, rec: &Recognizer, language: &str, handle: &Arc<Handle>, tx: Sender<Msg>) -> Result<Running, CapError> {
    let feed = Feed::new();
    let hit_limit = Arc::new(AtomicBool::new(false));
    let audio_ms = Arc::new(AtomicU64::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));
    type StopSource = Box<dyn Fn() + Send + Sync>;
    let (stop_source, keep): (StopSource, Option<Box<dyn std::any::Any>>) = match req.source {
        SpeechSource::Push => {
            let (Some(buf), Some(fmt)) = (handle.push.clone(), req.format) else {
                return Err(CapError::internal("push stream without buffer"));
            };
            let max_frames = req.max_duration_ms * fmt.sample_rate as u64 / 1000;
            let (feed, tx, hit, ms, cancelled) = (feed.clone(), tx.clone(), hit_limit.clone(), audio_ms.clone(), cancelled.clone());
            let buf2 = buf.clone();
            std::thread::Builder::new()
                .name("psyche-speech-push".into())
                .spawn(move || {
                    let mut aligner = FrameAligner::new(fmt.bytes_per_frame());
                    let mut conv = ToEngine::new(fmt);
                    let mut total = 0u64;
                    let bpf = fmt.bytes_per_frame();
                    while !cancelled.load(Ordering::SeqCst) {
                        match buf.next(Duration::from_millis(200)) {
                            Next::Chunk(chunk) => {
                                let whole = aligner.append(&chunk);
                                let (pass, limit) = gate(&mut total, (whole.len() / bpf) as u64, max_frames);
                                feed.write(&conv.push_bytes(&whole[..pass as usize * bpf]));
                                ms.store(total * 1000 / fmt.sample_rate as u64, Ordering::SeqCst);
                                if limit {
                                    hit.store(true, Ordering::SeqCst);
                                    buf.finish();
                                    break;
                                }
                            }
                            Next::Ended => break,
                            Next::Timeout => {}
                        }
                    }
                    feed.write(&conv.finish());
                    feed.finish();
                    let _ = tx.send(Msg::InputEnded);
                })
                .map_err(|e| CapError::internal(format!("cannot start the push reader: {e}")))?;
            let b = handle.push.clone();
            handle.set_stop_handler(move || {
                if let Some(b) = b {
                    b.finish();
                }
            });
            (Box::new(move || buf2.cancel()), None)
        }
        SpeechSource::Microphone => {
            let feed_a = feed.clone();
            let (hit, ms) = (hit_limit.clone(), audio_ms.clone());
            let max_ms = req.max_duration_ms;
            // Converter and frame count, set up from the device format on the first buffer.
            let mut conv: Option<(ToEngine, u64)> = None;
            let (feed_e, tx_e) = (feed.clone(), tx.clone());
            let capture = win::wasapi::start(
                move |samples, fmt| {
                    let ch = fmt.channels as usize;
                    let (c, total) = conv.get_or_insert_with(|| {
                        (ToEngine::new(PcmFormat { encoding: params::PcmEncoding::F32le, sample_rate: fmt.rate, channels: fmt.channels }), 0)
                    });
                    let (pass, limit) = gate(total, (samples.len() / ch) as u64, max_ms * fmt.rate as u64 / 1000);
                    feed_a.write(&c.push_samples(&samples[..pass as usize * ch]));
                    ms.store(*total * 1000 / fmt.rate as u64, Ordering::SeqCst);
                    if limit {
                        hit.store(true, Ordering::SeqCst);
                        feed_a.write(&c.finish());
                        return false;
                    }
                    true
                },
                move || {
                    feed_e.finish();
                    let _ = tx_e.send(Msg::InputEnded);
                },
            )?;
            let stopper = capture.stopper();
            let s2 = stopper.clone();
            handle.set_stop_handler(move || stopper.store(true, Ordering::SeqCst));
            (Box::new(move || s2.store(true, Ordering::SeqCst)), Some(Box::new(capture)))
        }
    };

    let token = rec.token_id.clone();
    let volatile = req.volatile;
    let (feed_s, cancelled_s) = (feed.clone(), cancelled.clone());
    std::thread::Builder::new()
        .name("psyche-sapi".into())
        .spawn(move || {
            let _com = Com::init();
            let tx2 = tx.clone();
            let r = sapi::recognize(&token, &feed_s, volatile, &mut |s| {
                let _ = tx2.send(Msg::Segment(s));
            }, &|| cancelled_s.load(Ordering::SeqCst));
            let _ = tx.send(Msg::Finished(r));
        })
        .map_err(|e| CapError::internal(format!("cannot start the recognizer: {e}")))?;

    let feed_c = feed.clone();
    Ok(Running {
        kind: EngineKind::Sapi,
        language: language.to_string(),
        hit_limit,
        audio_ms,
        cancel: Box::new(move || {
            cancelled.store(true, Ordering::SeqCst);
            stop_source();
            feed_c.cancel();
        }),
        _keep: keep,
    })
}

fn start_winrt(req: &TranscribeRequest, language: &str, handle: &Arc<Handle>, tx: Sender<Msg>) -> Result<Running, CapError> {
    let hit_limit = Arc::new(AtomicBool::new(false));
    let audio_ms = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Result<String, CapError>>();
    let (lang, volatile, short, max_ms) = (language.to_string(), req.volatile, req.preset == SpeechPreset::Short, req.max_duration_ms);
    let (hit, ms, stop_t, cancel_t) = (hit_limit.clone(), audio_ms.clone(), stop.clone(), cancelled.clone());
    std::thread::Builder::new()
        .name("psyche-winrt-speech".into())
        .spawn(move || {
            let _com = Com::init();
            let (etx, erx) = channel();
            let session = match win::winrt_speech::Session::start(&lang, volatile, short, etx) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(session.language.clone()));
            let mut stopping = false;
            loop {
                match erx.recv_timeout(Duration::from_millis(50)) {
                    Ok(win::winrt_speech::Event::Segment(s)) => {
                        let _ = tx.send(Msg::Segment(s));
                    }
                    Ok(win::winrt_speech::Event::Completed(r)) => {
                        if !stopping {
                            ms.store(session.started.elapsed().as_millis() as u64, Ordering::SeqCst);
                            let _ = tx.send(Msg::InputEnded);
                        }
                        // Results raised before Completed are already queued ahead of it.
                        let _ = tx.send(Msg::Finished(r));
                        return;
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => {
                        let _ = tx.send(Msg::Finished(Ok(())));
                        return;
                    }
                }
                if cancel_t.load(Ordering::SeqCst) {
                    session.cancel();
                    return;
                }
                let elapsed = session.started.elapsed().as_millis() as u64;
                if !stopping && (stop_t.load(Ordering::SeqCst) || elapsed >= max_ms) {
                    stopping = true;
                    if elapsed >= max_ms {
                        hit.store(true, Ordering::SeqCst);
                    }
                    ms.store(elapsed.min(max_ms), Ordering::SeqCst);
                    let _ = tx.send(Msg::InputEnded);
                    session.stop();
                }
            }
        })
        .map_err(|e| CapError::internal(format!("cannot start Windows speech: {e}")))?;
    let language = ready_rx.recv().map_err(|_| CapError::internal("Windows speech thread exited"))??;
    let s = stop.clone();
    handle.set_stop_handler(move || s.store(true, Ordering::SeqCst));
    Ok(Running {
        kind: EngineKind::WindowsSpeech,
        language,
        hit_limit,
        audio_ms,
        cancel: Box::new(move || cancelled.store(true, Ordering::SeqCst)),
        _keep: None,
    })
}

/// What the drive loop measured.
#[derive(Debug)]
struct Driven {
    transcript: Accumulator,
    first_result_ms: Option<u64>,
    finalize_ms: Option<u64>,
}

/// Emits segments as they arrive and finishes when the engine does (the mac's
/// `engine.transcribe` + `StreamState`).
fn drive(rx: Receiver<Msg>, inv: &Invocation, started: Instant, cancel: &mut Option<Box<dyn FnOnce()>>) -> Result<Driven, CapError> {
    let mut acc = Accumulator::default();
    let mut first: Option<u64> = None;
    let mut input_ended: Option<Instant> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Msg::Segment(s)) => {
                if first.is_none() && !s.text.is_empty() {
                    first = Some(started.elapsed().as_millis() as u64);
                }
                if !s.is_blank() {
                    inv.emit(segment_event(&s));
                }
                acc.ingest(s);
            }
            Ok(Msg::InputEnded) => {
                input_ended.get_or_insert_with(Instant::now);
            }
            Ok(Msg::Finished(r)) => {
                r?;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if inv.cancel.is_cancelled() {
            if let Some(c) = cancel.take() {
                c();
            }
            return Err(CapError::cancelled());
        }
    }
    acc.promote_volatile();
    Ok(Driven { transcript: acc, first_result_ms: first, finalize_ms: input_ended.map(|t| t.elapsed().as_millis() as u64) })
}

/// `speech.transcribe_stream`: source → duration gate → engine → events, with a summary result.
pub fn speech_transcribe_stream(params: Value, inv: &Invocation) -> Result<Value, CapError> {
    let req = decode::<TranscribeStreamParams>(params)?.validated()?;
    if req.source == SpeechSource::Microphone && win::privacy::microphone_status() != "granted" {
        return Err(CapError::permission_missing(Permission::Microphone));
    }
    let st = state();
    let handle = st.registry.register(inv.id, req.source)?;
    let _registration = Registration { registry: &st.registry, handle: handle.clone() };
    let _com = Com::init();
    let p = probe(req.locale.as_deref());
    let kind = select(req.source, &p.availability, req.engine, &req.vocabulary, req.preset)?;
    let (tx, rx) = channel();
    let running = match kind {
        EngineKind::WindowsSpeech => start_winrt(&req, p.availability.language(kind).unwrap_or(&p.requested), &handle, tx)?,
        EngineKind::Sapi => {
            let rec = p.sapi.as_ref().ok_or_else(|| CapError::unavailable("no_speech_engine", "No on-device speech engine supports this locale on this PC"))?;
            start_sapi(&req, rec, p.availability.language(kind).unwrap_or(&p.requested), &handle, tx)?
        }
    };
    let Running { kind, language, hit_limit, audio_ms, cancel, _keep } = running;
    let started = Instant::now();
    inv.emit(started_event(&handle.id, kind, &language, req.source, req.format.as_ref()));
    let mut cancel = Some(cancel);
    let driven = drive(rx, inv, started, &mut cancel);
    let driven = match driven {
        Ok(d) => d,
        Err(e) => {
            if let Some(c) = cancel.take() {
                c();
            }
            return Err(e);
        }
    };
    drop(_keep);
    if let Some(f) = driven.first_result_ms {
        st.timings.record(Metric::FirstPartial(req.preset), f);
    }
    if let Some(f) = driven.finalize_ms {
        st.timings.record(Metric::Finalize(req.preset), f);
    }
    let reason = if hit_limit.load(Ordering::SeqCst) {
        StopReason::MaxDuration
    } else if handle.is_stop_requested() {
        StopReason::Stopped
    } else {
        StopReason::EndOfInput
    };
    let mut summary = driven.transcript.summary(&handle.id, kind, &language, reason, audio_ms.load(Ordering::SeqCst), driven.first_result_ms);
    summary["preset"] = json!(req.preset.as_str());
    if let Some(f) = driven.finalize_ms {
        summary["finalizeMs"] = json!(f);
    }
    Ok(summary)
}

/// `speech.audio_push`: `{accepted, bufferedBytes, final}`.
pub fn speech_audio_push(params: Value) -> Result<Value, CapError> {
    let (id, audio, fin) = decode::<AudioPushParams>(params)?.validated()?;
    let buffered = state().registry.push(&id, &audio, fin)?;
    Ok(json!({ "accepted": audio.len(), "bufferedBytes": buffered, "final": fin }))
}

/// `speech.stop`: `{stopped: true, streamId}`.
pub fn speech_stop(params: Value) -> Result<Value, CapError> {
    let id = params::validate_stream_id(&decode::<StreamIdParams>(params)?.stream_id)?;
    state().registry.stop(&id)?;
    Ok(json!({ "stopped": true, "streamId": id }))
}

#[derive(Deserialize)]
struct StatusParams {
    locale: Option<String>,
}

/// `speech.status`: engines, the privacy settings and language packs gating them, recognizer
/// languages, permission state and active streams.
pub fn speech_status(params: Value) -> Result<Value, CapError> {
    let locale = validate_locale(decode::<StatusParams>(params)?.locale, "locale")?;
    let _com = Com::init();
    let p = probe(locale.as_deref());
    let a = &p.availability;
    let pick = |source, vocab: &[String], preset| select(source, a, None, vocab, preset).ok().map(|k| k.as_str());
    let st = state();
    let mut sorted_topic = p.topic_languages.clone();
    sorted_topic.sort();
    let mut sorted_sapi = p.sapi_languages.clone();
    sorted_sapi.sort();
    Ok(json!({
        "os": win::privacy::os_version(),
        "gates": {
            "onlineSpeechRecognition": a.online_speech,
            "windowsSpeechLanguage": a.windows_speech_language.is_some(),
            "desktopRecognizer": a.sapi(),
        },
        "locale": p.requested,
        "engines": {
            "windowsSpeech": {
                "available": a.windows_speech(),
                "onDevice": false,
                "language": a.windows_speech_language,
                "sources": ["microphone"],
                "systemLanguage": win::winrt_speech::system_language(),
            },
            "sapi": {
                "available": a.sapi(),
                "onDevice": true,
                "language": a.sapi_language,
                "sources": ["microphone", "push", "file"],
                "recognizer": p.sapi.as_ref().map(|r| r.name.clone()),
            },
        },
        "defaultEngine": pick(SpeechSource::Microphone, &[], SpeechPreset::Long),
        "pushEngine": pick(SpeechSource::Push, &[], SpeechPreset::Long),
        "vocabularyEngine": pick(SpeechSource::Microphone, &["x".to_string()], SpeechPreset::Long),
        "shortPresetEngine": pick(SpeechSource::Microphone, &[], SpeechPreset::Short),
        "permissions": {
            "microphone": win::privacy::microphone_status(),
            "speechRecognition": win::privacy::online_speech_status(),
        },
        "blockers": engine::blockers(a).iter().map(engine::Blocker::json).collect::<Vec<_>>(),
        "recognizerLocales": {
            "windowsSpeech": { "supported": sorted_topic },
            "sapi": { "installed": sorted_sapi },
        },
        "activeStreams": st.registry.active_count(),
        "timings": st.timings.json(),
        "microphoneBusy": st.registry.microphone_busy(),
    }))
}

/// `speech.transcribe_file`: path guard → duration gate → chunks → progress → merged result.
pub fn speech_transcribe_file(params: Value, inv: &Invocation) -> Result<Value, CapError> {
    let req = decode::<TranscribeFileParams>(params)?.validated()?;
    let path = Roots::load().resolve(&req.path)?;
    if !path.is_file() {
        return Err(CapError::new(ErrorCode::NotFound, "not_found", format!("{} is not a file", req.path)).with_detail("path", req.path.clone()));
    }
    let _com = Com::init();
    let file = win::media::open(&path)?;
    let audio_ms = file.duration_ms;
    req.check_duration(audio_ms)?;
    let p = probe(req.locale.as_deref());
    select(SpeechSource::Push, &p.availability, None, &req.vocabulary, SpeechPreset::Long)?;
    let rec = p.sapi.as_ref().ok_or_else(|| CapError::unavailable("no_speech_engine", "No on-device speech engine supports this locale on this PC"))?;
    let language = p.availability.sapi_language.clone().unwrap_or_else(|| p.requested.clone());
    let chunks = plan(audio_ms, CHUNK_MS, OVERLAP_MS);
    inv.emit(progress_event(0, audio_ms, 0, chunks.len()));
    let cancelled = || inv.cancel.is_cancelled();
    let mut merger = Merger::default();
    for chunk in &chunks {
        if cancelled() {
            return Err(CapError::cancelled());
        }
        let pcm = file.read_range(chunk.read_from_ms, chunk.read_to_ms, &cancelled)?;
        let feed = Feed::from_bytes(pcm);
        let mut acc = Accumulator::default();
        sapi::recognize(&rec.token_id, &feed, false, &mut |s| acc.ingest(s), &cancelled)?;
        acc.promote_volatile();
        merger.add(chunk, acc.finals, chunk.index + 1 == chunks.len());
        inv.emit(progress_event(chunk.keep_to_ms, audio_ms, chunk.index + 1, chunks.len()));
    }
    let mut result = merger.result(EngineKind::Sapi, &language, audio_ms);
    // Recorded speech is other people's words unless the caller knows better.
    result["provenance"] = json!("untrusted");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_gate() {
        let mut total = 0;
        assert_eq!(gate(&mut total, 100, 250), (100, false));
        assert_eq!(gate(&mut total, 100, 250), (100, false));
        assert_eq!(gate(&mut total, 100, 250), (50, true));
        assert_eq!(total, 250);
        let mut t = 0;
        assert_eq!(gate(&mut t, 250, 250), (250, true), "exactly the cap ends the stream");
    }

    #[test]
    fn push_and_stop_need_a_stream() {
        let e = speech_audio_push(json!({"streamId": "nope", "data": ""})).unwrap_err();
        assert_eq!((e.code, e.reason.as_str()), (ErrorCode::NotFound, "stream_not_found"));
        assert_eq!(speech_stop(json!({"streamId": "nope"})).unwrap_err().reason, "stream_not_found");
        assert_eq!(speech_stop(json!({})).unwrap_err().details["field"], "streamId");
        assert_eq!(speech_status(json!({"locale": "bad tag!"})).unwrap_err().details["field"], "locale");
    }

    #[test]
    fn drive_emits_non_blank_segments_and_promotes_the_tail() {
        let (tx, rx) = channel();
        tx.send(Msg::Segment(Segment::new("hel", 0, 100, false, None))).unwrap();
        tx.send(Msg::Segment(Segment::new(" ", 0, 100, false, None))).unwrap();
        tx.send(Msg::Segment(Segment::new("hello", 0, 200, true, Some(0.8)))).unwrap();
        tx.send(Msg::InputEnded).unwrap();
        tx.send(Msg::Segment(Segment::new("tail", 300, 400, false, None))).unwrap();
        tx.send(Msg::Finished(Ok(()))).unwrap();
        let events = std::cell::RefCell::new(vec![]);
        let sink = |name: &str, v: Value| events.borrow_mut().push((name.to_string(), v));
        let inv = Invocation::new("s", &sink);
        let d = drive(rx, &inv, Instant::now(), &mut None).unwrap();
        let names: Vec<String> = events.borrow().iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(names, ["speech.partial", "speech.final", "speech.partial"]);
        assert_eq!(d.transcript.text(), "hello tail");
        assert!(d.first_result_ms.is_some() && d.finalize_ms.is_some());

        let (tx, rx) = channel::<Msg>();
        tx.send(Msg::Finished(Err(CapError::unavailable("transcription_failed", "x")))).unwrap();
        assert_eq!(drive(rx, &inv, Instant::now(), &mut None).unwrap_err().reason, "transcription_failed");

        let (_tx, rx) = channel::<Msg>();
        inv.cancel.cancel();
        let hit = Arc::new(AtomicBool::new(false));
        let h2 = hit.clone();
        let mut c: Option<Box<dyn FnOnce()>> = Some(Box::new(move || h2.store(true, Ordering::SeqCst)));
        assert_eq!(drive(rx, &inv, Instant::now(), &mut c).unwrap_err().reason, "cancelled");
        assert!(hit.load(Ordering::SeqCst));
    }
}
