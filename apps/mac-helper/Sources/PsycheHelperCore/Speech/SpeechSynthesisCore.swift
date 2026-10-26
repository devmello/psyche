import Foundation
import PsycheProtocol

// Voice mode V-H H2 (docs/voice/voice-mode-2026.md §5, §8): pure pieces for fast synthesis.

/// Speed multiplier → `AVSpeechUtterance.rate`. The rate scale is far from linear. Measured on
/// macOS 27.0.1 with the en-US compact voice, the duration of a fixed 18-word sentence (normal
/// speed = rate 0.5, 4.83 s):
///
/// | rate  | 0.30 | 0.40 | 0.50 | 0.52 | 0.55 | 0.58 | 0.60 | 0.65 | 0.70 |
/// | speed | 0.83 | 0.91 | 1.00 | 1.08 | 1.29 | 1.42 | 1.59 | 1.83 | 2.10 |
///
/// Below 0.35 nothing gets slower, and between 0.40 and 0.50 there are only two steps, so slow
/// speeds are approximate. Speeds in between are linearly interpolated.
public enum SpeechRate {
    public static let minSpeed = 0.5
    public static let maxSpeed = 2.0

    /// (speed, rate) points, ascending.
    static let table: [(speed: Double, rate: Double)] = [
        (0.83, 0.30), (0.91, 0.40), (1.00, 0.50), (1.08, 0.52), (1.29, 0.55),
        (1.42, 0.58), (1.59, 0.60), (1.83, 0.65), (2.10, 0.70),
    ]

    public static func utteranceRate(speed raw: Double) -> Float {
        let speed = min(maxSpeed, max(minSpeed, raw.isFinite ? raw : 1))
        guard let first = table.first, let last = table.last else { return 0.5 }
        if speed <= first.speed { return Float(first.rate) }
        if speed >= last.speed { return Float(last.rate) }
        for (a, b) in zip(table, table.dropFirst()) where speed <= b.speed {
            let t = (speed - a.speed) / (b.speed - a.speed)
            return Float(a.rate + t * (b.rate - a.rate))
        }
        return Float(last.rate)
    }
}

/// `speech.prepare` params (`HelperSpeechPrepareParams`).
public struct SpeechPrepareParams: Decodable, Sendable, Equatable {
    public var voice: String?
    public var language: String?
    public var keepWarmMs: Int?

    public init(voice: String? = nil, language: String? = nil, keepWarmMs: Int? = nil) {
        self.voice = voice
        self.language = language
        self.keepWarmMs = keepWarmMs
    }

    public static let defaultKeepWarmMs = 120_000
    public static let keepWarmRange = 1_000...600_000

    public func validated() throws -> SpeechPrepareParams {
        if let voice, voice.isEmpty || voice.count > SpeechLimits.maxVoiceIdLength {
            throw CapabilityError.invalidParams("voice must be a voice identifier from speech.voices", field: "voice")
        }
        var p = self
        p.language = try SpeechValidation.locale(language, field: "language")
        let keep = keepWarmMs ?? Self.defaultKeepWarmMs
        guard Self.keepWarmRange.contains(keep) else {
            throw CapabilityError.invalidParams("keepWarmMs must be between 1000 and 600000", field: "keepWarmMs")
        }
        p.keepWarmMs = keep
        return p
    }
}

/// Recent timings per metric; `speech.status` reports the median of the last `window`.
public final class SpeechTimings: @unchecked Sendable {
    public enum Metric: String, Sendable, CaseIterable {
        case synthesisFirstAudio
        /// Stream start → first non-empty result, per `speech.transcribe_stream` preset (H3).
        case firstPartialLong, firstPartialShort
        /// End of input → the engine's last final, per preset (H3).
        case finalizeLong, finalizeShort

        public static func firstPartial(_ p: SpeechPreset) -> Metric { p == .short ? .firstPartialShort : .firstPartialLong }
        public static func finalize(_ p: SpeechPreset) -> Metric { p == .short ? .finalizeShort : .finalizeLong }
    }

    private let lock = NSLock()
    private var samples: [Metric: [Int]] = [:]
    public let window: Int

    public init(window: Int = 20) { self.window = max(1, window) }

    public func record(_ metric: Metric, ms: Int) {
        lock.withLock {
            var xs = samples[metric] ?? []
            xs.append(max(0, ms))
            if xs.count > window { xs.removeFirst(xs.count - window) }
            samples[metric] = xs
        }
    }

    public func median(_ metric: Metric) -> Int? {
        let xs = lock.withLock { samples[metric] ?? [] }.sorted()
        guard !xs.isEmpty else { return nil }
        return xs.count % 2 == 1 ? xs[xs.count / 2] : (xs[xs.count / 2 - 1] + xs[xs.count / 2]) / 2
    }

    /// `HelperSpeechTimings`: only measured metrics appear.
    public var json: JSONValue {
        var o: [String: JSONValue] = [:]
        if let m = median(.synthesisFirstAudio) { o["synthesisFirstAudioMs"] = .int(m) }
        func pair(_ long: Metric, _ short: Metric) -> JSONValue? {
            var p: [String: JSONValue] = [:]
            if let m = median(long) { p["long"] = .int(m) }
            if let m = median(short) { p["short"] = .int(m) }
            return p.isEmpty ? nil : .object(p)
        }
        if let p = pair(.firstPartialLong, .firstPartialShort) { o["firstPartialMs"] = p }
        if let p = pair(.finalizeLong, .finalizeShort) { o["finalizeMs"] = p }
        return .object(o)
    }
}

/// Milliseconds between two `ContinuousClock` instants.
public func elapsedMs(_ from: ContinuousClock.Instant, _ to: ContinuousClock.Instant) -> Int {
    let d = to - from
    return Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
}

/// `speech.personal_voice.authorize` (voice mode V-H H4): macOS asks the owner once. After that the
/// answer stands and only System Settings changes it, so the helper never prompts again.
public enum PersonalVoiceAuth {
    public static let statuses = ["authorized", "denied", "notDetermined", "unsupported"]

    /// Prompt only while nothing has been decided.
    public static func shouldPrompt(_ status: String) -> Bool { status == "notDetermined" }

    /// `{status, prompted, settingsHint?}`.
    public static func result(status: String, prompted: Bool) -> JSONValue {
        var o: [String: JSONValue] = ["status": .string(statuses.contains(status) ? status : "unsupported"), "prompted": .bool(prompted)]
        if status == "denied" { o["settingsHint"] = "System Settings › Accessibility › Personal Voice: allow Psyche" }
        return .object(o)
    }
}
