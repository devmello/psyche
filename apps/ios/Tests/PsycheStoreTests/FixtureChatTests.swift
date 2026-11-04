import Foundation
import Testing

@testable import PsycheStore

struct FixtureChatTests {
    let store = FixtureBackend()

    private func allItems() async throws -> [ChatItem] {
        var items: [ChatItem] = []
        for summary in try await store.threads() {
            items += try await store.thread(id: summary.id).items
        }
        return items
    }

    /// Every block type the phone draws shows up in at least one fixture thread.
    @Test func everyBlockTypeAppearsInAFixtureThread() async throws {
        let items = try await allItems()
        var seen: Set<String> = []
        for item in items {
            switch item {
            case .user: seen.insert("user")
            case .assistant: seen.insert("assistant")
            case .toolCall: seen.insert("toolCall")
            case .toolRun: seen.insert("toolRun")
            case .question: seen.insert("question")
            case .evidence: seen.insert("evidence")
            case .progress(_, let kind, _, _): seen.insert("progress.\(kind.rawValue)")
            case .file(_, _, _, _, _, let artifact): seen.insert(artifact ? "artifact" : "file")
            case .appLink: seen.insert("appLink")
            case .relatedThreads: seen.insert("relatedThreads")
            case .note(_, let kind, _, _): seen.insert("note.\(kind.rawValue)")
            case .approval: seen.insert("approval")
            case .unknown: seen.insert("unknown")
            }
        }
        let expected: Set<String> = [
            "user", "assistant", "toolCall", "toolRun", "question", "evidence", "progress.task", "progress.plan",
            "progress.checklist", "file", "artifact", "appLink", "relatedThreads", "approval", "unknown",
            "note.learned", "note.taught", "note.wrap_up", "note.compaction", "note.specialist_result",
            "note.automation_workflow",
        ]
        #expect(expected.subtracting(seen).isEmpty, "missing: \(expected.subtracting(seen).sorted())")
    }

    @Test func pinningMovesNothingButMarksTheThreadAndTheMainThreadStaysPinned() async throws {
        try await store.pinThread(id: "thr_lease", pinned: true)
        try await store.pinThread(id: FixtureData.mainThreadID, pinned: false)
        let threads = try await store.threads()
        #expect(threads.first { $0.id == "thr_lease" }?.isPinned == true)
        #expect(threads.first { $0.isMain }?.isPinned == true)
    }

    @Test func archivingRemovesASideChatButNeverTheMainThread() async throws {
        try await store.archiveThread(id: "thr_trip")
        try await store.archiveThread(id: FixtureData.mainThreadID)
        let ids = try await store.threads().map(\.id)
        #expect(!ids.contains("thr_trip"))
        #expect(ids.contains(FixtureData.mainThreadID))
    }

    @Test func aSentMessageStreamsAToolRunAndAReplyThenSources() async throws {
        let events = store.events()
        let sent = try await store.send(MessageDraft(threadID: "thr_lease", text: "Any news?", attachmentIDs: ["lib_x"]))
        #expect(sent.delivery == .sent)
        var sawTool = false
        var sawDelta = false
        var sawSources = false
        var finished = false
        for await event in events {
            guard case .chat(let chat) = event else { continue }
            switch chat {
            case .item(_, .toolRun(_, _, _, let arguments, _)): sawTool = !arguments.isEmpty
            case .delta: sawDelta = true
            case .item(_, .evidence(_, "Sources", _)): sawSources = true
            case .status(_, _, .neutral): finished = true
            default: break
            }
            if finished { break }
        }
        #expect(sawTool && sawDelta && sawSources)
    }

    @Test func cancelStopsTheReply() async throws {
        let events = store.events()
        _ = try await store.send(MessageDraft(threadID: "thr_trip", text: "Long one"))
        try await store.cancelRun(threadID: "thr_trip")
        var deltas = 0
        for await event in events {
            if case .chat(.delta) = event { deltas += 1 }
            if case .chat(.status(_, _, .neutral)) = event { break }
        }
        #expect(deltas == 0)
    }
}
