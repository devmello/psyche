//! Windows.Media.SpeechRecognition: a `SpeechRecognizer` with the dictation topic constraint and
//! a continuous recognition session on the default microphone. Hypotheses become volatile
//! segments, results final ones. The dictation topic is served by Microsoft's online speech
//! service and needs Settings › Privacy › Speech › Online speech recognition.

use crate::error::{CapError, Permission, win_err};
use crate::speech::transcript::Segment;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::SpeechRecognition::{
    SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechContinuousRecognitionSession,
    SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
    SpeechRecognizer,
};
use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
use windows::core::HSTRING;

/// SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED: Online speech recognition is off.
const PRIVACY_NOT_ACCEPTED: i32 = 0x8004_5509_u32 as i32;

/// Languages the dictation topic supports here (installed language + speech packs).
pub(crate) fn topic_languages() -> Vec<String> {
    SpeechRecognizer::SupportedTopicLanguages()
        .ok()
        .map(|v| v.into_iter().filter_map(|l| l.LanguageTag().ok().map(|t| t.to_string())).collect())
        .unwrap_or_default()
}

/// The recognizer's own default language ("Speech language" in Settings).
pub(crate) fn system_language() -> Option<String> {
    SpeechRecognizer::SystemSpeechLanguage().ok()?.LanguageTag().ok().map(|t| t.to_string())
}

pub(crate) fn map_error(e: &windows::core::Error) -> CapError {
    match e.code() {
        c if c.0 == PRIVACY_NOT_ACCEPTED => CapError::permission_missing(Permission::SpeechRecognition),
        c if c == E_ACCESSDENIED => CapError::permission_missing(Permission::Microphone),
        _ => win_err("transcription_failed", "Windows speech recognition failed", e).retryable(),
    }
}

fn now_hns() -> i64 {
    // SAFETY: plain clock read.
    let ft = unsafe { GetSystemTimePreciseAsFileTime() };
    ((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64
}

/// What the session thread reports.
pub(crate) enum Event {
    Segment(Segment),
    /// The session ended; Err for a recognizer failure.
    Completed(Result<(), CapError>),
}

/// A running continuous session.
pub(crate) struct Session {
    pub language: String,
    session: SpeechContinuousRecognitionSession,
    _recognizer: SpeechRecognizer,
    pub started: Instant,
}

impl Session {
    /// Compiles the dictation topic for `language` and starts listening; events go to `tx`.
    pub fn start(language: &str, volatile: bool, short: bool, tx: Sender<Event>) -> Result<Session, CapError> {
        let lang = Language::CreateLanguage(&HSTRING::from(language)).map_err(|e| map_error(&e))?;
        let rec = SpeechRecognizer::Create(&lang).map_err(|e| map_error(&e))?;
        let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("dictation")).map_err(|e| map_error(&e))?;
        rec.Constraints().and_then(|c| c.Append(&topic)).map_err(|e| map_error(&e))?;
        if short
            && let Ok(t) = rec.Timeouts()
        {
            // Conversation turns: finalize after half a second of silence.
            let _ = t.SetEndSilenceTimeout(TimeSpan { Duration: 5_000_000 });
        }
        let compiled = rec.CompileConstraintsAsync().and_then(|op| op.join()).map_err(|e| map_error(&e))?;
        match compiled.Status().unwrap_or(SpeechRecognitionResultStatus::Unknown) {
            SpeechRecognitionResultStatus::Success => {}
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => {
                return Err(CapError::unavailable("unsupported_locale", "Windows dictation does not support this language"));
            }
            SpeechRecognitionResultStatus::NetworkFailure => {
                return Err(CapError::unavailable("network_failure", "Windows dictation needs the network (Online speech recognition)").retryable());
            }
            s => return Err(CapError::unavailable("recognizer_unavailable", format!("Windows dictation is unavailable (status {})", s.0)).retryable()),
        }
        let session = rec.ContinuousRecognitionSession().map_err(|e| map_error(&e))?;
        // Never stop on silence by itself: speech.stop, maxDurationMs or the caller end it.
        let _ = session.SetAutoStopSilenceTimeout(TimeSpan { Duration: 24 * 3600 * 10_000_000 });

        let origin = Arc::new(Mutex::new(now_hns()));
        // The hypothesis' phrase start: the first hypothesis time since the last result.
        let phrase_start = Arc::new(Mutex::new(None::<i64>));
        if volatile {
            let (tx, origin, phrase_start) = (tx.clone(), origin.clone(), phrase_start.clone());
            rec.HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let text = args.Hypothesis()?.Text()?.to_string();
                    let now = now_hns();
                    let o = *origin.lock().unwrap_or_else(|e| e.into_inner());
                    let start = *phrase_start.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(now);
                    let s = (start - o).max(0) as u64;
                    let _ = tx.send(Event::Segment(Segment::from_hns(text, s, (now - start).max(0) as u64, false, None)));
                }
                Ok(())
            }))
            .map_err(|e| map_error(&e))?;
        }
        {
            let (tx, origin, phrase_start) = (tx.clone(), origin.clone(), phrase_start.clone());
            session
                .ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(
                    move |_, args| {
                        if let Some(args) = args.as_ref() {
                            let r = args.Result()?;
                            *phrase_start.lock().unwrap_or_else(|e| e.into_inner()) = None;
                            if r.Status()? == SpeechRecognitionResultStatus::Success {
                                let o = *origin.lock().unwrap_or_else(|e| e.into_inner());
                                let start = (r.PhraseStartTime()?.UniversalTime - o).max(0) as u64;
                                let len = r.PhraseDuration()?.Duration.max(0) as u64;
                                let conf = r.RawConfidence().ok().filter(|c| c.is_finite());
                                let _ = tx.send(Event::Segment(Segment::from_hns(r.Text()?.to_string(), start, len, true, conf)));
                            }
                        }
                        Ok(())
                    },
                ))
                .map_err(|e| map_error(&e))?;
        }
        {
            let tx = tx.clone();
            session
                .Completed(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionCompletedEventArgs>::new(move |_, args| {
                    let status = args.as_ref().and_then(|a| a.Status().ok()).unwrap_or(SpeechRecognitionResultStatus::Unknown);
                    let result = match status {
                        // Stopped, timed out, or the microphone went away: end of input.
                        SpeechRecognitionResultStatus::Success
                        | SpeechRecognitionResultStatus::UserCanceled
                        | SpeechRecognitionResultStatus::TimeoutExceeded
                        | SpeechRecognitionResultStatus::MicrophoneUnavailable
                        | SpeechRecognitionResultStatus::AudioQualityFailure => Ok(()),
                        SpeechRecognitionResultStatus::NetworkFailure => {
                            Err(CapError::unavailable("network_failure", "Windows dictation lost the network").retryable())
                        }
                        s => Err(CapError::unavailable("transcription_failed", format!("Windows dictation stopped (status {})", s.0)).retryable()),
                    };
                    let _ = tx.send(Event::Completed(result));
                    Ok(())
                }))
                .map_err(|e| map_error(&e))?;
        }
        session.StartAsync().and_then(|a| a.join()).map_err(|e| map_error(&e))?;
        *origin.lock().unwrap_or_else(|e| e.into_inner()) = now_hns();
        let language = lang.LanguageTag().map(|t| t.to_string()).unwrap_or_else(|_| language.to_string());
        Ok(Session { language, session, _recognizer: rec, started: Instant::now() })
    }

    /// Finishes the current phrase and ends the session (Completed follows).
    pub fn stop(&self) {
        let _ = self.session.StopAsync().and_then(|a| a.join());
    }

    pub fn cancel(&self) {
        let _ = self.session.CancelAsync().and_then(|a| a.join());
    }
}
