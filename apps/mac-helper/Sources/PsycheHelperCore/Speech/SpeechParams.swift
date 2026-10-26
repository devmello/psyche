import Foundation
import PsycheProtocol

public enum SpeechSource: String, Codable, Sendable, CaseIterable {
    case microphone
    case push
}

/// Limits shared by the speech capabilities (documented in the README section).
public enum SpeechLimits {
    public static let maxVocabularyEntries = 100
    public static let maxVocabularyEntryLength = 64
    public static let maxDurationMs = 10 * 60 * 1000
    public static let defaultMaxDurationMs = 5 * 60 * 1000
    public static let minDurationMs = 1000
    public static let maxSynthesisTextLength = 5000
    public static let maxStreamIdLength = 128
    public static let maxUtteranceIdLength = 64
    public static let maxVoiceIdLength = 256
    /// Decoded bytes per `speech.audio_push` (its base64 stays well under the 1 MiB frame limit).
    public static let maxPushBytes = 512 * 1024
    /// Unconsumed pushed bytes held per stream before pushes are refused (backpressure).
    public static let pushBufferLimitBytes = 8 * 1024 * 1024
    public static let maxConcurrentStreams = 4
}

public enum SpeechValidation {
    /// BCP-47-ish: a 2–3 letter language subtag followed by 2–8 character alphanumeric subtags,
    /// separated by `-` or `_` (`en`, `en-US`, `zh-Hant-TW`, `en_GB`). At most 35 characters.
    public static func isValidLocaleIdentifier(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 35 else { return false }
        let parts = id.split(separator: "-", omittingEmptySubsequences: false)
            .flatMap { $0.split(separator: "_", omittingEmptySubsequences: false) }
        guard let first = parts.first, (2...3).contains(first.count), first.allSatisfy({ $0.isASCII && $0.isLetter }) else { return false }
        return parts.dropFirst().allSatisfy { p in (2...8).contains(p.count) && p.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) } }
    }

    public static func locale(_ id: String?, field: String = "locale") throws -> String? {
        guard let id else { return nil }
        guard isValidLocaleIdentifier(id) else {
            throw CapabilityError.invalidParams("\(field) must be a BCP-47 language tag such as en-US", field: field)
        }
        return id
    }

    /// Trims, drops duplicates (keeping order) and enforces ≤ 100 entries × 64 characters.
    public static func vocabulary(_ entries: [String]?) throws -> [String] {
        guard let entries else { return [] }
        guard entries.count <= SpeechLimits.maxVocabularyEntries else {
            throw CapabilityError.invalidParams("vocabulary holds at most \(SpeechLimits.maxVocabularyEntries) entries", field: "vocabulary")
        }
        var seen = Set<String>()
        var out: [String] = []
        for (i, raw) in entries.enumerated() {
            let entry = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !entry.isEmpty, entry.count <= SpeechLimits.maxVocabularyEntryLength else {
                throw CapabilityError.invalidParams(
                    "vocabulary entries must be 1–\(SpeechLimits.maxVocabularyEntryLength) characters", field: "vocabulary.\(i)")
            }
            if seen.insert(entry).inserted { out.append(entry) }
        }
        return out
    }

    public static func streamId(_ id: String) throws -> String {
        guard !id.isEmpty, id.count <= SpeechLimits.maxStreamIdLength else {
            throw CapabilityError.invalidParams("streamId must be 1–\(SpeechLimits.maxStreamIdLength) characters", field: "streamId")
        }
        return id
    }
}

// MARK: - speech.transcribe_stream

/// Raw `speech.transcribe_stream` params; `validated()` applies defaults and limits.
public struct TranscribeStreamParams: Decodable, Sendable, Equatable {
    public var source: SpeechSource
    public var locale: String?
    public var vocabulary: [String]?
    public var format: PCMAudioFormat?
    public var maxDurationMs: Int?
    public var volatile: Bool

    public init(source: SpeechSource = .microphone, locale: String? = nil, vocabulary: [String]? = nil, format: PCMAudioFormat? = nil, maxDurationMs: Int? = nil, volatile: Bool = true) {
        self.source = source
        self.locale = locale
        self.vocabulary = vocabulary
        self.format = format
        self.maxDurationMs = maxDurationMs
        self.volatile = volatile
    }

    enum CodingKeys: String, CodingKey { case source, locale, vocabulary, format, maxDurationMs, volatile }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(SpeechSource.self, forKey: .source) ?? .microphone
        locale = try c.decodeIfPresent(String.self, forKey: .locale)
        vocabulary = try c.decodeIfPresent([String].self, forKey: .vocabulary)
        format = try c.decodeIfPresent(PCMAudioFormat.self, forKey: .format)
        maxDurationMs = try c.decodeIfPresent(Int.self, forKey: .maxDurationMs)
        volatile = try c.decodeIfPresent(Bool.self, forKey: .volatile) ?? true
    }

    public func validated() throws -> TranscribeRequest {
        let locale = try SpeechValidation.locale(locale)
        let vocabulary = try SpeechValidation.vocabulary(vocabulary)
        let maxDuration = maxDurationMs ?? SpeechLimits.defaultMaxDurationMs
        guard (SpeechLimits.minDurationMs...SpeechLimits.maxDurationMs).contains(maxDuration) else {
            throw CapabilityError.invalidParams(
                "maxDurationMs must be between \(SpeechLimits.minDurationMs) and \(SpeechLimits.maxDurationMs)", field: "maxDurationMs")
        }
        switch source {
        case .microphone:
            guard format == nil else {
                throw CapabilityError.invalidParams("format applies to source \"push\" only", field: "format")
            }
        case .push:
            guard let format else {
                throw CapabilityError.invalidParams("source \"push\" needs format {encoding, sampleRate, channels}", field: "format")
            }
            try format.validate()
        }
        return TranscribeRequest(source: source, locale: locale, vocabulary: vocabulary, format: format, maxDurationMs: maxDuration, volatile: volatile)
    }
}

/// Validated, defaulted `speech.transcribe_stream` request.
public struct TranscribeRequest: Sendable, Equatable {
    public var source: SpeechSource
    public var locale: String?
    public var vocabulary: [String]
    public var format: PCMAudioFormat?
    public var maxDurationMs: Int
    public var volatile: Bool

    public init(source: SpeechSource, locale: String?, vocabulary: [String], format: PCMAudioFormat?, maxDurationMs: Int, volatile: Bool) {
        self.source = source
        self.locale = locale
        self.vocabulary = vocabulary
        self.format = format
        self.maxDurationMs = maxDurationMs
        self.volatile = volatile
    }
}

// MARK: - speech.audio_push / speech.stop

public struct AudioPushParams: Decodable, Sendable, Equatable {
    public var streamId: String
    public var data: String
    public var final: Bool?

    public init(streamId: String, data: String, final: Bool? = nil) {
        self.streamId = streamId
        self.data = data
        self.final = final
    }

    /// Returns the stream id and the decoded audio bytes.
    public func validated() throws -> (streamId: String, audio: Data, final: Bool) {
        let id = try SpeechValidation.streamId(streamId)
        // Base64 length bounds the decoded size; check before decoding.
        guard data.utf8.count <= (SpeechLimits.maxPushBytes + 2) / 3 * 4 else {
            throw CapabilityError.invalidParams("data holds at most \(SpeechLimits.maxPushBytes) bytes per push", field: "data")
        }
        guard let audio = Data(base64Encoded: data) else {
            throw CapabilityError.invalidParams("data must be base64", field: "data")
        }
        return (id, audio, final ?? false)
    }
}

public struct StreamIdParams: Decodable, Sendable, Equatable {
    public var streamId: String

    public init(streamId: String) {
        self.streamId = streamId
    }

    public func validated() throws -> String { try SpeechValidation.streamId(streamId) }
}

// MARK: - speech.synthesize

public struct SynthesizeParams: Decodable, Sendable, Equatable {
    public var text: String
    public var voice: String?
    /// 0 (slowest) … 1 (fastest); 0.5 is the system default rate.
    public var rate: Double?
    /// Multiplier of the voice's normal speed (0.5–2); wins over `rate` (voice mode V-H H2).
    public var speed: Double?
    public var personalVoice: Bool
    public var format: PCMEncoding
    /// Echoed on every `speech.audio` event, so the Gateway can match audio to its sentence.
    public var utteranceId: String?

    public init(text: String, voice: String? = nil, rate: Double? = nil, speed: Double? = nil, personalVoice: Bool = false,
                format: PCMEncoding = .pcmS16le, utteranceId: String? = nil) {
        self.text = text
        self.voice = voice
        self.rate = rate
        self.speed = speed
        self.personalVoice = personalVoice
        self.format = format
        self.utteranceId = utteranceId
    }

    enum CodingKeys: String, CodingKey { case text, voice, rate, speed, personalVoice, format, utteranceId }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        text = try c.decode(String.self, forKey: .text)
        voice = try c.decodeIfPresent(String.self, forKey: .voice)
        rate = try c.decodeIfPresent(Double.self, forKey: .rate)
        speed = try c.decodeIfPresent(Double.self, forKey: .speed)
        personalVoice = try c.decodeIfPresent(Bool.self, forKey: .personalVoice) ?? false
        format = try c.decodeIfPresent(PCMEncoding.self, forKey: .format) ?? .pcmS16le
        utteranceId = try c.decodeIfPresent(String.self, forKey: .utteranceId)
    }

    public func validated() throws -> SynthesizeParams {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CapabilityError.invalidParams("text must not be empty", field: "text")
        }
        guard text.count <= SpeechLimits.maxSynthesisTextLength else {
            throw CapabilityError.invalidParams("text holds at most \(SpeechLimits.maxSynthesisTextLength) characters", field: "text")
        }
        if let voice, voice.isEmpty || voice.count > SpeechLimits.maxVoiceIdLength {
            throw CapabilityError.invalidParams("voice must be a voice identifier from speech.voices", field: "voice")
        }
        if let rate, !(0...1).contains(rate) {
            throw CapabilityError.invalidParams("rate must be between 0 and 1", field: "rate")
        }
        if let speed, !(SpeechRate.minSpeed...SpeechRate.maxSpeed).contains(speed) {
            throw CapabilityError.invalidParams("speed must be between \(SpeechRate.minSpeed) and \(SpeechRate.maxSpeed)", field: "speed")
        }
        if let utteranceId, utteranceId.isEmpty || utteranceId.count > SpeechLimits.maxUtteranceIdLength {
            throw CapabilityError.invalidParams("utteranceId is 1–\(SpeechLimits.maxUtteranceIdLength) characters", field: "utteranceId")
        }
        return self
    }

    /// The `AVSpeechUtterance.rate` to use: from `speed` when given, else from `rate` (0…1 across
    /// the system range), else nil (the voice's default).
    public func utteranceRate(min lo: Float, max hi: Float) -> Float? {
        if let speed { return SpeechRate.utteranceRate(speed: speed) }
        if let rate { return lo + Float(rate) * (hi - lo) }
        return nil
    }
}
