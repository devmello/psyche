import Testing

@testable import PsycheStore

struct FixtureStoreTests {
    let store = FixtureSnapshotStore()

    @Test func homeHasNeedsYouAndAnApprovalWithFields() async throws {
        let home = try await store.home()
        #expect(home.needsYou.count == 2)
        let approval = try #require(home.needsYou.first?.approval)
        #expect(approval.fields.contains { $0.key == "Amount" })
    }

    @Test func mainThreadIsListedFirst() async throws {
        let threads = try await store.threads()
        #expect(threads.first?.isMain == true)
        #expect(threads.first?.id == FixtureSnapshotStore.mainThreadID)
    }

    @Test func unknownThreadStillLoads() async throws {
        let thread = try await store.thread(id: "thr_nope")
        #expect(!thread.items.isEmpty)
    }

    @Test func searchGroupsHitsAndAnswersRent() async throws {
        let results = try await store.search(query: "Rent")
        #expect(results.answer != nil)
        #expect(results.hits.contains { $0.group == .todo })
        #expect(try await store.search(query: "sam").hits.contains { $0.group == .people })
        #expect(try await store.search(query: "  ").hits.isEmpty)
    }

    @Test func runningFractionIsStepOverCount() {
        let task = RunningTask(id: "t", title: "x", step: 3, stepCount: 7, detail: "", elapsed: "")
        #expect(abs(task.fraction - 3.0 / 7.0) < 0.0001)
    }
}
