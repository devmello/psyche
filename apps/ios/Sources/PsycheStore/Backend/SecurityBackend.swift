import Foundation

// Security notices on the phone. A request made with `psyched` on the Mac (a new admin device, a presence reset)
// waits before it applies, and its notice says it will "unless you cancel it in Psyche". The phone can cancel it
// when it holds `operator.admin`: `security.recoveries.cancel` only narrows, so the Gateway asks for no presence.
// Approving a request early (`security.recoveries.approve`) is a tap on an approval card (a presence reset also
// needs presence) and stays on the Mac.

/// The recovery a notice describes, as the notice words it (`notice.security.recovery.*` params).
public struct RecoveryNotice: Sendable, Equatable, Hashable {
    /// "approve", "grant", "presence" or "seal".
    public var op: String
    /// The device's name for approve and grant; nil for the others.
    public var device: String?
    /// The first 16 hex characters of the device key's fingerprint, when the notice carries one.
    public var key: String?
    /// When the request applies (the notice's `when`, to the second). The Inbox keeps old notices, so a notice
    /// only ever matches the request with this exact time; without it nothing matches.
    public var when: Date?

    public init(op: String, device: String? = nil, key: String? = nil, when: Date? = nil) {
        self.op = op
        self.device = device
        self.key = key
        self.when = when
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
    /// The notices that still have a waiting request to cancel, from one read of the Gateway's recoveries.
    func cancellable(_ notices: [RecoveryNotice]) async -> Set<RecoveryNotice>
    /// Cancels the waiting recovery the notice describes. The Gateway decides: a refusal comes back as
    /// `BackendError.refused` with its own sentence.
    func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome
}

extension SecurityBackend {
    public func canCancelRecoveries() async -> Bool { false }
    public func cancellable(_ notices: [RecoveryNotice]) async -> Set<RecoveryNotice> { [] }
    public func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome {
        throw BackendError.notFound
    }
}
