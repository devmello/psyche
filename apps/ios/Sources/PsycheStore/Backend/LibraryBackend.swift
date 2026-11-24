import Foundation

// Library (§4.4) and the share extension. Owner: the Library session (I6). Gateway methods:
// library.list/get/upload/delete.

public protocol LibraryBackend: Sendable {
    func library(section: LibrarySection) async throws -> [LibraryItem]
    /// One page of a section. `cursor` is nil for the first page, then the `nextCursor` of the page before; a nil
    /// `nextCursor` is the last page. The cursor is opaque to the app.
    func libraryPage(section: LibrarySection, cursor: String?) async throws -> LibraryPage
    /// A local file to show with Quick Look, or nil when the phone can't open it ("Open on your Mac").
    func libraryFile(id: String) async throws -> URL?
    /// Downloads the file for Quick Look, reporting 0...1 as bytes arrive. Throws `LibraryFileRefusal` when the
    /// phone may not open it, and honours cancellation of the calling task.
    func downloadLibraryFile(id: String, progress: @escaping @Sendable (Double) -> Void) async throws -> URL
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

    /// A backend that lists a section in one piece: the first page is the whole list, and there is no next page.
    public func libraryPage(section: LibrarySection, cursor: String?) async throws -> LibraryPage {
        guard cursor == nil else { return LibraryPage(items: [], nextCursor: nil) }
        return LibraryPage(items: try await library(section: section), nextCursor: nil)
    }
}

/// One page of a Library section, newest first.
public struct LibraryPage: Sendable, Equatable {
    public var items: [LibraryItem]
    /// Where the next page starts; nil on the last page.
    public var nextCursor: String?

    public init(items: [LibraryItem], nextCursor: String?) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

/// How pages of a Library section join: one row per id, newest first.
public enum LibraryPaging {
    /// `rows` without a repeated id (the first copy wins), sorted newest first. Rows with no date keep their order
    /// at the end. Sorting is stable, so equal dates keep the order the rows arrived in.
    public static func newestFirst(_ rows: [LibraryItem]) -> [LibraryItem] {
        var seen = Set<String>()
        let unique = rows.filter { seen.insert($0.id).inserted }
        return unique.enumerated()
            .sorted { lhs, rhs in
                switch (lhs.element.date, rhs.element.date) {
                case let (a?, b?) where a != b: return a > b
                case (nil, _?): return false
                case (_?, nil): return true
                default: return lhs.offset < rhs.offset
                }
            }
            .map(\.element)
    }
}

/// Why the phone won't open a Library file. The Mac decides, the phone only shows why.
public enum LibraryFileRefusal: Error, Equatable, Sendable {
    /// Quarantined on the Mac (a download, channel or connector file nobody has trusted yet). Never opened here.
    case quarantined
    /// Bigger than the phone downloads (64 MB). It opens on the Mac.
    case tooLarge
    /// Not kept on the phone, and no download is possible.
    case unavailable
}

public enum LibrarySection: String, Sendable, CaseIterable, Identifiable {
    case documents = "Documents"
    case images = "Images"
    case artifacts = "Artifacts"
    case downloads = "Downloads"
    /// Voice memos, meeting and browser recordings: the Mac's audio, video and `recording` kinds.
    case recordings = "Recordings"
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
    /// Why the phone won't open this file, known from the item itself (quarantined, or too big). Nil when it can
    /// be downloaded on demand.
    public var refusal: LibraryFileRefusal?
    /// The sources a document or artifact was made from (empty when it has none).
    public var sources: [SourceRef]
    /// The artifact this item is, for an artifact row: opens the artifact viewer instead of the file page.
    public var artifactID: String?
    /// When the item was made (the Gateway's `createdAt`), for ordering pages. Nil when the Gateway sent none.
    public var date: Date?

    public init(
        id: String, title: String, section: LibrarySection, fileType: String, detail: String,
        threadID: String? = nil, evidence: [String] = [], threadTitle: String? = nil, refusal: LibraryFileRefusal? = nil,
        sources: [SourceRef] = [], artifactID: String? = nil, date: Date? = nil
    ) {
        self.date = date
        self.artifactID = artifactID
        self.sources = sources
        self.refusal = refusal
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
