import Observation
import PsycheStore

@MainActor @Observable
final class InboxModel {
    private(set) var phase: LoadPhase<[InboxItem]> = .idle
    private(set) var needsYou: [NeedsYouItem] = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    func load() async {
        if phase.value == nil { phase = .loading }
        async let home = try? store.home()
        do {
            phase = .loaded(try await store.inbox())
        } catch {
            if phase.value == nil { phase = .failed(error.localizedDescription) }
        }
        needsYou = await home?.needsYou ?? needsYou
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.home), .resynced: await load()
            default: break
            }
        }
    }

    /// Marks read now (the list updates at once), then tells the Gateway.
    func markRead(_ item: InboxItem) async {
        guard !item.read, case .loaded(var items) = phase, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index].read = true
        phase = .loaded(items)
        try? await store.markRead(ids: [item.id])
    }

    /// The Needs-you item an entry is about, while it is still waiting.
    func pending(for item: InboxItem) -> NeedsYouItem? {
        item.needsYouID.flatMap { id in needsYou.first { $0.id == id } }
    }
}

extension [InboxItem] {
    static let skeleton: [InboxItem] = (1...4).map {
        InboxItem(
            id: "ski\($0)", title: "Placeholder inbox title", body: "Placeholder body line", kindLabel: "Done",
            time: "0:00", needsYou: $0 == 1)
    }
}
