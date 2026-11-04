import Testing

@testable import PsycheStore

struct FixtureStoreTests {
    let store = FixtureBackend()

    @Test func homeHasNeedsYouAndAnApprovalWithFields() async throws {
        let home = try await store.home()
        #expect(home.needsYou.count == 2)
        let approval = try #require(home.needsYou.first?.approval)
        #expect(approval.fields.contains { $0.key == "Amount" })
    }

    @Test func mainThreadIsListedFirst() async throws {
        let threads = try await store.threads()
        #expect(threads.first?.isMain == true)
        #expect(threads.first?.id == FixtureData.mainThreadID)
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

    @Test func answeringAnApprovalRemovesItFromHomeAndSaysSo() async throws {
        let events = store.events()
        try await Task.sleep(for: .milliseconds(20))
        try await store.answerApproval(id: "appr_electric", decision: .allow)
        #expect(try await store.home().needsYou.allSatisfy { $0.id != "appr_electric" })
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .changed(.home))
    }

    @Test func sendingStreamsAReplyThatEndsDone() async throws {
        let events = store.events()
        try await Task.sleep(for: .milliseconds(20))
        let sent = try await store.send(MessageDraft(threadID: "thr_q3", text: "Is rent paid?"))
        #expect(sent.delivery == .sent)
        var sawDelta = false
        for await event in events {
            guard case .chat(let chat) = event else { continue }
            if case .delta = chat { sawDelta = true }
            if case .done = chat { break }
        }
        #expect(sawDelta)
        let thread = try await store.thread(id: "thr_q3")
        #expect(thread.items.contains { $0.id == sent.messageID })
        #expect(thread.items.contains {
            if case .assistant(_, let text, false) = $0 { text.contains("Is rent paid?") } else { false }
        })
    }
}
