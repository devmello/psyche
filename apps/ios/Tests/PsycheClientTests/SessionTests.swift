import Foundation
import Testing

@testable import PsycheClient

@MainActor
struct SessionTests {
    @Test func startsInTheDriversState() {
        #expect(Session(driver: FixtureSessionDriver(scenario: .live)).state == .live)
        #expect(Session(driver: FixtureSessionDriver(scenario: .away)).state == .unreachable(.awayFromHome))
        #expect(Session().state == .unpaired)
    }

    @Test func pairingMovesPendingThenLive() async throws {
        let session = Session(driver: FixtureSessionDriver(approvalDelay: .milliseconds(20)))
        session.beginPairing(code: "psyche-pair:v1?x=1")
        try await Task.sleep(for: .milliseconds(5))
        #expect(session.state == .pending(FixtureSessionDriver.fixturePending))
        try await Task.sleep(for: .milliseconds(200))
        #expect(session.state == .live)
        #expect(session.lastSyncedAt != nil)
    }

    @Test func rejectsCodesThatAreNotPairingLinks() {
        let session = Session()
        session.beginPairing(code: "https://example.com")
        #expect(session.state == .unpaired)
        #expect(session.pairingError != nil)
    }

    @Test func cancelReturnsToUnpaired() {
        let session = Session(driver: FixtureSessionDriver(scenario: .pending))
        session.cancelPairing()
        #expect(session.state == .unpaired)
    }

    @Test func connectionStatesGateAnswersAndPairing() {
        #expect(ConnectionState.live.canAnswer)
        #expect(!ConnectionState.unreachable(.awayFromHome).canAnswer)
        #expect(ConnectionState.unpaired.needsPairing)
        #expect(!ConnectionState.refused(.identityMismatch).needsPairing)
    }
}
