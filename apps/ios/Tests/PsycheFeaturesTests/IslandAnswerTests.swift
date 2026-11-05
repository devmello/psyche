import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

/// The Dynamic Island's Deny and Approve (`AnswerApprovalIntent`) go through `AlertCenter.answerFromIsland`,
/// which answers only a plain write approval that belongs to a task with a Live Activity running, re-checked
/// against what is waiting. A presence-gated one (the payment) is never answered from there, whatever id arrives.
@MainActor
struct IslandAnswerTests {
    private let demo = FixtureBackend.demoApprovalID

    private func center(_ backend: FixtureBackend, watching: [String] = ["task_q3"]) -> AlertCenter {
        AlertCenter(
            store: backend, notifier: QuietNotifier(), activities: WatchedTasks(watching),
            connection: FixtureAlertConnection(), ledger: NotifiedLedger(directory: nil), isFixture: true)
    }

    private func waiting(_ backend: FixtureBackend) async throws -> Set<String> {
        Set(try await backend.home().needsYou.map(\.id))
    }

    /// Runs the fixture task until it parks on its write approval ("Send the Q3 summary to Dana?").
    private func backendWaitingOnDemo() async throws -> FixtureBackend {
        let backend = FixtureBackend()
        await backend.startRunningDemo(taskID: "task_q3", stepInterval: .milliseconds(5))
        for _ in 0..<200 where try await !waiting(backend).contains(demo) {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try await waiting(backend).contains(demo))
        return backend
    }

    @Test func approvesTheWatchedTasksWriteApproval() async throws {
        let backend = try await backendWaitingOnDemo()
        await center(backend).answerFromIsland(demo, approve: true)
        #expect(try await !waiting(backend).contains(demo))
    }

    @Test func neverAnswersForATaskWithNoLiveActivity() async throws {
        let backend = try await backendWaitingOnDemo()
        await center(backend, watching: []).answerFromIsland(demo, approve: true)
        #expect(try await waiting(backend).contains(demo))
    }

    @Test func neverAnswersAnApprovalOfNoWatchedTask() async throws {
        // A plain write approval, but not one an island shows: a forged or stale id.
        let backend = FixtureBackend()
        await center(backend).answerFromIsland("appr_dentist", approve: true)
        #expect(try await waiting(backend).contains("appr_dentist"))
    }

    @Test func neverAnswersAPresenceGatedApprovalOrAQuestion() async throws {
        let backend = FixtureBackend()
        let alerts = center(backend)
        await alerts.answerFromIsland("appr_electric", approve: true)
        await alerts.answerFromIsland("appr_electric", approve: false)
        await alerts.answerFromIsland("q_deck", approve: true)
        #expect(try await waiting(backend).isSuperset(of: ["appr_electric", "q_deck"]))
    }

    @Test func watchingATaskAlreadyWaitingOffersTheAnswerAtOnce() async throws {
        // The approval came before Watch was pressed (or the app was relaunched while it waits): the island must
        // offer Deny and Approve from its first frame, not after a sync the suspended app may never run.
        let backend = FixtureBackend()
        await backend.startRunningDemoParkedOnApproval(taskID: "task_q3", stepInterval: .seconds(60))
        let host = StartedActivities()
        let alerts = AlertCenter(
            store: backend, notifier: QuietNotifier(), activities: host,
            connection: FixtureAlertConnection(), ledger: NotifiedLedger(directory: nil), isFixture: true)
        let task = try #require(try await backend.home().running.first { $0.id == "task_q3" })
        #expect(await alerts.watch(task) == nil)
        let started = try #require(host.started["task_q3"])
        #expect(started.status == .needsApproval)
        #expect(started.inlineApprovalID == demo)
        #expect(started.answersInline)
    }

    @Test func theAppInstallsTheHandler() async throws {
        let backend = try await backendWaitingOnDemo()
        let alerts = center(backend)
        alerts.installSystemHooks()
        await IslandAnswers.answer("appr_electric", approve: true)
        #expect(try await waiting(backend).contains("appr_electric"))
        await IslandAnswers.answer(demo, approve: false)
        #expect(try await !waiting(backend).contains(demo))
    }
}

private struct QuietNotifier: LocalNotifier {
    func authorization() async -> NotifierAuthorization { .denied }
    func requestAuthorization() async -> Bool { false }
    func post(_ payload: AlertPayload) async {}
    func removeDelivered(ids: [String]) async {}
    func delivered() async -> [DeliveredAlert] { [] }
}

@MainActor
private final class WatchedTasks: ActivityHost {
    let activeTaskIDs: [String]
    init(_ watching: [String]) { activeTaskIDs = watching }
    var isEnabled: Bool { true }
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool { true }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {}
}

@MainActor
private final class StartedActivities: ActivityHost {
    var started: [String: TaskActivityContent] = [:]
    var activeTaskIDs: [String] { Array(started.keys) }
    var isEnabled: Bool { true }
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool { started[taskID] = content; return true }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {}
}
