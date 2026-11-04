import Foundation
import enum PsycheProtocol.JSONValue
import PsycheShared
import PsycheStore
import PsycheWire
import Testing

@testable import PsycheClient

/// The whole phone side against a scripted Gateway: pair, pending, refuse, revoke, reconnect, outbox.
struct GatewayClientTests {
    final class Harness: @unchecked Sendable {
        let gateway: FakeGateway
        let client: GatewayClient
        let endpointStore: EndpointStore
        let secrets = MemorySecretStore()
        let identityStore: DeviceIdentityStore
        let outbox: Outbox
        let dir: URL
        let wiped = Flag()

        init(gateway: FakeGateway = FakeGateway(), reachability: any Reachability = FakeReachability(resolvesHost: true, local: true), persist: Bool = false) {
            self.gateway = gateway
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("client-\(UUID().uuidString)")
            endpointStore = EndpointStore(directory: dir)
            identityStore = DeviceIdentityStore(store: secrets)
            outbox = Outbox(directory: dir)
            let wiped = self.wiped
            client = GatewayClient(dependencies: GatewayClientDependencies(
                endpointStore: endpointStore, identityStore: identityStore, outbox: outbox,
                transportFactory: { _, _ in gateway.makeTransport() }, reachability: reachability,
                backoff: Backoff(base: 0.02, cap: 0.05, random: { 0 }), deviceName: "Test iPhone",
                stateDirectory: dir, backgroundGrace: .milliseconds(80), pendingRecheck: .milliseconds(40),
                onWipe: { wiped.set() }))
        }
        deinit { try? FileManager.default.removeItem(at: dir) }
    }

    final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        func set() { lock.withLock { value = true } }
        var isSet: Bool { lock.withLock { value } }
    }

    static func link(hostName: String = "studio-mac") throws -> PairingLink {
        try PairingLink.parse(PairingLinkTests.link([
            "gatewayUrl": FakeGateway.origin, "gatewayFingerprint": PairingLink.fingerprint(ofKey: FakeGateway.publicKey)!,
            "setupToken": PairingLinkTests.token, "hostName": hostName,
        ]))
    }

    /// Waits until the client reports `want`, or fails after `seconds`.
    static func wait(_ client: GatewayClient, for want: @escaping @Sendable (ConnectionState) -> Bool, seconds: Double = 3) async -> ConnectionState? {
        let states = client.states()
        return await withTaskGroup(of: ConnectionState?.self) { group in
            group.addTask { for await s in states where want(s) { return s }; return nil }
            group.addTask { try? await Task.sleep(for: .seconds(seconds)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    // MARK: -

    @Test func pairsAndGoesLive() async throws {
        let h = Harness(gateway: FakeGateway(behavior: .paired(stateVersion: 4)))
        await h.client.beginPairing(try Self.link())
        let state = await Self.wait(h.client) { $0 == .live }
        #expect(state == .live)
        #expect(h.endpointStore.load()?.identityKey == FakeGateway.publicKey)
        let verify = h.gateway.received.first { $0.method == "connect.verify" }
        #expect(verify?.params?["setupToken"]?.stringValue == PairingLinkTests.token)
    }

    @Test func pendingShowsTheCodeThenPairsOnceApprovedWithoutResendingTheToken() async throws {
        let gateway = FakeGateway(behavior: .pending(code: "482917"))
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try Self.link())
        let pending = await Self.wait(h.client) { if case .pending = $0 { true } else { false } }
        guard case .pending(let p)? = pending else { Issue.record("never pending: \(String(describing: pending))"); return }
        #expect(p.code == "482 917")
        #expect(p.endpoint.hostName == "studio-mac")
        gateway.behavior = .paired(stateVersion: 2)  // the owner approved on the Mac
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        let tokens = gateway.received.filter { $0.method == "connect.verify" }.map { $0.params?["setupToken"]?.stringValue }
        #expect(tokens.first == PairingLinkTests.token)
        #expect(tokens.dropFirst().allSatisfy { $0 == nil })  // the token is spent once
    }

    @Test func aWrongGatewayIsRefusedWithNoRetryAndNothingStored() async throws {
        let gateway = FakeGateway(lie: .wrongKey)
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .refused(.identityMismatch) } == .refused(.identityMismatch))
        try await Task.sleep(for: .milliseconds(250))
        #expect(gateway.connectCount == 1)  // no retry
        #expect(gateway.received.allSatisfy { $0.method == "connect" })
        #expect(h.endpointStore.load() == nil)
    }

    @Test func anExpiredLinkSaysMakeANewOne() async throws {
        // The Gateway's own sentence (auth.ts SETUP_TOKEN_REFUSED) says "revoked" too; its code, not the word, decides.
        let gateway = FakeGateway(behavior: .denied(
            reason: "This pairing link was already used, has expired or was revoked. Make a new one on the Host.",
            setupTokenInvalid: true))
        let h = Harness(gateway: gateway)
        let failures = h.client.pairingFailures()
        await h.client.beginPairing(try Self.link())
        let message = await withTaskGroup(of: String?.self) { group in
            group.addTask { for await m in failures { return m }; return nil }
            group.addTask { try? await Task.sleep(for: .seconds(3)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        #expect(message?.contains("Make a new link on your Mac") == true)
        #expect(await h.client.currentState == .unpaired)
        #expect(h.endpointStore.load() == nil)
    }

    @Test func aRevokedPhoneWipesKeysEndpointAndOutbox() async throws {
        let gateway = FakeGateway()
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        let keyBefore = try await h.identityStore.identity().publicKey
        await h.outbox.enqueue(OutboxEntry(id: "x", kind: .markRead, method: "notifications.markRead", params: .object([:])))
        let myID = "dev_test"
        gateway.lastTransport?.push(
            event: "device.updated", payload: .object(["device": .object(["id": .string(myID), "revokedAt": "2030-01-01T00:00:00Z"])]),
            seq: 1, stateVersion: 9)
        #expect(await Self.wait(h.client) { $0 == .revoked } == .revoked)
        #expect(h.endpointStore.load() == nil)
        #expect(await h.outbox.isEmpty)
        #expect(h.wiped.isSet)
        #expect(try await h.identityStore.identity().publicKey != keyBefore)
    }

    @Test func aDeniedReconnectOfAPairedPhoneMeansRevoked() async throws {
        let gateway = FakeGateway()
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        gateway.behavior = .denied(reason: "device revoked")
        gateway.lastTransport?.dropFromGatewaySide()
        #expect(await Self.wait(h.client) { $0 == .revoked } == .revoked)
    }

    @Test func aDownGatewayIsClassifiedAndRetriedWithBackoffThenRecovers() async throws {
        let gateway = FakeGateway()
        gateway.down = true
        let h = Harness(gateway: gateway, reachability: FakeReachability(resolvesHost: true, local: true))
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .unreachable(.gatewayOff) } == .unreachable(.gatewayOff))
        gateway.down = false
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
    }

    @Test func tailscaleOffWhenTheNameDoesNotResolve() async throws {
        let gateway = FakeGateway()
        gateway.down = true
        let h = Harness(gateway: gateway, reachability: FakeReachability(resolvesHost: false, local: true))
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .unreachable(.tailscaleOff) } == .unreachable(.tailscaleOff))
    }

    @Test func aReconnectWithAMovedStateVersionPublishesResynced() async throws {
        let gateway = FakeGateway(behavior: .paired(stateVersion: 5))
        let h = Harness(gateway: gateway)
        let events = h.client.liveEvents()
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        gateway.behavior = .paired(stateVersion: 8)
        gateway.lastTransport?.dropFromGatewaySide()
        let resynced = await withTaskGroup(of: Bool.self) { group in
            group.addTask { for await e in events where e == .resynced { return true }; return false }
            group.addTask { try? await Task.sleep(for: .seconds(3)); return false }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        #expect(resynced)
    }

    @Test func theConnectionClosesAfterTheGraceInTheBackgroundAndReturnsWhenActive() async throws {
        let gateway = FakeGateway()
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        await h.client.setActive(false)
        try await Task.sleep(for: .milliseconds(300))
        #expect(gateway.lastTransport?.closedByClient == true)
        let before = gateway.connectCount
        await h.client.setActive(true)
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        #expect(gateway.connectCount > before)
    }

    @Test func queuedWritesFlushInOrderOnConnectExactlyOnce() async throws {
        let gateway = FakeGateway()
        let order = OutboxTests.Sent()
        gateway.on("chat.send") { req in
            order.add(req.idempotencyKey ?? "?")
            return .success(.object(["messageId": .string("m-" + (req.idempotencyKey ?? "")), "queued": .bool(false)]))
        }
        let h = Harness(gateway: gateway)
        // Offline: two sends are accepted into the outbox.
        for id in ["one", "two"] {
            let entry = OutboxEntry(id: id, kind: .chatSend, method: "chat.send", params: .object(["threadId": "t", "content": .string(id)]))
            let result = await h.client.submit(entry)
            #expect(result == .queued)
        }
        await h.client.beginPairing(try Self.link())
        #expect(await Self.wait(h.client) { $0 == .live } == .live)
        try await Task.sleep(for: .milliseconds(200))
        #expect(order.all == ["one", "two"])
        #expect(await h.outbox.isEmpty)
        // Reconnecting does not send them again.
        gateway.lastTransport?.dropFromGatewaySide()
        try await Task.sleep(for: .milliseconds(300))
        #expect(order.all == ["one", "two"])
    }
}
