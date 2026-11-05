import CryptoKit
import Foundation
import PsycheClient
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireReqFrame
import enum PsycheProtocol.WireFrame
import struct PsycheProtocol.WireResFrame
import struct PsycheProtocol.WireEventFrame
import struct PsycheProtocol.WireError
import PsycheShared
import PsycheWire

/// A scripted Gateway for tests: answers `connect` with a properly signed challenge (unless told to
/// lie), then `connect.verify` per `behavior`, then any other method from `handlers`.
final class FakeGateway: @unchecked Sendable {
    enum Behavior: Sendable {
        case paired(stateVersion: Int)
        case pending(code: String)
        case denied(reason: String, setupTokenInvalid: Bool = false, code: String? = nil)
    }
    enum Lie: Sendable { case none, wrongKey, badSignature, wrongOrigin, noKey }
    /// What the challenge gets wrong beyond identity: fields `connectSigningPayload` refuses, or an expired challenge.
    enum Malform: Sendable { case none, emptyNonce, newlineInNonce, protocolZero, protocolTwo, expired }
    /// What the challenge says about the TLS certificate when the transport reports a self-signed one.
    enum Vouch: Sendable { case valid, omitted, badSignature, otherCertificate }

    /// The Gateway identity key every test pins. Seed = 32 bytes of 0x07.
    static let key = try! Curve25519.Signing.PrivateKey(rawRepresentation: Data(repeating: 7, count: 32))
    static var publicKey: String { Base64URL.encode(key.publicKey.rawRepresentation) }
    static let origin = "https://studio-mac.tail1234.ts.net"
    static let nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

    private let lock = NSLock()
    private var _behavior: Behavior
    private var _lie: Lie
    private var _malform: Malform = .none
    private var _received: [WireReqFrame] = []
    private var _handlers: [String: @Sendable (WireReqFrame) -> Result<JSONValue, WireError>] = [:]
    private var _transports: [FakeTransport] = []
    private var _connects = 0
    private var _dropConnections = false
    private var _pingHangs = false
    private var _pings = 0
    private var _certificate: PeerCertificate? = .trusted
    private var _vouch: Vouch = .valid

    /// The key this Gateway signs with (a second Gateway in a test has its own).
    let identity: Curve25519.Signing.PrivateKey
    var publicKey: String { Base64URL.encode(identity.publicKey.rawRepresentation) }

    init(behavior: Behavior = .paired(stateVersion: 1), lie: Lie = .none, identity: Curve25519.Signing.PrivateKey = FakeGateway.key) {
        _behavior = behavior
        _lie = lie
        self.identity = identity
    }

    var behavior: Behavior { get { lock.withLock { _behavior } } set { lock.withLock { _behavior = newValue } } }
    var malform: Malform { get { lock.withLock { _malform } } set { lock.withLock { _malform = newValue } } }
    var lie: Lie { get { lock.withLock { _lie } } set { lock.withLock { _lie = newValue } } }
    var received: [WireReqFrame] { lock.withLock { _received } }
    var connectCount: Int { lock.withLock { _connects } }
    /// While true, new sockets fail at once (the Gateway is off).
    var down: Bool { get { lock.withLock { _dropConnections } } set { lock.withLock { _dropConnections = newValue } } }

    /// While true, a WebSocket ping never gets an answer and ignores cancellation (a half-open socket).
    var pingHangs: Bool { get { lock.withLock { _pingHangs } } set { lock.withLock { _pingHangs = newValue } } }
    var pingCount: Int { lock.withLock { _pings } }
    func notePing() { lock.withLock { _pings += 1 } }

    /// What every transport of this Gateway reports as the certificate it was given (nil: no TLS to report).
    var certificate: PeerCertificate? { get { lock.withLock { _certificate } } set { lock.withLock { _certificate = newValue } } }
    var vouch: Vouch { get { lock.withLock { _vouch } } set { lock.withLock { _vouch = newValue } } }

    func on(_ method: String, _ handler: @escaping @Sendable (WireReqFrame) -> Result<JSONValue, WireError>) {
        lock.withLock { _handlers[method] = handler }
    }

    func makeTransport() -> FakeTransport {
        let t = FakeTransport(gateway: self)
        lock.withLock { _transports.append(t) }
        return t
    }

    /// The most recent socket, to push events or close it.
    var lastTransport: FakeTransport? { lock.withLock { _transports.last } }

    func handle(_ req: WireReqFrame, on transport: FakeTransport) {
        lock.withLock { _received.append(req) }
        switch req.method {
        case "connect":
            lock.withLock { _connects += 1 }
            let devicePub = req.params?["publicKey"]?.stringValue ?? ""
            let malform = self.malform
            var nonce = Self.nonce
            if malform == .emptyNonce { nonce = "" }
            if malform == .newlineInNonce { nonce = Self.nonce + "\nX" }
            var origin = Self.origin
            var key = publicKey
            let lie = self.lie
            if lie == .wrongOrigin { origin = "https://evil.example" }
            let signedOrigin = lie == .wrongOrigin ? origin : Self.origin
            var payload = GatewaySigning.payload(nonce: nonce, serverOrigin: signedOrigin, devicePublicKey: devicePub)
            if lie == .badSignature { payload = Data("tampered".utf8) }
            let signer = lie == .wrongKey ? Curve25519.Signing.PrivateKey() : identity
            if lie == .wrongKey { key = Base64URL.encode(signer.publicKey.rawRepresentation) }
            let signature = Base64URL.encode(try! signer.signature(for: payload))
            var body: [String: JSONValue] = [
                "phase": "challenge", "nonce": .string(nonce), "serverOrigin": .string(origin),
                "protocolVersion": .number(malform == .protocolZero ? 0 : malform == .protocolTwo ? 2 : 1),
                "expiresAt": .string(malform == .expired ? "2020-01-01T00:00:00Z" : "2030-01-01T00:00:00Z"),
            ]
            if lie != .noKey {
                body["gatewayKey"] = .string(key)
                body["gatewaySignature"] = .string(signature)
            }
            if case .selfSigned(let seen)? = certificate, lie != .noKey, vouch != .omitted {
                let spki = vouch == .otherCertificate ? Base64URL.encode(Data(repeating: 1, count: 32)) : seen
                var certPayload = LanCertSigning.payload(
                    nonce: nonce, serverOrigin: signedOrigin, devicePublicKey: devicePub, spki: spki)
                if vouch == .badSignature { certPayload = Data("tampered".utf8) }
                body["lanCertSpki"] = .string(spki)
                body["lanCertSignature"] = .string(Base64URL.encode(try! signer.signature(for: certPayload)))
            }
            transport.reply(req.id, .success(.object(body)))
        case "connect.verify":
            let result: JSONValue
            switch behavior {
            case .paired(let v):
                result = .object(["phase": "paired", "deviceId": "dev_test", "scopes": .array(["operator.read"]),
                                  "stateVersion": .number(Double(v)), "serverTime": "2030-01-01T00:00:00Z"])
            case .pending(let code): result = .object(["phase": "pending", "pairingRequestId": "pr_1", "code": .string(code)])
            case .denied(let reason, let tokenInvalid, let code):
                var body: [String: JSONValue] = ["phase": "denied", "reason": .string(reason)]
                if tokenInvalid { body["code"] = "setup_token_invalid" } else if let code { body["code"] = .string(code) }
                result = .object(body)
            }
            transport.reply(req.id, .success(result))
        default:
            let handler = lock.withLock { _handlers[req.method] }
            if let handler {
                transport.reply(req.id, handler(req))
            } else if !req.method.hasPrefix("silent.") {
                transport.reply(req.id, .failure(WireError(code: "unknown_method", message: "no such method")))
            }
            // "silent.*" methods are never answered, so tests can exercise timeouts.
        }
    }
}

final class FakeTransport: WebSocketTransport, @unchecked Sendable {
    private let gateway: FakeGateway
    private let inbox: AsyncStream<Data>
    private let sink: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator
    private let lock = NSLock()
    private(set) var closedByClient = false

    init(gateway: FakeGateway) {
        self.gateway = gateway
        (inbox, sink) = AsyncStream.makeStream()
        iterator = inbox.makeAsyncIterator()
        if gateway.down { sink.finish() }
    }

    var peerCertificate: PeerCertificate? { gateway.certificate }

    func send(_ frame: Data) async throws {
        if gateway.down { throw TransportClosed() }
        guard case .req(let req)? = try? WireFrame.decode(frame) else { return }
        gateway.handle(req, on: self)
    }

    func receive() async throws -> Data {
        // One reader at a time (the connection's receive loop).
        var it = lock.withLock { iterator }
        guard let next = await it.next() else { throw TransportClosed() }
        lock.withLock { iterator = it }
        return next
    }

    func ping() async throws {
        gateway.notePing()
        if gateway.pingHangs { await withCheckedContinuation { (_: CheckedContinuation<Void, Never>) in } }
    }

    func close() {
        lock.withLock { closedByClient = true }
        sink.finish()
    }

    /// The Gateway closes the socket (sleep, restart, revoke).
    func dropFromGatewaySide() { sink.finish() }

    func reply(_ id: String, _ result: Result<JSONValue, WireError>) {
        let frame: WireResFrame
        switch result {
        case .success(let payload): frame = WireResFrame(id: id, ok: true, payload: payload)
        case .failure(let error): frame = WireResFrame(id: id, ok: false, error: error)
        }
        if let data = try? WireFrame.res(frame).encode() { sink.yield(data) }
    }

    func push(event: String, payload: JSONValue, seq: Int, stateVersion: Int) {
        let frame = WireEventFrame(event: event, payload: payload, seq: seq, stateVersion: stateVersion)
        if let data = try? WireFrame.event(frame).encode() { sink.yield(data) }
    }
}
