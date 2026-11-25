import CryptoKit
import Foundation
import PsycheShared
import PsycheStore
import PsycheWire
import Testing

@testable import PsycheClient

/// `psyche-pair:v2` (a Gateway on the local network), mirroring `packages/protocol/test/pairing-link-v2.test.ts` and
/// `lan-address.test.ts`: the same fields, size limits and host rules as the desktop, so the phone accepts what the Mac
/// makes and nothing else. The pinning half is at the bottom: a certificate that is not the pinned one is refused
/// before anything, the setup token included, leaves the phone.
struct PairingLinkV2Tests {
    static let key = Base64URL.encode(Data(repeating: 5, count: 32))
    static let pin = Base64URL.encode(Data(repeating: 9, count: 32))
    static let token = PairingLinkTests.token

    static func fields(url: String = "https://studio-mac.local:7443", host: String = "Studio Mac") -> [String: Any] {
        ["gatewayUrl": url, "gatewayKey": key, "certPin": pin, "setupToken": token, "hostName": host]
    }

    static func link(_ fields: [String: Any]) -> String {
        let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
        return PairingLink.prefixV2 + Base64URL.encode(data)
    }

    /// The failure `parse` throws, spelled as the TypeScript test spells `problem()`; nil when the link parses.
    static func problem(_ fields: [String: Any]) -> String? { PairingLinkTests.problem(link(fields)) }

    // MARK: - What must parse

    @Test func parsesAV2LinkAndPinsTheKeyAndTheCertificateAtOnce() throws {
        let parsed = try PairingLink.parse(Self.link(Self.fields()))
        #expect(parsed.gatewayURL == "https://studio-mac.local:7443")
        #expect(parsed.gatewayKey == Self.key)
        #expect(parsed.certPin == Self.pin)
        #expect(parsed.gatewayFingerprint == PairingLink.fingerprint(ofKey: Self.key))
        #expect(parsed.hostName == "Studio Mac")
        #expect(parsed.transport == .lan)
        let endpoint = parsed.endpoint
        #expect(endpoint.identityKey == Self.key)
        #expect(endpoint.lanCertSpki == Self.pin)
        #expect(endpoint.linkFingerprint == parsed.gatewayFingerprint)
        #expect(endpoint.transport == .lan)
        #expect(endpoint.url == "https://studio-mac.local:7443")
        // What the Mac shows next to the code is the first six bytes of the key's hash, as for a v1 link.
        #expect(parsed.fingerprint.count == 14)
    }

    /// The table the TypeScript parser is tested against (`packages/protocol/test/lan-origin-vectors.test.ts`): one
    /// file for both, so the phone accepts what the Mac makes and nothing else. A row the phone refuses although
    /// `URL.origin` writes it (`tsAccepts`, port 0) is the only place Swift may be stricter.
    struct Vectors: Decodable {
        struct Origin: Decodable, CustomTestStringConvertible {
            var text: String
            var ok: Bool
            var normalized: String?
            var tsAccepts: Bool?
            var testDescription: String { text }
        }
        struct Host: Decodable, CustomTestStringConvertible {
            var host: String
            var kind: String?
            var testDescription: String { host }
        }
        var origins: [Origin]
        var hosts: [Host]

        static let shared: Vectors = {
            let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            let file = root.appendingPathComponent("packages/protocol/test/vectors/lan-origin.json")
            return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
        }()
    }

    @Test(arguments: Vectors.shared.origins.filter(\.ok))
    func acceptsTheHostsTheMacMayNameAndNormalizesTheOrigin(row: Vectors.Origin) throws {
        let parsed = try PairingLink.parse(Self.link(Self.fields(url: row.text)))
        #expect(parsed.gatewayURL == row.normalized)
        #expect(LanHost.lanOrigin(row.text) == row.normalized)
        #expect(LanHost.lanOrigin(parsed.gatewayURL) == parsed.gatewayURL, "the stored origin must pass the connect-time check too")
    }

    @Test func aV1LinkStillParsesAndNeverPinsACertificate() throws {
        let parsed = try PairingLink.parse(PairingLinkTests.link(PairingLinkTests.fields()))
        #expect(parsed.certPin == nil)
        #expect(parsed.gatewayKey == nil)
        #expect(parsed.endpoint.lanCertSpki == nil)
        #expect(parsed.endpoint.identityKey.isEmpty)
    }

    // MARK: - What must be refused

    /// Every row names a host the Gateway never listens on or a spelling `URL.origin` never writes. Port 0 is the one
    /// row `URL.origin` does write: the phone refuses it on its own (`tsAccepts` in the table).
    @Test(arguments: Vectors.shared.origins.filter { !$0.ok })
    func refusesAnyOtherAddress(row: Vectors.Origin) {
        #expect(Self.problem(Self.fields(url: row.text)) == "bad_field:gatewayUrl", "\(row.text)")
    }

    @Test func theTableHasTheRowsThatMatter() {
        let refused = Set(Vectors.shared.origins.filter { !$0.ok }.map(\.text))
        // link-local, global IPv6, public IPv4, a zone id, a trailing-dot dotted-decimal host, port 0
        for text in ["https://[fe80::1]", "https://[2001:db8::1]", "https://8.8.8.8", "https://[fe80::1%25en0]", "https://10.0.0.5.", "https://10.0.0.5:0"] {
            #expect(refused.contains(text), "\(text)")
        }
        #expect(Vectors.shared.origins.filter(\.ok).count >= 14)
    }

    @Test func refusesAnOriginOverTheSizeLimit() {
        let long = "https://" + String(repeating: "a", count: 62) + "." + String(repeating: "b", count: 62) + "." + String(repeating: "c", count: 62)
            + "." + String(repeating: "d", count: 62) + "." + String(repeating: "e", count: 62) + ".local"
        #expect(long.utf16.count > 300)
        #expect(Self.problem(Self.fields(url: long)) == "bad_field:gatewayUrl")
        let max = "https://" + String(repeating: "a", count: 63) + ".local"
        #expect(Self.problem(Self.fields(url: max)) == nil)
        #expect(Self.problem(Self.fields(url: "https://" + String(repeating: "a", count: 64) + ".local")) == "bad_field:gatewayUrl")
    }

    @Test func refusesAnExtraFieldOrAMissingOne() {
        var extra = Self.fields()
        extra["gatewayFingerprint"] = PairingLinkTests.fingerprint  // a v1 field is not a v2 field
        #expect(Self.problem(extra) == "extra_fields:gatewayFingerprint")
        extra = Self.fields()
        extra["lanHostKind"] = "mdns"
        #expect(Self.problem(extra) == "extra_fields:lanHostKind")
        for field in ["gatewayUrl", "gatewayKey", "certPin", "setupToken", "hostName"] {
            var missing = Self.fields()
            missing[field] = nil
            #expect(Self.problem(missing) == "bad_field:\(field)")
            var numeric = Self.fields()
            numeric[field] = 7
            #expect(Self.problem(numeric) == "bad_field:\(field)")
        }
    }

    @Test(arguments: ["gatewayKey", "certPin"])
    func refusesABadKeyOrSpkiPin(field: String) {
        let bad: [String] = [
            "", "short", String(repeating: "A", count: 42), String(repeating: "A", count: 44),
            String(repeating: "A", count: 42) + "B",  // 32 bytes, but with non-zero trailing bits: not what an encoder writes
            String(repeating: "A", count: 42) + "+", String(repeating: "A", count: 42) + "=", String(repeating: "A", count: 42) + " ",
            "sha256:" + String(repeating: "ab", count: 32),
        ]
        for value in bad {
            var f = Self.fields()
            f[field] = value
            #expect(Self.problem(f) == "bad_field:\(field)", "\(value)")
        }
        var good = Self.fields()
        good[field] = String(repeating: "A", count: 42) + "A"
        #expect(Self.problem(good) == nil)
    }

    @Test func refusesABadTokenOrHostNameAndAnOversizeLink() {
        var f = Self.fields()
        f["setupToken"] = "pst_short"
        #expect(Self.problem(f) == "bad_field:setupToken")
        f = Self.fields(host: String(repeating: "x", count: 65))
        #expect(Self.problem(f) == "bad_field:hostName")
        f = Self.fields(host: "Mac\u{202E}")
        #expect(Self.problem(f) == "bad_field:hostName")
        f = Self.fields(host: "\u{200B}\u{FEFF}")
        #expect(Self.problem(f) == "bad_field:hostName")
        f = Self.fields(host: String(repeating: "x", count: 64))
        f["padding"] = String(repeating: "y", count: 2100)
        #expect(Self.problem(f) == "malformed")
    }

    @Test func otherVersionsAndDamagedBodiesAreRefused() {
        let body = String(Self.link(Self.fields()).dropFirst(PairingLink.prefixV2.count))
        #expect(PairingLinkTests.problem("psyche-pair:v3:" + body) == "unsupported_version")
        #expect(PairingLinkTests.problem("psyche-pair:v2:") == "malformed")
        #expect(PairingLinkTests.problem("psyche-pair:v2:!!!") == "malformed")
        #expect(PairingLinkTests.problem(PairingLink.prefixV2 + Base64URL.encode(Data("[]".utf8))) == "malformed")
        #expect(PairingLinkTests.problem("PSYCHE-PAIR:v2:" + body) == nil)
        // A v2 body under the v1 prefix is a v1 link with the wrong fields.
        #expect(PairingLinkTests.problem(PairingLink.prefix + body)?.hasPrefix("extra_fields") == true)
    }

    // MARK: - Which hosts count as this network (the same table `lan-address` is tested with)

    @Test(arguments: Vectors.shared.hosts)
    func classifiesHostsLikeTheTypeScriptParser(row: Vectors.Host) {
        let kind: LanHost.Kind? = switch row.kind {
        case "mdns": .mdns
        case "ipv4-private": .ipv4Private
        case "ipv6-unique-local": .ipv6UniqueLocal
        default: nil
        }
        #expect(LanHost.kind(of: row.host) == kind, "\(row.host)")
    }
}

// MARK: - Pinning

/// The phone talks to a v2 Gateway only through the certificate its link names: the transport refuses any other
/// before a byte is written (`TrustDelegate.decide`), and the handshake refuses unless the identity key signed that
/// certificate into the challenge (`IdentityCheck`). The system's trust is never consulted for such a Gateway.
struct PinnedCertificateTests {
    static let der = Data(base64Encoded: GatewayIdentityTests.certificateDER)!
    static let derPin = "y-qIuIwzdHBoooNoUxd1h6ejl3Yw105d7iq5eJ1lK04"
    static let other = Base64URL.encode(Data(repeating: 4, count: 32))

    private func decide(_ trust: TransportTrust, leaf: Data?, systemTrusts: Bool) -> TrustDelegate.Decision {
        TrustDelegate.decide(trust: trust, leafCertificate: leaf, systemTrusts: { systemTrusts })
    }

    @Test func theCertificateTheLinkNamesIsAcceptedEvenThoughTheSystemDoesNotTrustIt() {
        let trust = TransportTrust(allowSelfSigned: true, pinnedSPKI: Self.derPin)
        #expect(decide(trust, leaf: Self.der, systemTrusts: false) == .pinned(spki: Self.derPin))
    }

    @Test func anyOtherCertificateIsRefusedEvenWhenTheSystemTrustsIt() {
        let trust = TransportTrust(allowSelfSigned: true, pinnedSPKI: Self.other)
        // A pin mismatch is final: no fall back to the system's answer, whichever way it goes.
        #expect(decide(trust, leaf: Self.der, systemTrusts: false) == .pinMismatch)
        #expect(decide(trust, leaf: Self.der, systemTrusts: true) == .pinMismatch)
    }

    @Test func aPinnedGatewayThatPresentsNothingReadableIsRefused() {
        let trust = TransportTrust(allowSelfSigned: true, pinnedSPKI: Self.derPin)
        #expect(decide(trust, leaf: nil, systemTrusts: true) == .refuse)
        #expect(decide(trust, leaf: Data("not a certificate".utf8), systemTrusts: true) == .refuse)
        #expect(decide(trust, leaf: Self.der.prefix(40), systemTrusts: true) == .refuse)
    }

    @Test func theSystemsTrustIsOnlyEverUsedWhereNoPinIsStored() {
        // A Gateway on a public name (Tailscale): the system decides, a self-signed certificate is never kept.
        let remote = TransportTrust()
        #expect(decide(remote, leaf: Self.der, systemTrusts: true) == .system)
        #expect(decide(remote, leaf: Self.der, systemTrusts: false) == .refuse)
        // A pin without permission to use a self-signed certificate is not a way to turn one on.
        let stray = TransportTrust(allowSelfSigned: false, pinnedSPKI: Self.derPin)
        #expect(decide(stray, leaf: Self.der, systemTrusts: false) == .refuse)
    }

    // MARK: The handshake

    private func v2Endpoint(key: String = FakeGateway.publicKey, pin: String) throws -> GatewayEndpoint {
        var fields = PairingLinkV2Tests.fields(url: "https://studio-mac.local")
        fields["gatewayKey"] = key
        fields["certPin"] = pin
        var endpoint = try PairingLink.parse(PairingLinkV2Tests.link(fields)).endpoint
        // FakeGateway answers for one origin; the pins are what this test is about.
        endpoint.url = FakeGateway.origin
        return endpoint
    }

    private func connection(_ gateway: FakeGateway, _ endpoint: GatewayEndpoint) -> GatewayConnection {
        GatewayConnection(endpoint: endpoint, identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
    }

    @Test func aV2PairingGoesThroughWhenTheCertificateAndTheKeyAreTheOnesInTheLink() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.derPin)
        let conn = connection(gateway, try v2Endpoint(pin: Self.derPin))
        _ = try await conn.handshake(setupToken: PairingLinkV2Tests.token)
        #expect(await conn.proven == IdentityCheck.Proven(key: FakeGateway.publicKey, certSPKI: Self.derPin))
        let verify = try #require(gateway.received.first { $0.method == "connect.verify" })
        #expect(verify.params?["setupToken"]?.stringValue == PairingLinkV2Tests.token)
    }

    @Test func aCertificateThatIsNotThePinnedOneGetsNoSetupTokenAndNoSignature() async throws {
        // Even when the Gateway honestly vouches for the certificate it served, the link named another one.
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.derPin)
        let conn = connection(gateway, try v2Endpoint(pin: Self.other))
        await #expect(throws: ConnectionFailure.identityMismatch(.certChanged)) {
            _ = try await conn.handshake(setupToken: PairingLinkV2Tests.token)
        }
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func aChainTheSystemTrustsDoesNotStandInForThePinnedCertificate() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .trusted
        let conn = connection(gateway, try v2Endpoint(pin: Self.derPin))
        await #expect(throws: ConnectionFailure.identityMismatch(.certMissing)) {
            _ = try await conn.handshake(setupToken: PairingLinkV2Tests.token)
        }
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func aGatewayThatDoesNotVouchForItsCertificateIsRefused() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.derPin)
        gateway.vouch = .badSignature
        await #expect(throws: ConnectionFailure.identityMismatch(.certInvalid)) {
            _ = try await connection(gateway, try v2Endpoint(pin: Self.derPin)).handshake(setupToken: PairingLinkV2Tests.token)
        }
        gateway.vouch = .omitted
        await #expect(throws: ConnectionFailure.identityMismatch(.certMissing)) {
            _ = try await connection(gateway, try v2Endpoint(pin: Self.derPin)).handshake(setupToken: PairingLinkV2Tests.token)
        }
        #expect(gateway.received.filter { $0.method == "connect.verify" }.isEmpty)
    }

    @Test func aGatewayWithAnotherIdentityKeyIsRefusedAtOnce() async throws {
        // The link carried the key: there is no first connect that could adopt a different one.
        let impostor = FakeGateway(identity: Curve25519.Signing.PrivateKey())
        impostor.certificate = .selfSigned(spki: Self.derPin)
        let conn = connection(impostor, try v2Endpoint(pin: Self.derPin))
        await #expect(throws: ConnectionFailure.identityMismatch(.keyChanged)) {
            _ = try await conn.handshake(setupToken: PairingLinkV2Tests.token)
        }
        #expect(impostor.received.map(\.method) == ["connect"])
    }

    // MARK: The client

    private final class Captured: @unchecked Sendable {
        private let lock = NSLock()
        private var trusts: [TransportTrust] = []
        func add(_ t: TransportTrust) { lock.withLock { trusts.append(t) } }
        var all: [TransportTrust] { lock.withLock { trusts } }
    }

    /// A socket that never opens. `pinRefused` says whether TLS was cancelled by the pin check.
    private struct DeadTransport: WebSocketTransport {
        var pinRefused: Bool
        func send(_ frame: Data) async throws { throw TransportClosed() }
        func receive() async throws -> Data { throw TransportClosed() }
        func close() {}
    }

    private func client(
        _ gateway: FakeGateway, captured: Captured, transport: (@Sendable () -> any WebSocketTransport)? = nil,
        backoff: Backoff = Backoff(base: 0.02, cap: 0.05, random: { 0 })
    ) -> GatewayClient {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("client-v2-\(UUID().uuidString)")
        return GatewayClient(dependencies: GatewayClientDependencies(
            endpointStore: EndpointStore(directory: dir), identityStore: DeviceIdentityStore(store: MemorySecretStore()),
            outbox: Outbox(directory: dir),
            transportFactory: { _, trust in captured.add(trust); return transport?() ?? gateway.makeTransport() },
            reachability: FakeReachability(resolvesHost: true, local: true),
            backoff: backoff, deviceName: "Test iPhone", stateDirectory: dir,
            backgroundGrace: .milliseconds(80), pendingRecheck: .milliseconds(40),
            keptPingInterval: .seconds(180), keptPingTimeout: .seconds(10),
            shareInbox: nil, onWipe: {}, libraryCache: dir.appendingPathComponent("LibraryCache")))
    }

    @Test func aV2LinkConnectsOnlyThroughItsPinnedCertificate() async throws {
        let captured = Captured()
        let h = client(FakeGateway(), captured: captured)
        let link = try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-mac.local")))
        await h.setActive(true)
        await h.beginPairing(link)
        // The scripted Gateway answers for another origin, so the handshake stops; the transport was still made with the pin.
        _ = await GatewayClientTests.wait(h, for: { $0 == .refused(.identityMismatch) }, seconds: 5)
        let trust = try #require(captured.all.first)
        #expect(trust == TransportTrust(allowSelfSigned: true, pinnedSPKI: PairingLinkV2Tests.pin))
        await h.setActive(false)
    }

    @Test func aLinkWithoutAPinNeverAllowsASelfSignedCertificate() async throws {
        let captured = Captured()
        let h = client(FakeGateway(), captured: captured)
        // A v1 link to a name that is not on Tailscale used to open the self-signed path (any non-.ts.net host was "LAN").
        var fields = PairingLinkTests.fields(url: "https://studio-mac.example.com")
        fields["hostName"] = "Studio Mac"
        let link = try PairingLink.parse(PairingLinkTests.link(fields))
        await h.setActive(true)
        await h.beginPairing(link)
        _ = await GatewayClientTests.wait(h, for: { $0 == .refused(.identityMismatch) }, seconds: 5)
        let trust = try #require(captured.all.first)
        #expect(trust == TransportTrust(allowSelfSigned: false, pinnedSPKI: nil))
        await h.setActive(false)
    }

    @Test func aPinnedEndpointAtAnAddressOffTheLocalNetworkIsNeverDialed() async throws {
        let captured = Captured()
        let h = client(FakeGateway(), captured: captured)
        // A link-shaped value that did not come from the v2 parser (an older save, a hand-edited file) still has to
        // name a local-network host before a self-signed certificate is kept for it.
        let link = PairingLink(
            gatewayURL: "https://studio-mac.example.com", gatewayFingerprint: PairingLink.fingerprint(ofKey: PairingLinkV2Tests.key)!,
            setupToken: PairingLinkV2Tests.token, hostName: "Studio Mac", gatewayKey: PairingLinkV2Tests.key,
            certPin: PairingLinkV2Tests.pin)
        await h.setActive(true)
        await h.beginPairing(link)
        // Not "unreachable forever": the saved pin no longer names a local-network address, so the phone says so.
        let state = await GatewayClientTests.wait(h, for: { $0 == .refused(.identityChanged) }, seconds: 5)
        #expect(state == .refused(.identityChanged))
        #expect(captured.all.isEmpty)
        await h.cancelPairing()
        await h.setActive(false)
    }

    @Test func aChangedCertificateIsAnIdentityChangeNotAMacThatIsOff() async throws {
        let captured = Captured()
        let h = client(FakeGateway(), captured: captured, transport: { DeadTransport(pinRefused: true) })
        let link = try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-mac.local")))
        await h.setActive(true)
        await h.beginPairing(link)
        let state = await GatewayClientTests.wait(h, for: { $0 == .refused(.identityChanged) }, seconds: 5)
        #expect(state == .refused(.identityChanged))
        // The old pin is kept, never replaced: the next dial still demands the same certificate.
        #expect(captured.all.allSatisfy { $0.pinnedSPKI == PairingLinkV2Tests.pin })
        await h.setActive(false)
    }

    /// The first `wrong` dials reach another device (TLS cancelled by the pin check); after that the real Mac answers.
    private func wrongThenReal(_ wrong: Int, gateway: FakeGateway, calls: Calls) -> @Sendable () -> any WebSocketTransport {
        { calls.next() <= wrong ? DeadTransport(pinRefused: true) : gateway.makeTransport() }
    }

    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func next() -> Int { lock.withLock { n += 1; return n } }
        var count: Int { lock.withLock { n } }
    }

    private func realMac() -> FakeGateway {
        let gateway = FakeGateway()
        gateway.servedOrigin = "https://studio-mac.local"
        gateway.certificate = .selfSigned(spki: PairingLinkV2Tests.pin)
        return gateway
    }

    private func realLink() throws -> PairingLink {
        var fields = PairingLinkV2Tests.fields(url: "https://studio-mac.local")
        fields["gatewayKey"] = FakeGateway.publicKey
        return try PairingLink.parse(PairingLinkV2Tests.link(fields))
    }

    @Test func aWrongDeviceAtTheAddressIsNotFinalTheRealMacBringsThePhoneBackWithoutARelaunch() async throws {
        let calls = Calls()
        let captured = Captured()
        let gateway = realMac()
        let h = client(gateway, captured: captured, transport: wrongThenReal(3, gateway: gateway, calls: calls))
        await h.setActive(true)
        await h.beginPairing(try realLink())
        let refused = await GatewayClientTests.wait(h, for: { $0 == .refused(.identityChanged) }, seconds: 5)
        #expect(refused == .refused(.identityChanged))
        // Nothing was sent to the wrong device and nothing was replaced: every dial demanded the same certificate.
        #expect(await GatewayClientTests.wait(h, for: { $0 == .live }, seconds: 10) == .live)
        #expect(calls.count == 4)
        #expect(captured.all.allSatisfy { $0.pinnedSPKI == PairingLinkV2Tests.pin })
        #expect(await h.pairedEndpoint?.lanCertSpki == PairingLinkV2Tests.pin)
        await h.setActive(false)
    }

    @Test func theRunLoopKeepsDialingWhileTheIdentityIsChanged() async throws {
        let calls = Calls()
        let h = client(FakeGateway(), captured: Captured(), transport: { _ = calls.next(); return DeadTransport(pinRefused: true) })
        await h.setActive(true)
        await h.beginPairing(try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-mac.local"))))
        for _ in 0..<100 where calls.count < 4 { try await Task.sleep(for: .milliseconds(50)) }
        #expect(calls.count >= 4, "a single wrong handshake must not stop the loop")
        #expect(await h.currentState == .refused(.identityChanged))
        await h.setActive(false)
    }

    @Test func tryAgainDialsAtOnceInsteadOfWaitingOutTheBackoff() async throws {
        let calls = Calls()
        let gateway = realMac()
        // A backoff of half a minute: only "Try again" can make the second dial happen within this test.
        let h = client(gateway, captured: Captured(), transport: wrongThenReal(1, gateway: gateway, calls: calls),
                       backoff: Backoff(base: 30, cap: 30, random: { 0 }))
        await h.setActive(true)
        await h.beginPairing(try realLink())
        #expect(await GatewayClientTests.wait(h, for: { $0 == .refused(.identityChanged) }, seconds: 5) == .refused(.identityChanged))
        try await Task.sleep(for: .milliseconds(300))
        #expect(calls.count == 1)
        await h.retryNow()
        #expect(await GatewayClientTests.wait(h, for: { $0 == .live }, seconds: 5) == .live)
        #expect(calls.count == 2)
        await h.setActive(false)
    }

    @Test func tryAgainDoesNothingOutsideTheIdentityChangedScreen() async throws {
        let calls = Calls()
        let h = client(FakeGateway(), captured: Captured(), transport: { _ = calls.next(); return DeadTransport(pinRefused: false) },
                       backoff: Backoff(base: 30, cap: 30, random: { 0 }))
        await h.setActive(true)
        await h.beginPairing(try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-mac.local"))))
        _ = await GatewayClientTests.wait(h, for: { if case .unreachable = $0 { true } else { false } }, seconds: 5)
        let before = calls.count
        await h.retryNow()
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls.count == before)
        await h.cancelPairing()
        await h.setActive(false)
    }

    @Test func aMacThatIsOffStaysUnreachableAndNotRefused() async throws {
        let h = client(FakeGateway(), captured: Captured(), transport: { DeadTransport(pinRefused: false) })
        let link = try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-mac.local")))
        await h.setActive(true)
        await h.beginPairing(link)
        let state = await GatewayClientTests.wait(h, for: { if case .unreachable = $0 { true } else { false } }, seconds: 5)
        #expect(state != nil)
        await h.cancelPairing()
        await h.setActive(false)
    }

    @Test func aLinkTheLinkCarriesAKeyForIsNotAWorkingPairingUntilAConnectionProvesIt() async throws {
        // Two v2 links in a row, neither ever reached: cancelling must not "restore" the first, whose key came from the
        // link and was never proven. Nothing is paired, so the scanner comes back.
        let h = client(FakeGateway(), captured: Captured(), transport: { DeadTransport(pinRefused: false) })
        let first = try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-one.local")))
        let second = try PairingLink.parse(PairingLinkV2Tests.link(PairingLinkV2Tests.fields(url: "https://studio-two.local")))
        await h.setActive(true)
        await h.beginPairing(first)
        await h.beginPairing(second)
        _ = await GatewayClientTests.wait(h, for: { if case .unreachable = $0 { true } else { false } }, seconds: 5)
        await h.cancelPairing()
        #expect(await h.currentState == .unpaired)
        #expect(await h.pairedEndpoint == nil)
        await h.setActive(false)
    }
}
