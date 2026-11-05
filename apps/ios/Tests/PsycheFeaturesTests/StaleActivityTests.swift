import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

private struct Quiet: LocalNotifier {
    func authorization() async -> NotifierAuthorization { .denied }
    func requestAuthorization() async -> Bool { false }
    func post(_ payload: AlertPayload) async {}
    func removeDelivered(ids: [String]) async {}
    func delivered() async -> [DeliveredAlert] { [] }
}

/// A host whose activities can be marked stale, as iOS does once a stale date passes.
@MainActor
private final class StalingHost: ActivityHost {
    var live: Set<String>
    var stale: Set<String>
    var starts: [String] = []
    var updates: [(id: String, stale: Date?)] = []
    var ends: [String] = []
    init(active: [String] = [], stale: [String] = []) {
        live = Set(active)
        self.stale = Set(stale)
    }
    var isEnabled: Bool { true }
    /// Stale ones are still live (still on screen, still ours to update and end).
    var activeTaskIDs: [String] { Array(live.union(stale)) }
    /// Only a current activity may be answered from.
    var answerableTaskIDs: [String] { Array(live) }
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool {
        starts.append(taskID)
        live.insert(taskID)
        return true
    }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {
        updates.append((taskID, staleDate))
        if let staleDate, staleDate > .now { stale.remove(taskID); live.insert(taskID) }
    }
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {
        ends.append(taskID)
        live.remove(taskID)
        stale.remove(taskID)
    }
}

@MainActor
struct StaleActivityTests {
    private func center(_ backend: FixtureBackend, _ host: StalingHost) -> AlertCenter {
        AlertCenter(
            store: backend, notifier: Quiet(), activities: host, connection: FixtureAlertConnection(),
            ledger: NotifiedLedger(directory: nil), isFixture: true)
    }

    @Test func aStaleActivityIsStillTrackedAndUpdatedWithAFreshStaleDate() async throws {
        let backend = FixtureBackend()
        let host = StalingHost(stale: ["task_q3"])
        let alerts = center(backend, host)
        #expect(alerts.watching == ["task_q3"])  // not dropped for being stale
        await alerts.sync(.live)
        let update = try #require(host.updates.first)
        #expect(update.id == "task_q3")
        #expect(try #require(update.stale) > .now)  // fresh again
    }

    @Test func aStaleActivityIsEndedWhenTheSwitchTurnsLiveActivitiesOff() async throws {
        let backend = FixtureBackend()
        let host = StalingHost(stale: ["task_q3"])
        let alerts = center(backend, host)
        alerts.start()
        try await Task.sleep(for: .milliseconds(200))
        try await backend.updateSettings(
            PhoneSettings(notifications: true, liveActivities: false, taskTitlesOnLockScreen: false, faceIDForApprovals: true))
        try await Task.sleep(for: .milliseconds(300))
        #expect(host.ends == ["task_q3"])
        #expect(alerts.watching.isEmpty)
    }

    @Test func relaunchWithAStaleActivityDoesNotStartADuplicate() async throws {
        let backend = FixtureBackend()
        let host = StalingHost(stale: ["task_q3"])
        let alerts = center(backend, host)
        let task = try #require(try await backend.home().running.first { $0.id == "task_q3" })
        #expect(await alerts.watch(task) == nil)
        #expect(host.starts.isEmpty)
    }

    @Test func aStaleActivityIsNeverAnsweredFromTheIsland() async throws {
        let backend = FixtureBackend()
        await backend.startRunningDemoParkedOnApproval(taskID: "task_q3", stepInterval: .seconds(60))
        let host = StalingHost(stale: ["task_q3"])
        let alerts = center(backend, host)
        let before = try await backend.home().needsYou.map(\.id)
        await alerts.answerFromIsland(FixtureBackend.demoApprovalID, approve: true)
        #expect(try await backend.home().needsYou.map(\.id) == before)  // still waiting: nothing was answered
        host.live.insert("task_q3")
        host.stale.remove("task_q3")
        await alerts.answerFromIsland(FixtureBackend.demoApprovalID, approve: true)
        #expect(try await !backend.home().needsYou.map(\.id).contains(FixtureBackend.demoApprovalID))
    }
}
