import CryptoKit
import Darwin
import Foundation
import PsycheHelperCore
import PsycheProtocol
import Testing

/// Minimal fake Gateway on the other end of a socketpair.
private func fakeGateway(fd: Int32, phase: String) -> Foundation.Thread {
    let thread = Foundation.Thread {
        let conn = UnixSocketConnection(fd: fd)
        var buf = NDJSONLineBuffer()
        var lines: [Data] = []
        let deadline = Date().addingTimeInterval(5)
        func next() -> WireReqFrame? {
            while lines.isEmpty {
                guard let chunk = try? conn.read(before: deadline), let got = try? buf.append(chunk) else { return nil }
                lines.append(contentsOf: got)
            }
            if case .req(let req)? = try? WireFrame.decode(lines.removeFirst()) { return req }
            return nil
        }
        func reply(_ id: String, _ payload: JSONValue) {
            let frame = WireFrame.res(WireResFrame(id: id, ok: true, payload: payload))
            try? conn.write(NDJSONLineBuffer.line(for: frame.encode()))
        }
        guard let connect = next(), connect.method == "connect",
              let params = try? connect.params?.decode(as: WireConnectParams.self)
        else { return }
        let nonce = Base64URL.encode(Data(repeating: 9, count: 32))
        reply("connect", .object([
            "phase": .string("challenge"), "nonce": .string(nonce),
            "serverOrigin": .string("http://127.0.0.1:7979"), "protocolVersion": .number(1),
            "expiresAt": .string("2026-01-01T00:00:00.000Z"),
        ]))
        guard let verify = next(), verify.method == "connect.verify",
              let vp = try? verify.params?.decode(as: WireConnectVerifyParams.self),
              let rawKey = Base64URL.decode(params.publicKey),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: rawKey),
              let sig = Base64URL.decode(vp.signature)
        else { return }
        let payload = ConnectSigning.payload(
            nonce: nonce, platform: params.platform, deviceFamily: params.deviceFamily, protocolVersion: 1,
            serverOrigin: "http://127.0.0.1:7979"
        )
        let ok = vp.nonce == nonce && key.isValidSignature(sig, for: payload)
            && params.role == "node" && params.deviceFamily == "mac-helper" && params.platform == "macos"
            && params.capabilities == []
        reply("connect.verify", .object(["phase": .string(ok ? phase : "denied"), "reason": .string("bad")]))
    }
    thread.start()
    return thread
}

@Suite("node handshake")
struct HandshakeTests {
    @Test func completesConnectAndVerifyAgainstAFakeGateway() throws {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        _ = fakeGateway(fd: fds[1], phase: "paired")
        let client = NodeHandshakeClient(
            identity: DeviceIdentity(),
            options: NodeHandshakeOptions(timeout: 5, handshakeSecret: "s"),
            log: HelperLog(echo: { _ in })
        )
        let outcome = try client.run(on: UnixSocketConnection(fd: fds[0]))
        #expect(outcome == .result(phase: "paired"))
    }

    @Test func challengeOnlyStopsAfterTheChallenge() throws {
        var fds: [Int32] = [0, 0]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        _ = fakeGateway(fd: fds[1], phase: "paired")
        let client = NodeHandshakeClient(
            identity: DeviceIdentity(),
            options: NodeHandshakeOptions(timeout: 5, verify: false),
            log: HelperLog(echo: { _ in })
        )
        #expect(try client.run(on: UnixSocketConnection(fd: fds[0])) == .challengeOnly(nonceBytes: 32, protocolVersion: 1))
    }

    @Test func connectParamsAreANodeWithNoCapabilities() throws {
        let client = NodeHandshakeClient(identity: DeviceIdentity(), options: NodeHandshakeOptions())
        let params = client.connectParams()
        #expect(params.role == "node" && params.platform == "macos" && params.deviceFamily == "mac-helper")
        #expect(params.capabilities == [] && params.protocolVersion == WireProtocolRange(min: 1, max: 1))
        #expect(params.handshakeSecret == nil)
        let json = try JSONValue(encoding: params)
        #expect(json["capabilities"] == .array([]))
        #expect(json["handshakeSecret"] == nil)
    }

    @Test func missingSocketHasAClearError() {
        let path = NSTemporaryDirectory() + "psyche-missing-\(UUID().uuidString).sock"
        #expect(throws: NodeSocketError.socketMissing(path: path)) { try UnixSocketConnection(path: path) }
        #expect(NodeSocketError.socketMissing(path: path).description.contains("PSYCHE_NODE_SOCKET"))
    }

    @Test func socketPathFollowsTheEnvironment() {
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_NODE_SOCKET": "/x/n.sock"]) == "/x/n.sock")
        #expect(HelperPaths.nodeSocketPath(environment: ["PSYCHE_HOME": "/h"]) == "/h/run/node.sock")
        #expect(HelperPaths.handshakeSecretPath(environment: ["PSYCHE_HOME": "/h"]) == "/h/run/handshake.secret")
    }
}
