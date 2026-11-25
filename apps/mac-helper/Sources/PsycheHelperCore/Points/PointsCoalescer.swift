import Foundation

/// Work the coalescer says is due.
public enum PointsWork: Equatable, Sendable {
    /// A full re-read of the window.
    case fullRead
    /// A focused field's value stopped changing for 300 ms: send filled or empty (no value).
    case valueSettled(fieldId: String)
    /// Re-read the frames of the fields the overlay watches (after a scroll or a move).
    case frames
}

/// Change coalescing for the notification table of §3.2, pure and driven by a clock the caller
/// passes in (seconds, monotonic), so the numbers are tested without sleeping:
///
/// - value changes: coalesced for 300 ms per field (a trailing debounce);
/// - layout, title, load and destroy notifications: debounced for 400 ms (at most 2 s after the
///   first one, so a page that never stops changing is still read), then ONE full re-read;
/// - at most 2 full re-reads a second, whatever asks;
/// - scroll and move: at most 30 frame re-reads a second, the first one at once.
///
/// It owns no timer. `nextDeadline` says when the caller's one-shot timer should fire; nothing is
/// scheduled while nothing is pending, so an idle session has no wakeups.
public struct PointsCoalescer: Sendable {
    public static let valueDelay: Double = 0.3
    public static let layoutDelay: Double = 0.4
    public static let layoutMaxWait: Double = 2.0
    public static let minFullReadGap: Double = 0.5
    public static let minFramesGap: Double = 1.0 / 30.0

    private var layoutFirst: Double?
    private var layoutLast: Double?
    private var lastFullRead: Double = -.infinity
    private var valueDue: [String: Double] = [:]
    private var framesPending = false
    private var lastFrames: Double = -.infinity

    public init() {}

    public mutating func layoutChanged(at now: Double) {
        if layoutFirst == nil { layoutFirst = now }
        layoutLast = now
    }

    public mutating func valueChanged(fieldId: String, at now: Double) { valueDue[fieldId] = now + Self.valueDelay }

    public mutating func scrolled(at now: Double) { framesPending = true; _ = now }

    /// Forget a field's pending value change (focus left it and the commit was read).
    public mutating func cancelValue(fieldId: String) { valueDue[fieldId] = nil }

    private var fullReadDue: Double? {
        guard let first = layoutFirst, let last = layoutLast else { return nil }
        return max(min(last + Self.layoutDelay, first + Self.layoutMaxWait), lastFullRead + Self.minFullReadGap)
    }

    private var framesDue: Double? { framesPending ? lastFrames + Self.minFramesGap : nil }

    /// When the next piece of work comes due, or nil when nothing is pending.
    public var nextDeadline: Double? {
        [fullReadDue, framesDue, valueDue.values.min()].compactMap { $0 }.min()
    }

    /// Takes the work due at `now` (each kind at most once).
    public mutating func due(at now: Double) -> [PointsWork] {
        var out: [PointsWork] = []
        if let d = fullReadDue, d <= now {
            out.append(.fullRead)
            layoutFirst = nil
            layoutLast = nil
            lastFullRead = now
        }
        for (id, d) in valueDue.sorted(by: { $0.key < $1.key }) where d <= now {
            out.append(.valueSettled(fieldId: id))
            valueDue[id] = nil
        }
        if let d = framesDue, d <= now {
            out.append(.frames)
            framesPending = false
            lastFrames = now
        }
        return out
    }
}
