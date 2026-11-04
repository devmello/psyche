import Foundation

/// Jittered exponential backoff, 0.5 s doubling to 30 s (companion §2.3). The jitter takes up to a
/// quarter off, so many phones coming back at once do not line up.
public struct Backoff: Sendable {
    public var base: Double
    public var cap: Double
    public var random: @Sendable () -> Double  // in [0, 1)

    public init(base: Double = 0.5, cap: Double = 30, random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }) {
        self.base = base
        self.cap = cap
        self.random = random
    }

    /// The wait before attempt `attempt` (0 is the first retry), in seconds.
    public func delay(attempt: Int) -> Double {
        let nominal = min(cap, base * pow(2, Double(min(attempt, 20))))
        return nominal * (1 - 0.25 * random())
    }
}
