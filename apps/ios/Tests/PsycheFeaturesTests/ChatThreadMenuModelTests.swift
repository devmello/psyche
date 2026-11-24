import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Rename, fork, clear, compact, feedback and archived chats on the thread and list models, over the fixture.
@MainActor
struct ChatThreadMenuModelTests {
    /// The fixture's Maya chat: a transcript long enough to compact, with finished replies.
    static let tripID = "thr_trip"

    private func lastReplyID(_ thread: ChatThread) -> String? {
        for item in thread.items.reversed() {
            if case .assistant(let id, _, false) = item { return id }
        }
        return nil
    }

    @Test func renameTrimsTheTitleAndTheThreadShowsIt() async throws {
        let model = ThreadModel(id: Self.tripID, store: FixtureBackend())
        await model.load()
        await model.rename(to: "  Visit plans  ")
        #expect(model.phase.value?.title == "Visit plans")
        #expect(model.actionError == nil)
    }

    @Test func aBlankRenameLeavesTheTitleAlone() async throws {
        let model = ThreadModel(id: Self.tripID, store: FixtureBackend())
        await model.load()
        let before = try #require(model.phase.value?.title)
        await model.rename(to: "   ")
        #expect(model.phase.value?.title == before)
    }

    @Test func forkReturnsANewChatWithTheTranscriptUpToThatReply() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: Self.tripID, store: store)
        await model.load()
        let thread = try #require(model.phase.value)
        let messageID = try #require(lastReplyID(thread))
        let forkID = try #require(await model.fork(atMessage: messageID))
        #expect(forkID != Self.tripID)
        let fork = try await store.thread(id: forkID)
        #expect(fork.items.last?.id == messageID)
        #expect(model.actionError == nil)
    }

    @Test func aRefusedForkShowsTheGatewaysWordsAndReturnsNothing() async throws {
        let store = FixtureBackend()
        await store.failNextThreadAction(with: "Forking is paused for this chat.")
        let model = ThreadModel(id: Self.tripID, store: store)
        await model.load()
        let thread = try #require(model.phase.value)
        let messageID = try #require(lastReplyID(thread))
        #expect(await model.fork(atMessage: messageID) == nil)
        #expect(model.actionError == "Forking is paused for this chat.")
    }

    @Test func clearEmptiesTheTranscriptAndKeepsTheChat() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: Self.tripID, store: store)
        await model.load()
        #expect((model.phase.value?.items.count ?? 0) > 0)
        await model.clear()
        #expect(model.phase.value?.items.isEmpty == true)
        #expect(model.phase.value?.id == Self.tripID)
        #expect(model.actionError == nil)
    }

    @Test func aRefusedClearKeepsTheMessagesAndShowsTheWords() async throws {
        let store = FixtureBackend()
        await store.failNextThreadAction(with: "The chat is running.")
        let model = ThreadModel(id: Self.tripID, store: store)
        await model.load()
        let count = try #require(model.phase.value?.items.count)
        await model.clear()
        #expect(model.actionError == "The chat is running.")
        #expect(model.phase.value?.items.count == count)
    }

    @Test func compactAddsOneSummaryNoteAndIsNotRunningAfter() async throws {
        let model = ThreadModel(id: Self.tripID, store: FixtureBackend())
        await model.load()
        await model.compact()
        #expect(model.compacting == false)
        let first = try #require(model.phase.value?.items.first)
        guard case .note(_, .compaction, _, _) = first else {
            Issue.record("the first item should be the compaction note, got \(first)")
            return
        }
        #expect(model.actionError == nil)
    }

    @Test func thumbsRecordTheMarkAndAFailedMarkGoesBack() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: Self.tripID, store: store)
        await model.load()
        let thread = try #require(model.phase.value)
        let messageID = try #require(lastReplyID(thread))

        await model.giveFeedback(messageID: messageID, helpful: true)
        #expect(model.feedback[messageID] == true)

        await store.failNextThreadAction(with: "Feedback is off in incognito chats.")
        await model.giveFeedback(messageID: messageID, helpful: false)
        #expect(model.feedback[messageID] == true)
        #expect(model.actionError == "Feedback is off in incognito chats.")
    }

    @Test func archivedChatsLeaveTheListAndComeBackOnRestore() async throws {
        let store = FixtureBackend()
        let list = ThreadListModel(store: store)
        await list.load()
        let side = try #require(list.phase.value?.first { !$0.isMain })

        await list.archive(side)
        await list.load()
        #expect(list.phase.value?.contains { $0.id == side.id } == false)
        #expect(list.archived.contains { $0.id == side.id })

        await list.restore(side)
        #expect(list.archived.contains { $0.id == side.id } == false)
        // The fixture pages its list small, so the restored chat is checked in the store's full list.
        let all = try await store.threads()
        #expect(all.contains { $0.id == side.id && !$0.isArchived })
    }
}
