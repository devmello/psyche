#if os(iOS)
import Foundation
import Observation
import PsycheStore

/// One upload in flight (or failed), drawn as a row at the top of the list.
struct UploadJob: Identifiable, Equatable {
    let id = UUID()
    let file: UploadFile
    var progress: Double = 0
    var failure: String?
}

@MainActor @Observable
final class LibraryModel {
    var section: LibrarySection = .documents
    private(set) var uploads: [UploadJob] = []
    private let store: any PsycheBackend
    /// One list per section: each keeps its own pages, next cursor and failed page.
    private let pagers: [LibrarySection: PagedRows<PsycheStore.LibraryItem>]

    init(store: any PsycheBackend) {
        self.store = store
        var pagers: [LibrarySection: PagedRows<PsycheStore.LibraryItem>] = [:]
        for section in LibrarySection.allCases {
            pagers[section] = PagedRows { cursor in
                let page = try await store.libraryPage(section: section, cursor: cursor)
                return (page.items, page.nextCursor)
            }
        }
        self.pagers = pagers
    }

    private var pager: PagedRows<PsycheStore.LibraryItem> { pagers[section]! }

    var phase: LoadPhase<[PsycheStore.LibraryItem]> { pager.phase }
    /// True while the next page is being fetched (a quiet row at the end).
    var loadingMore: Bool { pager.loadingMore }
    /// True when the next page failed (a retry row at the end).
    var moreFailed: Bool { pager.moreFailed }
    /// Where the next page starts; nil once the section's last page is loaded.
    var nextCursor: String? { pager.nextCursor }

    /// Loads the first page of the section again.
    func load() async {
        await pager.reload()
    }

    /// Pull to refresh: keeps what's on screen and swaps it when the new list arrives.
    func refresh() async { await load() }

    /// Fetches the next page when the end of the list appears, then keeps the rows newest first.
    func loadMore() async {
        await pager.loadMore()
        sortShown()
    }

    /// Tries the failed next page again.
    func retryMore() async {
        await pager.retryMore()
        sortShown()
    }

    /// Pages come from one kind at a time, so a new page can hold rows older than rows already shown in another kind.
    private func sortShown() {
        pager.edit { $0 = LibraryPaging.newestFirst($0) }
    }

    /// Refetches when the library changed on the Gateway or the connection resynced, until the view goes.
    func observe() async {
        for await event in store.events() {
            switch event {
            case .changed(.library), .resynced: await load()
            default: break
            }
        }
    }

    // MARK: Uploads

    func upload(_ files: [UploadFile]) {
        for file in files {
            let job = UploadJob(file: file)
            uploads.append(job)
            run(job.id)
        }
    }

    func retry(_ id: UUID) {
        guard let index = uploads.firstIndex(where: { $0.id == id }) else { return }
        uploads[index].failure = nil
        uploads[index].progress = 0
        run(id)
    }

    func dismiss(_ id: UUID) {
        uploads.removeAll { $0.id == id }
    }

    private func run(_ id: UUID) {
        guard let file = uploads.first(where: { $0.id == id })?.file else { return }
        Task {
            do {
                let item = try await store.upload(file) { [weak self] value in
                    Task { @MainActor in self?.setProgress(id, value) }
                }
                finish(id, with: item)
            } catch {
                if let index = uploads.firstIndex(where: { $0.id == id }) {
                    uploads[index].failure = error.localizedDescription
                }
            }
        }
    }

    private func setProgress(_ id: UUID, _ value: Double) {
        guard let index = uploads.firstIndex(where: { $0.id == id }), uploads[index].failure == nil else { return }
        uploads[index].progress = max(uploads[index].progress, value)
    }

    /// The new item goes to the top of its section, and the list shows that section.
    private func finish(_ id: UUID, with item: PsycheStore.LibraryItem) {
        uploads.removeAll { $0.id == id }
        pagers[item.section]?.edit { items in
            items.removeAll { $0.id == item.id }
            items.insert(item, at: 0)
        }
        section = item.section
    }
}
#endif
