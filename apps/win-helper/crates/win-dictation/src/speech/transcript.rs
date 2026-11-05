//! Transcript segments, `speech.*` event payloads and the accumulator (`SpeechTranscript.swift`).

use super::engine::EngineKind;
use super::params::{PcmFormat, SpeechSource};
use serde_json::{Value, json};

/// One transcript segment (`SpeechSegment`); `final == false` is a volatile partial that a later
/// segment replaces.
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub r#final: bool,
    pub confidence: Option<f64>,
}

impl Segment {
    pub fn new(
        text: impl Into<String>,
        start_ms: u64,
        end_ms: u64,
        r#final: bool,
        confidence: Option<f64>,
    ) -> Self {
        Segment {
            text: text.into(),
            start_ms,
            end_ms: end_ms.max(start_ms),
            r#final,
            confidence,
        }
    }

    /// From 100 ns units (SAPI and WinRT times), clamping nothing below zero by construction.
    pub fn from_hns(
        text: impl Into<String>,
        start_hns: u64,
        len_hns: u64,
        r#final: bool,
        confidence: Option<f64>,
    ) -> Self {
        let ms = |h: u64| (h + 5_000) / 10_000;
        Segment::new(
            text,
            ms(start_hns),
            ms(start_hns + len_hns),
            r#final,
            confidence,
        )
    }

    pub fn json(&self) -> Value {
        let mut o = json!({ "text": self.text, "startMs": self.start_ms, "endMs": self.end_ms, "final": self.r#final });
        if let Some(c) = self.confidence.filter(|c| c.is_finite()) {
            o["confidence"] = json!(c.clamp(0.0, 1.0));
        }
        o
    }

    pub fn is_blank(&self) -> bool {
        self.text.trim().is_empty()
    }
}

/// Why a transcription stream ended normally.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// `speech.stop` (or the invocation was cancelled and finalized what it had).
    Stopped,
    /// A push stream received `final: true`, or the microphone went away.
    EndOfInput,
    /// `maxDurationMs` of audio was consumed.
    MaxDuration,
}

impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            StopReason::Stopped => "stopped",
            StopReason::EndOfInput => "end_of_input",
            StopReason::MaxDuration => "max_duration",
        }
    }
}

pub const PARTIAL: &str = "speech.partial";
pub const FINAL: &str = "speech.final";
pub const STARTED: &str = "speech.started";
pub const PROGRESS: &str = "speech.progress";

/// `{type: "speech.partial"|"speech.final", text, startMs, endMs, final, confidence?}`.
pub fn segment_event(s: &Segment) -> Value {
    let mut o = s.json();
    o["type"] = json!(if s.r#final { FINAL } else { PARTIAL });
    o
}

/// Emitted once the engine is ready and the source is live.
pub fn started_event(
    stream_id: &str,
    engine: EngineKind,
    language: &str,
    source: SpeechSource,
    format: Option<&PcmFormat>,
) -> Value {
    let mut o = json!({
        "type": STARTED, "streamId": stream_id, "engine": engine.as_str(), "language": language, "source": source.as_str(),
    });
    if let Some(f) = format {
        o["format"] = f.json();
    }
    o
}

/// `{type: "speech.progress", processedMs, totalMs, fraction, chunk, chunks}`.
pub fn progress_event(processed_ms: u64, total_ms: u64, chunk: usize, chunks: usize) -> Value {
    let done = processed_ms.min(total_ms);
    let fraction = if total_ms > 0 {
        done as f64 / total_ms as f64
    } else {
        1.0
    };
    json!({
        "type": PROGRESS, "processedMs": done, "totalMs": total_ms,
        "fraction": (fraction * 1000.0).round() / 1000.0, "chunk": chunk, "chunks": chunks.max(1),
    })
}

/// Folds volatile and final segments into the transcript. A final segment is kept and clears the
/// pending volatile one; a volatile segment replaces the previous volatile one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Accumulator {
    pub finals: Vec<Segment>,
    pub volatile: Option<Segment>,
}

impl Accumulator {
    pub fn ingest(&mut self, s: Segment) {
        let empty = s.is_blank();
        if s.r#final {
            self.volatile = None;
            if !empty {
                self.finals.push(s);
            }
        } else {
            self.volatile = if empty { None } else { Some(s) };
        }
    }

    /// Keeps a trailing volatile segment as final (an engine ended without finalizing it).
    pub fn promote_volatile(&mut self) {
        if let Some(mut v) = self.volatile.take() {
            v.r#final = true;
            self.finals.push(v);
        }
    }

    pub fn text(&self) -> String {
        self.finals
            .iter()
            .map(|s| s.text.trim())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// `{streamId, text, segments, engine, language, stopReason, audioMs, firstResultMs?}`.
    pub fn summary(
        &self,
        stream_id: &str,
        engine: EngineKind,
        language: &str,
        stop: StopReason,
        audio_ms: u64,
        first_result_ms: Option<u64>,
    ) -> Value {
        let mut o = json!({
            "streamId": stream_id,
            "text": self.text(),
            "segments": self.finals.iter().map(Segment::json).collect::<Vec<_>>(),
            "engine": engine.as_str(),
            "language": language,
            "stopReason": stop.as_str(),
            "audioMs": audio_ms,
        });
        if let Some(f) = first_result_ms {
            o["firstResultMs"] = json!(f);
        }
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_payloads_and_clamps() {
        let s = Segment::new("hi", 100, 50, false, Some(1.7));
        assert_eq!(s.end_ms, 100);
        assert_eq!(
            segment_event(&s),
            json!({"type": "speech.partial", "text": "hi", "startMs": 100, "endMs": 100, "final": false, "confidence": 1.0})
        );
        let f = Segment::new("yo", 0, 10, true, Some(f64::NAN));
        assert_eq!(segment_event(&f)["type"], "speech.final");
        assert!(segment_event(&f).get("confidence").is_none());
        assert_eq!(
            Segment::from_hns("x", 12_345_000, 4_000_000, true, None).start_ms,
            1235
        );
    }

    #[test]
    fn other_events() {
        let fmt = PcmFormat {
            encoding: super::super::params::PcmEncoding::S16le,
            sample_rate: 16_000,
            channels: 1,
        };
        let e = started_event(
            "s1",
            EngineKind::Sapi,
            "en-US",
            SpeechSource::Push,
            Some(&fmt),
        );
        assert_eq!(e["type"], "speech.started");
        assert_eq!(e["format"]["sampleRate"], 16_000);
        assert!(
            started_event(
                "s1",
                EngineKind::WindowsSpeech,
                "en-US",
                SpeechSource::Microphone,
                None
            )
            .get("format")
            .is_none()
        );
        let p = progress_event(600_000, 10_800_000, 1, 18);
        assert_eq!(
            (p["fraction"].as_f64(), p["chunk"].as_u64()),
            (Some(0.056), Some(1))
        );
        assert_eq!(progress_event(0, 0, 0, 1)["fraction"], 1.0);
    }

    #[test]
    fn accumulator_and_summary() {
        let mut a = Accumulator::default();
        a.ingest(Segment::new("hel", 0, 100, false, None));
        a.ingest(Segment::new("hello", 0, 200, false, None));
        a.ingest(Segment::new("Hello.", 0, 250, true, Some(0.9)));
        a.ingest(Segment::new("  ", 300, 300, true, None));
        a.ingest(Segment::new("wor", 300, 400, false, None));
        a.promote_volatile();
        assert_eq!(a.text(), "Hello. wor");
        let s = a.summary(
            "id",
            EngineKind::Sapi,
            "en-US",
            StopReason::EndOfInput,
            450,
            Some(120),
        );
        assert_eq!(s["stopReason"], "end_of_input");
        assert_eq!(s["segments"].as_array().unwrap().len(), 2);
        assert_eq!(s["segments"][1]["final"], true);
        assert_eq!(s["firstResultMs"], 120);
        assert_eq!(s["engine"], "sapi");
    }
}
