import Observation
import PsycheStore

@MainActor @Observable
final class ThreadListModel {
    private(set) var phase: LoadPhase<[ChatThreadSummary]> = .idle
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.threads())
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func resync() async { await load() }
}

@MainActor @Observable
final class ThreadModel {
    private(set) var phase: LoadPhase<ChatThread> = .idle
    /// Options picked here, so the card shows the choice before the Gateway confirms it.
    private(set) var chosen: [String: String] = [:]
    private(set) var sendError: String?
    private let store: any PsycheBackend
    let id: String

    init(id: String, store: any PsycheBackend) {
        self.id = id
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        do {
            phase = .loaded(try await store.thread(id: id))
        } catch {
            phase = .failed(error.localizedDescription)
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

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let draft = MessageDraft(threadID: id, text: trimmed)
        apply(.item(threadID: id, item: .user(id: draft.clientID, text: trimmed)))
        sendError = nil
        Task {
            do {
                _ = try await store.send(draft)
            } catch {
                sendError = error.localizedDescription
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

    private func apply(_ event: ChatEvent) {
        guard case .loaded(var thread) = phase else { return }
        switch event {
        case .item(_, let item):
            if let index = thread.items.firstIndex(where: { $0.id == item.id }) {
                thread.items[index] = item
            } else {
                thread.items.append(item)
            }
        case .delta(_, let itemID, let text):
            if let index = thread.items.firstIndex(where: { $0.id == itemID }),
                case .assistant(let id, let current, _) = thread.items[index]
            {
                thread.items[index] = .assistant(id: id, text: current + text, streaming: true)
            }
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
    }
}
