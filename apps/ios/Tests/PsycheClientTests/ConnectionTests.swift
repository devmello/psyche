import CryptoKit
import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheShared
import PsycheWire
import Testing

@testable import PsycheClient

struct ConnectionTests {
    static let token = PairingLinkTests.token

    static func endpoint() -> GatewayEndpoint {
        GatewayEndpoint(
            host: "studio-mac.tail1234.ts.net", fingerprint: "AAAA BBBB CCCC", transport: .tailscale,
            url: FakeGateway.origin, identityKey: FakeGateway.publicKey, hostName: "studio-mac")
    }

    /// An endpoint pinned only by the link's fingerprint, as on the first connect of a pairing.
    static func linkOnlyEndpoint(fingerprint: String = PairingLink.fingerprint(ofKey: FakeGateway.publicKey)!) -> GatewayEndpoint {
        GatewayEndpoint(
            host: "studio-mac.local", fingerprint: "AAAA BBBB CCCC", transport: .lan,
            url: FakeGateway.origin, identityKey: "", hostName: "studio-mac", linkFingerprint: fingerprint)
    }

    func connection(_ gateway: FakeGateway) -> GatewayConnection {
        GatewayConnection(
            endpoint: Self.endpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
    }

    @Test func pairsWhenTheGatewayProvesItsKey() async throws {
        let gateway = FakeGateway(behavior: .paired(stateVersion: 12))
        let outcome = try await connection(gateway).handshake(setupToken: nil)
        #expect(outcome == .paired(deviceID: "dev_test", scopes: ["operator.read"], stateVersion: 12))
    }

    @Test func connectVerifyCarriesTheV2SignatureTheGatewayKeyAndTheSetupToken() async throws {
        let gateway = FakeGateway()
        let identity = DeviceIdentity()
        let conn = GatewayConnection(endpoint: Self.endpoint(), identity: identity, deviceName: "iPhone", transport: gateway.makeTransport())
        _ = try await conn.handshake(setupToken: Self.token)
        let verify = try #require(gateway.received.first { $0.method == "connect.verify" })
        let params = try #require(verify.params)
        #expect(params["gatewayKey"]?.stringValue == FakeGateway.publicKey)
        #expect(params["setupToken"]?.stringValue == Self.token)
        // The signature is over the v2 payload and verifies with the device key.
        let payload = ConnectSigning.payload(
            nonce: FakeGateway.nonce, platform: "ios", deviceFamily: "ios", protocolVersion: 1,
            serverOrigin: FakeGateway.origin, gatewayKey: FakeGateway.publicKey)
        let encoded = try #require(params["signature"]?.stringValue)
        let signature = try #require(Base64URL.decode(encoded))
        #expect(identity.privateKey.publicKey.isValidSignature(signature, for: payload))
        // The token is in connect.verify only, never in the first frame.
        let connect = try #require(gateway.received.first { $0.method == "connect" })
        #expect(connect.params?["setupToken"] == nil)
        #expect(connect.params?["platform"]?.stringValue == "ios")
        #expect(connect.params?["role"]?.stringValue == "client")
    }

    @Test(arguments: [
        (FakeGateway.Lie.wrongKey, IdentityCheck.Failure.keyChanged),
        (.badSignature, .badSignature),
        (.wrongOrigin, .originMismatch),
        (.noKey, .missingKey),
    ])
    func refusesAWrongGatewayAndSendsNothingElse(lie: FakeGateway.Lie, failure: IdentityCheck.Failure) async {
        let gateway = FakeGateway(lie: lie)
        let conn = connection(gateway)
        await #expect(throws: ConnectionFailure.identityMismatch(failure)) {
            _ = try await conn.handshake(setupToken: Self.token)
        }
        // connect.verify (and with it the setup token and the device signature) was never sent.
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func reportsPendingWithTheCodeAndDeniedWithTheReason() async throws {
        let pending = FakeGateway(behavior: .pending(code: "482917"))
        #expect(try await connection(pending).handshake(setupToken: nil) == .pending(code: "482917"))
        let denied = FakeGateway(behavior: .denied(reason: "This pairing link was already used, has expired or was revoked.", setupTokenInvalid: true))
        #expect(try await connection(denied).handshake(setupToken: Self.token)
            == .denied(reason: "This pairing link was already used, has expired or was revoked.", setupTokenInvalid: true))
    }

    @Test func callsCorrelateByIdEvenWhenAnsweredOutOfOrder() async throws {
        let gateway = FakeGateway()
        let conn = connection(gateway)
        _ = try await conn.handshake(setupToken: nil)
        gateway.on("threads.list") { _ in .success(.object(["threads": .array([])])) }
        gateway.on("approvals.list") { _ in .success(.object(["approvals": .array([])])) }
        async let a = conn.call("threads.list")
        async let b = conn.call("approvals.list")
        let (ra, rb) = try await (a, b)
        #expect(ra["threads"] != nil && rb["approvals"] != nil)
    }

    @Test func aCallThatIsNeverAnsweredTimesOut() async throws {
        let gateway = FakeGateway()
        let conn = connection(gateway)
        _ = try await conn.handshake(setupToken: nil)
        await #expect(throws: ConnectionFailure.timeout) {
            _ = try await conn.call("silent.method", timeout: .milliseconds(80))
        }
    }

    @Test func aRemoteErrorSurfacesWithItsCode() async throws {
        let gateway = FakeGateway()
        let conn = connection(gateway)
        _ = try await conn.handshake(setupToken: nil)
        gateway.on("threads.get") { _ in .failure(WireError(code: "not_found", message: "no such thread")) }
        await #expect(throws: ConnectionFailure.remote(WireError(code: "not_found", message: "no such thread"))) {
            _ = try await conn.call("threads.get")
        }
    }

    @Test func eventsAreDeliveredAndTracked() async throws {
        let gateway = FakeGateway(behavior: .paired(stateVersion: 3))
        let conn = connection(gateway)
        _ = try await conn.handshake(setupToken: nil)
        gateway.lastTransport?.push(event: "thread.updated", payload: .object([:]), seq: 1, stateVersion: 4)
        gateway.lastTransport?.push(event: "thread.updated", payload: .object([:]), seq: 2, stateVersion: 5)
        var seen = 0
        for await event in conn.events {
            seen += 1
            if event.seq == 2 { break }
        }
        #expect(seen == 2)
        #expect(await conn.lastSeq == 2)
        #expect(await conn.stateVersion == 5)
    }

    @Test func closingFailsPendingCalls() async throws {
        let gateway = FakeGateway()
        let conn = connection(gateway)
        _ = try await conn.handshake(setupToken: nil)
        let pending = Task { try await conn.call("silent.method", timeout: .seconds(5)) }
        try await Task.sleep(for: .milliseconds(30))
        await conn.close()
        await #expect(throws: ConnectionFailure.closed) { _ = try await pending.value }
    }

    // MARK: - Pinning by the link's fingerprint

    @Test func theFirstConnectAcceptsTheKeyThatHashesToTheLinkFingerprintAndReportsIt() async throws {
        let gateway = FakeGateway()
        let conn = GatewayConnection(
            endpoint: Self.linkOnlyEndpoint(), identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
        _ = try await conn.handshake(setupToken: Self.token)
        #expect(await conn.proven == IdentityCheck.Proven(key: FakeGateway.publicKey, certSPKI: nil))
        // The connect is bound to the key the Gateway proved, which the link only named by hash.
        let verify = try #require(gateway.received.first { $0.method == "connect.verify" })
        #expect(verify.params?["gatewayKey"]?.stringValue == FakeGateway.publicKey)
    }

    @Test func aGatewayWhoseKeyDoesNotHashToTheLinkFingerprintGetsNothing() async {
        let gateway = FakeGateway()
        let other = PairingLink.fingerprint(ofKey: Base64URL.encode(Data(repeating: 3, count: 32)))!
        let conn = GatewayConnection(
            endpoint: Self.linkOnlyEndpoint(fingerprint: other), identity: DeviceIdentity(), deviceName: "iPhone",
            transport: gateway.makeTransport())
        await #expect(throws: ConnectionFailure.identityMismatch(.keyChanged)) { _ = try await conn.handshake(setupToken: Self.token) }
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    // MARK: - A self-signed LAN certificate

    static let seenSPKI = Base64URL.encode(Data(repeating: 9, count: 32))

    private func lanConnection(_ gateway: FakeGateway, pinnedSPKI: String? = nil) -> GatewayConnection {
        var endpoint = Self.linkOnlyEndpoint()
        endpoint.lanCertSpki = pinnedSPKI
        return GatewayConnection(endpoint: endpoint, identity: DeviceIdentity(), deviceName: "iPhone", transport: gateway.makeTransport())
    }

    @Test func aLanGatewayThatVouchesForTheCertificateItServedIsAccepted() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.seenSPKI)
        let conn = lanConnection(gateway)
        _ = try await conn.handshake(setupToken: Self.token)
        #expect(await conn.proven == IdentityCheck.Proven(key: FakeGateway.publicKey, certSPKI: Self.seenSPKI))
    }

    @Test(arguments: [
        (FakeGateway.Vouch.omitted, IdentityCheck.Failure.certMissing),
        (.badSignature, .certInvalid),
        (.otherCertificate, .certChanged),
    ])
    func aLanGatewayThatDoesNotVouchForThisCertificateGetsNothing(vouch: FakeGateway.Vouch, failure: IdentityCheck.Failure) async {
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.seenSPKI)
        gateway.vouch = vouch
        let conn = lanConnection(gateway)
        await #expect(throws: ConnectionFailure.identityMismatch(failure)) { _ = try await conn.handshake(setupToken: Self.token) }
        // No setup token and no signature left the phone.
        #expect(gateway.received.map(\.method) == ["connect"])
    }

    @Test func aPinnedCertificateMustBeThePresentedOne() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .selfSigned(spki: Self.seenSPKI)
        let other = Base64URL.encode(Data(repeating: 4, count: 32))
        await #expect(throws: ConnectionFailure.identityMismatch(.certChanged)) {
            _ = try await lanConnection(gateway, pinnedSPKI: other).handshake(setupToken: nil)
        }
        let again = FakeGateway()
        again.certificate = .selfSigned(spki: Self.seenSPKI)
        _ = try await lanConnection(again, pinnedSPKI: Self.seenSPKI).handshake(setupToken: nil)
    }

    @Test func aCertificateTheSystemTrustsNeedsNoVouching() async throws {
        let gateway = FakeGateway()
        gateway.certificate = .trusted
        _ = try await connection(gateway).handshake(setupToken: nil)
    }
}
