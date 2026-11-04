import Foundation

// Library (§4.4) and the share extension. Owner: the Library session (I6). Gateway methods:
// library.list/get/upload/delete.

public protocol LibraryBackend: Sendable {
    func library(section: LibrarySection) async throws -> [LibraryItem]
    /// A local file to show with Quick Look, or nil when the phone can't open it ("Open on your Mac").
    func libraryFile(id: String) async throws -> URL?
    func upload(_ file: UploadFile) async throws -> LibraryItem
    func deleteLibraryItem(id: String) async throws

    // Additive (I6). Both have defaults below, so a backend only overrides them to do better.

    /// `upload`, reporting 0...1 as chunks go (`library.upload` sends at most 600 KB per chunk).
    func upload(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> LibraryItem
    /// One item for its page (route `.file(id)`).
    func libraryItem(id: String) async throws -> LibraryItem
}

extension LibraryBackend {
    public func upload(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> LibraryItem {
        progress(0)
        let item = try await upload(file)
        progress(1)
        return item
    }

    public func libraryItem(id: String) async throws -> LibraryItem {
        for section in LibrarySection.allCases {
            if let item = try await library(section: section).first(where: { $0.id == id }) { return item }
        }
        throw BackendError.notFound
    }
}

public enum LibrarySection: String, Sendable, CaseIterable, Identifiable {
    case documents = "Documents"
    case images = "Images"
    case artifacts = "Artifacts"
    case downloads = "Downloads"
    public var id: String { rawValue }
}

public struct LibraryItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var section: LibrarySection
    /// A file type for the icon: "pdf", "key", "docx", "png", "html", "md".
    public var fileType: String
    /// "Monday 10:14 · 18 slides".
    public var detail: String
    public var threadID: String?
    /// The evidence line on the item page, parts joined by " · " ("Made for · Q3 review · Mon 10:14").
    /// Empty means the page builds one from the section and file type.
    public var evidence: [String]
    /// The title of `threadID`'s thread, for "Used in <thread>".
    public var threadTitle: String?

    public init(
        id: String, title: String, section: LibrarySection, fileType: String, detail: String,
        threadID: String? = nil, evidence: [String] = [], threadTitle: String? = nil
    ) {
        self.evidence = evidence
        self.threadTitle = threadTitle
        self.id = id
        self.title = title
        self.section = section
        self.fileType = fileType
        self.detail = detail
        self.threadID = threadID
    }
}

public struct UploadFile: Sendable, Equatable {
    public var name: String
    public var contentType: String
    public var data: Data
    public var threadID: String?
    public init(name: String, contentType: String, data: Data, threadID: String? = nil) {
        self.name = name
        self.contentType = contentType
        self.data = data
        self.threadID = threadID
    }
}

extension [LibraryItem] {
    public static let skeleton: [LibraryItem] = (1...6).map {
        LibraryItem(id: "sklib\($0)", title: "Placeholder file name", section: .documents, fileType: "pdf", detail: "Placeholder detail")
    }
}
