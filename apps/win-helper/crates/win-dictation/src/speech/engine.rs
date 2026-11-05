//! Engine choice and locale resolution (`SpeechEngineSelection.swift`), pure.
//!
//! - `windowsSpeech`: Windows.Media.SpeechRecognition `SpeechRecognizer` with the dictation topic
//!   constraint and a continuous recognition session. It captures the microphone itself (it
//!   cannot take pushed audio or files) and needs Settings › Privacy › Speech › Online speech
//!   recognition: the dictation topic is recognized by Microsoft's online service, so it is not
//!   on-device (status reports `onDevice: false`).
//! - `sapi`: the SAPI 5.4 in-process desktop recognizer ("Microsoft Speech Recognizer 8.0") with a
//!   dictation grammar, fed our own 16 kHz mono stream. On-device and the default for every
//!   source (pushed audio, files, the microphone via WASAPI); `windowsSpeech` only on request.

use super::params::{SpeechPreset, SpeechSource};
use crate::error::CapError;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineKind {
    WindowsSpeech,
    Sapi,
}

impl EngineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EngineKind::WindowsSpeech => "windowsSpeech",
            EngineKind::Sapi => "sapi",
        }
    }

    pub fn on_device(self) -> bool {
        self == EngineKind::Sapi
    }
}

/// What the running system can do for one request's locale.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Availability {
    /// The OneCore recognizer supports the locale's dictation topic (language + speech pack).
    pub windows_speech_language: Option<String>,
    /// Online speech recognition is turned on (and not blocked by policy).
    pub online_speech: bool,
    /// A SAPI desktop recognizer for the locale is installed.
    pub sapi_language: Option<String>,
}

impl Availability {
    pub fn windows_speech(&self) -> bool {
        self.windows_speech_language.is_some() && self.online_speech
    }

    pub fn sapi(&self) -> bool {
        self.sapi_language.is_some()
    }

    pub fn language(&self, kind: EngineKind) -> Option<&str> {
        match kind {
            EngineKind::WindowsSpeech => self.windows_speech_language.as_deref(),
            EngineKind::Sapi => self.sapi_language.as_deref(),
        }
    }
}

/// One thing standing between the request and an engine, with where the owner fixes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocker {
    pub reason: &'static str,
    pub engine: EngineKind,
    pub message: &'static str,
    pub settings_uri: &'static str,
}

impl Blocker {
    pub fn json(&self) -> Value {
        json!({ "reason": self.reason, "engine": self.engine.as_str(), "message": self.message, "settingsUri": self.settings_uri })
    }
}

pub fn blockers(a: &Availability) -> Vec<Blocker> {
    let mut out = vec![];
    if a.windows_speech_language.is_some() && !a.online_speech {
        out.push(Blocker {
            reason: "online_speech_disabled",
            engine: EngineKind::WindowsSpeech,
            message: "Turn on Settings › Privacy & security › Speech › Online speech recognition to use Windows dictation.",
            settings_uri: "ms-settings:privacy-speech",
        });
    }
    if a.windows_speech_language.is_none() {
        out.push(Blocker {
            reason: "language_not_installed",
            engine: EngineKind::WindowsSpeech,
            message: "Install the language's speech recognition in Settings › Time & language › Language & region.",
            settings_uri: "ms-settings:regionlanguage",
        });
    }
    if a.sapi_language.is_none() {
        out.push(Blocker {
            reason: "desktop_recognizer_not_installed",
            engine: EngineKind::Sapi,
            message: "No on-device desktop speech recognizer is installed for this language (Settings › Time & language › Speech).",
            settings_uri: "ms-settings:speech",
        });
    }
    out
}

/// Picks the engine. Audio never leaves the PC unless the caller asks (the mac helper's engines
/// are all on-device): every source uses the on-device SAPI recognizer by default, and Windows
/// dictation (`windowsSpeech`, Microsoft's online service) only when `requested` names it, for
/// the microphone only (WinRT cannot take pushed audio or files). Never a silent switch from one
/// to the other. The vocabulary and preset do not change the choice on Windows.
pub fn select(
    source: SpeechSource,
    a: &Availability,
    requested: Option<EngineKind>,
    _vocabulary: &[String],
    _preset: SpeechPreset,
) -> Result<EngineKind, CapError> {
    let online = requested == Some(EngineKind::WindowsSpeech);
    if online && source != SpeechSource::Microphone {
        return Err(CapError::invalid_params(
            "engine \"windowsSpeech\" serves the microphone only",
            Some("engine"),
        ));
    }
    if online && a.windows_speech() {
        return Ok(EngineKind::WindowsSpeech);
    }
    if !online && a.sapi() {
        return Ok(EngineKind::Sapi);
    }
    let wanted = if online {
        EngineKind::WindowsSpeech
    } else {
        EngineKind::Sapi
    };
    let found: Vec<Value> = blockers(a)
        .iter()
        .filter(|b| b.engine == wanted)
        .map(Blocker::json)
        .collect();
    let message = match (online, source) {
        (true, _) => "Windows online dictation cannot serve this locale on this PC",
        (false, SpeechSource::Microphone) => {
            "No on-device speech engine supports this locale on this PC"
        }
        (false, _) => {
            "No on-device speech engine supports this locale on this PC (pushed audio and files need the desktop recognizer)"
        }
    };
    let first_uri = found
        .first()
        .and_then(|b| b["settingsUri"].as_str())
        .unwrap_or("ms-settings:speech")
        .to_string();
    Err(CapError::unavailable("no_speech_engine", message)
        .with_detail("blockers", found)
        .with_detail("settingsUri", first_uri))
}

fn norm(tag: &str) -> String {
    tag.replace('_', "-").to_ascii_lowercase()
}

fn subtags(tag: &str) -> Vec<String> {
    norm(tag).split('-').map(str::to_string).collect()
}

fn region(parts: &[String]) -> Option<&str> {
    parts
        .iter()
        .skip(1)
        .find(|p| p.len() == 2 || (p.len() == 3 && p.chars().all(|c| c.is_ascii_digit())))
        .map(String::as_str)
}

fn script(parts: &[String]) -> Option<&str> {
    parts
        .iter()
        .skip(1)
        .find(|p| p.len() == 4)
        .map(String::as_str)
}

/// The region most speakers of a bare language tag mean (requested `en` → `en-US`).
fn likely_region(lang: &str) -> Option<&'static str> {
    Some(match lang {
        "en" => "us",
        "es" => "es",
        "fr" => "fr",
        "de" => "de",
        "it" => "it",
        "pt" => "br",
        "ja" => "jp",
        "ko" => "kr",
        "zh" => "cn",
        "nl" => "nl",
        "sv" => "se",
        "da" => "dk",
        "nb" | "no" => "no",
        "fi" => "fi",
        "pl" => "pl",
        "ru" => "ru",
        "tr" => "tr",
        "ar" => "sa",
        "hi" => "in",
        _ => return None,
    })
}

/// Chinese scripts imply regions and back (`zh-Hant` ↔ TW/HK, `zh-Hans` ↔ CN/SG).
fn implied_script(lang: &str, region: Option<&str>) -> Option<&'static str> {
    if lang != "zh" {
        return None;
    }
    match region {
        Some("tw" | "hk" | "mo") => Some("hant"),
        Some(_) => Some("hans"),
        None => None,
    }
}

/// Requested locale → the best of `available` (as the recognizer names them): exact tag, then
/// same language and region (any script), then same language and script, then the language's
/// usual region (or the PC's region), then any variant of the language. None when the language
/// is not there at all.
pub fn best_locale(
    requested: &str,
    available: &[String],
    home_region: Option<&str>,
) -> Option<String> {
    let want = subtags(requested);
    let lang = want.first()?.clone();
    let want_region = region(&want).map(str::to_string);
    let want_script = script(&want)
        .map(str::to_string)
        .or_else(|| implied_script(&lang, want_region.as_deref()).map(str::to_string));
    if let Some(a) = available.iter().find(|a| norm(a) == norm(requested)) {
        return Some(a.clone());
    }
    let same_lang: Vec<&String> = available
        .iter()
        .filter(|a| subtags(a).first() == Some(&lang))
        .collect();
    let pick = |pred: &dyn Fn(&[String]) -> bool| {
        same_lang
            .iter()
            .find(|a| pred(&subtags(a)))
            .map(|a| (*a).clone())
    };
    if let Some(r) = &want_region
        && let Some(a) = pick(&|p| region(p) == Some(r.as_str()))
    {
        return Some(a);
    }
    if let Some(s) = &want_script
        && let Some(a) = pick(&|p| {
            let have = script(p)
                .map(str::to_string)
                .or_else(|| implied_script(&lang, region(p)).map(str::to_string));
            have.as_deref() == Some(s.as_str())
        })
    {
        return Some(a);
    }
    if want_region.is_none() {
        for r in [
            home_region.map(|h| h.to_ascii_lowercase()),
            likely_region(&lang).map(str::to_string),
        ]
        .into_iter()
        .flatten()
        {
            if let Some(a) = pick(&|p| region(p) == Some(r.as_str())) {
                return Some(a);
            }
        }
    }
    let mut rest: Vec<&String> = same_lang;
    rest.sort();
    rest.first().map(|a| (*a).clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn selection() {
        let both = Availability {
            windows_speech_language: Some("en-US".into()),
            online_speech: true,
            sapi_language: Some("en-US".into()),
        };
        let v: Vec<String> = vec![];
        let mic = SpeechSource::Microphone;
        let online = Some(EngineKind::WindowsSpeech);
        // On-device by default, even with online recognition available.
        assert_eq!(
            select(mic, &both, None, &v, SpeechPreset::Long).unwrap(),
            EngineKind::Sapi
        );
        assert_eq!(
            select(mic, &both, Some(EngineKind::Sapi), &v, SpeechPreset::Long).unwrap(),
            EngineKind::Sapi
        );
        // Online only when asked for, and only for the microphone.
        assert_eq!(
            select(mic, &both, online, &v, SpeechPreset::Long).unwrap(),
            EngineKind::WindowsSpeech
        );
        let e = select(SpeechSource::Push, &both, online, &v, SpeechPreset::Long).unwrap_err();
        assert_eq!(
            (e.code, e.details["field"].as_str()),
            (crate::error::ErrorCode::InvalidParams, Some("engine"))
        );
        assert_eq!(
            select(SpeechSource::Push, &both, None, &v, SpeechPreset::Short).unwrap(),
            EngineKind::Sapi
        );
        let offline = Availability {
            online_speech: false,
            ..both.clone()
        };
        assert_eq!(
            select(mic, &offline, None, &v, SpeechPreset::Long).unwrap(),
            EngineKind::Sapi
        );
        // Asked for online while it is off: an error, never a silent switch to SAPI.
        let e = select(mic, &offline, online, &v, SpeechPreset::Long).unwrap_err();
        assert_eq!(e.details["blockers"][0]["reason"], "online_speech_disabled");
        // No SAPI recognizer: the default never falls back to the online service.
        let no_sapi = Availability {
            sapi_language: None,
            ..both.clone()
        };
        let e = select(mic, &no_sapi, None, &v, SpeechPreset::Long).unwrap_err();
        assert_eq!(e.reason, "no_speech_engine");
        assert_eq!(
            e.details["blockers"][0]["reason"],
            "desktop_recognizer_not_installed"
        );
        assert!(EngineKind::Sapi.on_device() && !EngineKind::WindowsSpeech.on_device());
    }

    #[test]
    fn no_engine_is_unavailable_with_actionable_blockers() {
        let only_winrt_offline = Availability {
            windows_speech_language: Some("fr-FR".into()),
            online_speech: false,
            sapi_language: None,
        };
        let e = select(
            SpeechSource::Microphone,
            &only_winrt_offline,
            Some(EngineKind::WindowsSpeech),
            &[],
            SpeechPreset::Long,
        )
        .unwrap_err();
        assert_eq!(
            (e.code, e.reason.as_str()),
            (crate::error::ErrorCode::Unavailable, "no_speech_engine")
        );
        let reasons: Vec<&str> = e.details["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["reason"].as_str().unwrap())
            .collect();
        assert_eq!(reasons, ["online_speech_disabled"]);
        assert_eq!(e.details["settingsUri"], "ms-settings:privacy-speech");
        // The on-device default lists only the SAPI blocker.
        for source in [SpeechSource::Microphone, SpeechSource::Push] {
            let e = select(source, &only_winrt_offline, None, &[], SpeechPreset::Long).unwrap_err();
            let reasons: Vec<&str> = e.details["blockers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b["reason"].as_str().unwrap())
                .collect();
            assert_eq!(reasons, ["desktop_recognizer_not_installed"]);
            assert_eq!(e.details["settingsUri"], "ms-settings:speech");
        }
        let nothing = Availability::default();
        let reasons: Vec<String> = blockers(&nothing)
            .iter()
            .map(|b| b.reason.to_string())
            .collect();
        assert_eq!(
            reasons,
            ["language_not_installed", "desktop_recognizer_not_installed"]
        );
    }

    #[test]
    fn locale_resolution() {
        let av = langs(&[
            "en-US", "en-GB", "fr-FR", "fr-CA", "zh-CN", "zh-TW", "de-DE", "es-MX",
        ]);
        assert_eq!(best_locale("en-GB", &av, None).as_deref(), Some("en-GB"));
        assert_eq!(best_locale("en_gb", &av, None).as_deref(), Some("en-GB"));
        assert_eq!(best_locale("en", &av, None).as_deref(), Some("en-US"));
        assert_eq!(
            best_locale("en", &av, Some("GB")).as_deref(),
            Some("en-GB"),
            "the PC's region wins for a bare tag"
        );
        assert_eq!(
            best_locale("en-AU", &av, None).as_deref(),
            Some("en-GB"),
            "same language, sorted fallback"
        );
        assert_eq!(
            best_locale("zh-Hant-TW", &av, None).as_deref(),
            Some("zh-TW")
        );
        assert_eq!(best_locale("zh-Hant", &av, None).as_deref(), Some("zh-TW"));
        assert_eq!(
            best_locale("zh-HK", &av, None).as_deref(),
            Some("zh-TW"),
            "Traditional script"
        );
        assert_eq!(best_locale("fr-BE", &av, None).as_deref(), Some("fr-CA"));
        assert_eq!(best_locale("es", &av, None).as_deref(), Some("es-MX"));
        assert_eq!(best_locale("es-419", &av, None).as_deref(), Some("es-MX"));
        assert_eq!(best_locale("ja-JP", &av, None), None);
        assert_eq!(best_locale("", &av, None), None);
    }
}
