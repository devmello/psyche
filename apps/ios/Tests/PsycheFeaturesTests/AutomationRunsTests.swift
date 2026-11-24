import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

@MainActor
struct AutomationRunsTests {
    enum StubError: Error { case down }

    /// Fails the page at `cursor` once, then lets it through.
    actor FailOnce {
        private let cursor: String
        private var spent = false
        init(cursor: String) { self.cursor = cursor }
        func shouldFail(_ requested: String?) -> Bool {
            guard requested == cursor, !spent else { return false }
            spent = true
            return true
        }
    }

    /// The fixture's seven runs of auto_1 come three a page, newest first, with no repeats.
    @Test func fixturePagesThroughEverySeededRun() async throws {
        let backend = FixtureBackend()
        let first = try await backend.automationRuns(id: "auto_1", cursor: nil)
        #expect(first.runs.count == 3)
        #expect(first.nextCursor == "3")
        let second = try await backend.automationRuns(id: "auto_1", cursor: first.nextCursor)
        #expect(second.runs.count == 3)
        let last = try await backend.automationRuns(id: "auto_1", cursor: second.nextCursor)
        #expect(last.runs.count == 1)
        #expect(last.nextCursor == nil)
        let ids = (first.runs + second.runs + last.runs).map(\.id)
        #expect(ids.count == 7 && Set(ids).count == 7)
        #expect(ids.first == "arun_7")
    }

    @Test func fixtureHasARunningRunAndAFailedRunWithItsReason() async throws {
        let runs = try await FixtureBackend().automationRuns(id: "auto_1", cursor: nil).runs
            + FixtureBackend().automationRuns(id: "auto_1", cursor: "3").runs
        #expect(runs.contains { $0.status == .running && $0.endedAt == nil })
        let failed = runs.filter { $0.status == .failed }
        #expect(!failed.isEmpty)
        #expect(failed.allSatisfy { ($0.summary ?? "").isEmpty == false })
    }

    @Test func aFailedNextPageShowsRetryAndRetryAddsTheRowsOnce() async throws {
        let backend = FixtureBackend()
        let gate = FailOnce(cursor: "3")
        let pager = PagedRows<AutomationRunItem> { cursor in
            if await gate.shouldFail(cursor) { throw StubError.down }
            let page = try await backend.automationRuns(id: "auto_1", cursor: cursor)
            return (page.runs, page.nextCursor)
        }
        await pager.reload()
        #expect(pager.rows.count == 3)

        await pager.loadMore()
        #expect(pager.moreFailed)
        #expect(pager.rows.count == 3)
        // The failed page is not asked for again until the owner taps Try again.
        await pager.loadMore()
        #expect(pager.rows.count == 3)

        await pager.retryMore()
        #expect(!pager.moreFailed)
        #expect(pager.rows.count == 6)
        #expect(pager.nextCursor == "6")

        await pager.loadMore()
        let ids = pager.rows.map(\.id)
        #expect(ids.count == 7 && Set(ids).count == 7)
        #expect(pager.nextCursor == nil)
    }
}
