import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct ChatPagingTests {
    @Test func theFixtureThreadListPagesThreeRowsAtATime() async throws {
        let store = FixtureBackend()
        let first = try await store.threadPage(cursor: nil)
        #expect(first.threads.map(\.id) == [FixtureData.mainThreadID, "thr_q3", "thr_bills"])
        #expect(first.nextCursor == "3")
        let second = try await store.threadPage(cursor: first.nextCursor)
        #expect(second.threads.map(\.id) == ["thr_lease", "thr_trip"])
        #expect(second.nextCursor == nil)
    }

    @Test func aLongTranscriptPagesBackUntilTheFirstMessage() async throws {
        let model = ThreadModel(id: "thr_trip", store: FixtureBackend())
        await model.load()
        var thread = try #require(model.phase.value)
        #expect(thread.items.count == ChatPaging.messagePageSize)
        #expect(thread.olderCursor == "87")
        #expect(thread.items.first?.id == "hist-a44")

        var calls = 0
        for _ in 0..<5 {
            guard thread.olderCursor != nil else { break }
            await model.loadOlder()
            calls += 1
            thread = try #require(model.phase.value)
        }
        #expect(calls == 3)
        #expect(thread.olderCursor == nil)
        #expect(thread.items.count == 127)
        #expect(Set(thread.items.map(\.id)).count == 127)
        #expect(thread.items.first?.id == "hist-u1")
        #expect(thread.items.last?.id == "t6")
        // Nothing older is left, so another call changes nothing.
        await model.loadOlder()
        #expect(model.phase.value?.items.count == 127)
    }

    @Test func aReloadOfTheNewestPageKeepsTheHistoryAlreadyLoaded() async throws {
        let model = ThreadModel(id: "thr_trip", store: FixtureBackend())
        await model.load()
        await model.loadOlder()
        await model.load()
        let thread = try #require(model.phase.value)
        #expect(thread.items.count == 80)
        #expect(thread.items.first?.id == "hist-a24")
        #expect(thread.olderCursor == "47")
    }

    @Test func anOlderPageGoesInFrontAndSkipsMessagesAlreadyLoaded() {
        let thread = ChatThread(
            id: "t", title: "T", status: "", statusKind: .neutral,
            items: [.user(id: "a", text: "Second"), .user(id: "b", text: "Third")], olderCursor: "5")
        let page = MessagePage(
            items: [.user(id: "x", text: "First"), .user(id: "a", text: "Second")], nextCursor: nil)
        let merged = ThreadModel.prepending(page, to: thread)
        #expect(merged.items.map(\.id) == ["x", "a", "b"])
        #expect(merged.olderCursor == nil)
    }

    @Test func aRefreshKeepsOlderMessagesAndLiveOnesAfterThePage() {
        let loaded = ChatThread(
            id: "t", title: "T", status: "", statusKind: .neutral,
            items: [
                .user(id: "o1", text: "Old"), .user(id: "n1", text: "New"),
                .user(id: "n2", text: "Newer"), .user(id: "live", text: "Live"),
            ], olderCursor: "5")
        let fresh = ChatThread(
            id: "t", title: "T2", status: "", statusKind: .neutral,
            items: [.user(id: "n1", text: "New"), .user(id: "n2", text: "Newer")], olderCursor: "9")
        let result = ThreadModel.refreshed(fresh, keeping: loaded)
        #expect(result.items.map(\.id) == ["o1", "n1", "n2", "live"])
        #expect(result.olderCursor == "5")
        #expect(result.title == "T2")
        // With no older page loaded, the fresh page's own cursor is the one that counts.
        #expect(ThreadModel.refreshed(fresh, keeping: nil) == fresh)
    }

    @Test func theThreadListLoadsTheNextPageAndNoMore() async throws {
        let model = ThreadListModel(store: FixtureBackend())
        await model.load()
        #expect(model.phase.value?.count == 3)
        #expect(model.nextCursor == "3")
        await model.loadMore()
        let ids = model.phase.value?.map(\.id) ?? []
        #expect(ids.count == 5)
        #expect(Set(ids).count == 5)
        #expect(model.nextCursor == nil)
        await model.loadMore()
        #expect(model.phase.value?.count == 5)
    }

    @Test func aReloadKeepsTheListPagesAlreadyLoaded() async throws {
        let model = ThreadListModel(store: FixtureBackend())
        await model.load()
        await model.loadMore()
        await model.load()
        #expect(model.phase.value?.count == 5)
        #expect(model.nextCursor == nil)
    }
}
