import Foundation

// Receipts and artifacts (read-only lookups, plus restore). Gateway methods: receipts.list/get,
// artifacts.list/read/versions/restore. Owner: the Library session.

public protocol ReceiptsBackend: Sendable {
    /// One page of receipts, newest first. `nextCursor` is nil on the last page.
    func receipts(cursor: String?) async throws -> ReceiptPage
    func receipt(id: String) async throws -> ReceiptItem
    /// One page of canvas artifacts, most recently updated first.
    func artifacts(cursor: String?) async throws -> ArtifactPage
    /// One artifact's metadata (title, type, latest version).
    func artifact(id: String) async throws -> ArtifactItem
    /// The content of one artifact at a version (the latest when nil).
    func artifactContent(id: String, version: Int?) async throws -> ArtifactContent
    /// Every version, oldest first.
    func artifactVersions(id: String) async throws -> [ArtifactVersionItem]
    /// Restores an old version as a new latest version. Returns the new version number.
    func restoreArtifact(id: String, version: Int) async throws -> Int
}

public struct ReceiptPage: Sendable, Equatable {
    public var receipts: [ReceiptItem]
    public var nextCursor: String?
    public init(receipts: [ReceiptItem], nextCursor: String?) {
        self.receipts = receipts
        self.nextCursor = nextCursor
    }
}

public enum ReceiptOutcome: String, Sendable, Equatable {
    case ok, failed, uncertain
}

public struct ReceiptItem: Sendable, Equatable, Identifiable {
    public var id: String
    /// What it was: the action kind (`payment`, `email.send`, …).
    public var kind: String
    public var summary: String
    public var outcome: ReceiptOutcome
    /// Formatted time ("Mon 10:14").
    public var when: String
    /// The task that made it, when there is one.
    public var taskID: String?
    /// The merchant and amount, read from the receipt's external references when the action had them.
    public var merchant: String?
    public var amount: String?
    /// The other external references, sorted by key.
    public var references: [ReceiptReference]

    public init(
        id: String, kind: String, summary: String, outcome: ReceiptOutcome, when: String, taskID: String? = nil,
        merchant: String? = nil, amount: String? = nil, references: [ReceiptReference] = []
    ) {
        self.id = id
        self.kind = kind
        self.summary = summary
        self.outcome = outcome
        self.when = when
        self.taskID = taskID
        self.merchant = merchant
        self.amount = amount
        self.references = references
    }
}

public struct ReceiptReference: Sendable, Equatable {
    public var key: String
    public var value: String
    public init(key: String, value: String) {
        self.key = key
        self.value = value
    }
}

public struct ArtifactPage: Sendable, Equatable {
    public var artifacts: [ArtifactItem]
    public var nextCursor: String?
    public init(artifacts: [ArtifactItem], nextCursor: String?) {
        self.artifacts = artifacts
        self.nextCursor = nextCursor
    }
}

public struct ArtifactItem: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// `markdown`, `html`, `code`, `table`, … (the Gateway's artifact type).
    public var type: String
    public var version: Int
    /// Formatted time of the last change.
    public var updatedAt: String
    /// The Library item that holds the artifact's file, so the Library can list artifacts with their item.
    public var libraryItemID: String?

    public init(id: String, title: String, type: String, version: Int, updatedAt: String, libraryItemID: String? = nil) {
        self.id = id
        self.title = title
        self.type = type
        self.version = version
        self.updatedAt = updatedAt
        self.libraryItemID = libraryItemID
    }

    /// HTML artifacts open in the Quick Look path (as a local .html file).
    public var isHTML: Bool { type == "html" }
}

public struct ArtifactContent: Sendable, Equatable {
    public var artifactID: String
    public var version: Int
    public var type: String
    public var content: String
    public var totalLines: Int
    public init(artifactID: String, version: Int, type: String, content: String, totalLines: Int) {
        self.artifactID = artifactID
        self.version = version
        self.type = type
        self.content = content
        self.totalLines = totalLines
    }
}

public struct ArtifactVersionItem: Sendable, Equatable, Identifiable {
    public var id: Int { version }
    public var version: Int
    /// `agent`, `user` or `specialist`.
    public var author: String
    public var summary: String
    public var createdAt: String
    /// Set when this version is a restore of an earlier one.
    public var restoredFrom: Int?

    public init(version: Int, author: String, summary: String, createdAt: String, restoredFrom: Int? = nil) {
        self.version = version
        self.author = author
        self.summary = summary
        self.createdAt = createdAt
        self.restoredFrom = restoredFrom
    }
}
