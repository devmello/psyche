import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct PagedRowsTests {
    struct Row: Identifiable, Sendable, Equatable {
        let id: String
    }

    enum StubError: Error { case down }

    /// A stub backend for the pager: fixed pages keyed by cursor ("first" for the first page). Pages after the first
    /// wait `delay`, so a test can overlap two requests. One page can be made to fail once.
    actor PageStub {
        private let pages: [String: ([Row], String?)]
        private let delay: Duration
        private var failCursor: String?
        private(set) var requested: [String] = []

        init(_ pages: [String: ([Row], String?)], delay: Duration = .zero) {
            self.pages = pages
            self.delay = delay
        }

        func failOnce(_ cursor: String) {
            failCursor = cursor
        }

        func page(_ cursor: String?) async throws -> (rows: [Row], nextCursor: String?) {
            let key = cursor ?? "first"
            requested.append(key)
            if cursor != nil, delay != .zero { try await Task.sleep(for: delay) }
            if failCursor == key {
                failCursor = nil
                throw StubError.down
            }
            guard let entry = pages[key] else { throw StubError.down }
            return (entry.0, entry.1)
        }
    }

    private let pages: [String: ([Row], String?)] = [
        "first": ([Row(id: "a"), Row(id: "b")], "2"),
        "2": ([Row(id: "c"), Row(id: "d")], "4"),
        "4": ([Row(id: "e")], nil),
    ]

    private func makePager(_ stub: PageStub) -> PagedRows<Row> {
        PagedRows<Row> { cursor in try await stub.page(cursor) }
    }

    @Test func pagesLoadOneAtATimeAndStopAtTheLastPage() async {
        let stub = PageStub(pages)
        let pager = makePager(stub)
        await pager.reload()
        #expect(pager.rows.map(\.id) == ["a", "b"])
        #expect(pager.nextCursor == "2")

        await pager.loadMore()
        #expect(pager.rows.map(\.id) == ["a", "b", "c", "d"])
        #expect(pager.nextCursor == "4")

        await pager.loadMore()
        #expect(pager.rows.map(\.id) == ["a", "b", "c", "d", "e"])
        #expect(pager.nextCursor == nil)

        // Past the end there is nothing to ask for.
        await pager.loadMore()
        let requested = await stub.requested
        #expect(requested == ["first", "2", "4"])
        #expect(!pager.loadingMore)
        #expect(!pager.moreFailed)
    }

    @Test func aFailedPageShowsRetryAndTheRetryAsksForTheSamePageAgain() async {
        let stub = PageStub(pages)
        let pager = makePager(stub)
        await pager.reload()
        await stub.failOnce("2")

        await pager.loadMore()
        #expect(pager.moreFailed)
        #expect(!pager.loadingMore)
        #expect(pager.rows.map(\.id) == ["a", "b"])
        #expect(pager.nextCursor == "2")

        // The end row is a retry row now, so a second load asks nothing new.
        await pager.loadMore()
        let beforeRetry = await stub.requested
        #expect(beforeRetry == ["first", "2"])

        await pager.retryMore()
        #expect(!pager.moreFailed)
        #expect(pager.rows.map(\.id) == ["a", "b", "c", "d"])
        #expect(pager.nextCursor == "4")
    }

    @Test func aRowThatRepeatsAddsNothingAndARowTwiceInAPageIsKeptOnce() async {
        let stub = PageStub([
            "first": ([Row(id: "a"), Row(id: "b")], "2"),
            "2": ([Row(id: "b"), Row(id: "c"), Row(id: "c"), Row(id: "d")], nil),
        ])
        let pager = makePager(stub)
        await pager.reload()
        await pager.loadMore()
        #expect(pager.rows.map(\.id) == ["a", "b", "c", "d"])
        #expect(pager.nextCursor == nil)
    }

    @Test func aReloadStartsAgainAtPageOne() async {
        let stub = PageStub(pages)
        let pager = makePager(stub)
        await pager.reload()
        await pager.loadMore()
        await pager.reload()
        #expect(pager.rows.map(\.id) == ["a", "b"])
        #expect(pager.nextCursor == "2")
        let requested = await stub.requested
        #expect(requested.last == "first")
    }

    @Test func oneNextPageIsInFlightAtATime() async {
        let stub = PageStub(pages, delay: .milliseconds(20))
        let pager = makePager(stub)
        await pager.reload()
        async let first: Void = pager.loadMore()
        async let second: Void = pager.loadMore()
        _ = await (first, second)
        let requested = await stub.requested
        #expect(requested.filter { $0 == "2" }.count == 1)
        #expect(pager.rows.map(\.id) == ["a", "b", "c", "d"])
    }

    @Test func aPageThatArrivesAfterAReloadIsDropped() async throws {
        let stub = PageStub(pages, delay: .milliseconds(50))
        let pager = makePager(stub)
        await pager.reload()
        async let more: Void = pager.loadMore()
        try await Task.sleep(for: .milliseconds(10))
        await pager.reload()
        _ = await more
        #expect(pager.rows.map(\.id) == ["a", "b"])
        #expect(pager.nextCursor == "2")
        #expect(!pager.loadingMore)
    }

    @Test func theInboxPagesThroughTheFixtureNotices() async {
        let model = InboxModel(store: FixtureBackend())
        await model.load()
        let all = FixtureData.inbox.map(\.id)
        // Two a page: the five fixture notices take three pages.
        #expect(model.phase.value?.map(\.id) == Array(all.prefix(2)))
        #expect(model.nextCursor == "2")

        await model.loadMore()
        #expect(model.phase.value?.map(\.id) == Array(all.prefix(4)))
        #expect(model.nextCursor == "4")

        await model.loadMore()
        #expect(model.phase.value?.map(\.id) == all)
        #expect(model.nextCursor == nil)
    }

    @Test func theReceiptsFixturePagesTwoAtATime() async throws {
        let store = FixtureBackend()
        let first = try await store.receipts(cursor: nil)
        #expect(first.receipts.map(\.id) == FixtureReceipts.all.prefix(2).map(\.id))
        #expect(first.nextCursor == "2")
        let second = try await store.receipts(cursor: "2")
        #expect(second.receipts.map(\.id) == FixtureReceipts.all.dropFirst(2).map(\.id))
        #expect(second.nextCursor == nil)
    }
}
