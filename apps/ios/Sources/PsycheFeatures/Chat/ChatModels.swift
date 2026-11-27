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
    /// The archived side chats, shown below the list. A failed read leaves the section empty.
    private(set) var archived: [ChatThreadSummary] = []
    /// Where the next page of archived chats starts; nil once the last page is loaded.
    private(set) var archivedCursor: String?
    /// True while the next page of archived chats is being fetched.
    private(set) var loadingMoreArchived = false
    private var archivedOlderIDs: Set<String> = []
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

    /// Reads the first page of chats, and of archived chats unless `includeArchived` is false (an event-driven
    /// refresh skips the archive when its section is not showing).
    func load() async { await reload(includeArchived: true) }

    /// `load`, optionally leaving the archive alone. A separate name keeps `model.load` usable as a plain `() async`
    /// function value (the views pass it as a retry action).
    func reload(includeArchived: Bool) async {
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
        if includeArchived { await loadArchived() }
    }

    /// Reads the first archived page again. A failure keeps the list already shown, and older pages stay.
    private func loadArchived() async {
        guard let page = try? await store.archivedThreadPage(cursor: nil) else { return }
        let fresh = Set(page.threads.map(\.id))
        let kept = archived.filter { archivedOlderIDs.contains($0.id) && !fresh.contains($0.id) }
        archivedOlderIDs = Set(kept.map(\.id))
        if kept.isEmpty { archivedCursor = page.nextCursor }
        archived = page.threads + kept
    }

    /// Fetches the next page of archived chats ("Load older chats").
    func loadMoreArchived() async {
        guard !loadingMoreArchived, let cursor = archivedCursor else { return }
        loadingMoreArchived = true
        defer { loadingMoreArchived = false }
        do {
            let page = try await store.archivedThreadPage(cursor: cursor)
            let known = Set(archived.map(\.id))
            let added = page.threads.filter { !known.contains($0.id) }
            archivedOlderIDs.formUnion(added.map(\.id))
            archivedCursor = page.nextCursor
            archived += added
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Brings an archived chat back into the list.
    func restore(_ thread: ChatThreadSummary) async {
        archived.removeAll { $0.id == thread.id }
        do {
            try await store.restoreThread(id: thread.id)
        } catch {
            actionError = error.localizedDescription
        }
        await load()
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
            case .changed(.threads): reloadSoon()
            case .resynced: await load()
            case .chat(.status(let id, let status, let kind)):
                // An empty status means the run ended: the row's own text (time, "Waiting for you") comes from the Gateway.
                if status.isEmpty { reloadSoon() } else { patch(id) { $0.status = status; $0.statusKind = kind } }
            default: break
            }
        }
    }

    /// How long a burst of `threads` events must be quiet before the list is read again. Every committed
    /// message emits one, so a multi-tool reply used to cause a fetch per message.
    @ObservationIgnored var reloadDelay: Duration = .milliseconds(400)
    @ObservationIgnored private var reloadTask: Task<Void, Never>?

    /// A trailing debounce: each call restarts the wait, and one reload follows the last. The archive is read
    /// again only while its section has rows on screen; actions that move chats in or out of it reload it directly.
    private func reloadSoon() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.reloadDelay)
            guard !Task.isCancelled else { return }
            let before = Set(self.phase.value?.map(\.id) ?? [])
            await self.reload(includeArchived: !self.archived.isEmpty)
            // A chat that left the active list may have been archived elsewhere (on the Mac) while the archive was
            // empty and its section hidden: read the archive then, or the chat would show in neither list.
            if self.archived.isEmpty, let now = self.phase.value, !before.subtracting(now.map(\.id)).isEmpty {
                await self.loadArchived()
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
    /// True while the Gateway summarises the thread's earlier turns (`threads.compact`); the view shows progress.
    private(set) var compacting = false
    /// The owner's thumbs on replies in this session, by message id (true is helpful).
    private(set) var feedback: [String: Bool] = [:]
    /// The Gateway's own word on this thread's chat run (`run.updated`); nil until one arrives, and after a
    /// terminal state. Keeps Stop up while a run waits on an approval.
    private(set) var runState: RunUpdate.State?
    /// True from the moment this phone sends a message until a reply or the Gateway's own status replaces it. The
    /// thread's `status` stays empty meanwhile: the words come from `displayStatus`, localized, never from a
    /// string compared against.
    private(set) var thinking = false
    private var refreshingHeader = false
    private let store: any PsycheBackend
    private var drafts: [String: MessageDraft] = [:]
    private var pendingDeltas: [String: String] = [:]
    private var flushTask: Task<Void, Never>?
    let id: String

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    /// The status words for the title line and the working row: the Gateway's text, or "Thinking" while only
    /// this phone's placeholder is up.
    var displayStatus: String {
        let status = phase.value?.status ?? ""
        if status.isEmpty, thinking { return String(localized: "Thinking", bundle: .module) }
        return status
    }

    /// True while Psyche is working on this thread, which swaps Send for Stop.
    var isRunning: Bool {
        guard let thread = phase.value else { return false }
        if runState == .waiting { return true }
        if thread.statusKind == .running { return true }
        if case .assistant(_, _, true)? = thread.items.last { return true }
        return false
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            let fresh = Self.refreshed(try await store.thread(id: id), keeping: phase.value)
            // A read of the thread replaces the placeholder with the Gateway's own word on the run.
            if fresh.statusKind != .running || !fresh.status.isEmpty { thinking = false }
            phase = .loaded(fresh)
            revision += 1
            runState = nil
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
            case .chat(let chat) where chat.threadID == id || chat.threadID == phase.value?.id:
                apply(chat)
                // A run that ended may have left a failure, a cancel or no reply at all: read the thread as it is now.
                if case .run(_, let update) = chat, update.isChat, Self.isTerminal(update.state) { await load() }
            // `thread.updated` (a rename, an automatic title) reaches an open thread as a threads change.
            case .changed(.threads): await refreshHeader()
            case .resynced: await load()
            default: break
            }
        }
    }

    /// Takes only the title from the Gateway, so a rename or an automatic title shows in an open thread without
    /// touching the messages. Bursts share one fetch.
    private func refreshHeader() async {
        guard !refreshingHeader, case .loaded = phase else { return }
        refreshingHeader = true
        defer { refreshingHeader = false }
        guard let fresh = try? await store.thread(id: threadID),
            case .loaded(var thread) = phase,
            thread.title != fresh.title || thread.permissionMode != fresh.permissionMode
        else { return }
        thread.title = fresh.title
        // Full access turned on or off on the Mac shows here too.
        thread.permissionMode = fresh.permissionMode
        thread.fullAccessAllowed = fresh.fullAccessAllowed
        phase = .loaded(thread)
    }

    static func isTerminal(_ state: RunUpdate.State) -> Bool {
        switch state {
        case .done, .failed, .cancelled: true
        case .running, .waiting: false
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
                    detail: String(localized: "Attached", bundle: .module), libraryID: file.id, isArtifact: false))
        }
        beginThinking()
        sentCount += 1
        deliver(draft)
    }

    func retry(_ messageID: String) {
        guard let draft = drafts[messageID] else { return }
        delivery[messageID] = nil
        beginThinking()
        deliver(draft)
    }

    private func deliver(_ draft: MessageDraft) {
        Task {
            do {
                let sent = try await store.send(draft)
                if sent.delivery == .queued { delivery[draft.clientID] = .queued }
            } catch {
                delivery[draft.clientID] = .failed(error.localizedDescription)
                thinking = false
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

    // MARK: Chat actions (rename, fork, clear, compact, feedback)

    /// The chat's id as the Gateway knows it, for calls that name it.
    private var threadID: String { phase.value?.id ?? id }

    /// Renames the chat. A blank title does nothing; a refusal shows the Gateway's words and the title is read again.
    func rename(to title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if case .loaded(var thread) = phase {
            thread.title = trimmed
            phase = .loaded(thread)
        }
        do {
            try await store.renameThread(id: threadID, title: trimmed)
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    /// Whether the chat is in Full access (the bar above the composer).
    var isFullAccess: Bool { phase.value?.isFullAccess ?? false }

    /// Whether the menu offers the Full access toggle: only in the owner's own chats, which the Gateway allows.
    /// A chat already in Full access keeps the toggle so it can be turned off.
    var canToggleFullAccess: Bool {
        phase.value.map(Self.offersFullAccess) ?? false
    }

    static func offersFullAccess(_ thread: ChatThread) -> Bool {
        thread.fullAccessAllowed || thread.isFullAccess
    }

    /// Turns Full access on or off (`threads.update`). The mode changes only once the Gateway has accepted it: a
    /// refusal (a phone that is not paired as admin) shows the Gateway's own reason and the chat stays as it was.
    func setFullAccess(_ enabled: Bool) async {
        do {
            try await store.setFullAccess(threadID: threadID, enabled: enabled)
            if case .loaded(var thread) = phase {
                thread.permissionMode = enabled ? ThreadFullAccess.mode : "balanced"
                phase = .loaded(thread)
            }
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// Forks the chat at one reply (`threads.fork`). Returns the new chat's id so the caller can open it; nil on refusal.
    func fork(atMessage messageID: String) async -> String? {
        do {
            return try await store.forkThread(id: threadID, messageID: messageID, title: nil).id
        } catch {
            actionError = error.localizedDescription
            return nil
        }
    }

    /// Empties the chat (`threads.clear`) once the owner has confirmed it, then reads it again.
    func clear() async {
        do {
            try await store.clearThread(id: threadID)
            queue = []
        } catch {
            actionError = error.localizedDescription
        }
        await replaceTranscript()
    }

    /// Summarises the earlier turns now, with progress shown until the transcript is read again.
    func compact() async {
        guard !compacting, !isRunning else { return }
        compacting = true
        defer { compacting = false }
        do {
            _ = try await store.compactThread(id: threadID)
        } catch {
            actionError = error.localizedDescription
        }
        await replaceTranscript()
    }

    /// Reads the transcript again as the Gateway has it now. Unlike `load()`, this does not keep older messages
    /// already on screen, so a compaction or a clear shows what is left, not the old turns in front of it.
    private func replaceTranscript() async {
        do {
            phase = .loaded(try await store.thread(id: threadID))
            revision += 1
        } catch {
            actionError = error.localizedDescription
        }
        await loadQueue()
    }

    /// Records thumbs on a reply. The mark shows at once; a refusal takes it back and shows the Gateway's words.
    func giveFeedback(messageID: String, helpful: Bool) async {
        guard feedback[messageID] != helpful else { return }
        let previous = feedback[messageID]
        feedback[messageID] = helpful
        do {
            try await store.giveFeedback(threadID: threadID, messageID: messageID, helpful: helpful)
        } catch {
            feedback[messageID] = previous
            actionError = error.localizedDescription
        }
    }

    // MARK: Applying events

    func apply(_ event: ChatEvent) {
        // The queue is the whole list, so it replaces what this phone had.
        if case .queue(_, let items) = event {
            queue = Self.sortedQueue(items)
            return
        }
        if case .run(_, let update) = event {
            applyRun(update)
            return
        }
        // The outbox settled a message that waited offline: a refusal marks its bubble failed (Retry shows), a
        // delivery drops "Waiting".
        if case .sendResult(_, let messageID, let failure) = event {
            if let failure {
                delivery[messageID] = .failed(failure)
                if thinking, case .loaded(var thread) = phase {
                    thinking = false
                    thread.status = ""
                    thread.statusKind = .neutral
                    phase = .loaded(thread)
                }
            } else if delivery[messageID] == .queued {
                delivery[messageID] = nil
            }
            return
        }
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
            if case .assistant(_, _, false) = item { endThinking(&thread) }
            Self.upsert(item, into: &thread)
        case .delta, .queue, .sendResult:
            break
        case .done(_, let itemID):
            if let index = thread.items.firstIndex(where: { $0.id == itemID }),
                case .assistant(let id, let current, _) = thread.items[index]
            {
                thread.items[index] = .assistant(id: id, text: current, streaming: false)
            }
            endThinking(&thread)
        case .status(_, let status, let kind):
            thinking = false
            thread.status = status
            thread.statusKind = kind
        case .run:
            break
        }
        phase = .loaded(thread)
        revision += 1
    }

    /// The thread follows its chat run. Any terminal state (done, failed, cancelled) clears Thinking and Running
    /// and settles a reply that was still streaming, even when no assistant message ever arrives. Task runs and
    /// other kinds say nothing about this thread's reply.
    private func applyRun(_ update: RunUpdate) {
        guard update.isChat else { return }
        flushDeltas()
        guard case .loaded(var thread) = phase else { return }
        if Self.isTerminal(update.state) {
            runState = nil
            if thread.statusKind == .running || thinking {
                thread.status = ""
                thread.statusKind = .neutral
            }
            thinking = false
            for index in thread.items.indices {
                if case .assistant(let id, let text, true) = thread.items[index] {
                    thread.items[index] = .assistant(id: id, text: text, streaming: false)
                }
            }
        } else {
            runState = update.state
            if update.state == .running, thread.statusKind != .running {
                thinking = true
                thread.status = ""
                thread.statusKind = .running
            }
        }
        phase = .loaded(thread)
        revision += 1
    }

    /// "Thinking" is this phone's own placeholder from sending; a finished reply ends it. A real run status
    /// from the Gateway (`.status`) is left alone.
    private func endThinking(_ thread: inout ChatThread) {
        if thinking {
            thinking = false
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
        // Take the thread out of `phase` first: while `phase` still holds it, the first write to `items` copies the
        // whole array on every flush (about every 16 ms). Nothing renders between these lines.
        phase = .idle
        for (itemID, text) in deltas {
            // The streaming reply is at or near the end, so search from there.
            if let index = thread.items.lastIndex(where: { $0.id == itemID }),
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

    private func beginThinking() {
        thinking = true
        setStatus("", .running)
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
