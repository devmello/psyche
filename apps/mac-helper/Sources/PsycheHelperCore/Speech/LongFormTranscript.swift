import Foundation
import PsycheProtocol

// Long-form file transcription (`speech.transcribe_file`, docs/workflows/mail-and-meetings-2026.md
// §8.4; #673 H1): pure pieces. The file is read in chunks of about 10 minutes, each with a short
// overlap on both sides, so a phrase cut at a chunk edge is heard whole by the neighbour. The
// merger keeps each phrase once. The engine and file reading are in PsycheHelperSystem.

public enum LongFormLimits {
    /// 4 hours (`SPEECH_FILE_MAX_DURATION_MS`).
    public static let maxDurationMs = 4 * 60 * 60 * 1000
    public static let chunkMs = 10 * 60 * 1000
    /// Audio read past each chunk boundary (on both sides).
    public static let overlapMs = 10 * 1000
    public static let maxPathLength = 4096
}

/// `speech.transcribe_file` params (`SpeechTranscribeFileParams`).
public struct TranscribeFileParams: Decodable, Sendable, Equatable {
    public var path: String
    public var locale: String?
    public var vocabulary: [String]?
    public var maxDurationMs: Int?

    public init(path: String, locale: String? = nil, vocabulary: [String]? = nil, maxDurationMs: Int? = nil) {
        self.path = path
        self.locale = locale
        self.vocabulary = vocabulary
        self.maxDurationMs = maxDurationMs
    }

    public func validated() throws -> TranscribeFileRequest {
        guard !path.isEmpty, path.count <= LongFormLimits.maxPathLength else {
            throw CapabilityError.invalidParams("path is 1–\(LongFormLimits.maxPathLength) characters", field: "path")
        }
        let maxDuration = maxDurationMs ?? LongFormLimits.maxDurationMs
        guard (SpeechLimits.minDurationMs...LongFormLimits.maxDurationMs).contains(maxDuration) else {
            throw CapabilityError.invalidParams(
                "maxDurationMs must be between \(SpeechLimits.minDurationMs) and \(LongFormLimits.maxDurationMs)", field: "maxDurationMs")
        }
        return TranscribeFileRequest(
            path: path, locale: try SpeechValidation.locale(locale), vocabulary: try SpeechValidation.vocabulary(vocabulary), maxDurationMs: maxDuration)
    }
}

public struct TranscribeFileRequest: Sendable, Equatable {
    public var path: String
    public var locale: String?
    public var vocabulary: [String]
    public var maxDurationMs: Int

    public init(path: String, locale: String?, vocabulary: [String], maxDurationMs: Int) {
        self.path = path
        self.locale = locale
        self.vocabulary = vocabulary
        self.maxDurationMs = maxDurationMs
    }

    /// The chunk engine request: final results only, from a file.
    public var engineRequest: TranscribeRequest {
        TranscribeRequest(source: .push, locale: locale, vocabulary: vocabulary, format: nil, maxDurationMs: LongFormLimits.chunkMs + 2 * LongFormLimits.overlapMs, volatile: false)
    }

    /// Refuses a file longer than `maxDurationMs` before any audio is read.
    public func checkDuration(audioMs: Int) throws {
        guard audioMs <= maxDurationMs else {
            throw CapabilityError(
                .invalidParams, reason: "too_long",
                "The recording is \(LongFormFormat.duration(audioMs)); transcription takes recordings up to \(LongFormFormat.duration(maxDurationMs)).",
                details: ["audioMs": .int(audioMs), "maxDurationMs": .int(maxDurationMs)])
        }
    }
}

enum LongFormFormat {
    /// `3 h 05 min`, `52 min`, `40 s`.
    static func duration(_ ms: Int) -> String {
        let s = max(0, ms) / 1000
        if s < 60 { return "\(s) s" }
        let m = s / 60
        return m < 60 ? "\(m) min" : String(format: "%d h %02d min", m / 60, m % 60)
    }
}

/// One chunk: the audio read (`readFromMs..<readToMs`) and the part whose phrases it owns
/// (`keepFromMs..<keepToMs`). Keep ranges tile the file without gaps.
public struct LongFormChunk: Sendable, Equatable {
    public var index: Int
    public var readFromMs: Int
    public var readToMs: Int
    public var keepFromMs: Int
    public var keepToMs: Int

    public init(index: Int, readFromMs: Int, readToMs: Int, keepFromMs: Int, keepToMs: Int) {
        self.index = index
        self.readFromMs = readFromMs
        self.readToMs = readToMs
        self.keepFromMs = keepFromMs
        self.keepToMs = keepToMs
    }
}

public enum LongFormChunkPlanner {
    /// Chunks of `chunkMs` with `overlapMs` read past each inner boundary. A short tail (under a
    /// quarter chunk) folds into the previous chunk instead of becoming its own.
    public static func plan(audioMs: Int, chunkMs: Int = LongFormLimits.chunkMs, overlapMs: Int = LongFormLimits.overlapMs) -> [LongFormChunk] {
        let total = max(0, audioMs)
        let size = max(1, chunkMs)
        guard total > 0 else { return [LongFormChunk(index: 0, readFromMs: 0, readToMs: 0, keepFromMs: 0, keepToMs: 0)] }
        var boundaries = Array(stride(from: 0, to: total, by: size))
        if boundaries.count > 1, let last = boundaries.last, total - last < size / 4 { boundaries.removeLast() }
        let overlap = max(0, overlapMs)
        return boundaries.enumerated().map { i, start in
            let end = i + 1 < boundaries.count ? boundaries[i + 1] : total
            return LongFormChunk(
                index: i, readFromMs: max(0, start - overlap), readToMs: min(total, end + overlap), keepFromMs: start, keepToMs: end)
        }
    }
}

/// Folds per-chunk segments (times relative to the chunk's `readFromMs`) into one transcript with
/// file times. A chunk keeps the segments whose midpoint is in its keep range (the last chunk also
/// keeps its end). A segment that still overlaps the previous one in time is the same phrase heard
/// by both chunks: the longer text wins.
public struct LongFormMerger: Sendable, Equatable {
    public private(set) var segments: [SpeechSegment] = []
    public private(set) var chunksAdded = 0

    public init() {}

    public mutating func add(_ chunk: LongFormChunk, segments raw: [SpeechSegment], isLast: Bool) {
        chunksAdded += 1
        let shifted = raw
            .filter { $0.final && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .map { SpeechSegment(text: $0.text, startMs: $0.startMs + chunk.readFromMs, endMs: $0.endMs + chunk.readFromMs, final: true, confidence: $0.confidence) }
            .sorted { $0.startMs < $1.startMs }
        for s in shifted {
            let mid = (s.startMs + s.endMs) / 2
            guard mid >= chunk.keepFromMs, mid < chunk.keepToMs || (isLast && mid <= chunk.keepToMs) else { continue }
            if let last = segments.last, Self.samePhrase(last, s) {
                if Self.words(s.text) > Self.words(last.text) { segments[segments.count - 1] = s }
                continue
            }
            segments.append(s)
        }
    }

    /// More than half of the shorter segment overlaps the other.
    static func samePhrase(_ a: SpeechSegment, _ b: SpeechSegment) -> Bool {
        let overlap = min(a.endMs, b.endMs) - max(a.startMs, b.startMs)
        let shorter = min(a.endMs - a.startMs, b.endMs - b.startMs)
        return overlap > 0 && overlap * 2 > shorter
    }

    static func words(_ s: String) -> Int { s.split(whereSeparator: \.isWhitespace).count }

    public var text: String {
        segments.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.joined(separator: " ")
    }

    /// `SpeechTranscribeFileResult`.
    public func result(engine: SpeechEngineKind, language: String, audioMs: Int) -> JSONValue {
        [
            "text": .string(text),
            "segments": .array(segments.map(\.json)),
            "engine": .string(engine.rawValue),
            "language": .string(language),
            "audioMs": .int(audioMs),
            "chunks": .int(max(1, chunksAdded)),
        ]
    }
}

extension SpeechEvent {
    public static let progress = "speech.progress"

    /// `{type: "speech.progress", processedMs, totalMs, fraction, chunk, chunks}` (`SpeechProgressEvent`).
    public static func progress(processedMs: Int, totalMs: Int, chunk: Int, chunks: Int) -> JSONValue {
        let done = min(max(0, processedMs), max(0, totalMs))
        let fraction = totalMs > 0 ? Double(done) / Double(totalMs) : 1
        return [
            "type": .string(progress), "processedMs": .int(done), "totalMs": .int(max(0, totalMs)),
            "fraction": .number((fraction * 1000).rounded() / 1000), "chunk": .int(chunk), "chunks": .int(max(1, chunks)),
        ]
    }
}
