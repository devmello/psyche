import Foundation
import Testing

@testable import PsycheClient

/// Same-day wire times keep the day period in 12-hour locales. No network, no prompt.
struct WireFormatTests {
    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    /// 15:12 UTC on 2026-11-26, the same moment as `now`, so the time is "today".
    private static let text = "2026-11-26T15:12:00Z"
    private static let now = ISO8601DateFormatter().date(from: text)!

    @Test func sameDayTimeKeepsAMPMInTwelveHourLocale() {
        let out = WireFormat.time(
            Self.text, now: Self.now, calendar: Self.utc, locale: Locale(identifier: "en_US"))
        #expect(out.contains("AM") || out.contains("PM"), "en_US same-day time lost AM/PM: \(out)")
    }

    @Test func sameDayTimeOmitsAMPMInTwentyFourHourLocale() {
        let out = WireFormat.time(
            Self.text, now: Self.now, calendar: Self.utc, locale: Locale(identifier: "de_DE"))
        #expect(!out.contains("AM") && !out.contains("PM"), "de_DE shows a day period: \(out)")
        #expect(out.contains(":"), "de_DE time has no clock separator: \(out)")
    }
}
