import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The end of a paged list keeps asking for pages while it stays on screen (`PagedRowsEnd`). These tests drive the
/// pager the way that end does: ask, and ask again while a cursor remains. The on-screen trigger itself is only
/// exercised in the simulator.
@MainActor
struct PagedRowsEndTests {
    actor Counter {
        private(set) var requests = 0
        func note() { requests += 1 }
    }

    @Test func everyRunPageLoadsThenTheListStops() async throws {
        let backend = FixtureBackend()
        let counter = Counter()
        let pager = PagedRows<AutomationRunItem> { cursor in
            await counter.note()
            let page = try await backend.automationRuns(id: "auto_1", cursor: cursor)
            return (page.runs, page.nextCursor)
        }
        await pager.reload()
        var rounds = 0
        while pager.nextCursor != nil, !pager.moreFailed, rounds < 10 {
            await pager.loadMore()
            rounds += 1
        }
        let ids = pager.rows.map(\.id)
        #expect(ids.count == 7)
        #expect(Set(ids).count == 7)
        #expect(pager.nextCursor == nil)
        // Three pages: the first from reload, then two more. Nothing is asked for after the last page.
        #expect(await counter.requests == 3)
        await pager.loadMore()
        #expect(await counter.requests == 3)
    }

    @Test func everyInboxPageLoadsThenTheListStops() async throws {
        let backend = FixtureBackend()
        let counter = Counter()
        let pager = PagedRows<InboxItem> { cursor in
            await counter.note()
            let page = try await backend.inboxPage(cursor: cursor)
            return (page.items, page.nextCursor)
        }
        await pager.reload()
        while pager.nextCursor != nil, !pager.moreFailed {
            await pager.loadMore()
        }
        let ids = pager.rows.map(\.id)
        #expect(ids.count == 5)
        #expect(Set(ids).count == 5)
        #expect(await counter.requests == 3)
        await pager.loadMore()
        #expect(await counter.requests == 3)
    }
}
