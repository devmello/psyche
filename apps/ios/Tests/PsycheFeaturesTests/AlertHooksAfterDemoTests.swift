import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheShared
@testable import PsycheStore

/// "Try it without a Mac" swaps the alert center and "Exit demo" swaps it back. The notification delegate and the
/// island's Approve/Deny are process-wide, so each swap must re-point them at the center on screen: a tap on a
/// lock-screen or island button after the demo is answered by the live backend, never by the demo's fixtures.
/// These tests share `AlertCenter.hookOwner` and `IslandAnswers.handler` with `IslandAnswerTests`, so they are part of
/// that serialized suite.
extension IslandAnswerTests {
    private func hooksCenter(_ backend: FixtureBackend, notifier: RecordingNotifier = RecordingNotifier(), host: Hosts = Hosts()) -> AlertCenter {
        AlertCenter(
            store: backend, notifier: notifier, activities: host, connection: FixtureAlertConnection(),
            ledger: NotifiedLedger(directory: nil), isFixture: true)
    }

    private func parkedBackend() async throws -> FixtureBackend {
        let backend = FixtureBackend()
        let id = FixtureBackend.demoApprovalID
        await backend.startRunningDemo(taskID: "task_q3", stepInterval: .milliseconds(5))
        for _ in 0..<200 where try await !backend.home().needsYou.map(\.id).contains(id) {
            try await Task.sleep(for: .milliseconds(10))
        }
        return backend
    }

    private func stillWaiting(_ backend: FixtureBackend) async throws -> Bool {
        try await backend.home().needsYou.map(\.id).contains(FixtureBackend.demoApprovalID)
    }

    @Test func afterTheDemoIsLeftTheHooksPointAtTheLiveCenter() async throws {
        let liveBackend = try await parkedBackend()
        let demoBackend = try await parkedBackend()
        let live = hooksCenter(liveBackend, host: Hosts(["task_q3"]))
        let demoCenter = hooksCenter(demoBackend, host: Hosts(["task_q3"]))

        live.installSystemHooks()  // launch
        demoCenter.installSystemHooks()  // "Try it without a Mac"
        #expect(AlertCenter.hookOwner === demoCenter)
        await IslandAnswers.answer(FixtureBackend.demoApprovalID, approve: false)
        #expect(try await !stillWaiting(demoBackend))
        #expect(try await stillWaiting(liveBackend))

        // "Exit demo": the live center already has its delegate, and still takes the hooks back.
        live.installSystemHooks()
        await demoCenter.retire()
        #expect(AlertCenter.hookOwner === live)
        await IslandAnswers.answer(FixtureBackend.demoApprovalID, approve: false)
        #expect(try await !stillWaiting(liveBackend), "the island's answer must reach the live backend")
    }

    @Test func aRetiredCenterEndsAndRemovesWhatItMadeAndDoesNothingMore() async throws {
        let backend = try await parkedBackend()
        let notifier = RecordingNotifier()
        let host = Hosts()
        let alerts = hooksCenter(backend, notifier: notifier, host: host)
        alerts.installSystemHooks()
        let task = try #require(try await backend.home().running.first { $0.id == "task_q3" })
        #expect(await alerts.watch(task) == nil)
        #expect(host.started == ["task_q3"])
        // A notification button the center cannot answer inline posts "open Psyche to answer".
        let tap = IncomingNotification(actionID: AlertAction.approve.rawValue, id: "appr_electric", category: nil, threadID: nil, route: nil)
        await alerts.handle(tap)
        #expect(!notifier.posted.isEmpty)

        await alerts.retire()
        #expect(host.ended == ["task_q3"])
        #expect(Set(notifier.removed) == Set(notifier.posted))
        #expect(AlertCenter.hookOwner !== alerts)
        #expect(alerts.watching.isEmpty)

        // Retired: no further notification, no answer, no new activity.
        let before = notifier.posted.count
        await alerts.handle(tap)
        await alerts.sync(.live)
        await alerts.answerFromIsland(FixtureBackend.demoApprovalID, approve: true)
        #expect(notifier.posted.count == before)
        #expect(try await stillWaiting(backend))
        #expect(await alerts.watch(task) == nil)
        #expect(host.started == ["task_q3"])
    }

    @Test func retiringTheDemoDoesNotEndActivitiesTheLiveCenterOwns() async throws {
        // The system's list of activities is shared: the demo center ends only what it started itself.
        let host = Hosts(["task_real"])
        let alerts = hooksCenter(FixtureBackend(), host: host)
        await alerts.retire()
        #expect(host.ended.isEmpty)
    }

    @Test func theDelegateDoesNotKeepAReplacedCenterAlive() async {
        weak var weakCenter: AlertCenter?
        do {
            let alerts = hooksCenter(FixtureBackend())
            weakCenter = alerts
            alerts.installSystemHooks()
            await alerts.retire()
        }
        #expect(weakCenter == nil)
    }
}

final class RecordingNotifier: LocalNotifier, @unchecked Sendable {
    private let lock = NSLock()
    private var _posted: [String] = []
    private var _removed: [String] = []
    var posted: [String] { lock.withLock { _posted } }
    var removed: [String] { lock.withLock { _removed } }
    func authorization() async -> NotifierAuthorization { .allowed }
    func requestAuthorization() async -> Bool { true }
    func post(_ payload: AlertPayload) async { lock.withLock { _posted.append(payload.id) } }
    func removeDelivered(ids: [String]) async { lock.withLock { _removed.append(contentsOf: ids) } }
    func delivered() async -> [DeliveredAlert] { [] }
}

@MainActor
final class Hosts: ActivityHost {
    private(set) var activeTaskIDs: [String]
    private(set) var started: [String] = []
    private(set) var ended: [String] = []
    init(_ active: [String] = []) { activeTaskIDs = active }
    var isEnabled: Bool { true }
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool {
        started.append(taskID)
        if !activeTaskIDs.contains(taskID) { activeTaskIDs.append(taskID) }
        return true
    }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {
        ended.append(taskID)
        activeTaskIDs.removeAll { $0 == taskID }
    }
}
