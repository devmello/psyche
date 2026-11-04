import Foundation

// Hand-written wire envelopes for docs/archive/plans/s00.md "Wire spec v1". Names carry a `Wire` prefix so
// they never collide with the generated models in PsycheProtocol.generated.swift.

/// Any JSON value, for `params` / `payload` / `details`.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Round-trips any `Encodable` through JSON.
    public init(encoding value: some Encodable) throws {
        let data = try JSONEncoder().encode(value)
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Decodes this value as `T` (via JSON).
    public func decode<T: Decodable>(as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(self))
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}

public struct WireError: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var details: JSONValue?
    public var retryable: Bool?

    public init(code: String, message: String, details: JSONValue? = nil, retryable: Bool? = nil) {
        self.code = code
        self.message = message
        self.details = details
        self.retryable = retryable
    }
}

/// `{ type: "req", id, method, params?, idempotencyKey? }`
public struct WireReqFrame: Codable, Sendable, Equatable {
    public var type: String = "req"
    public var id: String
    public var method: String
    public var params: JSONValue?
    public var idempotencyKey: String?

    public init(id: String, method: String, params: JSONValue? = nil, idempotencyKey: String? = nil) {
        self.id = id
        self.method = method
        self.params = params
        self.idempotencyKey = idempotencyKey
    }
}

/// `{ type: "res", id, ok: true, payload }` or `{ type: "res", id, ok: false, error }`
public struct WireResFrame: Codable, Sendable, Equatable {
    public var type: String = "res"
    public var id: String
    public var ok: Bool
    public var payload: JSONValue?
    public var error: WireError?

    public init(id: String, ok: Bool, payload: JSONValue? = nil, error: WireError? = nil) {
        self.id = id
        self.ok = ok
        self.payload = payload
        self.error = error
    }
}

/// `{ type: "event", event, payload, seq, stateVersion }`
public struct WireEventFrame: Codable, Sendable, Equatable {
    public var type: String = "event"
    public var event: String
    public var payload: JSONValue
    public var seq: Int
    public var stateVersion: Int

    public init(event: String, payload: JSONValue, seq: Int, stateVersion: Int) {
        self.event = event
        self.payload = payload
        self.seq = seq
        self.stateVersion = stateVersion
    }
}

public enum WireFrame: Sendable, Equatable {
    case req(WireReqFrame)
    case res(WireResFrame)
    case event(WireEventFrame)

    public enum DecodeError: Error, Equatable {
        case unknownType(String)
    }

    private struct TypeProbe: Decodable { let type: String }

    public static func decode(_ data: Data) throws -> WireFrame {
        let decoder = JSONDecoder()
        let probe = try decoder.decode(TypeProbe.self, from: data)
        switch probe.type {
        case "req": return .req(try decoder.decode(WireReqFrame.self, from: data))
        case "res": return .res(try decoder.decode(WireResFrame.self, from: data))
        case "event": return .event(try decoder.decode(WireEventFrame.self, from: data))
        default: throw DecodeError.unknownType(probe.type)
        }
    }

    public func encode() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        switch self {
        case .req(let f): return try encoder.encode(f)
        case .res(let f): return try encoder.encode(f)
        case .event(let f): return try encoder.encode(f)
        }
    }
}

public struct WireProtocolRange: Codable, Sendable, Equatable {
    public var min: Int
    public var max: Int
    public init(min: Int, max: Int) {
        self.min = min
        self.max = max
    }
}

/// `ConnectParams` (first frame on any connection).
public struct WireConnectParams: Codable, Sendable, Equatable {
    public var protocolVersion: WireProtocolRange
    public var deviceId: String
    /// base64url raw 32-byte Ed25519 public key.
    public var publicKey: String
    public var role: String
    public var platform: String
    public var deviceFamily: String
    public var name: String
    public var capabilities: [JSONValue]?
    public var handshakeSecret: String?

    public init(
        protocolVersion: WireProtocolRange, deviceId: String, publicKey: String, role: String,
        platform: String, deviceFamily: String, name: String, capabilities: [JSONValue]? = nil,
        handshakeSecret: String? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.deviceId = deviceId
        self.publicKey = publicKey
        self.role = role
        self.platform = platform
        self.deviceFamily = deviceFamily
        self.name = name
        self.capabilities = capabilities
        self.handshakeSecret = handshakeSecret
    }
}

/// Result of `connect`: `{ phase: "challenge", nonce, serverOrigin, protocolVersion, expiresAt }`.
public struct WireConnectChallenge: Codable, Sendable, Equatable {
    public var phase: String
    public var nonce: String
    public var serverOrigin: String
    public var protocolVersion: Int
    public var expiresAt: String
}

/// `connect.verify` params.
public struct WireConnectVerifyParams: Codable, Sendable, Equatable {
    public var nonce: String
    public var signature: String
    public init(nonce: String, signature: String) {
        self.nonce = nonce
        self.signature = signature
    }
}

/// Result of `connect.verify`: paired / pending / denied (fields optional by phase).
public struct WireConnectResult: Codable, Sendable, Equatable {
    public var phase: String
    public var deviceId: String?
    public var scopes: [String]?
    public var nodeId: String?
    public var stateVersion: Int?
    public var serverTime: String?
    public var pairingRequestId: String?
    public var code: String?
    public var reason: String?
}

public enum WireProtocol {
    public static let version = 1
    public static let maxFrameBytes = 1_048_576
}
