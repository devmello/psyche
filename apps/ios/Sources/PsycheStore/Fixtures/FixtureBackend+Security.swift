import Foundation

// Demo mode: this phone holds admin, and a cancel always finds its one waiting request.
extension FixtureBackend: SecurityBackend {
    public func canCancelRecoveries() async -> Bool { true }

    public func cancellable(_ notices: [RecoveryNotice]) async -> Set<RecoveryNotice> { Set(notices) }

    public func cancelRecovery(for notice: RecoveryNotice) async throws -> RecoveryCancelOutcome {
        await pause()
        return .cancelled(1)
    }
}
