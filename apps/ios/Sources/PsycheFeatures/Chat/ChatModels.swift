import Foundation
import Observation
import PsycheBlocks
import PsycheStore

/// A chat exported as Markdown, ready for the share sheet.
struct ExportedChat: Identifiable, Equatable {
    var id: String
    var title: String
    var markdown: String
}

@MainActor @Observable
final class ThreadListModel {
    private(set) var phase: LoadPhase<[ChatThreadSummary]> = .idle
    private(set) var actionError: String?
    private(set) var exported: ExportedChat?
    /// Where the next page of the list starts; nil once the last page is loaded.
    private(set) var nextCursor: String?
    /// True while the next page is being fetched (the list shows a quiet spinner row).
    private(set) var loadingMore = false
    /// The rows that came from pages after the first, so a refresh of the first page keeps them.
    private var olderIDs: Set<String> = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            let page = try await store.threadPage(cursor: nil)
            let fresh = Set(page.threads.map(\.id))
            // A refresh of the newest page keeps the older pages already loaded; their cursor stays too.
            let kept = (phase.value ?? []).filter { olderIDs.contains($0.id) && !fresh.contains($0.id) }
            olderIDs = Set(kept.map(\.id))
            if kept.isEmpty { nextCursor = page.nextCursor }
            phase = .loaded(Self.sorted(page.threads + kept))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    /// Fetches the next page when the last row appears, adding rows the list does not have yet.
    func loadMore() async {
        guard !loadingMore, let cursor = nextCursor, case .loaded(let threads) = phase else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await store.threadPage(cursor: cursor)
            let known = Set(threads.map(\.id))
            let added = page.threads.filter { !known.contains($0.id) }
            olderIDs.formUnion(added.map(\.id))
            nextCursor = page.nextCursor
            phase = .loaded(Self.sorted(threads + added))
        } catch {
            actionError = error.localizedDescription
        }
    }

    func resync() async { await load() }

    /// Refetches when the Gateway says threads changed, and after a reconnect.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.threads), .resynced: await load()
            case .chat(.status(let id, let status, let kind)):
                // An empty status means the run ended: the row's own text (time, "Waiting for you") comes from the Gateway.
                if status.isEmpty { await load() } else { patch(id) { $0.status = status; $0.statusKind = kind } }
            default: break
            }
        }
    }

    /// Creates a chat and returns its id so the list can open it.
    func newThread() async -> String? {
        do {
            let summary = try await store.newThread()
            await load()
            return summary.id
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    func pin(_ thread: ChatThreadSummary) async {
        let pinned = !thread.isPinned
        patch(thread.id) { $0.isPinned = pinned }
        do { try await store.pinThread(id: thread.id, pinned: pinned) } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    func archive(_ thread: ChatThreadSummary) async {
        if case .loaded(let threads) = phase { phase = .loaded(threads.filter { $0.id != thread.id }) }
        do { try await store.archiveThread(id: thread.id) } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// Renames a chat. A blank title is ignored, as the sheet's Save does nothing for it.
    func rename(_ thread: ChatThreadSummary, to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != thread.title else { return }
        patch(thread.id) { $0.title = trimmed }
        do {
            try await store.renameThread(id: thread.id, title: trimmed)
            await load()
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// Deletes a side chat once the owner has confirmed it. The row leaves the list at once; a failure brings it back.
    func delete(_ thread: ChatThreadSummary) async {
        if case .loaded(let threads) = phase { phase = .loaded(threads.filter { $0.id != thread.id }) }
        do {
            try await store.deleteThread(id: thread.id)
            await load()
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// Fetches the chat as Markdown; the view presents it for sharing.
    func export(_ thread: ChatThreadSummary) async {
        do {
            let markdown = try await store.exportThread(id: thread.id)
            exported = ExportedChat(id: thread.id, title: thread.title, markdown: markdown)
        } catch {
            actionError = error.localizedDescription
        }
    }

    func clearExport() { exported = nil }

    func clearError() { actionError = nil }

    private func patch(_ id: String, _ change: (inout ChatThreadSummary) -> Void) {
        guard case .loaded(var threads) = phase, let index = threads.firstIndex(where: { $0.id == id }) else { return }
        change(&threads[index])
        phase = .loaded(Self.sorted(threads))
    }

    /// The main thread first, then pinned chats, then the rest in the order the Gateway gave them.
    static func sorted(_ threads: [ChatThreadSummary]) -> [ChatThreadSummary] {
        func rank(_ thread: ChatThreadSummary) -> Int { thread.isMain ? 0 : thread.isPinned ? 1 : 2 }
        return threads.enumerated().sorted { a, b in
            let (ra, rb) = (rank(a.element), rank(b.element))
            return ra == rb ? a.offset < b.offset : ra < rb
        }.map(\.element)
    }
}

/// A file attached to a message: picked, uploaded through Library, then referenced by id.
struct AttachmentRef: Equatable, Identifiable {
    var id: String
    var name: String
    var fileType: String
}

@MainActor @Observable
final class ThreadModel {
    private(set) var phase: LoadPhase<ChatThread> = .idle
    /// Options picked here, so the card shows the choice before the Gateway confirms it.
    private(set) var chosen: [String: String] = [:]
    private(set) var delivery: [String: MessageDelivery] = [:]
    /// The last action the Gateway refused (a stop or an answer that failed), shown as an alert.
    private(set) var actionError: String?
    /// Bumped each time the view should look at the bottom again (a flush of streamed text, a new item).
    private(set) var revision = 0
    /// Bumped on every message handed to the backend; drives the send haptic.
    private(set) var sentCount = 0
    /// The follow-ups the Gateway holds until the reply settles, in run order (`chat.queue.updated`).
    private(set) var queue: [QueuedFollowUp] = []
    /// How a message sent while Psyche is replying goes. Queue is the default, as on the desktop.
    private(set) var runMode: RunMessageMode = .queue
    private let store: any PsycheBackend
    private var drafts: [String: MessageDraft] = [:]
    private var pendingDeltas: [String: String] = [:]
    private var flushTask: Task<Void, Never>?
    let id: String

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    /// True while Psyche is working on this thread, which swaps Send for Stop.
    var isRunning: Bool {
        guard let thread = phase.value else { return false }
        if thread.statusKind == .running { return true }
        if case .assistant(_, _, true)? = thread.items.last { return true }
        return false
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(Self.refreshed(try await store.thread(id: id), keeping: phase.value))
            revision += 1
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        await loadQueue()
    }

    /// True while an older page of the transcript is being fetched.
    private(set) var loadingOlder = false

    /// Prepends the page before the loaded messages (deduped by id; the loaded copy wins).
    func loadOlder() async {
        guard !loadingOlder, case .loaded(let thread) = phase, let cursor = thread.olderCursor else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await store.olderItems(threadID: thread.id, before: cursor)
            guard case .loaded(let current) = phase else { return }
            phase = .loaded(Self.prepending(page, to: current))
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// The older page goes in front. Its messages are older than everything loaded, so order holds.
    static func prepending(_ page: MessagePage, to thread: ChatThread) -> ChatThread {
        let known = Set(thread.items.map(\.id))
        var result = thread
        result.items = page.items.filter { !known.contains($0.id) } + thread.items
        result.olderCursor = page.nextCursor
        return result
    }

    /// A reload of the newest page keeps the older messages already loaded and any live message that came
    /// after the page's last shared message, so a refresh never drops history the reader has scrolled to.
    static func refreshed(_ fresh: ChatThread, keeping current: ChatThread?) -> ChatThread {
        guard let current, !current.items.isEmpty else { return fresh }
        let freshIDs = Set(fresh.items.map(\.id))
        guard let first = current.items.firstIndex(where: { freshIDs.contains($0.id) }),
            let last = current.items.lastIndex(where: { freshIDs.contains($0.id) })
        else { return fresh }
        let older = Array(current.items[..<first])
        let newer = current.items[(last + 1)...].filter { !freshIDs.contains($0.id) }
        var result = fresh
        result.items = older + fresh.items + newer
        if !older.isEmpty { result.olderCursor = current.olderCursor }
        return result
    }

    /// The queue as the Gateway lists it. The live `chat.queue.updated` events keep it current after this.
    private func loadQueue() async {
        do {
            queue = Self.sortedQueue(try await store.queuedFollowUps(threadID: phase.value?.id ?? id))
        } catch {
            actionError = error.localizedDescription
        }
    }

    func setRunMode(_ mode: RunMessageMode) {
        runMode = mode
    }

    /// Sends a message while Psyche is replying: steers the reply now, or queues it after the reply, by
    /// `runMode`. Returns false when the Gateway refused it (the error shows in the alert), so the composer
    /// keeps the text. The user's bubble is not added here: a steer or a queued item shows in its own place.
    func submitWhileRunning(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let threadID = phase.value?.id ?? id
        do {
            switch runMode {
            case .steer:
                try await store.steer(threadID: threadID, text: trimmed)
            case .queue:
                let item = try await store.queueFollowUp(threadID: threadID, text: trimmed)
                if !queue.contains(where: { $0.id == item.id }) {
                    queue = Self.sortedQueue(queue + [item])
                }
            }
            sentCount += 1
            return true
        } catch {
            actionError = error.localizedDescription
            return false
        }
    }

    /// Removes a queued follow-up. It leaves the strip at once; if the Gateway says it already started, or
    /// refuses, the queue is read again so the strip shows what really waits.
    func removeQueued(_ item: QueuedFollowUp) async {
        queue.removeAll { $0.id == item.id }
        do {
            let removed = try await store.removeQueuedFollowUp(threadID: item.threadID, id: item.id)
            if !removed { await loadQueue() }
        } catch {
            actionError = error.localizedDescription
            await loadQueue()
        }
    }

    static func sortedQueue(_ items: [QueuedFollowUp]) -> [QueuedFollowUp] {
        items.sorted { $0.position < $1.position }
    }

    /// Applies this thread's live events until the view goes away (the reference pattern for every
    /// screen: load in `.task`, then `observe()` in the same task).
    func observe() async {
        for await event in store.events() {
            switch event {
            // Opened by an alias (the main thread is "thr_main" until loaded), events carry the real id.
            case .chat(let chat) where chat.threadID == id || chat.threadID == phase.value?.id: apply(chat)
            case .resynced: await load()
            default: break
            }
        }
    }

    func send(_ text: String, attachments: [AttachmentRef] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let draft = MessageDraft(threadID: id, text: trimmed, attachmentIDs: attachments.map(\.id))
        drafts[draft.clientID] = draft
        flushDeltas()
        // The message and its files appear at once; the Gateway's echo replaces the message by id.
        if !trimmed.isEmpty { upsert(.user(id: draft.clientID, text: trimmed)) }
        for (index, file) in attachments.enumerated() {
            upsert(
                .file(
                    id: "\(draft.clientID)-file\(index)", title: file.name, fileType: file.fileType,
                    detail: "Attached", libraryID: file.id, isArtifact: false))
        }
        setStatus("Thinking", .running)
        sentCount += 1
        deliver(draft)
    }

    func retry(_ messageID: String) {
        guard let draft = drafts[messageID] else { return }
        delivery[messageID] = nil
        setStatus("Thinking", .running)
        deliver(draft)
    }

    private func deliver(_ draft: MessageDraft) {
        Task {
            do {
                let sent = try await store.send(draft)
                if sent.delivery == .queued { delivery[draft.clientID] = .queued }
            } catch {
                delivery[draft.clientID] = .failed(error.localizedDescription)
                setStatus("", .neutral)
            }
        }
    }

    func cancel() {
        Task {
            do { try await store.cancelRun(threadID: phase.value?.id ?? id) } catch {
                actionError = error.localizedDescription
            }
        }
    }

    /// Marks the option at once; if the Gateway refuses the answer, the mark goes back and the error shows.
    func choose(option: String, for question: String) {
        let previous = chosen[question]
        chosen[question] = option
        Task {
            do { try await store.answerQuestion(id: question, answer: QuestionAnswer(singleText: option)) } catch {
                if chosen[question] == option { chosen[question] = previous }
                actionError = error.localizedDescription
            }
        }
    }

    func clearActionError() { actionError = nil }

    // MARK: Applying events

    private func apply(_ event: ChatEvent) {
        // The queue is the whole list, so it replaces what this phone had.
        if case .queue(_, let items) = event {
            queue = Self.sortedQueue(items)
            return
        }
        // Run changes feed the Live Activity (AlertCenter); the thread screen reads its own status.
        if case .run = event { return }
        if case .delta(_, let itemID, let text) = event {
            // Deltas arrive faster than frames; they are folded together and laid out once per frame.
            pendingDeltas[itemID, default: ""] += text
            scheduleFlush()
            return
        }
        flushDeltas()
        guard case .loaded(var thread) = phase else { return }
        switch event {
        case .item(_, let item):
            if case .user(let userID, let text) = item {
                delivery[userID] = nil
                // The Gateway stores the message under its own id: swap it in for this phone's local echo
                // (keyed by the draft's clientID) instead of showing the message twice.
                if !thread.items.contains(where: { $0.id == userID }),
                    let echo = thread.items.firstIndex(where: {
                        if case .user(let localID, let localText) = $0 { drafts[localID] != nil && localText == text } else { false }
                    })
                {
                    if case .user(let localID, _) = thread.items[echo] {
                        drafts[localID] = nil
                        delivery[localID] = nil
                    }
                    thread.items[echo] = item
                    break
                }
            }
            if case .assistant(_, _, false) = item { Self.endThinking(&thread) }
            Self.upsert(item, into: &thread)
        case .delta, .queue:
            break
        case .done(_, let itemID):
            if let index = thread.items.firstIndex(where: { $0.id == itemID }),
                case .assistant(let id, let current, _) = thread.items[index]
            {
                thread.items[index] = .assistant(id: id, text: current, streaming: false)
            }
            Self.endThinking(&thread)
        case .status(_, let status, let kind):
            thread.status = status
            thread.statusKind = kind
        case .run:
            break
        }
        phase = .loaded(thread)
        revision += 1
    }

    /// "Thinking" is this phone's own placeholder from sending; a finished reply ends it. A real run status
    /// from the Gateway (`.status`) is left alone.
    private static func endThinking(_ thread: inout ChatThread) {
        if thread.status == "Thinking" {
            thread.status = ""
            thread.statusKind = .neutral
        }
    }

    private func scheduleFlush() {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(16))
            self?.flushDeltas()
        }
    }

    private func flushDeltas() {
        flushTask?.cancel()
        flushTask = nil
        guard !pendingDeltas.isEmpty else { return }
        let deltas = pendingDeltas
        pendingDeltas = [:]
        guard case .loaded(var thread) = phase else { return }
        for (itemID, text) in deltas {
            if let index = thread.items.firstIndex(where: { $0.id == itemID }),
                case .assistant(let id, let current, _) = thread.items[index]
            {
                thread.items[index] = .assistant(id: id, text: current + text, streaming: true)
            }
        }
        phase = .loaded(thread)
        revision += 1
    }

    private func upsert(_ item: ChatItem) {
        guard case .loaded(var thread) = phase else { return }
        Self.upsert(item, into: &thread)
        phase = .loaded(thread)
        revision += 1
    }

    private func setStatus(_ status: String, _ kind: ChatThreadSummary.Status) {
        guard case .loaded(var thread) = phase else { return }
        thread.status = status
        thread.statusKind = kind
        phase = .loaded(thread)
    }

    static func upsert(_ item: ChatItem, into thread: inout ChatThread) {
        if let index = thread.items.firstIndex(where: { $0.id == item.id }) {
            thread.items[index] = item
        } else {
            thread.items.append(item)
        }
    }
}
