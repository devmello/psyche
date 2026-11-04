import Foundation

/// Library's fixture state.
struct LibraryState: Sendable {
    var items = FixtureData.libraryItems
    var counter = 0
}

extension FixtureBackend: LibraryBackend {
    public func library(section: LibrarySection) async throws -> [LibraryItem] {
        await pause()
        return libraryState.items.filter { $0.section == section }
    }

    public func libraryFile(id: String) async throws -> URL? { nil }

    public func upload(_ file: UploadFile) async throws -> LibraryItem {
        libraryState.counter += 1
        let section: LibrarySection = file.contentType.hasPrefix("image/") ? .images : .documents
        let fileType = (file.name as NSString).pathExtension.lowercased()
        let item = LibraryItem(
            id: "lib_up\(libraryState.counter)", title: file.name, section: section, fileType: fileType,
            detail: "Just now · from this phone", threadID: file.threadID)
        libraryState.items.insert(item, at: 0)
        publish(.changed(.library))
        return item
    }

    public func deleteLibraryItem(id: String) async throws {
        libraryState.items.removeAll { $0.id == id }
        publish(.changed(.library))
    }
}

extension FixtureData {

    public static let libraryItems: [LibraryItem] = [
        LibraryItem(id: "lib_8f2a", title: "Q3-review-v4.key", section: .documents, fileType: "key", detail: "Monday 10:14 · 18 slides", threadID: "thr_q3"),
        LibraryItem(id: "lib_91c0", title: "Q3-review-final.pdf", section: .documents, fileType: "pdf", detail: "Monday 16:52 · 21 pages", threadID: "thr_q3"),
        LibraryItem(id: "lib_lease", title: "lease-2026.pdf", section: .documents, fileType: "pdf", detail: "Oct 28 · 9 pages"),
        LibraryItem(id: "lib_77c1", title: "PG&E statement, October", section: .documents, fileType: "pdf", detail: "Today 08:58 · 2 pages"),
        LibraryItem(id: "lib_img1", title: "Quartz sample.jpg", section: .images, fileType: "jpg", detail: "Oct 30"),
        LibraryItem(id: "lib_img2", title: "Receipt, hardware store.png", section: .images, fileType: "png", detail: "Oct 27"),
        LibraryItem(id: "lib_art1", title: "Kitchen budget", section: .artifacts, fileType: "html", detail: "Built for you · Oct 30"),
        LibraryItem(id: "lib_dl1", title: "renters-policy-2026.pdf", section: .downloads, fileType: "pdf", detail: "Oct 12 · 14 pages"),
    ]
}
