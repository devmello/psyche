import Foundation
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// The composer's behaviour while a reply runs: which mode a message takes, the queue strip's state,
/// and how a refusal or a live update changes it.
@MainActor
struct ChatQueueModelTests {
    /// A thread that is replying: the phone's own "Thinking" status from a send makes `isRunning` true.
    func runningThread(_ store: FixtureBackend) async -> ThreadModel {
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.send("Draft the report")
        #expect(model.isRunning)
        return model
    }

    @Test func aMessageSentWhileReplyingQueuesByDefault() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        #expect(model.runMode == .queue)
        #expect(await model.submitWhileRunning("Then send it to Dana"))
        #expect(model.queue.map(\.text) == ["Then send it to Dana"])
        #expect(model.actionError == nil)
    }

    @Test func choosingSteerSendsTheTextIntoTheReplyInsteadOfQueuingIt() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        model.setRunMode(.steer)
        #expect(model.runMode == .steer)
        #expect(await model.submitWhileRunning("Use euros"))
        #expect(model.queue.isEmpty)
        #expect(model.actionError == nil)
    }

    @Test func aBlankMessageIsNotSent() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        #expect(await model.submitWhileRunning("   ") == false)
        #expect(model.queue.isEmpty)
    }

    @Test func aRefusedQueueKeepsTheQueueAndShowsTheError() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        await store.failNextQueueCall(with: "Psyche can't take a message right now.")
        #expect(await model.submitWhileRunning("Then send it") == false)
        #expect(model.queue.isEmpty)
        #expect(model.actionError == "Psyche can't take a message right now.")
        model.clearActionError()
        #expect(model.actionError == nil)
    }

    @Test func removingAQueuedMessageTakesItOutOfTheStripAndTheGateway() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        #expect(await model.submitWhileRunning("First"))
        #expect(await model.submitWhileRunning("Second"))
        let first = try #require(model.queue.first)
        #expect(first.text == "First")
        await model.removeQueued(first)
        #expect(model.queue.map(\.text) == ["Second"])
        #expect(model.actionError == nil)
        let remaining = try await store.queuedFollowUps(threadID: "thr_1")
        #expect(remaining.map(\.text) == ["Second"])
    }

    @Test func aQueueEventReplacesTheStripWithTheGatewaysList() async throws {
        let store = FixtureBackend()
        let model = await runningThread(store)
        let observer = Task { await model.observe() }
        defer { observer.cancel() }
        let remote = [QueuedFollowUp(id: "gw1", threadID: "thr_1", position: 0, text: "From the Mac")]
        // The observer subscribes on its own task; publish until the strip shows the list.
        for _ in 0..<200 where model.queue != remote {
            await store.publish(.chat(.queue(threadID: "thr_1", items: remote)))
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(model.queue == remote)
        // The run started the queued item: the Gateway sends an empty list and the strip clears.
        for _ in 0..<200 where !model.queue.isEmpty {
            await store.publish(.chat(.queue(threadID: "thr_1", items: [])))
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(model.queue.isEmpty)
    }

    @Test func aLoadReadsTheQueueTheGatewayAlreadyHolds() async throws {
        let store = FixtureBackend()
        _ = try await store.queueFollowUp(threadID: "thr_1", text: "Waiting from before")
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        #expect(model.queue.map(\.text) == ["Waiting from before"])
    }

    @Test func aQueueSortsByItsPositionWhateverTheArrivalOrder() {
        let late = QueuedFollowUp(id: "b", threadID: "t", position: 1, text: "second")
        let early = QueuedFollowUp(id: "a", threadID: "t", position: 0, text: "first")
        #expect(ThreadModel.sortedQueue([late, early]).map(\.id) == ["a", "b"])
    }
}
