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
        let denied = FakeGateway(behavior: .denied(reason: "this pairing link expired or was already used; make a new one on the Host"))
        #expect(try await connection(denied).handshake(setupToken: Self.token)
            == .denied(reason: "this pairing link expired or was already used; make a new one on the Host"))
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
}
