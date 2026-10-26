import Foundation
import PsycheProtocol

/// One transcript segment; wire shape `SpeechSegment` in packages/protocol SpeechEngine.ts.
/// `final == false` is a volatile partial that a later segment replaces.
public struct SpeechSegment: Codable, Sendable, Equatable {
    public var text: String
    public var startMs: Int
    public var endMs: Int
    public var final: Bool
    public var confidence: Double?

    public init(text: String, startMs: Int, endMs: Int, final: Bool, confidence: Double? = nil) {
        self.text = text
        self.startMs = startMs
        self.endMs = max(startMs, endMs)
        self.final = final
        self.confidence = confidence
    }

    /// Builds a segment from seconds (framework time ranges), clamping negatives and NaN to zero.
    public init(text: String, startSeconds: Double, endSeconds: Double, final: Bool, confidence: Double? = nil) {
        func ms(_ s: Double) -> Int { s.isFinite && s > 0 ? Int((s * 1000).rounded()) : 0 }
        self.init(text: text, startMs: ms(startSeconds), endMs: ms(endSeconds), final: final, confidence: confidence)
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "text": .string(text), "startMs": .int(startMs), "endMs": .int(endMs), "final": .bool(final),
        ]
        if let confidence, confidence.isFinite { o["confidence"] = .number(min(1, max(0, confidence))) }
        return .object(o)
    }
}

/// Why a transcription stream ended normally.
public enum SpeechStopReason: String, Sendable, Equatable {
    /// `speech.stop` (or the invocation was cancelled and finalized what it had).
    case stopped
    /// A push stream received `final: true`, or the microphone went away.
    case endOfInput = "end_of_input"
    /// `maxDurationMs` of audio was consumed.
    case maxDuration = "max_duration"
}

/// Event payloads streamed as `node.event` data for the `speech.*` capabilities.
public enum SpeechEvent {
    public static let partial = "speech.partial"
    public static let final = "speech.final"
    public static let started = "speech.started"
    public static let modelDownload = "speech.model_download"
    public static let audio = "speech.audio"

    /// `{type: "speech.partial"|"speech.final", text, startMs, endMs, final, confidence?}`.
    public static func segment(_ s: SpeechSegment) -> JSONValue {
        guard case .object(var o) = s.json else { return .null }
        o["type"] = .string(s.final ? final : partial)
        return .object(o)
    }

    /// Emitted once the engine is ready and the source is live (push audio is accepted earlier and buffered).
    public static func started(streamId: String, engine: SpeechEngineKind, language: String, source: SpeechSource, format: PCMAudioFormat?) -> JSONValue {
        var o: [String: JSONValue] = [
            "type": .string(started), "streamId": .string(streamId), "engine": .string(engine.rawValue),
            "language": .string(language), "source": .string(source.rawValue),
        ]
        if let format { o["format"] = format.json }
        return .object(o)
    }

    public enum DownloadPhase: String, Sendable {
        case started, progress, finished
    }

    /// `{type: "speech.model_download", phase, locale, fraction}` while system speech assets install.
    public static func modelDownload(phase: DownloadPhase, locale: String, fraction: Double) -> JSONValue {
        let f = fraction.isFinite ? min(1, max(0, fraction)) : 0
        return ["type": .string(modelDownload), "phase": .string(phase.rawValue), "locale": .string(locale), "fraction": .number((f * 1000).rounded() / 1000)]
    }

    /// `{type: "speech.audio", seq, data (base64), format, utteranceId?}`.
    public static func audio(seq: Int, data: Data, format: PCMAudioFormat, utteranceId: String? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["type": .string(audio), "seq": .int(seq), "data": .string(data.base64EncodedString()), "format": format.json]
        if let utteranceId { o["utteranceId"] = .string(utteranceId) }
        return .object(o)
    }
}

/// Folds a stream of volatile and final segments into the transcript. A final segment is kept and
/// clears the pending volatile one; a volatile segment replaces the previous volatile one.
public struct TranscriptAccumulator: Sendable, Equatable {
    public private(set) var finals: [SpeechSegment] = []
    public private(set) var volatile: SpeechSegment?

    public init() {}

    public mutating func ingest(_ segment: SpeechSegment) {
        let empty = segment.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if segment.final {
            volatile = nil
            if !empty { finals.append(segment) }
        } else {
            volatile = empty ? nil : segment
        }
    }

    /// Keeps a trailing volatile segment as final (an engine ended without finalizing it).
    public mutating func promoteVolatile() {
        guard var v = volatile else { return }
        v.final = true
        finals.append(v)
        volatile = nil
    }

    public var text: String {
        finals.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: " ")
    }

    /// The terminal result of `speech.transcribe_stream`:
    /// `{streamId, text, segments, engine, language, stopReason, audioMs, firstResultMs?}`.
    public func summary(streamId: String, engine: SpeechEngineKind, language: String, stopReason: SpeechStopReason, audioMs: Int, firstResultMs: Int?) -> JSONValue {
        var o: [String: JSONValue] = [
            "streamId": .string(streamId),
            "text": .string(text),
            "segments": .array(finals.map(\.json)),
            "engine": .string(engine.rawValue),
            "language": .string(language),
            "stopReason": .string(stopReason.rawValue),
            "audioMs": .int(audioMs),
        ]
        if let firstResultMs { o["firstResultMs"] = .int(firstResultMs) }
        return .object(o)
    }
}
