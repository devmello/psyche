import Foundation
import Testing

@testable import PsycheClient

/// The reconnect counter after a live connection ends: a handshake alone must not reset the backoff (a Gateway that
/// accepts and drops at once used to be redialled every half second).
struct GatewayBackoffResetTests {
    @Test func aConnectionThatDropsRightAfterItsHandshakeKeepsTheBackoff() {
        #expect(GatewayClient.attemptAfterLive(.milliseconds(200), previous: 4) == 4)
        #expect(GatewayClient.attemptAfterLive(.seconds(5), previous: 0) == 0)
        #expect(GatewayClient.attemptAfterLive(.seconds(29), previous: 6) == 6)
    }

    @Test func aConnectionThatStayedUpLongEnoughResetsTheBackoff() {
        #expect(GatewayClient.attemptAfterLive(.seconds(30), previous: 6) == 0)
        #expect(GatewayClient.attemptAfterLive(.seconds(600), previous: 6) == 0)
    }

    /// Positive control on the real schedule: a crash loop climbs the delays, a stable link starts again at half a second.
    @Test func aCrashLoopClimbsWhileAStableLinkStartsOver() {
        let backoff = Backoff(random: { 0 })
        var attempt = 0
        var delays: [Double] = []
        for _ in 0..<4 {
            attempt = GatewayClient.attemptAfterLive(.seconds(1), previous: attempt)
            delays.append(backoff.delay(attempt: attempt))
            attempt += 1
        }
        #expect(delays == [0.5, 1, 2, 4])
        attempt = GatewayClient.attemptAfterLive(.seconds(90), previous: attempt)
        #expect(backoff.delay(attempt: attempt) == 0.5)
    }
}
