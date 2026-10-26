import Foundation
import PsycheHelperCore
import Testing

/// #626: what `mail.search`'s filters become as AppleScript handler arguments.
struct MailSearchFilterTests {
    let utc = TimeZone(identifier: "UTC")!

    @Test func readStatusCoversUnreadReadAndBoth() {
        #expect(MailSearchFilter(unread: true).readStatus == ("false", "false"))
        #expect(MailSearchFilter(unread: false).readStatus == ("true", "true"))
        #expect(MailSearchFilter().readStatus == ("true", "false"))
    }

    @Test func datesBecomeLocalPartsWithFarBoundsWhenOpen() {
        let since = AppleDates.parse("2026-10-24T09:30:15Z")!
        #expect(MailSearchFilter(since: since).sinceParts(timeZone: utc) == ["2026", "10", "24", "\(9 * 3600 + 30 * 60 + 15)"])
        #expect(MailSearchFilter().sinceParts(timeZone: utc) == ["1970", "1", "1", "0"])
        #expect(MailSearchFilter().untilParts(timeZone: utc) == ["2100", "1", "1", "0"])
    }

    @Test func newestFirstAndLimited() {
        let pairs = [["1", "2026-10-20T08:00:00"], ["2", "2026-10-24T08:00:00"], ["3", "2026-10-22T08:00:00"], ["bad"]]
        #expect(MailSearchFilter.newest(pairs, limit: 2) == ["2", "3"])
        #expect(MailSearchFilter.newest(pairs, limit: 0) == [])
    }
}
