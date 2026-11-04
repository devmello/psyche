import Foundation

// Library (§4.4) and the share extension. Owner: the Library session (I6). Gateway methods:
// library.list/get/upload/delete.

public protocol LibraryBackend: Sendable {
    func library(section: LibrarySection) async throws -> [LibraryItem]
    /// A local file to show with Quick Look, or nil when the phone can't open it ("Open on your Mac").
    func libraryFile(id: String) async throws -> URL?
    func upload(_ file: UploadFile) async throws -> LibraryItem
    func deleteLibraryItem(id: String) async throws
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

    public init(id: String, title: String, section: LibrarySection, fileType: String, detail: String, threadID: String? = nil) {
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
