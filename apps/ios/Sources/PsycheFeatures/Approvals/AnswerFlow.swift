import Foundation
import Observation
import PsycheStore

/// Where answering an approval or a question stands. One model for both sheets.
@MainActor @Observable
final class AnswerFlow {
    enum Stage: Equatable {
        case review
        /// Waiting for Face ID or the passcode.
        case checking
        case sending
        /// The Gateway took the answer.
        case answered(String)
        /// The Gateway's own message, with "Try again".
        case failed(String)
    }

    private(set) var stage: Stage = .review
    /// Bumped when an answer lands, to fire the `.success` haptic once.
    private(set) var answeredCount = 0
    private var lastAttempt: (() async -> Void)?

    var isBusy: Bool { stage == .checking || stage == .sending }

    /// Runs `operation`, asking for presence first when `reason` is set. `confirmation` is the line shown
    /// once it lands ("Allowed. Your Mac has it."). The sheet dismisses itself a moment later.
    func run(
        presence: (any PresenceCheck)? = nil, reason: String? = nil, confirmation: String,
        _ operation: @escaping @Sendable () async throws -> Void
    ) async {
        guard !isBusy else { return }
        lastAttempt = { [weak self] in
            await self?.run(presence: presence, reason: reason, confirmation: confirmation, operation)
        }
        if let presence, let reason {
            stage = .checking
            switch await presence.confirm(reason: reason) {
            case .confirmed: break
            case .cancelled:
                stage = .review
                return
            case .unavailable(let message):
                stage = .failed(message)
                return
            }
        }
        stage = .sending
        do {
            try await operation()
            stage = .answered(confirmation)
            answeredCount += 1
        } catch {
            stage = .failed(error.localizedDescription)
        }
    }

    func retry() async { await lastAttempt?() }
    func dismissError() { stage = .review }
}
