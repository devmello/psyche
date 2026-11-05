import Foundation
import Testing

@testable import PsycheShared
@testable import PsycheStore

struct AlertPolicyTests {
    private func approval(kind: String, presenceNote: String?) -> NeedsYouItem {
        NeedsYouItem(
            id: "appr_1", kind: .approval, title: "Pay PG&E $84.20", source: "Bills", time: "9:12",
            approval: ApprovalDetail(
                kindLabel: kind, title: "t", summary: "s", fields: [], evidence: [], alsoSentTo: "",
                presenceNote: presenceNote, allowLabel: "Allow"),
            threadID: "thr_1")
    }

    @Test func writeApprovalsGetApproveAndDeny() {
        let item = approval(kind: "calendar", presenceNote: nil)
        #expect(AlertPolicy.category(for: item) == .approvalWrite)
        #expect(AlertPolicy.actions(for: .approvalWrite) == [.approve, .deny])
    }

    @Test func presenceGatedKindsGetOnlyReview() {
        let payment = approval(kind: "payment", presenceNote: "Payments need Face ID on this phone.")
        #expect(AlertPolicy.category(for: payment) == .approvalReview)
        #expect(AlertPolicy.actions(for: .approvalReview) == [.review])
        // Nothing from the card (an amount, a payee) goes on the lock screen.
        let payload = AlertPolicy.payload(for: payment)
        #expect(!payload.title.contains("84"))
        #expect(!payload.body.contains("PG&E"))
        #expect(payload.level == .active)
    }

    @Test func questionsGetOpenAndFinishedTasksArePassive() {
        let question = NeedsYouItem(id: "q1", kind: .question, title: "Which deck?", source: "Q3", time: "8:40", threadID: "thr_q3")
        #expect(AlertPolicy.category(for: question) == .question)
        #expect(AlertPolicy.actions(for: .question) == [.open])
        let done = AlertPolicy.finished(taskID: "t1", title: "Q3 summary", failed: false)
        #expect(done.category == .finished)
        #expect(done.level == .passive)
        #expect(done.id == "done-t1")
        #expect(AlertPolicy.actions(for: .finished).isEmpty)
    }

    @Test func notificationIdentifierIsTheApprovalID() {
        #expect(AlertPolicy.payload(for: approval(kind: "calendar", presenceNote: nil)).id == "appr_1")
        #expect(AlertPolicy.reconnect(for: "appr_1").id == "appr_1")
    }

    @Test func onlyAsksWaitingOnTheOwnerAreClearedWhenAnsweredElsewhere() {
        #expect(AlertPolicy.isWaitingOnOwner(.approvalWrite))
        #expect(AlertPolicy.isWaitingOnOwner(.reconnect))
        #expect(!AlertPolicy.isWaitingOnOwner(.finished))
    }
}

struct NotifiedLedgerTests {
    private func tempDirectory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ledger-\(UUID().uuidString)", isDirectory: true)
    }

    @Test func anIdIsAnnouncedOnce() async {
        let ledger = NotifiedLedger(directory: nil)
        #expect(await ledger.claim("appr_1"))
        #expect(await !ledger.claim("appr_1"))
        #expect(await ledger.claim("appr_2"))
    }

    @Test func seenIdsAreNotAnnouncedLater() async {
        let ledger = NotifiedLedger(directory: nil)
        await ledger.markSeen(["a", "b"])
        #expect(await !ledger.claim("a"))
        #expect(await ledger.claim("c"))
    }

    @Test func survivesARestartSoABackgroundCheckDoesNotRepeatTheForegroundOne() async {
        let directory = tempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = NotifiedLedger(directory: directory)
        #expect(await first.claim("appr_1"))
        await first.setRunning(["task_1"])
        let second = NotifiedLedger(directory: directory)
        #expect(await !second.claim("appr_1"))
        #expect(await second.knownRunning() == ["task_1"])
    }

    @Test func oldEntriesAreForgotten() async {
        let ledger = NotifiedLedger(directory: nil, keepFor: 100)
        let long = Date(timeIntervalSince1970: 1_000)
        #expect(await ledger.claim("old", at: long))
        #expect(await ledger.claim("old", at: long.addingTimeInterval(500)))
    }
}

struct TaskActivityContentTests {
    private let task = RunningTask(
        id: "task_q3", title: "Drafting the Q3 review summary", step: 3, stepCount: 7, detail: "reading 12 files",
        elapsed: "2 min", startedAt: Date(timeIntervalSince1970: 1_000))

    @Test func noTitleWhenTheSettingIsOff() throws {
        let content = TaskActivityContent.make(task: task, status: .running, showTitle: false)
        #expect(content.title == nil)
        // Nothing but progress is encoded: this is what Apple's Live Activity service would carry.
        let json = try String(decoding: JSONEncoder().encode(content), as: UTF8.self)
        #expect(!json.contains("Q3"))
        #expect(!json.contains("reading"))
    }

    @Test func titleWhenTheSettingIsOn() {
        let content = TaskActivityContent.make(task: task, status: .running, showTitle: true)
        #expect(content.title == "Drafting the Q3 review summary")
        #expect(content.titled("x", show: false).title == nil)
    }

    @Test func stepLineAndSegments() {
        let content = TaskActivityContent.make(task: task, status: .running, showTitle: false)
        #expect(content.statusLine == "Step 3 of 7 · running")
        #expect(content.startedAt == Date(timeIntervalSince1970: 1_000))
        #expect(content.segments.total == 7)
        #expect(content.segments.finished == 2)
    }

    @Test func unknownStepCountSaysRunning() {
        var unknown = task
        unknown.stepCount = 0
        let content = TaskActivityContent.make(task: unknown, status: .running, showTitle: false)
        #expect(!content.hasStepCount)
        #expect(content.statusLine == "Running")
        #expect(content.segments.total == 0)
    }

    @Test func statusWordsAndFinishing() {
        let waiting = TaskActivityContent.make(task: task, status: .needsApproval, showTitle: false)
        #expect(waiting.statusLine == "Needs approval")
        let done = waiting.finished(failed: false, at: Date(timeIntervalSince1970: 2_000))
        #expect(done.status == .done)
        #expect(done.endedAt == Date(timeIntervalSince1970: 2_000))
        #expect(done.segments.finished == 7)
        #expect(waiting.finished(failed: true).statusLine == "Failed")
    }

    @Test func deepLinkGoesThroughTheRouterScheme() {
        #expect(TaskActivityContent.url(forTask: "task_q3")?.absoluteString == "psyche://task/task_q3")
    }
}

struct UpdateCoalescerTests {
    @Test func aBurstBecomesOneImmediateRunAndOneTrailingRun() {
        var coalescer = UpdateCoalescer(interval: 1)
        let t0 = Date(timeIntervalSince1970: 100)
        #expect(coalescer.request(at: t0) == .runNow)
        guard case .runAfter(let delay) = coalescer.request(at: t0.addingTimeInterval(0.2)) else {
            Issue.record("expected a trailing run")
            return
        }
        #expect(abs(delay - 0.8) < 0.001)
        for step in 3...9 {
            #expect(coalescer.request(at: t0.addingTimeInterval(Double(step) / 10)) == .alreadyScheduled)
        }
    }

    @Test func aRequestAfterTheIntervalRunsAtOnce() {
        var coalescer = UpdateCoalescer(interval: 1)
        let t0 = Date(timeIntervalSince1970: 100)
        #expect(coalescer.request(at: t0) == .runNow)
        #expect(coalescer.request(at: t0.addingTimeInterval(1.5)) == .runNow)
    }

    @Test func afterTheTrailingRunTheThrottleStartsAgain() {
        var coalescer = UpdateCoalescer(interval: 1)
        let t0 = Date(timeIntervalSince1970: 100)
        _ = coalescer.request(at: t0)
        _ = coalescer.request(at: t0.addingTimeInterval(0.5))
        coalescer.fire(at: t0.addingTimeInterval(1))
        if case .runAfter = coalescer.request(at: t0.addingTimeInterval(1.2)) {} else { Issue.record("expected throttling again") }
    }
}
