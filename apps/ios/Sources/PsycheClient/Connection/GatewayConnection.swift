import Foundation
import PsycheShared
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireEventFrame
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import struct PsycheProtocol.WireResFrame
import enum PsycheProtocol.WireFrame
import struct PsycheProtocol.WireConnectParams
import struct PsycheProtocol.WireProtocolRange
import struct PsycheProtocol.WireConnectChallenge
import struct PsycheProtocol.WireConnectVerifyParams
import struct PsycheProtocol.WireConnectResult
import enum PsycheProtocol.WireProtocol
import PsycheWire

/// What went wrong on one connection.
public enum ConnectionFailure: Error, Equatable, Sendable {
    /// The Gateway that answered is not the one pinned. Never retried (companion M1 acceptance 2).
    case identityMismatch(IdentityCheck.Failure)
    case transport(String)
    case timeout
    case closed
    case protocolError(String)
    /// The Gateway answered the request with an error.
    case remote(WireError)
}

/// The Gateway-identity checks that run before this phone signs anything (remote-gateway design §3.3).
public enum IdentityCheck {
    public enum Failure: Error, Equatable, Sendable {
        case missingKey, keyChanged, badSignature, originMismatch
        /// A self-signed LAN certificate was served but the challenge does not vouch for one.
        case certMissing
        /// The Gateway key's signature over the certificate is not valid.
        case certInvalid
        /// The certificate this connection presented is not the one the Gateway vouched for, or not the pinned one.
        case certChanged
    }

    /// What this phone holds about the Gateway. A key, once pinned, wins; before that the link's fingerprint decides.
    public struct Pin: Equatable, Sendable {
        public var key: String?
        public var fingerprint: String?
        public var certSPKI: String?
        public init(key: String? = nil, fingerprint: String? = nil, certSPKI: String? = nil) {
            self.key = key
            self.fingerprint = fingerprint
            self.certSPKI = certSPKI
        }

        public init(endpoint: GatewayEndpoint) {
            self.init(
                key: endpoint.identityKey.isEmpty ? nil : endpoint.identityKey,
                fingerprint: endpoint.linkFingerprint, certSPKI: endpoint.lanCertSpki)
        }
    }

    /// What the checks established, to be stored once the connection reaches pending or paired.
    public struct Proven: Equatable, Sendable {
        public var key: String
        /// The LAN certificate's SPKI pin, when a self-signed certificate was accepted on this connection.
        public var certSPKI: String?
    }

    /// In order: the challenge carries a key and signature; `serverOrigin` is the origin we dialed; the key is the
    /// pinned key (or hashes to the link's fingerprint, when none is pinned yet); the signature over
    /// `{nonce, serverOrigin, devicePublicKey}` verifies. Then, when the TLS certificate was self-signed (a LAN
    /// Gateway), the challenge must carry the SPKI the Gateway says it served and its signature of that SPKI, and
    /// it must be the certificate this connection actually presented and the pinned one. Nothing is signed or
    /// sent unless all of this holds.
    public static func verify(
        challenge: WireConnectChallenge, pin: Pin, dialedOrigin: String, devicePublicKey: String,
        certificate: PeerCertificate? = nil
    ) -> Result<Proven, Failure> {
        guard let key = challenge.gatewayKey, let signature = challenge.gatewaySignature else { return .failure(.missingKey) }
        guard challenge.serverOrigin == dialedOrigin else { return .failure(.originMismatch) }
        if let pinned = pin.key {
            guard key == pinned else { return .failure(.keyChanged) }
        } else {
            // First connect: the link named the Gateway by the hash of its key. No pin at all fails closed.
            guard let expected = pin.fingerprint, PairingLink.fingerprint(ofKey: key) == expected else {
                return .failure(.keyChanged)
            }
        }
        guard GatewaySigning.verify(
            signature: signature, gatewayKey: key, nonce: challenge.nonce,
            serverOrigin: challenge.serverOrigin, devicePublicKey: devicePublicKey)
        else { return .failure(.badSignature) }
        var certSPKI: String?
        if case .selfSigned(let observed)? = certificate {
            guard let vouched = challenge.lanCertSpki, let certSignature = challenge.lanCertSignature else {
                return .failure(.certMissing)
            }
            guard LanCertSigning.verify(
                signature: certSignature, gatewayKey: key, nonce: challenge.nonce, serverOrigin: challenge.serverOrigin,
                devicePublicKey: devicePublicKey, spki: vouched)
            else { return .failure(.certInvalid) }
            guard vouched == observed else { return .failure(.certChanged) }
            if let pinned = pin.certSPKI, pinned != observed { return .failure(.certChanged) }
            certSPKI = observed
        }
        return .success(Proven(key: key, certSPKI: certSPKI))
    }
}

/// One WebSocket to the Gateway: handshake with identity verification, typed calls with id
/// correlation and timeouts, and the event stream with `seq` and `stateVersion` tracking.
/// A new instance per connection attempt; `GatewayClient` owns the lifetime and the retries.
public actor GatewayConnection {
    public enum Outcome: Equatable, Sendable {
        case paired(deviceID: String, scopes: [String], stateVersion: Int)
        case pending(code: String)
        /// `setupTokenInvalid` is the Gateway's machine-readable `code`: the pairing link was used, expired or revoked.
        case denied(reason: String, setupTokenInvalid: Bool = false)
    }

    public nonisolated let events: AsyncStream<WireEventFrame>
    private let eventSink: AsyncStream<WireEventFrame>.Continuation

    private let endpoint: GatewayEndpoint
    private let identity: DeviceIdentity
    private let deviceName: String
    private let transport: any WebSocketTransport
    private let onClose: @Sendable (ConnectionFailure) -> Void

    private struct Pending {
        let continuation: CheckedContinuation<WireResFrame, any Error>
        let timer: Task<Void, Never>
    }

    private var pending: [String: Pending] = [:]
    private var nextID = 0
    private var receiver: Task<Void, Never>?
    private var closed = false

    /// The key (and LAN certificate) the Gateway proved in the last handshake; set before anything was signed.
    public private(set) var proven: IdentityCheck.Proven?
    public private(set) var lastSeq: Int?
    public private(set) var stateVersion: Int?

    public init(
        endpoint: GatewayEndpoint, identity: DeviceIdentity, deviceName: String,
        transport: any WebSocketTransport, onClose: @escaping @Sendable (ConnectionFailure) -> Void = { _ in }
    ) {
        self.endpoint = endpoint
        self.identity = identity
        self.deviceName = deviceName
        self.transport = transport
        self.onClose = onClose
        (events, eventSink) = AsyncStream.makeStream(bufferingPolicy: .unbounded)
    }

    // MARK: - Handshake

    /// Runs `connect` and `connect.verify`. Nothing is signed or sent beyond `connect` until the
    /// challenge proves the pinned Gateway answered. `setupToken` rides in `connect.verify` only, only
    /// together with `gatewayKey`, and only on the first connect of a pairing.
    public func handshake(setupToken: String?, timeout: Duration = .seconds(15)) async throws -> Outcome {
        startReceiving()
        let params = WireConnectParams(
            protocolVersion: WireProtocolRange(min: WireProtocol.version, max: WireProtocol.version),
            deviceId: identity.deviceId, publicKey: identity.publicKey, role: "client", platform: "ios",
            deviceFamily: "ios", name: String(deviceName.prefix(64)).isEmpty ? "iPhone" : String(deviceName.prefix(64)))
        let challengeJSON = try await call("connect", params: try JSONValue(encoding: params), timeout: timeout)
        let challenge: WireConnectChallenge
        do { challenge = try challengeJSON.decode(as: WireConnectChallenge.self) } catch {
            throw ConnectionFailure.protocolError("bad challenge")
        }
        let verified = IdentityCheck.verify(
            challenge: challenge, pin: IdentityCheck.Pin(endpoint: endpoint), dialedOrigin: endpoint.url,
            devicePublicKey: identity.publicKey, certificate: transport.peerCertificate)
        let proof: IdentityCheck.Proven
        switch verified {
        case .failure(let failure):
            close(reason: .identityMismatch(failure))
            throw ConnectionFailure.identityMismatch(failure)
        case .success(let value): proof = value
        }
        proven = proof
        let signed = ConnectSigning.payload(
            nonce: challenge.nonce, platform: "ios", deviceFamily: "ios",
            protocolVersion: challenge.protocolVersion, serverOrigin: challenge.serverOrigin,
            gatewayKey: proof.key)
        let verify = WireConnectVerifyParams(
            nonce: challenge.nonce, signature: try identity.sign(signed), gatewayKey: proof.key,
            setupToken: setupToken)
        let resultJSON = try await call("connect.verify", params: try JSONValue(encoding: verify), timeout: timeout)
        let result: WireConnectResult
        do { result = try resultJSON.decode(as: WireConnectResult.self) } catch {
            throw ConnectionFailure.protocolError("bad connect result")
        }
        switch result.phase {
        case "paired":
            stateVersion = result.stateVersion
            return .paired(
                deviceID: result.deviceId ?? identity.deviceId, scopes: result.scopes ?? [],
                stateVersion: result.stateVersion ?? 0)
        case "pending": return .pending(code: result.code ?? "")
        default: return .denied(reason: result.reason ?? "denied", setupTokenInvalid: result.code == "setup_token_invalid")
        }
    }

    // MARK: - Calls

    /// A request and its response payload. Throws `ConnectionFailure.remote` for an error response.
    public func call(
        _ method: String, params: JSONValue? = nil, idempotencyKey: String? = nil, timeout: Duration = .seconds(20)
    ) async throws -> JSONValue {
        if closed { throw ConnectionFailure.closed }
        nextID += 1
        let id = "r\(nextID)"
        let frame = WireReqFrame(id: id, method: method, params: params, idempotencyKey: idempotencyKey)
        let data = try WireFrame.req(frame).encode()
        guard data.count <= WireProtocol.maxFrameBytes else { throw ConnectionFailure.protocolError("request too large") }
        let response: WireResFrame = try await withCheckedThrowingContinuation { continuation in
            let timer = Task { [weak self] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                await self?.expire(id)
            }
            pending[id] = Pending(continuation: continuation, timer: timer)
            Task { [transport] in
                do { try await transport.send(data) } catch {
                    self.fail(id, with: .transport(String(describing: error)))
                }
            }
        }
        if response.ok { return response.payload ?? .null }
        throw ConnectionFailure.remote(response.error ?? WireError(code: "unknown", message: "The Gateway refused."))
    }

    public func call<R: Decodable & Sendable>(
        _ method: String, params: JSONValue? = nil, idempotencyKey: String? = nil,
        timeout: Duration = .seconds(20), as type: R.Type
    ) async throws -> R {
        let payload = try await call(method, params: params, idempotencyKey: idempotencyKey, timeout: timeout)
        do { return try payload.decode(as: R.self) } catch {
            throw ConnectionFailure.protocolError("\(method): unexpected result")
        }
    }

    public func close() { close(reason: .closed) }

    // MARK: - Plumbing

    private func startReceiving() {
        guard receiver == nil else { return }
        receiver = Task { [transport] in
            do {
                while !Task.isCancelled {
                    let data = try await transport.receive()
                    self.handle(data)
                }
            } catch {
                self.close(reason: .transport(String(describing: error)), notify: true)
            }
        }
    }

    private func handle(_ data: Data) {
        guard let frame = try? WireFrame.decode(data) else { return }
        switch frame {
        case .res(let res):
            guard let entry = pending.removeValue(forKey: res.id) else { return }
            entry.timer.cancel()
            entry.continuation.resume(returning: res)
        case .event(let event):
            lastSeq = event.seq
            stateVersion = max(stateVersion ?? 0, event.stateVersion)
            eventSink.yield(event)
        case .req:
            break  // The Gateway does not call the phone in M1.
        }
    }

    private func expire(_ id: String) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.continuation.resume(throwing: ConnectionFailure.timeout)
    }

    private func fail(_ id: String, with failure: ConnectionFailure) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timer.cancel()
        entry.continuation.resume(throwing: failure)
    }

    private func close(reason: ConnectionFailure, notify: Bool = false) {
        guard !closed else { return }
        closed = true
        receiver?.cancel()
        transport.close()
        for (_, entry) in pending {
            entry.timer.cancel()
            entry.continuation.resume(throwing: reason)
        }
        pending.removeAll()
        eventSink.finish()
        if notify { onClose(reason) }
    }
}
