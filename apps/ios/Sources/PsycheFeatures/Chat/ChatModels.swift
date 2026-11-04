import Foundation
import Observation
import PsycheBlocks
import PsycheStore

@MainActor @Observable
final class ThreadListModel {
    private(set) var phase: LoadPhase<[ChatThreadSummary]> = .idle
    private(set) var actionError: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(Self.sorted(try await store.threads()))
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
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
    /// Bumped each time the view should look at the bottom again (a flush of streamed text, a new item).
    private(set) var revision = 0
    /// Bumped on every message handed to the backend; drives the send haptic.
    private(set) var sentCount = 0
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
            phase = .loaded(try await store.thread(id: id))
            revision += 1
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
    }

    /// Applies this thread's live events until the view goes away (the reference pattern for every
    /// screen: load in `.task`, then `observe()` in the same task).
    func observe() async {
        for await event in store.events() {
            switch event {
            case .chat(let chat) where chat.threadID == id: apply(chat)
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
        Task { try? await store.cancelRun(threadID: id) }
    }

    func choose(option: String, for question: String) {
        chosen[question] = option
        Task { try? await store.answerQuestion(id: question, answer: QuestionAnswer(optionID: option)) }
    }

    // MARK: Applying events

    private func apply(_ event: ChatEvent) {
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
            if case .user(let userID, _) = item { delivery[userID] = nil }
            Self.upsert(item, into: &thread)
        case .delta:
            break
        case .done(_, let itemID):
            if let index = thread.items.firstIndex(where: { $0.id == itemID }),
                case .assistant(let id, let current, _) = thread.items[index]
            {
                thread.items[index] = .assistant(id: id, text: current, streaming: false)
            }
        case .status(_, let status, let kind):
            thread.status = status
            thread.statusKind = kind
        }
        phase = .loaded(thread)
        revision += 1
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
