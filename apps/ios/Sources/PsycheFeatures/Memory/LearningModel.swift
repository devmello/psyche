import Foundation
import Observation
import PsycheStore

/// The People tab's learning screens: the claims to confirm and the owner's quick notes. Writes reload the list they change; a failed write shows in `notice`, or is thrown
/// to the sheet that made it, so the owner keeps what they typed.
@MainActor @Observable
final class LearningModel {
    /// The most a note may hold (memory.remember takes up to 4000 characters).
    nonisolated static let noteLimit = 4000

    private(set) var claims: LoadPhase<[ClaimItem]> = .idle
    /// Shown in an alert when a write from a list fails.
    var notice: String?
    /// Claims put off with "Not now" this session. Not persisted and never sent to the Gateway.
    private(set) var hiddenClaimIDs: Set<String> = []

    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    // MARK: Reads

    func loadClaims() async {
        if claims.value == nil { claims = .loading }
        do {
            claims = .loaded(try await store.claims())
        } catch {
            if claims.value == nil { claims = .failed(error.localizedDescription) }
        }
    }

    // MARK: Claims

    func confirm(_ claim: ClaimItem) async {
        await write { try await self.store.confirmClaim(id: claim.id) }
        await loadClaims()
    }

    /// "Not now": hides a claim for this session only. Nothing is sent to the Gateway and the claim stays waiting.
    func hideForNow(_ claim: ClaimItem) {
        hiddenClaimIDs.insert(claim.id)
    }

    /// The claims the To confirm screen shows: waiting ones the owner has not put off for now.
    func shownClaims(_ claims: [ClaimItem]) -> [ClaimItem] {
        claims.filter { !hiddenClaimIDs.contains($0.id) }
    }

    // MARK: Quick note

    /// A note is worth saving when it has text other than whitespace and fits the Gateway's limit.
    static func canRemember(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= noteLimit
    }

    /// Saves the owner's note to today's daily note. Throws so the sheet stays open with the Gateway's words.
    func remember(_ text: String) async throws {
        try await store.remember(text: text.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    // MARK: Helpers

    /// Runs `reload` whenever Memory changed or the connection resynced, until the view goes away.
    func follow(_ reload: @escaping @MainActor () async -> Void) async {
        for await event in store.events() {
            switch event {
            case .changed(.memory), .resynced: await reload()
            default: break
            }
        }
    }

    private func write(_ work: () async throws -> Void) async {
        do {
            try await work()
        } catch {
            notice = error.localizedDescription
        }
    }
}
