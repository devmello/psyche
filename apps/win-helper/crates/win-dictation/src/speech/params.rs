//! `speech.*` params, limits and validation (`SpeechParams.swift`, `SpeechAudioFormat.swift`).

use crate::error::CapError;
use base64::Engine as _;
use serde::Deserialize;
use std::ops::RangeInclusive;

pub const MAX_VOCABULARY_ENTRIES: usize = 100;
pub const MAX_VOCABULARY_ENTRY_LENGTH: usize = 64;
pub const MAX_DURATION_MS: u64 = 10 * 60 * 1000;
pub const DEFAULT_MAX_DURATION_MS: u64 = 5 * 60 * 1000;
pub const MIN_DURATION_MS: u64 = 1000;
pub const MAX_STREAM_ID_LENGTH: usize = 128;
/// Decoded bytes per `speech.audio_push`.
pub const MAX_PUSH_BYTES: usize = 512 * 1024;
/// Unconsumed pushed bytes held per stream before pushes are refused (backpressure).
pub const PUSH_BUFFER_LIMIT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_CONCURRENT_STREAMS: usize = 4;
pub const SAMPLE_RATE_RANGE: RangeInclusive<u32> = 8_000..=48_000;
pub const CHANNEL_RANGE: RangeInclusive<u32> = 1..=2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechSource {
    Microphone,
    Push,
}

impl SpeechSource {
    pub fn as_str(self) -> &'static str {
        match self {
            SpeechSource::Microphone => "microphone",
            SpeechSource::Push => "push",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeechPreset {
    Long,
    Short,
}

impl SpeechPreset {
    pub fn as_str(self) -> &'static str {
        match self {
            SpeechPreset::Long => "long",
            SpeechPreset::Short => "short",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum PcmEncoding {
    #[serde(rename = "pcm_s16le")]
    S16le,
    #[serde(rename = "pcm_f32le")]
    F32le,
}

impl PcmEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            PcmEncoding::S16le => "pcm_s16le",
            PcmEncoding::F32le => "pcm_f32le",
        }
    }

    pub fn bytes_per_sample(self) -> usize {
        match self {
            PcmEncoding::S16le => 2,
            PcmEncoding::F32le => 4,
        }
    }
}

/// Interleaved little-endian PCM (`AudioFormat {encoding, sampleRate, channels}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmFormat {
    pub encoding: PcmEncoding,
    pub sample_rate: u32,
    pub channels: u32,
}

impl PcmFormat {
    pub fn bytes_per_frame(&self) -> usize {
        self.encoding.bytes_per_sample() * self.channels as usize
    }

    /// Milliseconds of audio in `byte_count` bytes (whole frames only).
    pub fn duration_ms(&self, byte_count: usize) -> u64 {
        if self.sample_rate == 0 || self.bytes_per_frame() == 0 {
            return 0;
        }
        ((byte_count / self.bytes_per_frame()) as f64 * 1000.0 / self.sample_rate as f64).round() as u64
    }

    /// Bytes holding `ms` of audio (whole frames).
    pub fn byte_count(&self, ms: u64) -> usize {
        ((ms as f64 * self.sample_rate as f64 / 1000.0).floor() as usize) * self.bytes_per_frame()
    }

    pub fn validate(&self, field: &str) -> Result<(), CapError> {
        if !SAMPLE_RATE_RANGE.contains(&self.sample_rate) {
            return Err(CapError::invalid_params(
                format!("{field}.sampleRate must be between {} and {}", SAMPLE_RATE_RANGE.start(), SAMPLE_RATE_RANGE.end()),
                Some(&format!("{field}.sampleRate")),
            ));
        }
        if !CHANNEL_RANGE.contains(&self.channels) {
            return Err(CapError::invalid_params(format!("{field}.channels must be 1 or 2"), Some(&format!("{field}.channels"))));
        }
        Ok(())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({ "encoding": self.encoding.as_str(), "sampleRate": self.sample_rate, "channels": self.channels })
    }
}

/// BCP-47-ish: a 2–3 letter language subtag, then 2–8 character alphanumeric subtags, separated
/// by `-` or `_`. At most 35 characters.
pub fn is_valid_locale(id: &str) -> bool {
    if id.is_empty() || id.chars().count() > 35 {
        return false;
    }
    let parts: Vec<&str> = id.split(['-', '_']).collect();
    let first = parts[0];
    if !(2..=3).contains(&first.len()) || !first.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    parts[1..].iter().all(|p| (2..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

pub fn validate_locale(id: Option<String>, field: &str) -> Result<Option<String>, CapError> {
    match id {
        None => Ok(None),
        Some(id) if is_valid_locale(&id) => Ok(Some(id)),
        Some(_) => Err(CapError::invalid_params(format!("{field} must be a BCP-47 language tag such as en-US"), Some(field))),
    }
}

/// Trims, drops duplicates (keeping order) and enforces ≤ 100 entries × 64 characters.
pub fn validate_vocabulary(entries: Option<Vec<String>>) -> Result<Vec<String>, CapError> {
    let Some(entries) = entries else { return Ok(vec![]) };
    if entries.len() > MAX_VOCABULARY_ENTRIES {
        return Err(CapError::invalid_params(format!("vocabulary holds at most {MAX_VOCABULARY_ENTRIES} entries"), Some("vocabulary")));
    }
    let mut out: Vec<String> = vec![];
    for (i, raw) in entries.iter().enumerate() {
        let entry = raw.trim();
        let n = crate::dictation::policy::char_count(entry);
        if entry.is_empty() || n > MAX_VOCABULARY_ENTRY_LENGTH {
            return Err(CapError::invalid_params(
                format!("vocabulary entries must be 1–{MAX_VOCABULARY_ENTRY_LENGTH} characters"),
                Some(&format!("vocabulary.{i}")),
            ));
        }
        if !out.iter().any(|e| e == entry) {
            out.push(entry.to_string());
        }
    }
    Ok(out)
}

pub fn validate_stream_id(id: &str) -> Result<String, CapError> {
    if id.is_empty() || id.chars().count() > MAX_STREAM_ID_LENGTH {
        return Err(CapError::invalid_params(format!("streamId must be 1–{MAX_STREAM_ID_LENGTH} characters"), Some("streamId")));
    }
    Ok(id.to_string())
}

/// Raw `speech.transcribe_stream` params.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeStreamParams {
    pub source: Option<SpeechSource>,
    pub locale: Option<String>,
    pub vocabulary: Option<Vec<String>>,
    pub format: Option<PcmFormat>,
    pub max_duration_ms: Option<u64>,
    pub volatile: Option<bool>,
    pub preset: Option<SpeechPreset>,
}

/// Validated, defaulted `speech.transcribe_stream` request.
#[derive(Clone, Debug, PartialEq)]
pub struct TranscribeRequest {
    pub source: SpeechSource,
    pub locale: Option<String>,
    pub vocabulary: Vec<String>,
    pub format: Option<PcmFormat>,
    pub max_duration_ms: u64,
    pub volatile: bool,
    pub preset: SpeechPreset,
}

impl TranscribeStreamParams {
    pub fn validated(self) -> Result<TranscribeRequest, CapError> {
        let locale = validate_locale(self.locale, "locale")?;
        let vocabulary = validate_vocabulary(self.vocabulary)?;
        let max = self.max_duration_ms.unwrap_or(DEFAULT_MAX_DURATION_MS);
        if !(MIN_DURATION_MS..=MAX_DURATION_MS).contains(&max) {
            return Err(CapError::invalid_params(
                format!("maxDurationMs must be between {MIN_DURATION_MS} and {MAX_DURATION_MS}"),
                Some("maxDurationMs"),
            ));
        }
        let source = self.source.unwrap_or(SpeechSource::Microphone);
        match source {
            SpeechSource::Microphone if self.format.is_some() => {
                return Err(CapError::invalid_params("format applies to source \"push\" only", Some("format")));
            }
            SpeechSource::Push => match &self.format {
                None => return Err(CapError::invalid_params("source \"push\" needs format {encoding, sampleRate, channels}", Some("format"))),
                Some(f) => f.validate("format")?,
            },
            _ => {}
        }
        Ok(TranscribeRequest {
            source,
            locale,
            vocabulary,
            format: self.format,
            max_duration_ms: max,
            volatile: self.volatile.unwrap_or(true),
            preset: self.preset.unwrap_or(SpeechPreset::Long),
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPushParams {
    pub stream_id: String,
    pub data: String,
    pub r#final: Option<bool>,
}

impl AudioPushParams {
    /// The stream id and the decoded audio bytes.
    pub fn validated(&self) -> Result<(String, Vec<u8>, bool), CapError> {
        let id = validate_stream_id(&self.stream_id)?;
        // Base64 length bounds the decoded size; check before decoding.
        if self.data.len() > MAX_PUSH_BYTES.div_ceil(3) * 4 {
            return Err(CapError::invalid_params(format!("data holds at most {MAX_PUSH_BYTES} bytes per push"), Some("data")));
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(self.data.as_bytes())
            .map_err(|_| CapError::invalid_params("data must be base64", Some("data")))?;
        Ok((id, audio, self.r#final.unwrap_or(false)))
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamIdParams {
    pub stream_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(v: serde_json::Value) -> Result<TranscribeRequest, CapError> {
        serde_json::from_value::<TranscribeStreamParams>(v).unwrap().validated()
    }

    #[test]
    fn locales() {
        for ok in ["en", "en-US", "en_US", "zh-Hant-TW", "yue-HK", "es-419"] {
            assert!(is_valid_locale(ok), "{ok}");
        }
        let long = "ab-".repeat(20) + "ab";
        for bad in ["", "e", "english", "en-", "-US", "en--US", "en-U", "en-US-toolongsubtag", "en US", "ée", "en-US;rm -rf", long.as_str()] {
            assert!(!is_valid_locale(bad), "{bad}");
        }
    }

    #[test]
    fn transcribe_defaults_and_push_format() {
        let r = req(json!({})).unwrap();
        assert_eq!((r.source, r.max_duration_ms, r.volatile, r.preset), (SpeechSource::Microphone, DEFAULT_MAX_DURATION_MS, true, SpeechPreset::Long));
        assert_eq!(req(json!({"source": "push"})).unwrap_err().details["field"], "format");
        let fmt = json!({"encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1});
        assert_eq!(req(json!({"source": "microphone", "format": fmt})).unwrap_err().details["field"], "format");
        let r = req(json!({"source": "push", "format": fmt, "preset": "short", "volatile": false})).unwrap();
        assert_eq!(r.format.unwrap().bytes_per_frame(), 2);
        assert_eq!((r.preset, r.volatile), (SpeechPreset::Short, false));
        let bad = json!({"source": "push", "format": {"encoding": "pcm_f32le", "sampleRate": 96000, "channels": 1}});
        assert_eq!(req(bad).unwrap_err().details["field"], "format.sampleRate");
        let bad = json!({"source": "push", "format": {"encoding": "pcm_f32le", "sampleRate": 16000, "channels": 3}});
        assert_eq!(req(bad).unwrap_err().details["field"], "format.channels");
    }

    #[test]
    fn duration_bounds_and_vocabulary() {
        assert!(req(json!({"maxDurationMs": 999})).is_err());
        assert!(req(json!({"maxDurationMs": 600_001})).is_err());
        assert!(req(json!({"maxDurationMs": 600_000})).is_ok());
        let v = validate_vocabulary(Some(vec![" Psyche ".into(), "Alice Chen".into(), "Psyche".into()])).unwrap();
        assert_eq!(v, ["Psyche", "Alice Chen"]);
        assert_eq!(validate_vocabulary(Some(vec!["ok".into(), " ".into()])).unwrap_err().details["field"], "vocabulary.1");
        assert!(validate_vocabulary(Some(vec!["x".into(); 101])).is_err());
        assert!(validate_vocabulary(Some(vec!["x".repeat(65)])).is_err());
        assert_eq!(req(json!({"locale": "english"})).unwrap_err().details["field"], "locale");
    }

    #[test]
    fn audio_push_and_format_math() {
        let p = AudioPushParams { stream_id: "s".into(), data: "AAEC".into(), r#final: None };
        assert_eq!(p.validated().unwrap(), ("s".into(), vec![0, 1, 2], false));
        let bad = AudioPushParams { data: "!!".into(), ..p.clone() };
        assert_eq!(bad.validated().unwrap_err().details["field"], "data");
        let big = AudioPushParams { data: "A".repeat(699_053), ..p.clone() };
        assert_eq!(big.validated().unwrap_err().details["field"], "data");
        assert!(AudioPushParams { stream_id: "".into(), ..p }.validated().is_err());
        let f = PcmFormat { encoding: PcmEncoding::F32le, sample_rate: 48_000, channels: 2 };
        assert_eq!(f.bytes_per_frame(), 8);
        assert_eq!(f.duration_ms(8 * 48_000), 1000);
        assert_eq!(f.byte_count(10), 480 * 8);
        assert_eq!(f.duration_ms(7), 0);
        assert_eq!(f.json(), json!({"encoding": "pcm_f32le", "sampleRate": 48000, "channels": 2}));
    }
}
