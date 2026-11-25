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

    @Test(arguments: [
        ("https://studio-mac.local", "https://studio-mac.local"),
        ("https://studio-mac.local/", "https://studio-mac.local"),
        ("https://studio-mac.local:8443", "https://studio-mac.local:8443"),
        ("https://studio-mac.local.", "https://studio-mac.local."),
        ("https://a.b-c.local:1", "https://a.b-c.local:1"),
        ("https://10.0.0.5", "https://10.0.0.5"),
        ("https://10.255.255.255:7443", "https://10.255.255.255:7443"),
        ("https://172.16.0.1", "https://172.16.0.1"),
        ("https://172.31.255.255", "https://172.31.255.255"),
        ("https://192.168.1.20:7443/", "https://192.168.1.20:7443"),
        ("https://[fd12:3456::1]", "https://[fd12:3456::1]"),
        ("https://[fd12:3456::1]:8443", "https://[fd12:3456::1]:8443"),
        ("https://[fc00::1]/", "https://[fc00::1]"),
        ("https://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]", "https://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]"),
    ])
    func acceptsTheHostsTheMacMayNameAndNormalizesTheOrigin(text: String, origin: String) throws {
        let parsed = try PairingLink.parse(Self.link(Self.fields(url: text)))
        #expect(parsed.gatewayURL == origin)
        #expect(LanHost.lanOrigin(origin) == origin, "the stored origin must pass the connect-time check too")
    }

    @Test func aV1LinkStillParsesAndNeverPinsACertificate() throws {
        let parsed = try PairingLink.parse(PairingLinkTests.link(PairingLinkTests.fields()))
        #expect(parsed.certPin == nil)
        #expect(parsed.gatewayKey == nil)
        #expect(parsed.endpoint.lanCertSpki == nil)
        #expect(parsed.endpoint.identityKey.isEmpty)
    }

    // MARK: - What must be refused

    /// Every row names a host the Gateway never listens on or a spelling `URL.origin` never writes.
    @Test(arguments: [
        // link-local (IPv4 and IPv6), with and without a zone id
        "https://169.254.10.20", "https://[fe80::1]", "https://[fe80::1%25en0]", "https://[fe80::1%en0]", "https://studio-mac.local%25en0",
        // global and documentation IPv6, mapped IPv4, loopback, unspecified, multicast
        "https://[2001:db8::1]", "https://[2606:4700::1111]", "https://[::ffff:10.0.0.1]", "https://[::1]", "https://[::]", "https://[ff02::1]",
        // public IPv4, loopback, carrier-grade NAT, the edges of the private blocks
        "https://8.8.8.8", "https://127.0.0.1", "https://100.64.0.1", "https://172.15.0.1", "https://172.32.0.1", "https://192.169.0.1",
        "https://11.0.0.1", "https://0.0.0.0", "https://localhost",
        // names that are not mDNS names
        "https://example.com", "https://studio-mac.tail1234.ts.net", "https://studio-mac.local.example.com", "https://local", "https://.local",
        "https://a_b.local", "https://-a.local", "https://a-.local", "https://studio mac.local",
        // not written as URL.origin writes it
        "https://Studio-Mac.local", "https://STUDIO-MAC.LOCAL", "https://[FD12:3456::1]", "https://[fd12:0:0:0:0:0:0:1]",
        "https://[fd12:3456:0:0:0:0:0:1]", "https://[fd12::0:1]", "https://[fd12:3456::1.2.3.4]", "https://010.0.0.1", "https://10.0.0.05",
        "https://10.1", "https://10.0.0.5:443", "https://10.0.0.5:0", "https://10.0.0.5:08443", "https://10.0.0.5:65536", "https://10.0.0.5:abc",
        "https://10.0.0.5:", "https://[fd12::1]:", "HTTPS://10.0.0.5",
        // wrong scheme, credentials, path, query, fragment, more than an origin
        "http://10.0.0.5", "wss://10.0.0.5", "10.0.0.5", "//10.0.0.5", "https://user@10.0.0.5", "https://user:pw@10.0.0.5", "https://10.0.0.5/x",
        "https://10.0.0.5//", "https://10.0.0.5?x=1", "https://10.0.0.5#x", "https://10.0.0.5\\x", "https://10.0.0.5 ", " https://10.0.0.5",
        "https://10.0.0.5\n", "https://[fd12::1", "https://fd12::1", "https://10.0.0.5:7443:7443", "", "https://",
    ])
    func refusesAnyOtherAddress(url: String) {
        #expect(Self.problem(Self.fields(url: url)) == "bad_field:gatewayUrl", "\(url)")
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

    // MARK: - Which hosts count as this network (the table `lan-address.test.ts` runs)

    @Test(arguments: [
        ("studio-mac.local", LanHost.Kind.mdns), ("STUDIO-MAC.LOCAL", .mdns), ("studio-mac.local.", .mdns), ("10.0.0.1", .ipv4Private),
        ("172.20.1.1", .ipv4Private), ("192.168.0.9", .ipv4Private), ("[fd00::1]", .ipv6UniqueLocal), ("fc12::9", .ipv6UniqueLocal),
    ])
    func classifiesLocalNetworkHosts(host: String, kind: LanHost.Kind) {
        #expect(LanHost.kind(of: host) == kind)
    }

    @Test(arguments: [
        "", ".", "fe80::1", "[fe80::1]", "fe80::1%en0", "169.254.1.1", "2001:db8::1", "::ffff:10.0.0.1", "::1", "127.0.0.1", "8.8.8.8",
        "100.64.0.1", "10.0.0", "10.0.0.256", "10.0.0.1.1", "01.0.0.1", "local", "example.com", "a..local", "10.0.0.5%en0", "fd00::1%en0",
        "[fd00::1%25en0]", "fd00:::1", "fd00::1::2", "1:2:3:4:5:6:7:8:9", "fd00:1:2:3:4:5:6:7:8",
    ])
    func refusesEverythingElse(host: String) {
        #expect(LanHost.kind(of: host) == nil, "\(host)")
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
        #expect(decide(trust, leaf: Self.der, systemTrusts: false) == .refuse)
        #expect(decide(trust, leaf: Self.der, systemTrusts: true) == .refuse)
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

    private func client(_ gateway: FakeGateway, captured: Captured) -> GatewayClient {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("client-v2-\(UUID().uuidString)")
        return GatewayClient(dependencies: GatewayClientDependencies(
            endpointStore: EndpointStore(directory: dir), identityStore: DeviceIdentityStore(store: MemorySecretStore()),
            outbox: Outbox(directory: dir),
            transportFactory: { _, trust in captured.add(trust); return gateway.makeTransport() },
            reachability: FakeReachability(resolvesHost: true, local: true),
            backoff: Backoff(base: 0.02, cap: 0.05, random: { 0 }), deviceName: "Test iPhone", stateDirectory: dir,
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
        let state = await GatewayClientTests.wait(h, for: { if case .unreachable = $0 { true } else { false } }, seconds: 5)
        #expect(state != nil)
        #expect(captured.all.isEmpty)
        await h.cancelPairing()
        await h.setActive(false)
    }
}
