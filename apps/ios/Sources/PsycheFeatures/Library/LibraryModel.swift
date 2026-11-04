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
    private(set) var phases: [LibrarySection: LoadPhase<[PsycheStore.LibraryItem]>] = [:]
    private(set) var uploads: [UploadJob] = []
    private let store: any PsycheBackend

    init(store: any PsycheBackend) {
        self.store = store
    }

    var phase: LoadPhase<[PsycheStore.LibraryItem]> { phases[section] ?? .idle }

    func load() async {
        let section = section
        if phases[section]?.value == nil { phases[section] = .loading }
        do {
            phases[section] = .loaded(try await store.library(section: section))
        } catch {
            phases[section] = .failed(error.localizedDescription)
        }
    }

    /// Pull to refresh: keeps what's on screen and swaps it when the new list arrives.
    func refresh() async { await load() }

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
        var items = phases[item.section]?.value ?? []
        items.removeAll { $0.id == item.id }
        items.insert(item, at: 0)
        phases[item.section] = .loaded(items)
        section = item.section
    }
}
#endif
