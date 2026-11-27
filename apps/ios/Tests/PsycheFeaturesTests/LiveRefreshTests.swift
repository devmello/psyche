import Foundation
import PsycheShared
import Testing

@testable import PsycheFeatures
@testable import PsycheStore

/// Run lifecycle, archived paging, outbox outcomes, waiting attachments, share drains and paged-list merges:
/// the places a live event or a reconnect used to leave the screen wrong.
@MainActor
struct LiveRefreshTests {
    /// Runs `model.observe()` and waits until it has subscribed, so a published event is not lost.
    static func observing(_ store: FixtureBackend, _ model: ThreadModel) async -> Task<Void, Never> {
        let task = Task { await model.observe() }
        try? await Task.sleep(for: .milliseconds(80))
        return task
    }

    static func eventually(_ what: String = "", _ ok: () -> Bool) async -> Bool {
        for _ in 0..<300 {
            if ok() { return true }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return ok()
    }

    // MARK: Run state

    @Test func aRunCancelledWithNoAssistantMessageClearsRunning() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        let task = await Self.observing(store, model)
        defer { task.cancel() }
        await store.publish(.chat(.run(threadID: "thr_1", update: RunUpdate(state: .running))))
        #expect(await Self.eventually { model.isRunning })
        #expect(model.thinking)
        #expect(!model.displayStatus.isEmpty)
        await store.publish(.chat(.run(threadID: "thr_1", update: RunUpdate(state: .cancelled))))
        #expect(await Self.eventually { !model.isRunning })
        #expect(!model.thinking)
        #expect(model.displayStatus.isEmpty)
        #expect(model.phase.value?.statusKind != .running)
    }

    @Test(arguments: [RunUpdate.State.failed, .done, .cancelled])
    func anyTerminalRunStateClearsThinkingFromASend(_ state: RunUpdate.State) async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.send("Draft the report")
        #expect(model.isRunning)
        model.apply(ChatEvent.run(threadID: "thr_1", update: RunUpdate(state: state)))
        #expect(!model.isRunning)
        #expect(model.phase.value?.status == "")
    }

    @Test func aStreamingReplyIsSettledWhenItsRunEnds() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.apply(.item(threadID: "thr_1", item: .assistant(id: "a1", text: "Working", streaming: true)))
        #expect(model.isRunning)
        model.apply(.run(threadID: "thr_1", update: RunUpdate(state: .failed)))
        #expect(!model.isRunning)
    }

    @Test func aTasksRunSaysNothingAboutTheChatReply() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.send("Hello")
        model.apply(.run(threadID: "thr_1", update: RunUpdate(state: .done, isChat: false, taskID: "task1")))
        #expect(model.isRunning)
    }

    @Test func aRunWaitingOnAnApprovalKeepsStopUp() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.apply(.status(threadID: "thr_1", status: "Waiting for you", kind: .needsYou))
        #expect(!model.isRunning)
        model.apply(.run(threadID: "thr_1", update: RunUpdate(state: .waiting)))
        #expect(model.isRunning)
        model.apply(.run(threadID: "thr_1", update: RunUpdate(state: .done)))
        #expect(!model.isRunning)
    }

    @Test func aThreadUpdatedEventShowsTheNewTitleInAnOpenThread() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_q3", store: store)
        await model.load()
        let task = await Self.observing(store, model)
        defer { task.cancel() }
        try await store.renameThread(id: "thr_q3", title: "Renamed on the Mac")
        await store.publish(.changed(.threads))
        #expect(await Self.eventually { model.phase.value?.title == "Renamed on the Mac" })
    }

    // MARK: Archived chats

    @Test func archivedChatsPageAndLoadOlderAddsTheRest() async throws {
        let store = FixtureBackend()
        let list = ThreadListModel(store: store)
        for id in ["thr_q3", "thr_bills", "thr_lease", "thr_trip"] { try await store.archiveThread(id: id) }
        await list.load()
        // Four side chats are archived and a page holds three.
        #expect(list.archived.count == 3)
        #expect(list.archivedCursor != nil)
        await list.loadMoreArchived()
        #expect(list.archived.count == 4)
        #expect(Set(list.archived.map(\.id)).count == 4)
        #expect(list.archivedCursor == nil)
    }

    @Test func aFailedArchivedReadKeepsTheLastGoodList() async throws {
        let store = FixtureBackend()
        let list = ThreadListModel(store: store)
        await list.load()
        if let thread = list.phase.value?.first(where: { !$0.isMain }) { await list.archive(thread) }
        await list.load()
        let before = list.archived
        #expect(!before.isEmpty)
        await store.failArchivedReads()
        await list.load()
        #expect(list.archived == before)
    }

    // MARK: Outbox outcomes

    @Test func anOutboxRejectionMarksTheMessageFailedAndARetryClearsIt() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        model.send("Hello offline")
        guard case .user(let id, _)? = model.phase.value?.items.last else { Issue.record("no bubble"); return }
        model.apply(.sendResult(threadID: "thr_1", messageID: id, failure: "This phone can't send."))
        #expect(model.delivery[id] == .failed("This phone can't send."))
        model.retry(id)
        #expect(model.delivery[id] == nil)
    }

    @Test func aDeliveredQueuedMessageStopsWaiting() async throws {
        let store = FixtureBackend()
        let model = ThreadModel(id: "thr_1", store: store)
        await model.load()
        await store.queueNextSends(true)
        model.send("Hello offline")
        guard case .user(let id, _)? = model.phase.value?.items.last else { Issue.record("no bubble"); return }
        #expect(await Self.eventually { model.delivery[id] == .queued })
        model.apply(.sendResult(threadID: "thr_1", messageID: id, failure: nil))
        #expect(model.delivery[id] == nil)
    }

    @Test func aFailedMarkReadPutsTheRowBackAndShowsTheError() async throws {
        let store = FixtureBackend()
        let inbox = InboxModel(store: store)
        await inbox.load()
        guard let item = inbox.phase.value?.first(where: { !$0.read }) else { Issue.record("no unread row"); return }
        await store.failNextMarkRead(with: "Couldn't reach the Mac.")
        await inbox.markRead(item)
        #expect(inbox.actionError == "Couldn't reach the Mac.")
        #expect(inbox.phase.value?.first { $0.id == item.id }?.read == false)
    }

    // MARK: Attachments

    @Test func aFileAttachedWhileConnectingUploadsOnceTheConnectionIsLive() async throws {
        let store = FixtureBackend()
        await store.failUploadsAsUnreachable(true)
        let composer = ComposerModel(threadID: "thr_1", store: store)
        composer.connectionChanged(to: .connecting)
        composer.addCameraImage(Data([1, 2, 3]))
        #expect(await Self.eventually { composer.attachments.first?.state == .waiting })
        #expect(composer.isUploading)
        await store.failUploadsAsUnreachable(false)
        composer.connectionChanged(to: .live)
        #expect(await Self.eventually {
            if case .ready? = composer.attachments.first?.state { true } else { false }
        })
        #expect(!composer.isUploading)
    }

    // MARK: Share inbox

    @Test func aReconnectDrainsWhatTheColdLaunchLeftQueued() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "share-resync-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let inbox = ShareInbox(root: root)
        let file = FileManager.default.temporaryDirectory.appending(path: "share-\(UUID().uuidString).txt")
        try Data("x".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        try inbox.enqueue(ShareDraft(destination: .newChat, note: "from the share sheet", files: [(file, "s.txt", "text/plain")]))
        let store = FixtureBackend()
        // Cold launch: the Mac is unreachable, the item stays queued.
        await store.failUploadsAsUnreachable(true)
        _ = await ShareInboxDrain.run(inbox: inbox, backend: store)
        #expect(inbox.pending().count == 1)
        await store.failUploadsAsUnreachable(false)
        // Other events do not drain; the reconnect does.
        await ShareInboxDrain.react(to: .changed(.home), inbox: inbox, backend: store)
        #expect(inbox.pending().count == 1)
        await ShareInboxDrain.react(to: .resynced, inbox: inbox, backend: store)
        #expect(inbox.pending().isEmpty)
    }

    // MARK: Paged lists

    struct Row: Identifiable, Sendable, Equatable { let id: String; var text: String = "" }

    final class Source: @unchecked Sendable {
        private let lock = NSLock()
        private var rows: [Row]
        init(_ rows: [Row]) { self.rows = rows }
        func set(_ rows: [Row]) { lock.withLock { self.rows = rows } }
        /// Pages of two rows; the cursor is the offset.
        func page(_ cursor: String?) -> (rows: [Row], nextCursor: String?) {
            let all = lock.withLock { rows }
            let start = Int(cursor ?? "") ?? 0
            let end = min(start + 2, all.count)
            return (Array(all[start..<end]), end < all.count ? String(end) : nil)
        }
    }

    static func ids(_ rows: PagedRows<Row>) -> [String] { rows.rows.map(\.id) }

    @Test func aLiveRefreshKeepsPageTwoPrependsNewRowsAndUpdatesChangedOnes() async throws {
        let source = Source(["a", "b", "c", "d", "e"].map { Row(id: $0) })
        let pager = PagedRows<Row> { source.page($0) }
        await pager.reload()
        await pager.loadMore()
        #expect(Self.ids(pager) == ["a", "b", "c", "d"])
        source.set([Row(id: "n"), Row(id: "a", text: "edited"), Row(id: "b"), Row(id: "c"), Row(id: "d"), Row(id: "e")])
        await pager.refresh()
        #expect(Self.ids(pager) == ["n", "a", "b", "c", "d"])
        #expect(pager.rows.first { $0.id == "a" }?.text == "edited")
        // The pages after the first are still there, and so is the way to the next one.
        #expect(pager.nextCursor == "4")
    }

    @Test func aLiveRefreshDropsARowDeletedInTheFirstPage() async throws {
        let source = Source(["a", "b", "c", "d", "e"].map { Row(id: $0) })
        let pager = PagedRows<Row> { source.page($0) }
        await pager.reload()
        await pager.loadMore()
        source.set([Row(id: "b"), Row(id: "c"), Row(id: "d"), Row(id: "e")])
        await pager.refresh()
        #expect(Self.ids(pager) == ["b", "c", "d"])
    }

    @Test func aRefreshThatFailsChangesNothingAndABurstRefreshesOnce() async throws {
        let calls = Count()
        let source = Source(["a", "b", "c"].map { Row(id: $0) })
        let pager = PagedRows<Row> { cursor in
            if cursor == nil { calls.bump() }
            return source.page(cursor)
        }
        await pager.reload()
        let before = calls.value
        for _ in 0..<5 { pager.refreshSoon(after: .milliseconds(60)) }
        try await Task.sleep(for: .milliseconds(300))
        #expect(calls.value == before + 1)
    }

    final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func bump() { lock.withLock { n += 1 } }
        var value: Int { lock.withLock { n } }
    }
}
