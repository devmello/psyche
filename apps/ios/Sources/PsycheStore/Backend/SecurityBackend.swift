import Foundation

// Security notices on the phone. A request made with `psyched` on the Mac (a new admin device, a presence reset)
// waits before it applies, and its notice says it will "unless you cancel it in Psyche". The phone can cancel it
// when it holds `operator.admin`: `security.recoveries.cancel` only narrows, so the Gateway asks for no presence.
// Approving a request early (`security.recoveries.approve`) needs a fresh-presence card and stays on the Mac.

/// The recovery a notice describes, as the notice words it (`notice.security.recovery.*` params).
public struct RecoveryNotice: Sendable, Equatable {
    /// "approve", "grant", "presence" or "seal".
    public var op: String
    /// The device's name for approve and grant; nil for the others.
    public var device: String?
    /// The first 16 hex characters of the device key's fingerprint, when the notice carries one.
    public var key: String?

    public init(op: String, device: String? = nil, key: String? = nil) {
        self.op = op
        self.device = device
        self.key = key
    }
}

public enum RecoveryCancelOutcome: Sendable, Equatable {
    /// This many waiting requests matched the notice and were cancelled.
    case cancelled(Int)
    /// Nothing matching is waiting any more: it was already applied or cancelled.
    case nothingWaiting
}

public protocol SecurityBackend: Sendable {
    /// Whether this phone may cancel a waiting recovery (the Gateway granted it `operator.admin`).
    func canCancelRecoveries() async -> Bool
    /// Cancels the waiting recovery the notice describes. The Gateway decides: a refusal comes back as
    /// `BackendError.refused` with its own sentence.
    func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome
}

extension SecurityBackend {
    public func canCancelRecoveries() async -> Bool { false }
    public func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome {
        throw BackendError.notFound
    }
}
