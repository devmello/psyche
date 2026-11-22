import Foundation
import Testing

@testable import PsycheStore

struct ChatTurnTrackerTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    private func run(_ thread: String, _ state: RunUpdate.State, chat: Bool = true, startedAt: Date? = nil, task: String? = nil) -> ChatEvent {
        .run(threadID: thread, update: RunUpdate(state: state, startedAt: startedAt, isChat: chat, taskID: task))
    }

    @Test func aRunStartsAndEndsATurn() {
        var tracker = ChatTurnTracker()
        let started = tracker.apply(run("t1", .running), now: t0)
        guard case .started(let turn)? = started.first else { Issue.record("no start"); return }
        #expect(turn.threadID == "t1")
        #expect(turn.startedAt == t0)
        let ended = tracker.apply(run("t1", .done), now: t0 + 30)
        #expect(ended == [.ended(turn, .done, at: t0 + 30)])
        #expect(tracker.turns.isEmpty)
    }

    @Test func theGatewaysStartTimeWinsWhenPlausible() {
        var tracker = ChatTurnTracker()
        _ = tracker.apply(run("t1", .running, startedAt: t0 - 12), now: t0)
        #expect(tracker.turns["t1"]?.startedAt == t0 - 12)
        // A start in the future (a fast clock on the Mac) or hours old is not trusted.
        var other = ChatTurnTracker()
        _ = other.apply(run("t2", .running, startedAt: t0 + 90), now: t0)
        #expect(other.turns["t2"]?.startedAt == t0)
        _ = other.apply(run("t3", .running, startedAt: t0 - 7 * 3600), now: t0)
        #expect(other.turns["t3"]?.startedAt == t0)
    }

    @Test func aTasksRunIsNotAChatReply() {
        var tracker = ChatTurnTracker()
        #expect(tracker.apply(run("t1", .running, chat: false, task: "task_1"), now: t0).isEmpty)
        #expect(tracker.turns.isEmpty)
    }

    @Test func failedAndCancelledRunsEndWithTheirOutcome() {
        var tracker = ChatTurnTracker()
        _ = tracker.apply(run("t1", .running), now: t0)
        guard case .ended(_, let outcome, _)? = tracker.apply(run("t1", .failed), now: t0 + 40).first else { Issue.record("no end"); return }
        #expect(outcome == .failed)
        _ = tracker.apply(run("t2", .running), now: t0)
        guard case .ended(_, let second, _)? = tracker.apply(run("t2", .cancelled), now: t0 + 2).first else { Issue.record("no end"); return }
        #expect(second == .cancelled)
    }

    @Test func streamingTextStartsATurnAndItsEndEndsIt() {
        var tracker = ChatTurnTracker()
        let item = ChatItem.assistant(id: "m1", text: "Hel", streaming: true)
        guard case .started(let turn)? = tracker.apply(.item(threadID: "t1", item: item), now: t0).first else { Issue.record("no start"); return }
        #expect(turn.latest == .writing)
        #expect(tracker.apply(.delta(threadID: "t1", itemID: "m1", text: "lo"), now: t0 + 1).isEmpty)
        let ended = tracker.apply(.done(threadID: "t1", itemID: "m1"), now: t0 + 2)
        #expect(ended.count == 1)
        #expect(tracker.turns.isEmpty)
    }

    @Test func aFinishedParagraphDoesNotEndARunTheGatewayAnnounced() {
        var tracker = ChatTurnTracker()
        _ = tracker.apply(run("t1", .running), now: t0)
        _ = tracker.apply(.item(threadID: "t1", item: .assistant(id: "m1", text: "Let me look.", streaming: true)), now: t0 + 1)
        // A tool call follows the first paragraph: the run goes on.
        #expect(tracker.apply(.done(threadID: "t1", itemID: "m1"), now: t0 + 2).isEmpty)
        #expect(tracker.turns["t1"] != nil)
        let tool = ChatItem.toolCall(id: "c1", symbol: "doc", summary: "Reading 12 files")
        let updated = tracker.apply(.item(threadID: "t1", item: tool), now: t0 + 3)
        guard case .updated(let turn)? = updated.first else { Issue.record("no update"); return }
        #expect(turn.latest == .text("Reading 12 files"))
    }

    @Test func fixtureStatusEventsDriveATurn() {
        var tracker = ChatTurnTracker()
        let started = tracker.apply(.status(threadID: "t1", status: "Thinking", kind: .running), now: t0)
        guard case .started(let turn)? = started.first else { Issue.record("no start"); return }
        #expect(turn.latest == .thinking)
        let waiting = tracker.apply(.status(threadID: "t1", status: "Waiting for you", kind: .needsYou), now: t0 + 1)
        guard case .updated(let paused)? = waiting.first else { Issue.record("no update"); return }
        #expect(paused.waiting)
        #expect(tracker.apply(.status(threadID: "t1", status: "", kind: .neutral), now: t0 + 2).count == 1)
    }

    @Test func statusTextIsOneShortLine() {
        var tracker = ChatTurnTracker()
        let long = String(repeating: "word ", count: 40) + "\nsecond line"
        _ = tracker.apply(.status(threadID: "t1", status: long, kind: .running), now: t0)
        guard case .text(let text)? = tracker.turns["t1"]?.latest else { Issue.record("no text"); return }
        #expect(text.count <= ChatTurnTracker.maxStatusLength)
        #expect(!text.contains("second"))
    }

    @Test func theThreadListNeverStartsAReplyButEndsOneTheEventsNeverClosed() {
        var tracker = ChatTurnTracker()
        func row(_ id: String, _ kind: ChatThreadSummary.Status) -> ChatThreadSummary {
            ChatThreadSummary(id: id, title: id, status: "", statusKind: kind, isMain: false, updated: "")
        }
        // A row that says "running" may be a task's run: only a run event says it is a chat reply.
        #expect(tracker.reconcile([row("t1", .running)], now: t0).isEmpty)
        #expect(tracker.turns.isEmpty)
        _ = tracker.apply(.delta(threadID: "t1", itemID: "m", text: "x"), now: t0 + 10)
        // Idle on the list right after an event: the list may be older than the event, so the turn stays.
        #expect(tracker.reconcile([row("t1", .neutral)], now: t0 + 11).isEmpty)
        // Idle for a while: the end event was lost.
        #expect(tracker.reconcile([row("t1", .neutral)], now: t0 + 20).count == 1)
        #expect(tracker.turns.isEmpty)
    }

    @Test func theThreadListMarksAReplyThatWaitsForTheOwner() {
        var tracker = ChatTurnTracker()
        _ = tracker.apply(run("t1", .running), now: t0)
        let row = ChatThreadSummary(id: "t1", title: "t1", status: "", statusKind: .needsYou, isMain: false, updated: "")
        guard case .updated(let turn)? = tracker.reconcile([row], now: t0 + 1).first else { Issue.record("no update"); return }
        #expect(turn.waiting)
    }

    @Test func aThreadThatLeftTheListIsNoLongerRunning() {
        var tracker = ChatTurnTracker()
        _ = tracker.apply(run("gone", .running), now: t0)
        let changes = tracker.reconcile([], now: t0 + 1)
        guard case .ended(_, let outcome, _)? = changes.first else { Issue.record("no end"); return }
        #expect(outcome == .cancelled)
    }
}
