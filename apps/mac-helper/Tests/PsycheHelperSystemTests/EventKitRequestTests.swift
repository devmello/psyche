import EventKit
import Foundation
@testable import PsycheHelperSystem
import Testing

@Suite("EventKit request refusals (#570)")
struct EventKitRequestTests {
    @Test func onlyANearInstantDenialWithNoDecisionCountsAsRefused() {
        #expect(EventKitRequest.looksRefused(elapsed: 0.02, statusAfter: .notDetermined))
        #expect(!EventKitRequest.looksRefused(elapsed: 4, statusAfter: .notDetermined))  // someone answered; status lags
        #expect(!EventKitRequest.looksRefused(elapsed: 0.02, statusAfter: .denied))
    }

    @Test func aHelperOutsideAnotherAppIsNotAttributed() throws {
        // The test runner is not nested in an app bundle: nothing to refuse up front.
        #expect(HostAttribution.current(bundlePath: "/tmp/PsycheHelper.app") == nil)
        try HostAttribution.check(.reminders)
    }
}
