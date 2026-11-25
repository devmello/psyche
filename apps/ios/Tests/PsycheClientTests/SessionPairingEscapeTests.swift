import Foundation
import PsycheShared
import Testing

@testable import PsycheClient

/// No pairing screen is a dead end: a refused Gateway can be forgotten and paired again, a first pairing to a Mac that
/// can't be reached can be cancelled, and the demo can be left.
@MainActor
struct SessionPairingEscapeTests {
    /// A driver whose state changes the test pushes, and that records what the session asked of it.
    final class Script: @unchecked Sendable {
        let stream: AsyncStream<DriverUpdate>
        let sink: AsyncStream<DriverUpdate>.Continuation
        private let lock = NSLock()
        private var _forgets = 0
        private var _cancels = 0
        var failOnForget = false
        /// What the driver says to show after the owner cancels (an earlier pairing that carries on says `.connecting`).
        var afterCancel: ConnectionState = .unpaired
        init() { (stream, sink) = AsyncStream.makeStream() }
        var forgets: Int { lock.withLock { _forgets } }
        var cancels: Int { lock.withLock { _cancels } }
        func noteForget() { lock.withLock { _forgets += 1 } }
        func noteCancel() { lock.withLock { _cancels += 1 } }
        func push(_ state: ConnectionState) { sink.yield(.state(state)) }
    }

    struct ScriptedDriver: SessionDriver {
        let script: Script
        var initial: ConnectionState = .unpaired
        var initialState: ConnectionState { initial }
        var initialSyncedAt: Date? { nil }
        var updates: AsyncStream<DriverUpdate> { script.stream }
        func pair(code: String) -> AsyncStream<ConnectionState> { AsyncStream { $0.finish() } }
        func preview(code: String) throws -> PairingPreview? {
            PairingPreview(hostName: "Studio Mac", host: "studio-mac.local", fingerprint: "7F3A 91C2 E04B", transport: .lan)
        }
        func cancelPairing() async -> ConnectionState {
            script.noteCancel()
            return script.afterCancel
        }
        func forgetGateway() async throws {
            script.noteForget()
            if script.failOnForget { throw TransportClosed() }
        }
    }

    private func settle() async { try? await Task.sleep(for: .milliseconds(60)) }

    // MARK: Refused

    @Test func pairAgainFromARefusedGatewayForgetsItAndReturnsToTheScanner() async {
        let script = Script()
        let session = Session(driver: ScriptedDriver(script: script, initial: .refused(.identityMismatch)))
        await session.forgetGateway()
        #expect(script.forgets == 1)
        #expect(session.state == .unpaired)
        #expect(session.state.needsPairing)
        #expect(session.pairingError == nil)
    }

    @Test func aKeychainFailureWhileForgettingIsSaidOnTheScanner() async {
        let script = Script()
        script.failOnForget = true
        let session = Session(driver: ScriptedDriver(script: script, initial: .refused(.identityMismatch)))
        await session.forgetGateway()
        #expect(session.state == .unpaired)
        #expect(session.pairingError != nil)
    }

    // MARK: A first pairing that never reaches the Mac

    @Test func aConfirmedPairingStaysOnThePairingScreenWhileTheMacIsUnreachable() async {
        let script = Script()
        let session = Session(driver: ScriptedDriver(script: script))
        #expect(session.pairingAttempt == nil)
        session.beginPairing(code: "psyche-pair:v2:x")
        #expect(session.pairingPreview != nil)
        session.confirmPairing()
        #expect(session.pairingAttempt == Session.PairingAttempt(host: "studio-mac.local", hostName: "Studio Mac"))
        script.push(.connecting)
        script.push(.unreachable(.awayFromHome))
        await settle()
        #expect(session.state == .unreachable(.awayFromHome))
        #expect(session.pairingAttempt != nil, "the root view needs it to keep the Cancel screen up")
        // Cancel goes back to the scanner and tells the client, which drops the unproven endpoint.
        session.cancelPairing()
        await settle()
        #expect(session.state == .unpaired)
        #expect(session.pairingAttempt == nil)
        #expect(script.cancels == 1)
    }

    @Test func aFailedAttemptThatPutAnEarlierPairingBackLeavesThePairingScreen() async {
        let script = Script()
        let session = Session(driver: ScriptedDriver(script: script))
        session.beginPairing(code: "psyche-pair:v2:x")
        session.confirmPairing()
        script.push(.unreachable(.awayFromHome))
        await settle()
        #expect(session.pairingAttempt != nil)
        // The client restored the earlier pairing and said why; the screen must not keep saying "can't reach <new Mac>".
        script.sink.yield(.pairingFailed("Couldn't reach the Mac in that pairing link. Your earlier connection is unchanged."))
        script.push(.connecting)
        await settle()
        #expect(session.pairingAttempt == nil)
        #expect(session.state == .connecting)
    }

    @Test func cancellingNeverLeavesAPairedPhoneOnTheScanner() async {
        let script = Script()
        script.afterCancel = .connecting  // the client put the earlier pairing back
        let session = Session(driver: ScriptedDriver(script: script))
        session.beginPairing(code: "psyche-pair:v2:x")
        session.confirmPairing()
        script.push(.connecting)
        await settle()
        session.cancelPairing()
        #expect(session.state == .unpaired, "the scanner shows at once")
        await settle()
        #expect(session.state == .connecting, "and goes away when the earlier pairing carries on")
        #expect(session.pairingAttempt == nil)
    }

    @Test func theAttemptEndsOnceTheMacAnswersOrTheClientGivesUp() async {
        for ending in [ConnectionState.live, .unpaired, .refused(.identityMismatch)] {
            let script = Script()
            let session = Session(driver: ScriptedDriver(script: script))
            session.beginPairing(code: "psyche-pair:v2:x")
            session.confirmPairing()
            script.push(.connecting)
            await settle()
            #expect(session.pairingAttempt != nil)
            script.push(ending)
            await settle()
            #expect(session.pairingAttempt == nil, "\(ending)")
        }
    }

    @Test func aSessionThatNeverStartedAPairingHasNoAttempt() async {
        // The cached tabs of an earlier pairing that lost its connection are not replaced by the pairing screen.
        let script = Script()
        let session = Session(driver: ScriptedDriver(script: script, initial: .connecting))
        script.push(.unreachable(.gatewayOff))
        await settle()
        #expect(session.state == .unreachable(.gatewayOff))
        #expect(session.pairingAttempt == nil)
    }

    @Test func declinedConfirmationStartsNoAttempt() {
        let session = Session(driver: ScriptedDriver(script: Script()))
        session.beginPairing(code: "psyche-pair:v2:x")
        session.declinePairing()
        #expect(session.pairingAttempt == nil)
        #expect(session.pairingPreview == nil)
    }

    // MARK: The demo

    @Test func onlyAFixtureSessionIsADemoAndItCanBeLeft() {
        #expect(!Session(driver: ScriptedDriver(script: Script())).isDemo)
        let demo = Session(driver: FixtureSessionDriver(scenario: .live))
        #expect(demo.isDemo)
        #expect(!demo.exitDemoRequested)
        demo.exitDemo()
        #expect(demo.exitDemoRequested)
    }

    @Test func aSessionPutBackAfterTheDemoDoesNotRequestItAgain() {
        let session = Session(driver: ScriptedDriver(script: Script()))
        session.requestFixtureMode()
        #expect(session.fixtureModeRequested)
        session.clearDemoRequests()
        #expect(!session.fixtureModeRequested)
        #expect(!session.exitDemoRequested)
    }
}
