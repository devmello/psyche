import Foundation
import Observation
import PsycheStore

@MainActor @Observable
final class InboxModel {
    /// The inbox rows, one page at a time. `phase` is what the list shows; the pager owns the cursor.
    private let pager: PagedRows<InboxItem>
    private(set) var needsYou: [NeedsYouItem] = []
    private(set) var actionError: String?
    /// What the last Cancel recovery said, so the owner sees the result in the list.
    private(set) var recoveryResult: String?
    /// True once the Gateway has granted this phone admin, the scope cancelling a recovery needs.
    private(set) var canCancelRecoveries = false
    private(set) var cancellingRecovery = false
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
        canCancelRecoveries = await store.canCancelRecoveries()
        await refreshCancellable()
    }

    /// Fetches the next page when the end of the list appears.
    func loadMore() async {
        await pager.loadMore()
        await refreshCancellable()
    }

    /// Tries the failed next page again.
    func retryMore() async {
        await pager.retryMore()
    }

    func observe() async {
        for await event in store.events() {
            switch event {
            // Live events fire in bursts while Psyche works: refresh quietly (page one merged into what is loaded)
            // instead of throwing away the pages the owner scrolled to. A resync is rare and loads in full.
            case .changed(.home): refreshSoon()
            case .resynced: await refreshNow()
            default: break
            }
        }
    }

    /// How long a burst of events must be quiet before the inbox refreshes.
    @ObservationIgnored var refreshDelay: Duration = .milliseconds(400)
    @ObservationIgnored private var refreshTask: Task<Void, Never>?

    private func refreshSoon() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.refreshDelay)
            guard !Task.isCancelled else { return }
            await self.refreshNow()
        }
    }

    /// Re-reads the inbox without losing the pages loaded: page one is merged in, older pages and the scroll position stay.
    func refreshNow() async {
        async let home = try? store.home()
        await pager.refresh()
        needsYou = await home?.needsYou ?? needsYou
        await refreshCancellable()
    }

    /// Marks read now (the list updates at once), then tells the Gateway.
    func markRead(_ item: InboxItem) async {
        guard !item.read, pager.rows.contains(where: { $0.id == item.id }) else { return }
        pager.edit { items in
            if let index = items.firstIndex(where: { $0.id == item.id }) { items[index].read = true }
        }
        do {
            try await store.markRead(ids: [item.id])
        } catch {
            // Put the row back to unread and say so, the way the inbox shows its other errors.
            pager.edit { items in
                if let index = items.firstIndex(where: { $0.id == item.id }) { items[index].read = false }
            }
            actionError = error.localizedDescription
        }
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

    /// The waiting security request a notice is about, when it still says it will apply "unless you cancel it":
    /// the Mac's `psyched` asked for it (state "requested"). Applied, cancelled and failed notices have nothing
    /// left to cancel.
    static func recoveryNotice(for item: InboxItem) -> RecoveryNotice? {
        guard let message = item.message, message.bodyKey == "notice.security.recovery.body",
              message.params["state"] == "requested",
              let op = message.params["op"], ["approve", "grant", "presence", "seal"].contains(op)
        else { return nil }
        func named(_ name: String, absent: String) -> String? {
            guard let value = message.params[name], !value.isEmpty, value != absent else { return nil }
            return value
        }
        return RecoveryNotice(
            op: op, device: named("device", absent: "?"), key: named("key", absent: "none"),
            when: named("when", absent: "none").flatMap(Self.utcDate(_:)))
    }

    /// The Gateway's `new Date(notBefore).toUTCString()`: "Mon, 02 Mar 2026 09:00:00 GMT".
    static func utcDate(_ text: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return f.date(from: text)
    }

    /// Notices that still have a waiting request. Old notices stay in the Inbox, so the button shows only for these.
    var cancellable: Set<String> = []

    private func refreshCancellable() async {
        guard canCancelRecoveries, case .loaded(let items) = pager.phase else { cancellable = []; return }
        let pairs = items.compactMap { item in Self.recoveryNotice(for: item).map { (item.id, $0) } }
        let live = await store.cancellable(pairs.map(\.1))
        cancellable = Set(pairs.filter { live.contains($0.1) }.map(\.0))
    }

    /// Cancels the request a notice describes (`security.recoveries.cancel`: it only narrows, so it is a plain tap).
    /// The Gateway decides; its refusal is shown as it words it.
    func cancelRecovery(_ item: InboxItem) async {
        guard let notice = Self.recoveryNotice(for: item), cancellable.contains(item.id), !cancellingRecovery else { return }
        cancellingRecovery = true
        actionError = nil
        recoveryResult = nil
        do {
            switch try await store.cancelRecovery(for: notice) {
            case .cancelled:
                recoveryResult = String(localized: "Cancelled. Nothing will change.", bundle: .module)
            case .nothingWaiting:
                recoveryResult = String(localized: "Nothing is waiting any more. It was already applied or cancelled.", bundle: .module)
            }
        } catch {
            actionError = error.localizedDescription
        }
        cancellingRecovery = false
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
