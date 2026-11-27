import Foundation

import Testing

@testable import PsycheFeatures

/// The dates the inbox rows print. The formatters are built once now, so these pin their output.
@MainActor
struct FormatterOutputTests {
    @Test func theGatewayUTCStringParsesToThatInstant() throws {
        let expected = try #require(ISO8601DateFormatter().date(from: "2026-03-02T09:00:00Z"))
        #expect(InboxModel.utcDate("Mon, 02 Mar 2026 09:00:00 GMT") == expected)
        // Positive control: the same text with a different hour is a different instant.
        #expect(InboxModel.utcDate("Mon, 02 Mar 2026 10:00:00 GMT") != expected)
        #expect(InboxModel.utcDate("not a date") == nil)
    }
}
