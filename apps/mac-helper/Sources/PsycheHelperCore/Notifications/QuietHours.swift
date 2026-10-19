import Foundation

/// A daily quiet-hours window. `start` is inclusive and `end` exclusive, both minutes after local
/// midnight. When `end <= start` the window wraps past midnight (22:00–07:00). `start == end` is an
/// empty window (quiet hours effectively off).
public struct QuietHours: Sendable, Equatable {
    public var startMinute: Int
    public var endMinute: Int

    public init(startMinute: Int, endMinute: Int) {
        self.startMinute = startMinute
        self.endMinute = endMinute
    }

    /// Parses `"HH:mm"` (24-hour, two digits each). Returns nil for anything else.
    public init?(start: String, end: String) {
        guard let s = QuietHours.parse(start), let e = QuietHours.parse(end) else { return nil }
        self.init(startMinute: s, endMinute: e)
    }

    public static func parse(_ text: String) -> Int? {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2,
            parts[0].utf8.allSatisfy({ (0x30...0x39).contains($0) }), parts[1].utf8.allSatisfy({ (0x30...0x39).contains($0) }),
            let h = Int(parts[0]), let m = Int(parts[1]),
            (0...23).contains(h), (0...59).contains(m)
        else { return nil }
        return h * 60 + m
    }

    public var isEmpty: Bool { startMinute == endMinute }

    /// Whether minute-of-day `minute` falls inside the window.
    public func contains(minuteOfDay minute: Int) -> Bool {
        if startMinute == endMinute { return false }
        if startMinute < endMinute { return minute >= startMinute && minute < endMinute }
        return minute >= startMinute || minute < endMinute
    }

    /// Whether `date` falls inside the window, reading the wall clock in `calendar`'s time zone.
    public func contains(_ date: Date, calendar: Calendar) -> Bool {
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return contains(minuteOfDay: (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }
}
