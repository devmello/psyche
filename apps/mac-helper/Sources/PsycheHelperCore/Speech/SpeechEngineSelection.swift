import Foundation
import PsycheProtocol

/// On-device transcription engines (ADR-014, ADR-016).
///
/// - `speechAnalyzer`: `SpeechAnalyzer` + `SpeechTranscriber` (macOS 26+). Long-form, volatile and
///   final results, system-managed models.
/// - `dictationTranscriber`: `SpeechAnalyzer` + `DictationTranscriber` (macOS 26+), chosen when the
///   caller passes a custom vocabulary (fed as `AnalysisContext.contextualStrings`).
/// - `sfSpeech`: `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. Interim engine on macOS 15
///   until spike 03 picks FluidAudio Parakeet or WhisperKit; also the fallback on 26+ when the
///   analyzer does not support the requested locale.
public enum SpeechEngineKind: String, Codable, Sendable, CaseIterable {
    case speechAnalyzer
    case dictationTranscriber
    case sfSpeech
}

/// What the running system can do for one request's locale (filled by PsycheHelperSystem).
public struct SpeechEngineAvailability: Sendable, Equatable {
    /// `SpeechTranscriber` is available and supports the locale (only ever true on macOS 26+).
    public var speechTranscriber: Bool
    /// `DictationTranscriber` supports the locale (only ever true on macOS 26+).
    public var dictationTranscriber: Bool
    /// `SFSpeechRecognizer` exists for the locale and supports on-device recognition.
    public var sfSpeechOnDevice: Bool

    public init(speechTranscriber: Bool, dictationTranscriber: Bool, sfSpeechOnDevice: Bool) {
        self.speechTranscriber = speechTranscriber
        self.dictationTranscriber = dictationTranscriber
        self.sfSpeechOnDevice = sfSpeechOnDevice
    }
}

public enum SpeechEngineSelector {
    /// ADR-016: macOS 26 unlocks SpeechAnalyzer.
    public static let analyzerMinimumMajorVersion = 26

    public static func analyzerGateOpen(_ os: OperatingSystemVersion) -> Bool {
        os.majorVersion >= analyzerMinimumMajorVersion
    }

    /// Picks the engine: `dictationTranscriber` on 26+ when a vocabulary is given, `speechAnalyzer`
    /// on 26+, `sfSpeech` otherwise; each step falls through when its engine cannot serve the locale.
    public static func select(os: OperatingSystemVersion, vocabulary: [String], availability: SpeechEngineAvailability) throws -> SpeechEngineKind {
        let gate = analyzerGateOpen(os)
        if gate, !vocabulary.isEmpty, availability.dictationTranscriber { return .dictationTranscriber }
        if gate, availability.speechTranscriber { return .speechAnalyzer }
        if gate, availability.dictationTranscriber { return .dictationTranscriber }
        if availability.sfSpeechOnDevice { return .sfSpeech }
        throw CapabilityError.unavailable(
            "no_speech_engine", "No on-device speech engine supports this locale on this Mac")
    }
}
