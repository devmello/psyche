//! Long-form file transcription, pure pieces (`LongFormTranscript.swift`): params, the ~10 min
//! chunk plan with 10 s overlap on both sides, the merger that keeps each phrase once, and the
//! folder guard (granted folders plus the Library, as `FinderRoots`).

use super::engine::EngineKind;
use super::params::{MIN_DURATION_MS, validate_locale, validate_vocabulary};
use super::transcript::Segment;
use crate::error::{CapError, ErrorCode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

/// 4 hours (`SPEECH_FILE_MAX_DURATION_MS`).
pub const MAX_FILE_DURATION_MS: u64 = 4 * 60 * 60 * 1000;
pub const CHUNK_MS: u64 = 10 * 60 * 1000;
/// Audio read past each chunk boundary (on both sides).
pub const OVERLAP_MS: u64 = 10 * 1000;
pub const MAX_PATH_LENGTH: usize = 4096;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeFileParams {
    pub path: String,
    pub locale: Option<String>,
    pub vocabulary: Option<Vec<String>>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranscribeFileRequest {
    pub path: String,
    pub locale: Option<String>,
    pub vocabulary: Vec<String>,
    pub max_duration_ms: u64,
}

impl TranscribeFileParams {
    pub fn validated(self) -> Result<TranscribeFileRequest, CapError> {
        if self.path.is_empty() || self.path.chars().count() > MAX_PATH_LENGTH {
            return Err(CapError::invalid_params(
                format!("path is 1–{MAX_PATH_LENGTH} characters"),
                Some("path"),
            ));
        }
        let max = self.max_duration_ms.unwrap_or(MAX_FILE_DURATION_MS);
        if !(MIN_DURATION_MS..=MAX_FILE_DURATION_MS).contains(&max) {
            return Err(CapError::invalid_params(
                format!(
                    "maxDurationMs must be between {MIN_DURATION_MS} and {MAX_FILE_DURATION_MS}"
                ),
                Some("maxDurationMs"),
            ));
        }
        Ok(TranscribeFileRequest {
            path: self.path,
            locale: validate_locale(self.locale, "locale")?,
            vocabulary: validate_vocabulary(self.vocabulary)?,
            max_duration_ms: max,
        })
    }
}

impl TranscribeFileRequest {
    /// Refuses a file longer than `max_duration_ms` before any audio is read.
    pub fn check_duration(&self, audio_ms: u64) -> Result<(), CapError> {
        if audio_ms <= self.max_duration_ms {
            return Ok(());
        }
        Err(CapError::new(
            ErrorCode::InvalidParams,
            "too_long",
            format!(
                "The recording is {}; transcription takes recordings up to {}.",
                format_duration(audio_ms),
                format_duration(self.max_duration_ms)
            ),
        )
        .with_detail("audioMs", audio_ms)
        .with_detail("maxDurationMs", self.max_duration_ms))
    }
}

/// `3 h 05 min`, `52 min`, `40 s`.
pub fn format_duration(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        return format!("{s} s");
    }
    let m = s / 60;
    if m < 60 {
        format!("{m} min")
    } else {
        format!("{} h {:02} min", m / 60, m % 60)
    }
}

/// One chunk: the audio read (`read_from..read_to`) and the part whose phrases it owns
/// (`keep_from..keep_to`). Keep ranges tile the file without gaps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub index: usize,
    pub read_from_ms: u64,
    pub read_to_ms: u64,
    pub keep_from_ms: u64,
    pub keep_to_ms: u64,
}

/// Chunks of `chunk_ms` with `overlap_ms` read past each inner boundary. A short tail (under a
/// quarter chunk) folds into the previous chunk instead of becoming its own.
pub fn plan(audio_ms: u64, chunk_ms: u64, overlap_ms: u64) -> Vec<Chunk> {
    let size = chunk_ms.max(1);
    if audio_ms == 0 {
        return vec![Chunk {
            index: 0,
            read_from_ms: 0,
            read_to_ms: 0,
            keep_from_ms: 0,
            keep_to_ms: 0,
        }];
    }
    let mut bounds: Vec<u64> = (0..audio_ms).step_by(size as usize).collect();
    if bounds.len() > 1 && audio_ms - bounds[bounds.len() - 1] < size / 4 {
        bounds.pop();
    }
    (0..bounds.len())
        .map(|i| {
            let start = bounds[i];
            let end = bounds.get(i + 1).copied().unwrap_or(audio_ms);
            Chunk {
                index: i,
                read_from_ms: start.saturating_sub(overlap_ms),
                read_to_ms: (end + overlap_ms).min(audio_ms),
                keep_from_ms: start,
                keep_to_ms: end,
            }
        })
        .collect()
}

/// Folds per-chunk segments (times relative to the chunk's `read_from_ms`) into one transcript
/// with file times. A chunk keeps the segments whose midpoint is in its keep range (the last
/// chunk also keeps its end). A segment that still overlaps the previous one in time is the same
/// phrase heard by both chunks: the longer text wins.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Merger {
    pub segments: Vec<Segment>,
    pub chunks_added: usize,
}

impl Merger {
    pub fn add(&mut self, chunk: &Chunk, raw: Vec<Segment>, is_last: bool) {
        self.chunks_added += 1;
        let mut shifted: Vec<Segment> = raw
            .into_iter()
            .filter(|s| s.r#final && !s.is_blank())
            .map(|s| {
                Segment::new(
                    s.text,
                    s.start_ms + chunk.read_from_ms,
                    s.end_ms + chunk.read_from_ms,
                    true,
                    s.confidence,
                )
            })
            .collect();
        shifted.sort_by_key(|s| s.start_ms);
        for s in shifted {
            let mid = (s.start_ms + s.end_ms) / 2;
            if mid < chunk.keep_from_ms
                || !(mid < chunk.keep_to_ms || (is_last && mid <= chunk.keep_to_ms))
            {
                continue;
            }
            if let Some(last) = self.segments.last_mut()
                && same_phrase(last, &s)
            {
                if words(&s.text) > words(&last.text) {
                    *last = s;
                }
                continue;
            }
            self.segments.push(s);
        }
    }

    pub fn text(&self) -> String {
        self.segments
            .iter()
            .map(|s| s.text.trim())
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// `SpeechTranscribeFileResult` (plus `provenance: "untrusted"`, added by the capability).
    pub fn result(&self, engine: EngineKind, language: &str, audio_ms: u64) -> Value {
        json!({
            "text": self.text(),
            "segments": self.segments.iter().map(Segment::json).collect::<Vec<_>>(),
            "engine": engine.as_str(),
            "language": language,
            "audioMs": audio_ms,
            "chunks": self.chunks_added.max(1),
        })
    }
}

/// More than half of the shorter segment overlaps the other.
fn same_phrase(a: &Segment, b: &Segment) -> bool {
    let overlap = a.end_ms.min(b.end_ms) as i64 - a.start_ms.max(b.start_ms) as i64;
    let shorter = (a.end_ms - a.start_ms).min(b.end_ms - b.start_ms) as i64;
    overlap > 0 && overlap * 2 > shorter
}

fn words(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Folders `speech.transcribe_file` may read: `permissions.folders[].path` from the Gateway's
/// `$PSYCHE_HOME/config.json` plus `$PSYCHE_HOME/library`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Roots {
    pub roots: Vec<PathBuf>,
}

/// `PSYCHE_HOME`, else `%USERPROFILE%\.psyche`.
pub fn psyche_home() -> PathBuf {
    if let Ok(h) = std::env::var("PSYCHE_HOME")
        && !h.is_empty()
    {
        return PathBuf::from(h);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".psyche")
}

fn expand_tilde(p: &str) -> PathBuf {
    match p.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            PathBuf::from(home).join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(p),
    }
}

/// Symlinks resolved when the path exists; otherwise `.`/`..` folded lexically. The `\\?\`
/// prefix `canonicalize` adds is dropped so roots and paths compare alike.
pub fn canonical(p: &Path) -> PathBuf {
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::ParentDir => {
                    out.pop();
                }
                Component::CurDir => {}
                other => out.push(other.as_os_str()),
            }
        }
        out
    });
    let s = resolved.to_string_lossy();
    match s.strip_prefix(r"\\?\UNC\") {
        Some(rest) => PathBuf::from(format!(r"\\{rest}")),
        None => PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()),
    }
}

fn key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('/', "\\").to_lowercase();
    s.trim_end_matches('\\').to_string()
}

impl Roots {
    pub fn new(roots: Vec<PathBuf>) -> Self {
        Roots {
            roots: roots
                .iter()
                .map(|r| canonical(&expand_tilde(&r.to_string_lossy())))
                .collect(),
        }
    }

    pub fn load() -> Self {
        let home = psyche_home();
        let mut roots: Vec<PathBuf> = std::fs::read(home.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v["permissions"]["folders"].as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|f| f["path"].as_str().map(PathBuf::from))
            .collect();
        roots.push(home.join("library"));
        Roots::new(roots)
    }

    /// The canonical path if it lies inside a granted root, else `policy_denied`.
    pub fn resolve(&self, path: &str) -> Result<PathBuf, CapError> {
        let expanded = expand_tilde(path);
        if !expanded.is_absolute() {
            return Err(CapError::invalid_params(
                "path must be absolute",
                Some("path"),
            ));
        }
        if self.roots.is_empty() {
            return Err(CapError::new(
                ErrorCode::PolicyDenied,
                "no_granted_folders",
                "No folders are granted. Add one in Settings → Permissions → Folders.",
            ));
        }
        let p = canonical(&expanded);
        let pk = key(&p);
        let inside = self.roots.iter().any(|r| {
            let rk = key(r);
            pk == rk || pk.starts_with(&format!("{rk}\\"))
        });
        if !inside {
            return Err(CapError::new(
                ErrorCode::PolicyDenied,
                "outside_granted_folders",
                format!("{path} is outside the granted folders"),
            )
            .with_detail("path", path));
        }
        Ok(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN10: u64 = CHUNK_MS;

    #[test]
    fn plan_tiles_the_file() {
        let three_hours = 3 * 60 * 60 * 1000;
        let p = plan(three_hours, CHUNK_MS, OVERLAP_MS);
        assert_eq!(p.len(), 18);
        assert_eq!(
            p[0],
            Chunk {
                index: 0,
                read_from_ms: 0,
                read_to_ms: MIN10 + OVERLAP_MS,
                keep_from_ms: 0,
                keep_to_ms: MIN10
            }
        );
        assert_eq!(
            p[17],
            Chunk {
                index: 17,
                read_from_ms: 17 * MIN10 - OVERLAP_MS,
                read_to_ms: three_hours,
                keep_from_ms: 17 * MIN10,
                keep_to_ms: three_hours
            }
        );
        for w in p.windows(2) {
            assert_eq!(w[0].keep_to_ms, w[1].keep_from_ms);
            assert_eq!(w[0].read_to_ms - w[1].read_from_ms, 2 * OVERLAP_MS);
        }
        assert!(
            p.iter()
                .all(|c| c.read_to_ms - c.read_from_ms <= MIN10 + 2 * OVERLAP_MS)
        );
    }

    #[test]
    fn short_tail_folds_into_the_previous_chunk() {
        let p = plan(21 * 60 * 1000, CHUNK_MS, OVERLAP_MS);
        assert_eq!(
            p.iter().map(|c| c.keep_to_ms).collect::<Vec<_>>(),
            [MIN10, 21 * 60 * 1000]
        );
        assert_eq!(plan(25 * 60 * 1000, CHUNK_MS, OVERLAP_MS).len(), 3);
        assert_eq!(
            plan(40_000, CHUNK_MS, OVERLAP_MS),
            [Chunk {
                index: 0,
                read_from_ms: 0,
                read_to_ms: 40_000,
                keep_from_ms: 0,
                keep_to_ms: 40_000
            }]
        );
        assert_eq!(plan(0, CHUNK_MS, OVERLAP_MS).len(), 1);
    }

    fn seg(t: &str, s: u64, e: u64) -> Segment {
        Segment::new(t, s, e, true, None)
    }

    #[test]
    fn merger_keeps_each_phrase_once() {
        let p = plan(2 * MIN10, CHUNK_MS, OVERLAP_MS);
        let mut m = Merger::default();
        m.add(
            &p[0],
            vec![
                seg("first", 1000, 2000),
                seg("across the boundary", MIN10 - 2000, MIN10 + 3000),
                seg("cut", MIN10 + OVERLAP_MS - 500, MIN10 + OVERLAP_MS),
                Segment::new("volatile", 3000, 4000, false, None),
            ],
            false,
        );
        let base = p[1].read_from_ms;
        m.add(
            &p[1],
            vec![
                seg("tail of the previous", 1000, 3000),
                seg(
                    "across the boundary",
                    MIN10 - 2100 - base,
                    MIN10 + 3100 - base,
                ),
                seg(
                    "cut off here",
                    MIN10 + OVERLAP_MS - 600 - base,
                    MIN10 + OVERLAP_MS + 900 - base,
                ),
                seg("end", 2 * MIN10 - 1000 - base, 2 * MIN10 - base),
            ],
            true,
        );
        assert_eq!(
            m.segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["first", "across the boundary", "cut off here", "end"]
        );
        assert_eq!(
            m.segments.iter().map(|s| s.start_ms).collect::<Vec<_>>(),
            [
                1000,
                MIN10 - 2100,
                MIN10 + OVERLAP_MS - 600,
                2 * MIN10 - 1000
            ]
        );
        assert_eq!(m.text(), "first across the boundary cut off here end");
        assert_eq!(m.chunks_added, 2);
    }

    #[test]
    fn same_phrase_heard_twice_keeps_the_longer_text() {
        let p = plan(2 * MIN10, CHUNK_MS, OVERLAP_MS);
        let mut m = Merger::default();
        m.add(
            &p[0],
            vec![seg("we ship on", MIN10 - 3000, MIN10 + 2000)],
            false,
        );
        let base = p[1].read_from_ms;
        m.add(
            &p[1],
            vec![seg(
                "we ship on Friday",
                MIN10 - 2800 - base,
                MIN10 + 3600 - base,
            )],
            true,
        );
        assert_eq!(
            m.segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["we ship on Friday"]
        );
    }

    #[test]
    fn result_and_params() {
        let mut m = Merger::default();
        m.add(
            &plan(5000, CHUNK_MS, OVERLAP_MS)[0],
            vec![seg("hi", 0, 500)],
            true,
        );
        let r = m.result(EngineKind::Sapi, "en-US", 5000);
        assert_eq!(
            (
                r["text"].as_str(),
                r["chunks"].as_u64(),
                r["audioMs"].as_u64()
            ),
            (Some("hi"), Some(1), Some(5000))
        );
        let p = |v: Value| {
            serde_json::from_value::<TranscribeFileParams>(v)
                .unwrap()
                .validated()
        };
        assert_eq!(
            p(json!({"path": "C:\\a.wav"})).unwrap().max_duration_ms,
            MAX_FILE_DURATION_MS
        );
        assert!(
            p(json!({"path": "C:\\a.wav", "maxDurationMs": MAX_FILE_DURATION_MS + 1})).is_err()
        );
        assert!(p(json!({"path": ""})).is_err());
        let r = p(json!({"path": "C:\\a.wav", "maxDurationMs": 60_000})).unwrap();
        let e = r
            .check_duration(3 * 60 * 60 * 1000 + 5 * 60 * 1000)
            .unwrap_err();
        assert_eq!(e.reason, "too_long");
        assert_eq!(
            e.message,
            "The recording is 3 h 05 min; transcription takes recordings up to 1 min."
        );
        assert_eq!(format_duration(40_000), "40 s");
        assert_eq!(format_duration(52 * 60_000), "52 min");
    }

    #[test]
    fn roots_guard() {
        let dir = std::env::temp_dir().join(format!("psyche-roots-{}", std::process::id()));
        let granted = dir.join("Granted");
        std::fs::create_dir_all(granted.join("sub")).unwrap();
        std::fs::write(granted.join("sub").join("a.wav"), b"x").unwrap();
        let roots = Roots::new(vec![granted.clone()]);
        let inside = granted.join("sub").join("a.wav");
        assert!(roots.resolve(&inside.to_string_lossy()).is_ok());
        // Case-insensitive, and `..` cannot climb out.
        assert!(
            roots
                .resolve(&inside.to_string_lossy().to_uppercase())
                .is_ok()
        );
        let escape = granted.join("..").join("other.wav");
        assert_eq!(
            roots.resolve(&escape.to_string_lossy()).unwrap_err().reason,
            "outside_granted_folders"
        );
        let sibling = dir.join("GrantedEvil").join("a.wav");
        assert_eq!(
            roots
                .resolve(&sibling.to_string_lossy())
                .unwrap_err()
                .reason,
            "outside_granted_folders"
        );
        assert_eq!(
            roots.resolve("relative\\a.wav").unwrap_err().details["field"],
            "path"
        );
        assert_eq!(
            Roots { roots: vec![] }
                .resolve(&inside.to_string_lossy())
                .unwrap_err()
                .reason,
            "no_granted_folders"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
