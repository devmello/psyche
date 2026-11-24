import Observation
import PsycheStore

@MainActor @Observable
final class InboxModel {
    /// The inbox rows, one page at a time. `phase` is what the list shows; the pager owns the cursor.
    private let pager: PagedRows<InboxItem>
    private(set) var needsYou: [NeedsYouItem] = []
    private(set) var actionError: String?
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
        self.pager = PagedRows<InboxItem> { cursor in
            let page = try await store.inboxPage(cursor: cursor)
            return (page.items, page.nextCursor)
        }
    }

    var phase: LoadPhase<[InboxItem]> { pager.phase }
    /// True while the next page is being fetched (a quiet spinner row at the end).
    var loadingMore: Bool { pager.loadingMore }
    /// True when the next page failed (a retry row at the end).
    var moreFailed: Bool { pager.moreFailed }
    /// Where the next page starts; nil once the last page is loaded. The end row is keyed on it, so each page is a new row.
    var nextCursor: String? { pager.nextCursor }

    /// Loads page one again (a reload resets the list to its newest page).
    func load() async {
        async let home = try? store.home()
        await pager.reload()
        needsYou = await home?.needsYou ?? needsYou
    }

    /// Fetches the next page when the end of the list appears.
    func loadMore() async {
        await pager.loadMore()
    }

    /// Tries the failed next page again.
    func retryMore() async {
        await pager.retryMore()
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
        guard !item.read, pager.rows.contains(where: { $0.id == item.id }) else { return }
        pager.edit { items in
            if let index = items.firstIndex(where: { $0.id == item.id }) { items[index].read = true }
        }
        try? await store.markRead(ids: [item.id])
    }

    /// Taps one of a notice's own buttons. The Gateway's answer decides what the row shows next, so it reloads
    /// rather than editing the row. A failure is kept for the list to show.
    func act(_ item: InboxItem, _ action: InboxAction) async {
        actionError = nil
        do {
            try await store.resolveNotice(id: item.id, actionID: action.id)
        } catch {
            actionError = error.localizedDescription
        }
        await load()
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
