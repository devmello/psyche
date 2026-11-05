//! Capability manifest data, mirroring the Swift `CapabilitySpec` fields and the `Schema` builder.

use crate::dictation::policy::MAX_CHARS;
use crate::error::Permission;
use crate::speech::longform::{MAX_FILE_DURATION_MS, MAX_PATH_LENGTH};
use crate::speech::params::{
    CHANNEL_RANGE, DEFAULT_MAX_DURATION_MS, MAX_DURATION_MS, MAX_PUSH_BYTES, MAX_STREAM_ID_LENGTH,
    MAX_VOCABULARY_ENTRIES, MAX_VOCABULARY_ENTRY_LENGTH, MIN_DURATION_MS, SAMPLE_RATE_RANGE,
};
use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SideEffect {
    Read,
    Write,
}

impl SideEffect {
    pub fn as_str(self) -> &'static str {
        match self {
            SideEffect::Read => "read",
            SideEffect::Write => "write",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Path,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Path => "path",
        }
    }
}

/// Static description of one capability (Swift `CapabilitySpec`).
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilitySpec {
    pub name: &'static str,
    pub description: String,
    pub side_effect: SideEffect,
    pub target_kind: Option<TargetKind>,
    pub input_schema: Value,
    pub streaming: bool,
    /// Privacy permissions checked before dispatch (none here: the speech ones are per call).
    pub permissions: Vec<Permission>,
    /// Receipt kind for side-effecting calls.
    pub receipt_kind: Option<&'static str>,
}

impl CapabilitySpec {
    /// Wire form (`NodeCapability`).
    pub fn manifest_entry(&self) -> Value {
        let mut o = json!({
            "name": self.name,
            "description": self.description,
            "sideEffect": self.side_effect.as_str(),
            "inputSchema": self.input_schema,
            "streaming": self.streaming,
        });
        if let Some(t) = self.target_kind {
            o["targetKind"] = Value::String(t.as_str().into());
        }
        o
    }
}

/// The Swift `Schema` builder (draft 2020-12 subset the Gateway's validator understands).
pub(crate) mod schema {
    use super::*;

    pub fn object(
        properties: Vec<(&str, Value)>,
        required: &[&str],
        description: Option<&str>,
    ) -> Value {
        let props: Map<String, Value> = properties
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let mut o = json!({ "type": "object", "properties": props, "additionalProperties": false });
        if !required.is_empty() {
            let mut r: Vec<&str> = required.to_vec();
            r.sort_unstable();
            o["required"] = json!(r);
        }
        if let Some(d) = description {
            o["description"] = json!(d);
        }
        o
    }

    pub fn string(
        description: Option<&str>,
        enum_values: Option<&[&str]>,
        max_length: Option<usize>,
    ) -> Value {
        let mut o = json!({ "type": "string" });
        if let Some(d) = description {
            o["description"] = json!(d);
        }
        if let Some(e) = enum_values {
            o["enum"] = json!(e);
        }
        if let Some(m) = max_length {
            o["maxLength"] = json!(m);
        }
        o
    }

    pub fn integer(description: Option<&str>, min: Option<i64>, max: Option<i64>) -> Value {
        let mut o = json!({ "type": "integer" });
        if let Some(d) = description {
            o["description"] = json!(d);
        }
        if let Some(m) = min {
            o["minimum"] = json!(m);
        }
        if let Some(m) = max {
            o["maximum"] = json!(m);
        }
        o
    }

    pub fn boolean(description: Option<&str>) -> Value {
        let mut o = json!({ "type": "boolean" });
        if let Some(d) = description {
            o["description"] = json!(d);
        }
        o
    }

    pub fn array(items: Value, description: Option<&str>, max_items: Option<usize>) -> Value {
        let mut o = json!({ "type": "array", "items": items });
        if let Some(d) = description {
            o["description"] = json!(d);
        }
        if let Some(m) = max_items {
            o["maxItems"] = json!(m);
        }
        o
    }
}

const KEYS: &[&str] = &["fn", "rightOption", "rightCommand"];

/// Every capability this crate serves, in manifest order (dictation, then speech).
pub fn specs() -> Vec<CapabilitySpec> {
    use schema::*;
    let vocabulary = || {
        array(
            string(None, None, Some(MAX_VOCABULARY_ENTRY_LENGTH)),
            Some("Custom vocabulary (names, terms)"),
            Some(MAX_VOCABULARY_ENTRIES),
        )
    };
    let stream_id = || {
        string(
            Some("Stream id: the invocationId of the speech.transcribe_stream call"),
            None,
            Some(MAX_STREAM_ID_LENGTH),
        )
    };
    let format = object(
        vec![
            (
                "encoding",
                string(
                    Some("PCM sample encoding (little-endian, interleaved)"),
                    Some(&["pcm_s16le", "pcm_f32le"]),
                    None,
                ),
            ),
            (
                "sampleRate",
                integer(
                    Some("Hz"),
                    Some(*SAMPLE_RATE_RANGE.start() as i64),
                    Some(*SAMPLE_RATE_RANGE.end() as i64),
                ),
            ),
            (
                "channels",
                integer(
                    None,
                    Some(*CHANNEL_RANGE.start() as i64),
                    Some(*CHANNEL_RANGE.end() as i64),
                ),
            ),
        ],
        &["encoding", "sampleRate", "channels"],
        Some("Pushed audio format (source \"push\" only)"),
    );
    vec![
        CapabilitySpec {
            name: "dictation.target",
            description: "Desktop dictation only: the focused app and element (UI Automation) and whether dictated text can go there (never the field's contents).".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(vec![], &[], None),
            streaming: false,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "dictation.insert",
            description: "Desktop dictation only: insert text into the focused element via UI Automation (value with the selection replaced, caret kept) where that is exact, else unicode SendInput typing, or a clipboard paste that restores the clipboard for long text. Refuses password fields and Psyche's windows; control characters become spaces, so it never presses Enter.".into(),
            side_effect: SideEffect::Write,
            target_kind: None,
            input_schema: object(
                vec![
                    ("text", string(Some("Dictated text"), None, Some(MAX_CHARS))),
                    ("expectPid", integer(Some("Refuse with focus_changed unless this process still has focus"), Some(0), Some(i32::MAX as i64))),
                ],
                &["text"],
                None,
            ),
            streaming: false,
            permissions: vec![],
            receipt_kind: Some("dictation"),
        },
        CapabilitySpec {
            name: "dictation.watch",
            description: "Desktop dictation and voice only: stream {key, down, at, role?} while a hold-to-talk key goes down and up (low-level keyboard hook; fn = the configured key, Right Alt by default; rightOption = Right Alt; rightCommand = Right Ctrl). `keys` watches two keys with roles (dictation, voice); a single `key` has no role. Listen-only; a newer watch or key: null ends this one.".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(
                vec![
                    ("key", string(Some("Modifier to watch; null stops"), Some(KEYS), None)),
                    (
                        "keys",
                        array(
                            object(vec![("key", string(None, Some(KEYS), None)), ("role", string(None, Some(&["dictation", "voice"]), None))], &["key", "role"], None),
                            Some("Up to two keys with distinct roles; wins over key"),
                            Some(2),
                        ),
                    ),
                ],
                &[],
                None,
            ),
            streaming: true,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "speech.transcribe_stream",
            description: "Transcribe speech from the microphone or pushed PCM, streaming speech.partial / speech.final events. Engine: the on-device SAPI desktop recognizer (default; audio never leaves the PC), or Windows.Media.SpeechRecognition online dictation only when engine is \"windowsSpeech\" (microphone only, needs Online speech recognition). The stream id is this invocation's id; end it with speech.stop.".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(
                vec![
                    ("source", string(Some("Audio source (default microphone)"), Some(&["microphone", "push"]), None)),
                    ("locale", string(Some("BCP-47 language tag (default: the PC's locale)"), None, Some(35))),
                    ("vocabulary", vocabulary()),
                    ("format", format),
                    ("maxDurationMs", integer(Some(&format!("Audio cap (default {DEFAULT_MAX_DURATION_MS})")), Some(MIN_DURATION_MS as i64), Some(MAX_DURATION_MS as i64))),
                    ("volatile", boolean(Some("Stream volatile partial results (default true)"))),
                    (
                        "preset",
                        string(
                            Some("long (default: dictation, memos) or short (conversation turns: shorter end-of-phrase silence, frequent finalization)"),
                            Some(&["long", "short"]),
                            None,
                        ),
                    ),
                    (
                        "engine",
                        string(
                            Some("sapi (default: on-device) or windowsSpeech (Microsoft's online dictation; microphone only, sends audio off the PC)"),
                            Some(&["sapi", "windowsSpeech"]),
                            None,
                        ),
                    ),
                ],
                &[],
                None,
            ),
            streaming: true,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "speech.transcribe_file",
            description: "Transcribe an audio file in a granted folder or the Library on device (up to 4 h; decoded with Media Foundation), in chunks of about 10 minutes with overlap, streaming speech.progress events. Engine: the on-device SAPI desktop recognizer. The transcript is untrusted: other people may be speaking.".into(),
            side_effect: SideEffect::Read,
            target_kind: Some(TargetKind::Path),
            input_schema: object(
                vec![
                    ("path", string(Some("Absolute path of an audio file in a granted folder or the Library"), None, Some(MAX_PATH_LENGTH))),
                    ("locale", string(Some("BCP-47 language tag (default: the PC's locale)"), None, Some(35))),
                    ("vocabulary", vocabulary()),
                    (
                        "maxDurationMs",
                        integer(Some(&format!("Refuse longer files (default and ceiling {MAX_FILE_DURATION_MS})")), Some(MIN_DURATION_MS as i64), Some(MAX_FILE_DURATION_MS as i64)),
                    ),
                ],
                &["path"],
                None,
            ),
            streaming: true,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "speech.audio_push",
            description: "Push a chunk of PCM audio (base64) into a speech.transcribe_stream started with source \"push\"; final: true ends the input.".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(
                vec![
                    ("streamId", stream_id()),
                    ("data", string(Some(&format!("Base64 PCM in the stream's format (≤ {MAX_PUSH_BYTES} bytes decoded)")), None, Some(MAX_PUSH_BYTES.div_ceil(3) * 4))),
                    ("final", boolean(Some("No more audio follows"))),
                ],
                &["streamId", "data"],
                None,
            ),
            streaming: false,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "speech.stop",
            description: "Stop a speech stream (microphone or push); it finalizes and its speech.transcribe_stream call returns the transcript.".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(vec![("streamId", stream_id())], &["streamId"], None),
            streaming: false,
            permissions: vec![],
            receipt_kind: None,
        },
        CapabilitySpec {
            name: "speech.status",
            description: "Speech engines available on this PC, the privacy settings and language packs that gate them, recognizer languages, permission state and active streams.".into(),
            side_effect: SideEffect::Read,
            target_kind: None,
            input_schema: object(vec![("locale", string(Some("Locale to evaluate engines for (default: the PC's locale)"), None, Some(35)))], &[], None),
            streaming: false,
            permissions: vec![],
            receipt_kind: None,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_schemas_match_the_mac_helper() {
        let s = specs();
        let names: Vec<&str> = s.iter().map(|c| c.name).collect();
        assert_eq!(
            names,
            [
                "dictation.target",
                "dictation.insert",
                "dictation.watch",
                "speech.transcribe_stream",
                "speech.transcribe_file",
                "speech.audio_push",
                "speech.stop",
                "speech.status"
            ]
        );
        let insert = &s[1].input_schema;
        assert_eq!(insert["required"], json!(["text"]));
        assert_eq!(insert["properties"]["text"]["maxLength"], json!(4000));
        assert_eq!(insert["additionalProperties"], json!(false));
        let watch = &s[2].input_schema;
        assert_eq!(watch["properties"]["keys"]["maxItems"], json!(2));
        assert_eq!(
            watch["properties"]["keys"]["items"]["required"],
            json!(["key", "role"])
        );
        assert_eq!(
            s[5].input_schema["properties"]["data"]["maxLength"],
            json!(699_052)
        );
        assert_eq!(s[5].input_schema["required"], json!(["data", "streamId"]));
        assert_eq!(s[4].manifest_entry()["targetKind"], json!("path"));
        assert!(s.iter().filter(|c| c.streaming).map(|c| c.name).eq([
            "dictation.watch",
            "speech.transcribe_stream",
            "speech.transcribe_file"
        ]));
        assert_eq!(s[1].receipt_kind, Some("dictation"));
        assert_eq!(s[1].side_effect, SideEffect::Write);
    }
}
