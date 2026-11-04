import Observation
import PsycheStore

@MainActor @Observable
final class ThreadListModel {
    private(set) var phase: LoadPhase<[ChatThreadSummary]> = .idle
    private let store: any SnapshotStore

    init(store: any SnapshotStore) {
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
    /// Local-only until the Outbox exists (I2): messages sent from the composer and chosen options.
    private(set) var sent: [ChatItem] = []
    private(set) var chosen: [String: String] = [:]
    private let store: any SnapshotStore
    let id: String

    init(id: String, store: any SnapshotStore) {
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

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        sent.append(.user(id: "local-\(sent.count)", text: trimmed))
    }

    func choose(option: String, for question: String) {
        chosen[question] = option
    }
}
