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
    public static let maxStreamIdLength = 128
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

/// `long`: dictation and memos (the default). `short`: conversation turns of about a minute or
/// less: DictationTranscriber with the short-form hint and frequent finalization, as Apple's
/// `progressiveShortDictation` preset (voice mode V-H H3).
public enum SpeechPreset: String, Codable, Sendable, CaseIterable {
    case long
    case short
}

/// Raw `speech.transcribe_stream` params; `validated()` applies defaults and limits.
public struct TranscribeStreamParams: Decodable, Sendable, Equatable {
    public var source: SpeechSource
    public var locale: String?
    public var vocabulary: [String]?
    public var format: PCMAudioFormat?
    public var maxDurationMs: Int?
    public var volatile: Bool
    public var preset: SpeechPreset

    public init(source: SpeechSource = .microphone, locale: String? = nil, vocabulary: [String]? = nil, format: PCMAudioFormat? = nil, maxDurationMs: Int? = nil,
                volatile: Bool = true, preset: SpeechPreset = .long) {
        self.source = source
        self.locale = locale
        self.vocabulary = vocabulary
        self.format = format
        self.maxDurationMs = maxDurationMs
        self.volatile = volatile
        self.preset = preset
    }

    enum CodingKeys: String, CodingKey { case source, locale, vocabulary, format, maxDurationMs, volatile, preset }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        source = try c.decodeIfPresent(SpeechSource.self, forKey: .source) ?? .microphone
        locale = try c.decodeIfPresent(String.self, forKey: .locale)
        vocabulary = try c.decodeIfPresent([String].self, forKey: .vocabulary)
        format = try c.decodeIfPresent(PCMAudioFormat.self, forKey: .format)
        maxDurationMs = try c.decodeIfPresent(Int.self, forKey: .maxDurationMs)
        volatile = try c.decodeIfPresent(Bool.self, forKey: .volatile) ?? true
        preset = try c.decodeIfPresent(SpeechPreset.self, forKey: .preset) ?? .long
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
        return TranscribeRequest(source: source, locale: locale, vocabulary: vocabulary, format: format, maxDurationMs: maxDuration, volatile: volatile, preset: preset)
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
    public var preset: SpeechPreset

    public init(source: SpeechSource, locale: String?, vocabulary: [String], format: PCMAudioFormat?, maxDurationMs: Int, volatile: Bool, preset: SpeechPreset = .long) {
        self.source = source
        self.locale = locale
        self.vocabulary = vocabulary
        self.format = format
        self.maxDurationMs = maxDurationMs
        self.volatile = volatile
        self.preset = preset
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
