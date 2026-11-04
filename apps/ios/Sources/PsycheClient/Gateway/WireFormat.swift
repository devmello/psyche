import Foundation

/// How wire values read on the phone: "9:12" times, "Yesterday", "1 min".
enum WireFormat {
    static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        if let d = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }

    /// Today: "9:12". Earlier this week: "Tue". Otherwise "Mar 4".
    static func time(_ text: String?, now: Date = .now, calendar: Calendar = .current) -> String {
        guard let date = date(text) else { return "" }
        if calendar.isDate(date, inSameDayAs: now) {
            return date.formatted(.dateTime.hour(.defaultDigits(amPM: .omitted)).minute())
        }
        if let days = calendar.dateComponents([.day], from: date, to: now).day, days >= 0, days < 6 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    /// "4 min", "2 h": how long ago `text` was.
    static func elapsed(since text: String?, now: Date = .now) -> String {
        guard let date = date(text) else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60) min" }
        if seconds < 86_400 { return "\(seconds / 3600) h" }
        return "\(seconds / 86_400) d"
    }
}
