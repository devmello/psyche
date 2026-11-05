import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

/// The Dynamic Island's Deny and Approve (`AnswerApprovalIntent`) go through `AlertCenter.answerFromIsland`,
/// which answers only a plain write approval, re-checked against what is waiting. A presence-gated one
/// (the payment) is never answered from there, whatever id arrives.
@MainActor
struct IslandAnswerTests {
    private func center(_ backend: FixtureBackend) -> AlertCenter {
        AlertCenter(
            store: backend, notifier: QuietNotifier(), activities: NoActivityHost(),
            connection: FixtureAlertConnection(), ledger: NotifiedLedger(directory: nil), isFixture: true)
    }

    private func waiting(_ backend: FixtureBackend) async throws -> Set<String> {
        Set(try await backend.home().needsYou.map(\.id))
    }

    @Test func approvesAWriteApproval() async throws {
        let backend = FixtureBackend()
        #expect(try await waiting(backend).contains("appr_dentist"))
        await center(backend).answerFromIsland("appr_dentist", approve: true)
        #expect(try await !waiting(backend).contains("appr_dentist"))
    }

    @Test func neverAnswersAPresenceGatedApproval() async throws {
        let backend = FixtureBackend()
        let alerts = center(backend)
        await alerts.answerFromIsland("appr_electric", approve: true)
        await alerts.answerFromIsland("appr_electric", approve: false)
        #expect(try await waiting(backend).contains("appr_electric"))
    }

    @Test func neverAnswersAQuestion() async throws {
        let backend = FixtureBackend()
        await center(backend).answerFromIsland("q_deck", approve: true)
        #expect(try await waiting(backend).contains("q_deck"))
    }

    @Test func theAppInstallsTheHandler() async throws {
        let backend = FixtureBackend()
        let alerts = center(backend)
        alerts.installSystemHooks()
        await IslandAnswers.answer("appr_dentist", approve: false)
        #expect(try await !waiting(backend).contains("appr_dentist"))
        await IslandAnswers.answer("appr_electric", approve: true)
        #expect(try await waiting(backend).contains("appr_electric"))
    }
}

private struct QuietNotifier: LocalNotifier {
    func authorization() async -> NotifierAuthorization { .denied }
    func requestAuthorization() async -> Bool { false }
    func post(_ payload: AlertPayload) async {}
    func removeDelivered(ids: [String]) async {}
    func delivered() async -> [DeliveredAlert] { [] }
}
