import CryptoKit
import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireConnectChallenge
import struct PsycheProtocol.WireError
import PsycheShared
import PsycheStore
import PsycheWire
import Testing

@testable import PsycheClient

/// The two security reviews of the iOS Gateway client (PR #1209), one test group per finding.
struct SecurityReviewTests {
    typealias Harness = GatewayClientTests.Harness

    static func pairedHarness(_ gateway: FakeGateway = FakeGateway()) async throws -> Harness {
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return h
    }

    static func failures(_ client: GatewayClient) -> Collector {
        let collector = Collector()
        let stream = client.pairingFailures()
        collector.task = Task { for await message in stream { collector.add(message) } }
        return collector
    }

    final class Collector: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        var task: Task<Void, Never>?
        func add(_ m: String) { lock.withLock { items.append(m) } }
        var messages: [String] { lock.withLock { items } }
        deinit { task?.cancel() }

        func waitForFirst(seconds: Double = 3) async -> String? {
            let deadline = Date().addingTimeInterval(seconds)
            while Date() < deadline {
                if let first = messages.first { return first }
                try? await Task.sleep(for: .milliseconds(20))
            }
            return nil
        }
    }

    // MARK: 1. Remove this phone does the real thing

    @Test func removingThisPhoneRevokesItsOwnDeviceThenWipesBeforeTheStateIsRevoked() async throws {
        let gateway = FakeGateway()
        let asked = OutboxTests.Sent()
        gateway.on("devices.revoke") { req in
            asked.add(req.params?["deviceId"]?.stringValue ?? "?")
            return .success(.object(["device": .object([:])]))
        }
        let h = try await Self.pairedHarness(gateway)
        let keyBefore = try await h.identityStore.identity().publicKey
        let backend = GatewayBackend(client: h.client)
        try await backend.revokeThisPhone()
        #expect(asked.all == ["dev_test"])  // the Gateway was asked to revoke this device, by id
        #expect(await h.client.currentState == .revoked)
        #expect(h.endpointStore.load() == nil)
        #expect(h.wiped.isSet)
        #expect(try await h.identityStore.identity().publicKey != keyBefore)
    }

    @Test func removingThisPhoneWhileAwayThrowsUnreachableAndWipesNothing() async throws {
        let h = Harness(gateway: FakeGateway())
        try await GatewayClientTests.pairedThenOffline(h)
        let backend = GatewayBackend(client: h.client)
        await #expect(throws: BackendError.unreachable) { try await backend.revokeThisPhone() }
        #expect(h.endpointStore.load() != nil)
        #expect(!h.wiped.isSet)
        #expect(await h.client.currentState != .revoked)
    }

    @Test func aGatewayThatRefusesTheRevokeLeavesThePhonePaired() async throws {
        let gateway = FakeGateway()
        gateway.on("devices.revoke") { _ in .failure(WireError(code: "forbidden", message: "Needs admin.")) }
        let h = try await Self.pairedHarness(gateway)
        await #expect(throws: BackendError.refused("Needs admin.")) { try await GatewayBackend(client: h.client).revokeThisPhone() }
        #expect(h.endpointStore.load() != nil)
        #expect(await h.client.currentState == .live)
    }

    // MARK: 2. Outbox.flush survives a wipe during the send

    @Test func aWipeDuringTheOnlyInFlightSendLeavesNothingToRemoveAndNoOutcome() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(OutboxTests.entry("a"))
        let outcomes = await outbox.flush { _ in
            await outbox.wipe()  // entries is now empty while the send is still awaited
            return .null
        }
        #expect(outcomes.isEmpty)
        #expect(await outbox.isEmpty)
        #expect(await outbox.takeOutcome(for: "a") == nil)
    }

    // MARK: 3. The outbox is bound to the Gateway

    @Test func entriesForAnotherGatewayAreDroppedUnsent() async {
        let outbox = Outbox(directory: nil)
        await outbox.enqueue(OutboxEntry(id: "mine", kind: .chatSend, method: "chat.send", params: .null, gateway: "sha256:A"))
        await outbox.enqueue(OutboxEntry(id: "theirs", kind: .chatSend, method: "chat.send", params: .null, gateway: "sha256:B"))
        await outbox.enqueue(OutboxEntry(id: "unbound", kind: .chatSend, method: "chat.send", params: .null))
        let sent = OutboxTests.Sent()
        let outcomes = await outbox.flush(gateway: "sha256:A", checkGateway: true) { e in sent.add(e.id); return .null }
        #expect(sent.all == ["mine"])
        if case .rejected? = outcomes["theirs"], case .rejected? = outcomes["unbound"] {} else { Issue.record("not dropped: \(outcomes)") }
        #expect(await outbox.isEmpty)
    }

    @Test func submitStampsTheEntryWithThePinnedGatewayAndRefusesWhenUnpaired() async throws {
        let h = Harness(gateway: FakeGateway())
        let entry = OutboxEntry(id: "x", kind: .markRead, method: "notifications.markRead", params: .object([:]))
        if case .rejected = await h.client.submit(entry) {} else { Issue.record("unpaired phone accepted a write") }
        #expect(await h.outbox.isEmpty)

        let paired = try await Self.pairedHarness()
        paired.gateway.down = true
        paired.gateway.lastTransport?.dropFromGatewaySide()
        _ = await GatewayClientTests.wait(paired.client) { if case .unreachable = $0 { true } else { false } }
        #expect(await paired.client.submit(entry) == .queued)
        #expect(await paired.outbox.pending.first?.gateway == PairingLink.fingerprint(ofKey: FakeGateway.publicKey))
    }

    @Test func anEntryFromAnotherGatewayIsNeverSentOnConnect() async throws {
        let gateway = FakeGateway()
        let sent = OutboxTests.Sent()
        gateway.on("chat.send") { req in sent.add(req.idempotencyKey ?? "?"); return .success(.object([:])) }
        let h = Harness(gateway: gateway)
        await h.outbox.enqueue(OutboxEntry(
            id: "foreign", kind: .chatSend, method: "chat.send", params: .object(["threadId": "t", "content": "hi"]),
            gateway: "sha256:" + String(repeating: "0", count: 64)))
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        try await Task.sleep(for: .milliseconds(200))
        #expect(sent.all.isEmpty)
        #expect(await h.outbox.isEmpty)
    }

    @Test func pairingWithADifferentProvenGatewayWipesOutboxStateAndShareInbox() async throws {
        let h = try await Self.pairedHarness()
        let first = try #require(await h.client.pairedEndpoint)
        h.gateway.down = true
        h.gateway.lastTransport?.dropFromGatewaySide()
        _ = await GatewayClientTests.wait(h.client) { if case .unreachable = $0 { true } else { false } }
        _ = await h.client.submit(OutboxEntry(id: "old", kind: .markRead, method: "notifications.markRead", params: .object([:])))
        let source = h.dir.appendingPathComponent("a.txt")
        try Data("x".utf8).write(to: source)
        try h.inbox.enqueue(ShareDraft(destination: .newChat, note: "queued for the old Mac", files: [(source, "a.txt", "text/plain")]))
        h.inbox.writeRecents([ShareThreadChoice(id: "t", title: "Old Mac thread")])
        #expect(FileManager.default.fileExists(atPath: h.dir.appendingPathComponent("state.json").path))
        #expect(await h.outbox.pending.count == 1)

        let otherKey = Curve25519.Signing.PrivateKey()
        let other = FakeGateway(behavior: .paired(stateVersion: 1), identity: otherKey)
        h.route.gateway = other
        let link = try PairingLink.parse(PairingLinkTests.link([
            "gatewayUrl": FakeGateway.origin, "gatewayFingerprint": PairingLink.fingerprint(ofKey: Base64URL.encode(otherKey.publicKey.rawRepresentation))!,
            "setupToken": PairingLinkTests.token, "hostName": "other-mac",
        ]))
        await h.client.beginPairing(link)
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)

        #expect(await h.outbox.isEmpty)
        #expect(h.inbox.pending().isEmpty)
        #expect(h.inbox.recents().isEmpty)
        #expect(h.wiped.isSet)
        let second = try #require(h.endpointStore.load())
        #expect(second.identityKey == Base64URL.encode(otherKey.publicKey.rawRepresentation))
        #expect(second.identityKey != first.identityKey)
    }

    // MARK: 4. A failed re-pair costs nothing

    @Test func anExpiredLinkOnAWorkingPairingKeepsThePairing() async throws {
        let gateway = FakeGateway()
        let h = try await Self.pairedHarness(gateway)
        let before = try #require(h.endpointStore.load())
        let messages = Self.failures(h.client)
        gateway.behavior = .denied(reason: "This pairing link was already used, has expired or was revoked.", setupTokenInvalid: true)
        await h.client.beginPairing(try GatewayClientTests.link())
        let message = await messages.waitForFirst()
        #expect(message?.contains("Make a new link on your Mac") == true)
        #expect(h.endpointStore.load() == before)
        #expect(await h.client.pairedEndpoint == before)
        #expect(await h.client.currentState != .unpaired)
        #expect(!h.wiped.isSet)
        gateway.behavior = .paired(stateVersion: 3)  // the Mac is fine; only the link was spent
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
    }

    @Test func aReasonThatSaysRevokedWithoutTheCodeDoesNotWipeAPairedPhone() async throws {
        let gateway = FakeGateway()
        let h = try await Self.pairedHarness(gateway)
        await h.outbox.enqueue(OutboxEntry(id: "keep", kind: .markRead, method: "notifications.markRead", params: .object([:]),
                                            gateway: PairingLink.fingerprint(ofKey: FakeGateway.publicKey)))
        gateway.down = true
        gateway.lastTransport?.dropFromGatewaySide()
        _ = await GatewayClientTests.wait(h.client) { if case .unreachable = $0 { true } else { false } }
        gateway.down = false
        gateway.behavior = .denied(reason: "This device was revoked by an administrator.")
        let state = await GatewayClientTests.wait(h.client, for: { $0 == .revoked || $0 == .unpaired }, seconds: 0.6)
        #expect(state == nil)  // neither wiped nor unpaired
        #expect(h.endpointStore.load() != nil)
        #expect(!h.wiped.isSet)
        #expect(await h.outbox.pending.map(\.id) == ["keep"])
    }

    @Test func cancellingARePairBringsBackTheWorkingEndpoint() async throws {
        let gateway = FakeGateway()
        let h = try await Self.pairedHarness(gateway)
        let before = try #require(h.endpointStore.load())
        gateway.behavior = .pending(code: "123456")
        await h.client.beginPairing(try GatewayClientTests.link())
        _ = await GatewayClientTests.wait(h.client) { if case .pending = $0 { true } else { false } }
        await h.client.cancelPairing()
        #expect(await h.client.pairedEndpoint == before)
        #expect(h.endpointStore.load() == before)
    }

    @Test func cancellingAFirstPairingLeavesNoUnprovenEndpointInMemoryOrOnDisk() async throws {
        let gateway = FakeGateway()
        gateway.down = true
        let h = Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        _ = await GatewayClientTests.wait(h.client) { if case .unreachable = $0 { true } else { false } }
        #expect(await h.client.pairedEndpoint != nil)  // the link's endpoint, while the attempt runs
        await h.client.cancelPairing()
        #expect(await h.client.pairedEndpoint == nil)
        #expect(h.endpointStore.load() == nil)
        #expect(await h.client.currentState == .unpaired)
    }

    @Test func aRePairThatCannotReachTheLinkedMacRestoresTheWorkingEndpoint() async throws {
        let gateway = FakeGateway()
        let h = try await Self.pairedHarness(gateway)
        let before = try #require(h.endpointStore.load())
        let messages = Self.failures(h.client)
        gateway.down = true
        gateway.lastTransport?.dropFromGatewaySide()
        _ = await GatewayClientTests.wait(h.client) { if case .unreachable = $0 { true } else { false } }
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await messages.waitForFirst()?.contains("Couldn't reach") == true)
        #expect(await h.client.pairedEndpoint == before)
        #expect(h.endpointStore.load() == before)
    }

    // MARK: 8. The method is pinned to the kind

    @Test func whatGoesOnTheWireIsTheKindsMethodNeverTheEntrysOwn() async throws {
        let gateway = FakeGateway()
        let h = try await Self.pairedHarness(gateway)
        gateway.on("chat.send") { _ in .success(.object(["messageId": "m1"])) }
        let hostile = OutboxEntry(id: "k", kind: .chatSend, method: "devices.revoke", params: .object(["deviceId": "dev_test"]))
        _ = await h.client.submit(hostile)
        #expect(gateway.received.contains { $0.method == "chat.send" && $0.idempotencyKey == "k" })
        #expect(gateway.received.allSatisfy { $0.method != "devices.revoke" })
    }

    @Test func aQueueFileWithAnEditedMethodIsNotLoaded() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let good = OutboxEntry(id: "good", kind: .markRead, method: "notifications.markRead", params: .object([:]))
        let edited = OutboxEntry(id: "edited", kind: .chatSend, method: "devices.revoke", params: .object([:]))
        try JSONEncoder().encode([good, edited]).write(to: dir.appendingPathComponent("outbox.json"))
        #expect(await Outbox(directory: dir).pending.map(\.id) == ["good"])
        #expect(OutboxEntry.Kind.allCases.map(\.method) == ["chat.send", "library.upload", "notifications.markRead"])
    }

    // MARK: 10. Events before the Gateway is proven

    @Test func eventsThatArriveBeforeTheGatewayIsProvenAreDropped() async throws {
        let gateway = FakeGateway()
        let transport = gateway.makeTransport()
        transport.push(event: "device.updated", payload: .object(["device": .object(["id": "dev_test", "revokedAt": "2030-01-01T00:00:00Z"])]), seq: 1, stateVersion: 1)
        let conn = GatewayConnection(endpoint: ConnectionTests.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: transport)
        _ = try await conn.handshake(setupToken: nil)
        transport.push(event: "thread.updated", payload: .object([:]), seq: 2, stateVersion: 2)
        var iterator = conn.events.makeAsyncIterator()
        let first = await iterator.next()
        #expect(first?.seq == 2)  // seq 1 came before the proof and never reached the consumer
    }

    @Test func theEventBufferIsBounded() async throws {
        let gateway = FakeGateway()
        let transport = gateway.makeTransport()
        let conn = GatewayConnection(endpoint: ConnectionTests.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: transport)
        _ = try await conn.handshake(setupToken: nil)
        for seq in 1...4000 { transport.push(event: "tick", payload: .object([:]), seq: seq, stateVersion: seq) }
        try await Task.sleep(for: .milliseconds(500))
        await conn.close()
        var count = 0
        for await _ in conn.events { count += 1 }
        #expect(count > 0 && count <= 1024)
    }

    // MARK: 11 and 12. Signing input parity and the challenge's expiry

    @Test(arguments: [
        FakeGateway.Malform.emptyNonce, .newlineInNonce, .protocolZero, .protocolTwo,
    ])
    func aChallengeTheGatewayCouldNotHaveSignedIsRefusedBeforeAnythingIsSent(malform: FakeGateway.Malform) async {
        let gateway = FakeGateway()
        gateway.malform = malform
        let conn = GatewayConnection(endpoint: ConnectionTests.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
        await #expect(throws: ConnectionFailure.identityMismatch(.badChallenge)) {
            _ = try await conn.handshake(setupToken: PairingLinkTests.token)
        }
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func anExpiredChallengeIsRefused() async {
        let gateway = FakeGateway()
        gateway.malform = .expired
        let conn = GatewayConnection(endpoint: ConnectionTests.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
        await #expect(throws: ConnectionFailure.identityMismatch(.challengeExpired)) {
            _ = try await conn.handshake(setupToken: nil)
        }
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func expiryUsesTheClockItIsGiven() throws {
        let challenge = try JSONValue.object([
            "phase": "challenge", "nonce": "n", "serverOrigin": .string(FakeGateway.origin), "protocolVersion": .number(1),
            "expiresAt": "2030-01-01T00:00:00.500Z", "gatewayKey": .string(FakeGateway.publicKey), "gatewaySignature": "s",
        ]).decode(as: WireConnectChallenge.self)
        let after = Date(timeIntervalSince1970: 1_893_456_001)  // just past 2030-01-01T00:00:00Z
        let result = IdentityCheck.verify(
            challenge: challenge, pin: IdentityCheck.Pin(key: FakeGateway.publicKey), dialedOrigin: FakeGateway.origin,
            devicePublicKey: "d", certificate: .trusted, now: after)
        #expect(result == .failure(.challengeExpired))
    }

    // MARK: 13. Transports

    @Test func socketURLsAllowPlainHttpOnlyForLoopback() {
        func url(_ origin: String) -> String? { URLSessionTransport.socketURL(forOrigin: origin)?.absoluteString }
        #expect(url("https://studio-mac.tail1234.ts.net") == "wss://studio-mac.tail1234.ts.net/ws")
        #expect(url("https://mac.local:8443") == "wss://mac.local:8443/ws")
        #expect(url("http://localhost:7433") == "ws://localhost:7433/ws")
        #expect(url("http://127.0.0.1:7433") == "ws://127.0.0.1:7433/ws")
        #expect(url("http://[::1]:7433") == "ws://[::1]:7433/ws")
        #expect(url("http://studio-mac.local") == nil)
        #expect(url("http://192.168.1.20:7433") == nil)
        #expect(url("http://localhost.evil.example") == nil)
        #expect(url("http://127.0.0.2") == nil)
        #expect(url("ws://localhost") == nil)
        #expect(url("ftp://example.com") == nil)
        #expect(url("not a url") == nil)
    }

    @Test func aStoredEndpointIsRevalidatedWhenLoaded() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("endpoint-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = EndpointStore(directory: dir)
        func endpoint(_ url: String) -> GatewayEndpoint {
            GatewayEndpoint(host: "h", fingerprint: "AAAA", transport: .lan, url: url, identityKey: "", hostName: "m", linkFingerprint: "sha256:x")
        }
        try store.save(endpoint("https://studio-mac.local:7433"))
        #expect(store.load()?.url == "https://studio-mac.local:7433")
        try store.save(endpoint("http://localhost:7433"))
        #expect(store.load() != nil)
        for bad in ["http://studio-mac.local", "http://evil.example", "ws://localhost", "https://user:pw@mac.local", "https://mac.local/path?x=1", "file:///etc/passwd"] {
            try store.save(endpoint(bad))
            #expect(store.load() == nil, "\(bad) must not load")
        }
    }

    @Test func aTlsConnectionWithNoCertificateReportIsRefused() {
        let challenge = try! JSONValue.object([
            "phase": "challenge", "nonce": "n", "serverOrigin": .string(FakeGateway.origin), "protocolVersion": .number(1),
            "expiresAt": "2030-01-01T00:00:00Z", "gatewayKey": .string(FakeGateway.publicKey), "gatewaySignature": "s",
        ]).decode(as: WireConnectChallenge.self)
        let result = IdentityCheck.verify(
            challenge: challenge, pin: IdentityCheck.Pin(key: FakeGateway.publicKey), dialedOrigin: FakeGateway.origin,
            devicePublicKey: "d", certificate: nil)
        #expect(result == .failure(.certMissing))
    }

    // MARK: 14 and 15

    @Test(arguments: [
        "https://[fe80::1%25en0]", "https://exa_mple.com", "https://ex!ample.com", "https://exam$ple.com",
    ])
    func pairingLinkHostsAreWhitelisted(origin: String) {
        #expect(throws: PairingLink.ParseError.self) { _ = try PairingLink.origin(origin) }
    }

    @Test func plainHostsAndIPv6LiteralsStillPass() throws {
        #expect(try PairingLink.origin("https://Studio-Mac.tail1234.ts.net") == "https://studio-mac.tail1234.ts.net")
        #expect(try PairingLink.origin("https://192.168.1.20:8443") == "https://192.168.1.20:8443")
        #expect(try PairingLink.origin("https://[2001:db8::1]") == "https://[2001:db8::1]")
    }

    @Test func aFailedQueueWriteIsReportedAndTheEntryStaysInMemory() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("not-a-dir-\(UUID().uuidString)")
        try Data("x".utf8).write(to: file)  // a file where the directory should be
        defer { try? FileManager.default.removeItem(at: file) }
        let outbox = Outbox(directory: file)
        let failure = await outbox.enqueue(OutboxTests.entry("a"))
        #expect(failure != nil)
        #expect(await outbox.persistenceError != nil)
        #expect(await outbox.pending.map(\.id) == ["a"])
    }
}

