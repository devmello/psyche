import Foundation

// The share extension's outbox (docs/design/mobile-companion-2026.md §2.3, ios-app-2026.md §2): the
// extension writes what the owner shared and the note into a folder in the app group; the app drains it
// on launch and on foreground (upload with the chosen thread, then send the note). Shared content is
// untrusted: taint is applied on the Gateway side, so nothing here interprets it.
//
// Layout under the root:
//   <root>/<item id>/item.json      written last, so a half-copied item is never picked up
//   <root>/<item id>/files/<name>   copies of the shared files
//   <root>/recents.json             the threads the picker offers (written by the app)

/// A thread the share sheet can send to.
public struct ShareThreadChoice: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

/// One shared file, copied into the inbox.
public struct SharedFile: Codable, Sendable, Equatable {
    public var name: String
    public var contentType: String
    /// Relative to the item's folder.
    public var path: String
    public init(name: String, contentType: String, path: String) {
        self.name = name
        self.contentType = contentType
        self.path = path
    }
}

/// Where a share goes.
public enum ShareDestination: Codable, Sendable, Equatable {
    case newChat
    case thread(id: String)

    public var threadID: String? {
        if case .thread(let id) = self { id } else { nil }
    }
}

/// What the compose sheet hands to `ShareInbox.enqueue`: files are given as URLs and copied.
public struct ShareDraft: Sendable {
    public var destination: ShareDestination
    public var note: String
    /// Shared text and URLs, sent inside the message rather than uploaded.
    public var text: String
    public var files: [(url: URL, name: String, contentType: String)]

    public init(
        destination: ShareDestination, note: String = "", text: String = "",
        files: [(url: URL, name: String, contentType: String)] = []
    ) {
        self.destination = destination
        self.note = note
        self.text = text
        self.files = files
    }
}

public struct ShareInboxItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var createdAt: Date
    public var destination: ShareDestination
    public var note: String
    public var text: String
    public var files: [SharedFile]
    /// Failed drain attempts so far; an item that keeps failing is dropped (see `ShareInbox.maxAttempts`).
    public var attempts: Int

    public init(
        id: String, createdAt: Date, destination: ShareDestination, note: String, text: String,
        files: [SharedFile], attempts: Int = 0
    ) {
        self.id = id
        self.createdAt = createdAt
        self.destination = destination
        self.note = note
        self.text = text
        self.files = files
        self.attempts = attempts
    }

    /// The chat message that goes with the files: the note, then any shared text or link.
    public var messageText: String {
        let parts = [note, text].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        if parts.isEmpty { return files.isEmpty ? "" : "Shared from my iPhone." }
        return parts.joined(separator: "\n\n")
    }
}

public enum ShareInboxError: Error, Equatable {
    /// No app group container (an unsigned build): nothing can be shared between the extension and the app.
    case unavailable
    case nothingToShare
}

public final class ShareInbox: @unchecked Sendable {
    public static let maxAttempts = 5

    /// The inbox in the app group, or nil where the group isn't provisioned.
    /// One instance per process, so the single-drain guard holds across launch and foreground.
    public static let shared: ShareInbox? = AppGroup.containerURL.map {
        ShareInbox(root: $0.appending(path: "ShareInbox", directoryHint: .isDirectory))
    }

    private let root: URL
    private let lock = NSLock()
    private var draining = false

    public init(root: URL) {
        self.root = root
    }

    // MARK: Writing (the extension)

    @discardableResult
    public func enqueue(_ draft: ShareDraft, now: Date = Date()) throws -> ShareInboxItem {
        guard !draft.files.isEmpty || !draft.text.isEmpty || !draft.note.isEmpty else { throw ShareInboxError.nothingToShare }
        let fm = FileManager.default
        let id = UUID().uuidString
        let folder = root.appending(path: id, directoryHint: .isDirectory)
        let filesFolder = folder.appending(path: "files", directoryHint: .isDirectory)
        try AppGroup.prepareDirectory(root)
        try fm.createDirectory(at: filesFolder, withIntermediateDirectories: true, attributes: Self.protection)
        var shared: [SharedFile] = []
        var used = Set<String>()
        for file in draft.files {
            let name = Self.uniqueName(Self.safeName(file.name), used: &used)
            let copy = filesFolder.appending(path: name)
            try fm.copyItem(at: file.url, to: copy)
            try fm.setAttributes(Self.protection, ofItemAtPath: copy.path)
            shared.append(SharedFile(name: name, contentType: file.contentType, path: "files/\(name)"))
        }
        let item = ShareInboxItem(
            id: id, createdAt: now, destination: draft.destination, note: draft.note, text: draft.text,
            files: shared, attempts: 0)
        try write(item)
        return item
    }

    // MARK: Reading (the app)

    /// Everything waiting, oldest first.
    public func pending() -> [ShareInboxItem] {
        let fm = FileManager.default
        guard let folders = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        let decoder = JSONDecoder()
        return folders.compactMap { folder in
            guard let data = try? Data(contentsOf: folder.appending(path: "item.json")) else { return nil }
            return try? decoder.decode(ShareInboxItem.self, from: data)
        }
        .sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    }

    public func fileURL(_ file: SharedFile, in item: ShareInboxItem) -> URL {
        folder(of: item).appending(path: file.path)
    }

    public func remove(_ item: ShareInboxItem) {
        try? FileManager.default.removeItem(at: folder(of: item))
    }

    /// Everything the extension queued and the thread list: revoked, unpaired or paired with another Gateway.
    public func wipe() {
        try? FileManager.default.removeItem(at: root)
    }

    public enum DrainResult: Sendable, Equatable {
        case drained(count: Int)
        /// One item failed and stayed queued; later items wait so order is kept.
        case stopped(done: Int, remaining: Int)
        /// Another drain was already running.
        case busy
    }

    /// Hands each waiting item to `process`, oldest first, removing it when `process` returns. When
    /// `process` throws, the item stays (its attempt count goes up; at `maxAttempts` it is dropped so one
    /// bad share can't block the rest) and the drain stops. Only one drain runs at a time per inbox, so
    /// launch and foreground racing each other can't send an item twice.
    ///
    /// `countsAsAttempt` says whether a failure counts toward `maxAttempts`: an item that could not go because
    /// the Mac was unreachable is not a bad item, so it waits without using up an attempt.
    public func drain(
        countsAsAttempt: (any Error) -> Bool = { _ in true },
        _ process: (ShareInboxItem) async throws -> Void
    ) async -> DrainResult {
        guard claim() else { return .busy }
        defer { release() }

        var done = 0
        let items = pending()
        for (index, item) in items.enumerated() {
            do {
                try await process(item)
                remove(item)
                done += 1
            } catch {
                if countsAsAttempt(error) {
                    var failed = item
                    failed.attempts += 1
                    if failed.attempts >= Self.maxAttempts {
                        remove(item)
                    } else {
                        try? write(failed)
                    }
                }
                return .stopped(done: done, remaining: items.count - index)
            }
        }
        return .drained(count: done)
    }

    // MARK: Recent threads for the picker

    public func writeRecents(_ threads: [ShareThreadChoice]) {
        try? AppGroup.prepareDirectory(root)
        if let data = try? JSONEncoder().encode(threads) {
            try? data.write(
                to: root.appending(path: "recents.json"),
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    public func recents() -> [ShareThreadChoice] {
        guard let data = try? Data(contentsOf: root.appending(path: "recents.json")) else { return [] }
        return (try? JSONDecoder().decode([ShareThreadChoice].self, from: data)) ?? []
    }

    // MARK: Private

    private func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if draining { return false }
        draining = true
        return true
    }

    private func release() {
        lock.lock()
        draining = false
        lock.unlock()
    }

    private func folder(of item: ShareInboxItem) -> URL {
        root.appending(path: item.id, directoryHint: .isDirectory)
    }

    private func write(_ item: ShareInboxItem) throws {
        try JSONEncoder().encode(item).write(
            to: folder(of: item).appending(path: "item.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private static var protection: [FileAttributeKey: Any] { [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication] }

    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : cleaned
    }

    private static func uniqueName(_ name: String, used: inout Set<String>) -> String {
        var candidate = name
        var n = 1
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        while used.contains(candidate) {
            n += 1
            candidate = ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)"
        }
        used.insert(candidate)
        return candidate
    }
}
