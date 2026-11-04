import Foundation
import PsycheShared
import Testing

@testable import PsycheClient

struct BackoffTests {
    @Test func doublesFromHalfASecondToThirtyWithoutJitter() {
        let backoff = Backoff(random: { 0 })
        let delays = (0..<9).map { backoff.delay(attempt: $0) }
        #expect(delays == [0.5, 1, 2, 4, 8, 16, 30, 30, 30])
    }

    @Test func jitterTakesAtMostAQuarterOff() {
        let low = Backoff(random: { 0.999 }), high = Backoff(random: { 0 })
        for attempt in 0..<10 {
            let a = low.delay(attempt: attempt), b = high.delay(attempt: attempt)
            #expect(a <= b && a >= b * 0.75)
        }
        #expect(Backoff().delay(attempt: 100) <= 30)
    }
}

struct FakeReachability: Reachability {
    var resolvesHost: Bool
    var local: Bool
    func resolves(_ host: String) async -> Bool { resolvesHost }
    func onLocalNetwork() async -> Bool { local }
}

struct UnreachableClassifierTests {
    let ts = GatewayEndpoint(host: "studio-mac.tail1.ts.net", fingerprint: "", transport: .tailscale)
    let lan = GatewayEndpoint(host: "studio-mac.local", fingerprint: "", transport: .lan)
    let loopback = GatewayEndpoint(host: "127.0.0.1", fingerprint: "", transport: .lan)

    @Test func tailscaleThatDoesNotResolveMeansTailscaleIsOff() async {
        #expect(await UnreachableClassifier.classify(ts, reachability: FakeReachability(resolvesHost: false, local: true)) == .tailscaleOff)
    }

    @Test func tailscaleThatResolvesButDoesNotAnswerMeansTheGatewayIsOff() async {
        #expect(await UnreachableClassifier.classify(ts, reachability: FakeReachability(resolvesHost: true, local: false)) == .gatewayOff)
    }

    @Test func aLanGatewayOffTheHomeNetworkMeansAwayFromHome() async {
        #expect(await UnreachableClassifier.classify(lan, reachability: FakeReachability(resolvesHost: false, local: false)) == .awayFromHome)
        // On Wi-Fi but the .local name does not resolve (Bonjour finds nothing): still away.
        #expect(await UnreachableClassifier.classify(lan, reachability: FakeReachability(resolvesHost: false, local: true)) == .awayFromHome)
        // Home, name resolves, nothing answers: the Mac is off.
        #expect(await UnreachableClassifier.classify(lan, reachability: FakeReachability(resolvesHost: true, local: true)) == .gatewayOff)
    }

    @Test func loopbackIsNeverAwayOrTailscale() async {
        #expect(await UnreachableClassifier.classify(loopback, reachability: FakeReachability(resolvesHost: false, local: false)) == .gatewayOff)
    }
}
