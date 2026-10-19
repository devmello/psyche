import Foundation
import PsycheProtocol
import Security

/// TCC permission a capability needs (security §12). Used for preflight before dispatch and for the
/// `permissions.*` capability group.
public enum TCCPermission: String, Codable, Sendable, CaseIterable {
    case accessibility
    case screenRecording
    case automation
    case fullDiskAccess
    case calendars
    case reminders
    case contacts
    case microphone
    case speechRecognition
    case notifications
    case inputMonitoring
}

/// Static description of one capability, as declared in the manifest (architecture §7). Side-effect
/// classes are what the Gateway's Permission Broker gates on, exactly like tools.
public struct CapabilitySpec: Sendable {
    public var name: String
    public var description: String
    public var sideEffect: SideEffect
    public var targetKind: TargetKind?
    public var inputSchema: JSONValue
    public var streaming: Bool
    /// TCC permissions the handler needs before it can run (checked locally, reported on refusal).
    public var permissions: [TCCPermission]
    /// Receipt kind (data model `receipts.kind` vocabulary) for side-effecting calls.
    public var receiptKind: String?

    public init(
        name: String, description: String, sideEffect: SideEffect, targetKind: TargetKind? = nil,
        inputSchema: JSONValue = Schema.object([:]), streaming: Bool = false,
        permissions: [TCCPermission] = [], receiptKind: String? = nil
    ) {
        self.name = name
        self.description = description
        self.sideEffect = sideEffect
        self.targetKind = targetKind
        self.inputSchema = inputSchema
        self.streaming = streaming
        self.permissions = permissions
        self.receiptKind = receiptKind
    }

    /// Wire form (`NodeCapability`).
    public var manifestEntry: JSONValue {
        var o: [String: JSONValue] = [
            "name": .string(name),
            "description": .string(description),
            "sideEffect": .string(sideEffect.rawValue),
            "inputSchema": inputSchema,
            "streaming": .bool(streaming),
        ]
        if let targetKind { o["targetKind"] = .string(targetKind.rawValue) }
        return .object(o)
    }
}

/// A capability failure. `code` is a protocol `ErrorCode`; `reason` is the helper's finer-grained
/// machine reason (`stale_ref`, `expectation_failed`, `secure_field`, `tier_read_only`, …) carried in
/// `details.reason` so the model and the Gateway can react without parsing messages.
public struct CapabilityError: Error, Sendable, Equatable, CustomStringConvertible {
    public var code: ErrorCode
    public var reason: String
    public var message: String
    public var details: [String: JSONValue]
    public var retryable: Bool

    public init(_ code: ErrorCode, reason: String, _ message: String, details: [String: JSONValue] = [:], retryable: Bool = false) {
        self.code = code
        self.reason = reason
        self.message = message
        self.details = details
        self.retryable = retryable
    }

    public var description: String { "\(code.rawValue)/\(reason): \(message)" }

    public var wire: WireError {
        var d = details
        d["reason"] = .string(reason)
        return WireError(code: code.rawValue, message: message, details: .object(d), retryable: retryable ? true : nil)
    }

    // Common constructors.
    public static func invalidParams(_ message: String, field: String? = nil) -> CapabilityError {
        CapabilityError(.invalidParams, reason: "invalid_params", message, details: field.map { ["field": .string($0)] } ?? [:])
    }

    public static func permissionMissing(_ permission: TCCPermission) -> CapabilityError {
        CapabilityError(
            .forbidden, reason: "permission_missing",
            "Psyche Helper does not have the \(permission.rawValue) permission. Grant it in System Settings › Privacy & Security.",
            details: ["permission": .string(permission.rawValue)]
        )
    }

    public static func unavailable(_ reason: String, _ message: String, retryable: Bool = false) -> CapabilityError {
        CapabilityError(.unavailable, reason: reason, message, retryable: retryable)
    }

    public static let cancelled = CapabilityError(.cancelled, reason: "cancelled", "The invocation was cancelled")
    public static let stopped = CapabilityError(.cancelled, reason: "user_stopped", "The user pressed Esc to stop computer use")
}

/// What a handler returns. `receipt` is filled for side-effecting calls (`NodeResultParams.receipt`).
public struct CapabilityOutput: Sendable {
    public var result: JSONValue
    public var receipt: ReceiptDraft?

    public init(_ result: JSONValue, receipt: ReceiptDraft? = nil) {
        self.result = result
        self.receipt = receipt
    }
}

/// The node-side half of a `Receipt` (the Gateway adds task / tool-call ids when it records it).
public struct ReceiptDraft: Sendable, Equatable {
    public var outcome: ReceiptOutcome
    public var summary: String
    public var externalRefs: [String: JSONValue]

    public init(outcome: ReceiptOutcome, summary: String, externalRefs: [String: JSONValue] = [:]) {
        self.outcome = outcome
        self.summary = summary
        self.externalRefs = externalRefs
    }

    /// Full `Receipt` wire object.
    public func wire(kind: String, approvalId: String?, now: Date = Date()) -> JSONValue {
        .object([
            "id": .string("rcpt_" + ReceiptDraft.randomId()),
            "kind": .string(kind),
            "taskId": .null,
            "toolCallId": .null,
            "approvalId": approvalId.map { .string($0) } ?? .null,
            "outcome": .string(outcome.rawValue),
            "summary": .string(summary),
            "externalRefs": .object(externalRefs),
            "payload": .null,
            "createdAt": .string(ISO8601DateFormatter.psyche.string(from: now)),
        ])
    }

    static func randomId() -> String {
        var bytes = [UInt8](repeating: 0, count: 12)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Base64URL.encode(Data(bytes))
    }
}

extension ISO8601DateFormatter {
    nonisolated(unsafe) static let psyche: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// Per-invocation context handed to a handler.
public struct InvocationContext: Sendable {
    public var invocationId: String
    public var capability: String
    public var params: JSONValue
    public var approvalId: String?
    /// Streams one `node.event` for this invocation.
    public var emit: @Sendable (JSONValue) async -> Void

    public init(invocationId: String, capability: String, params: JSONValue, approvalId: String?, emit: @escaping @Sendable (JSONValue) async -> Void) {
        self.invocationId = invocationId
        self.capability = capability
        self.params = params
        self.approvalId = approvalId
        self.emit = emit
    }

    /// Typed view of `params` (missing params decode as `{}`).
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let value = params == .null ? .object([:]) : params
        do {
            return try value.decode(as: T.self)
        } catch let DecodingError.keyNotFound(key, _) {
            throw CapabilityError.invalidParams("missing parameter \(key.stringValue)", field: key.stringValue)
        } catch let DecodingError.typeMismatch(_, ctx), let DecodingError.valueNotFound(_, ctx) {
            let field = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            throw CapabilityError.invalidParams("parameter \(field) has the wrong type", field: field)
        } catch let DecodingError.dataCorrupted(ctx) {
            let field = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            throw CapabilityError.invalidParams("parameter \(field) is invalid", field: field)
        }
    }
}

/// One capability implementation.
public protocol CapabilityHandler: Sendable {
    var spec: CapabilitySpec { get }
    func invoke(_ context: InvocationContext) async throws -> CapabilityOutput
}

/// Closure-backed handler, so capability groups can be declared compactly.
public struct Capability: CapabilityHandler {
    public let spec: CapabilitySpec
    private let body: @Sendable (InvocationContext) async throws -> CapabilityOutput

    public init(_ spec: CapabilitySpec, _ body: @escaping @Sendable (InvocationContext) async throws -> CapabilityOutput) {
        self.spec = spec
        self.body = body
    }

    public func invoke(_ context: InvocationContext) async throws -> CapabilityOutput {
        try await body(context)
    }
}

/// Answers whether a TCC permission is granted right now (preflight only; never prompts).
public protocol PermissionPreflight: Sendable {
    func isGranted(_ permission: TCCPermission) -> Bool
}

/// The set of capabilities this node serves.
public final class CapabilityRegistry: Sendable {
    public let handlers: [String: any CapabilityHandler]
    public let ordered: [any CapabilityHandler]

    public init(_ handlers: [any CapabilityHandler]) {
        var map: [String: any CapabilityHandler] = [:]
        for h in handlers {
            precondition(map[h.spec.name] == nil, "duplicate capability \(h.spec.name)")
            map[h.spec.name] = h
        }
        self.handlers = map
        self.ordered = handlers
    }

    public subscript(name: String) -> (any CapabilityHandler)? { handlers[name] }

    /// `NodeCapability[]` for `connect`.
    public var manifestEntries: [JSONValue] { ordered.map(\.spec.manifestEntry) }

    /// `CapabilityManifest` (what `psyche-helper --manifest` prints).
    public func manifest(version: String) -> JSONValue {
        .object([
            "platform": .string("macos"),
            "version": .string(version),
            "capabilities": .array(manifestEntries),
        ])
    }
}
