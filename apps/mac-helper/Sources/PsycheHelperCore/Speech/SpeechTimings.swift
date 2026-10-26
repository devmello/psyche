import Foundation
import PsycheProtocol

/// Recent timings per metric; `speech.status` reports the median of the last `window`.
public final class SpeechTimings: @unchecked Sendable {
    public enum Metric: String, Sendable, CaseIterable {
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
