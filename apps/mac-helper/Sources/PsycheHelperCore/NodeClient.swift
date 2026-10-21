import Foundation
import os
import PsycheProtocol

/// Structured, content-free logging (architecture §14, ADR-017): phases and sizes only.
public struct HelperLog: Sendable {
    private let logger = Logger(subsystem: "com.psyche.helper", category: "node")
    private let echo: @Sendable (String) -> Void

    public init(echo: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data("psyche-helper: \($0)\n".utf8)) }) {
        self.echo = echo
    }

    public func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        echo(message)
    }

    public func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        echo(message)
    }
}

public struct NodeHandshakeOptions: Sendable {
    public var timeout: TimeInterval
    /// Sign the challenge and send `connect.verify`. When false, stop after logging the challenge.
    public var verify: Bool
    /// The per-launch secret from `$PSYCHE_HOME/run/handshake.secret`, for loopback auto-pairing.
    public var handshakeSecret: String?
    public var name: String
    /// `NodeCapability[]` declared at `connect` (the capability manifest).
    public var capabilities: [JSONValue]

    public init(
        timeout: TimeInterval = 10, verify: Bool = true, handshakeSecret: String? = nil, name: String = "Psyche (Helper)",
        capabilities: [JSONValue] = []
    ) {
        self.timeout = timeout
        self.verify = verify
        self.handshakeSecret = handshakeSecret
        self.name = name
        self.capabilities = capabilities
    }
}

public enum NodeHandshakeOutcome: Sendable, Equatable {
    case challengeOnly(nonceBytes: Int, protocolVersion: Int)
    case result(phase: String)
}

public enum NodeHandshakeError: Error, Equatable, CustomStringConvertible {
    case gateway(code: String)
    case unexpectedFrame

    public var description: String {
        switch self {
        case .gateway(let code): return "Gateway refused the handshake: \(code)"
        case .unexpectedFrame: return "Unexpected frame from the Gateway"
        }
    }
}

/// Node-side `connect` → challenge → `connect.verify` over the NDJSON node socket (wire spec v1).
/// The helper connects as `role: "node"`, `platform: "macos"`, `deviceFamily: "mac-helper"` and
/// declares its capability manifest in `capabilities`.
public struct NodeHandshakeClient {
    public static let platform = "macos"
    public static let deviceFamily = "mac-helper"

    public let identity: DeviceIdentity
    public let options: NodeHandshakeOptions
    public let log: HelperLog

    public init(identity: DeviceIdentity, options: NodeHandshakeOptions, log: HelperLog = HelperLog()) {
        self.identity = identity
        self.options = options
        self.log = log
    }

    public func connectParams() -> WireConnectParams {
        WireConnectParams(
            protocolVersion: WireProtocolRange(min: 1, max: WireProtocol.version),
            deviceId: identity.deviceId,
            publicKey: identity.publicKey,
            role: "node",
            platform: Self.platform,
            deviceFamily: Self.deviceFamily,
            name: options.name,
            capabilities: options.capabilities,
            handshakeSecret: options.handshakeSecret
        )
    }

    public func run(on socket: UnixSocketConnection) throws -> NodeHandshakeOutcome {
        try run(on: FrameChannel(socket: socket))
    }

    public func run(on channel: FrameChannel) throws -> NodeHandshakeOutcome {
        switch try perform(on: channel) {
        case .challengeOnly(let nonceBytes, let version): return .challengeOnly(nonceBytes: nonceBytes, protocolVersion: version)
        case .completed(let result): return .result(phase: result.phase)
        }
    }

    public enum Completion: Sendable {
        case challengeOnly(nonceBytes: Int, protocolVersion: Int)
        case completed(WireConnectResult)
    }

    /// Runs the handshake on `channel`. Frames that arrive after `connect.verify` stay queued in the
    /// channel for the serve loop.
    public func perform(on channel: FrameChannel) throws -> Completion {
        let deadline = Date().addingTimeInterval(options.timeout)

        func awaitResponse(id: String) throws -> WireResFrame {
            while true {
                guard let frame = try channel.readFrame(before: deadline) else { throw NodeSocketError.closedByPeer }
                if case .res(let res) = frame, res.id == id { return res }
                // Events or Gateway requests before pairing are ignored here.
            }
        }

        log.info("phase=connecting role=node deviceFamily=\(Self.deviceFamily) capabilities=\(options.capabilities.count)")
        try channel.send(.req(WireReqFrame(id: "connect", method: "connect", params: try JSONValue(encoding: connectParams()))))

        let connectRes = try awaitResponse(id: "connect")
        guard connectRes.ok, let payload = connectRes.payload else {
            throw NodeHandshakeError.gateway(code: connectRes.error?.code ?? "unknown")
        }
        let challenge = try payload.decode(as: WireConnectChallenge.self)
        guard challenge.phase == "challenge" else { throw NodeHandshakeError.unexpectedFrame }
        let nonceBytes = Base64URL.decode(challenge.nonce)?.count ?? 0
        log.info("phase=challenge nonceBytes=\(nonceBytes) protocolVersion=\(challenge.protocolVersion)")
        guard options.verify else {
            return .challengeOnly(nonceBytes: nonceBytes, protocolVersion: challenge.protocolVersion)
        }

        let signingPayload = ConnectSigning.payload(
            nonce: challenge.nonce,
            platform: Self.platform,
            deviceFamily: Self.deviceFamily,
            protocolVersion: challenge.protocolVersion,
            serverOrigin: challenge.serverOrigin
        )
        let verify = WireConnectVerifyParams(nonce: challenge.nonce, signature: try identity.sign(signingPayload))
        log.info("phase=verifying")
        try channel.send(.req(WireReqFrame(id: "connect.verify", method: "connect.verify", params: try JSONValue(encoding: verify))))

        let verifyRes = try awaitResponse(id: "connect.verify")
        guard verifyRes.ok, let resultPayload = verifyRes.payload else {
            throw NodeHandshakeError.gateway(code: verifyRes.error?.code ?? "unknown")
        }
        let result = try resultPayload.decode(as: WireConnectResult.self)
        log.info("phase=\(result.phase)")
        return .completed(result)
    }
}
