import CryptoKit
import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

// Library over `library.list/get/upload/delete`, and `files.read` for the bytes of one file. Uploads are
// direct calls, not outbox entries: a later chunk needs the `uploadId` the first chunk's answer carries, and
// the caller needs the item's id (a chat attachment), so there is nothing to queue ahead. Away from the Mac an
// upload throws `BackendError.unreachable`, and the share inbox (the durable queue for shared files) keeps the
// item without spending one of its attempts.
extension GatewayBackend {
    /// Raw bytes per `library.upload` call: `UPLOAD_CHUNK_BYTES` (384 KiB, 512 KiB as base64, under the 600 KB limit).
    static let uploadChunkBytes = 384 * 1024
    /// The Gateway refuses a bigger file (`UPLOAD_MAX_BYTES`).
    static let uploadMaxBytes = 25 * 1024 * 1024
    /// Files bigger than this open on the Mac, not on the phone.
    static let downloadMaxBytes = 64 * 1024 * 1024
    /// Downloaded copies kept on the phone; past this the least recently opened go first.
    static let cacheMaxBytes = 200 * 1024 * 1024

    public func library(section: LibrarySection) async throws -> [LibraryItem] {
        let result = try await call("library.list", .obj(["kind": .string(Self.wireKind(of: section)), "limit": .number(100)]))
        return (result["items"]?.array ?? []).compactMap { item in
            guard item["quarantined"]?.bool != true else { return nil }
            return Self.libraryItem(from: item, section: section)
        }
    }

    public func libraryItem(id: String) async throws -> LibraryItem {
        let result = try await call("library.get", .obj(["itemId": .string(id)]))
        guard let wire = result["item"], var item = Self.libraryItem(from: wire) else { throw BackendError.notFound }
        if let threadID = item.threadID,
           let thread = await optional({ try await self.call("threads.get", .obj(["threadId": .string(threadID)])) }),
           let title = thread.at("thread", "title")?.string, !title.isEmpty {
            item.threadTitle = title
            item.evidence = Self.evidence(of: wire, threadTitle: title)
        }
        return item
    }

    /// A local copy for thumbnails and the share sheet, which stay quiet: nil when the phone can't have one.
    public func libraryFile(id: String) async throws -> URL? {
        do { return try await downloadLibraryFile(id: id, progress: { _ in }) } catch is LibraryFileRefusal { return nil }
    }

    /// Downloads the file into the caches directory (protected, kept out of backups) and returns where it is.
    /// Throws `LibraryFileRefusal` before any byte moves when the file is quarantined or too big, and
    /// `CancellationError` when the caller cancels between chunks (the partial file is removed). A copy already
    /// on the phone for this hash is reused; the cache keeps at most `cacheMaxBytes`, least recently used first.
    public func downloadLibraryFile(id: String, progress: @escaping @Sendable (Double) -> Void) async throws -> URL {
        let result = try await call("library.get", .obj(["itemId": .string(id)]))
        guard let item = result["item"], let path = item["path"]?.string, !path.isEmpty else { throw BackendError.notFound }
        if item["quarantined"]?.bool == true { throw LibraryFileRefusal.quarantined }
        let size = item["size"]?.int ?? 0
        if size > Self.downloadMaxBytes { throw LibraryFileRefusal.tooLarge }
        let name = item["name"]?.string ?? "file"
        let version = String((item["sha256"]?.string ?? "").prefix(12))
        let downloads = LibraryDownloads(directory: client.libraryCache)
        let destination = downloads.url(id: id, version: version, name: name)
        progress(0)
        if FileManager.default.fileExists(atPath: destination.path) {
            downloads.touch(destination)
            progress(1)
            return destination
        }

        let temporary = try downloads.beginFile(for: destination)
        var finished = false
        defer { if !finished { try? FileManager.default.removeItem(at: temporary) } }
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close() }
        var offset = 0
        var etag: String?
        var hasher = SHA256()
        while true {
            try Task.checkCancellation()
            let chunk = try await call("files.read", .obj(["libraryPath": .string(path), "offset": .number(Double(offset))]))
            if let etag, let now = chunk["etag"]?.string, now != etag {
                throw BackendError.refused("This file changed while it downloaded. Try again.")
            }
            etag = chunk["etag"]?.string
            guard let encoded = chunk["bytes"]?.string, let bytes = Data(base64Encoded: encoded) else {
                throw BackendError.refused("The Gateway sent a file this phone can't read.")
            }
            try handle.write(contentsOf: bytes)
            hasher.update(data: bytes)
            offset += bytes.count
            if offset > Self.downloadMaxBytes { throw LibraryFileRefusal.tooLarge }
            let total = max(chunk["size"]?.int ?? size, 1)
            progress(min(Double(offset) / Double(total), 1))
            // nextOffset is null on the last chunk.
            guard let next = chunk["nextOffset"]?.int, !bytes.isEmpty else { break }
            offset = next
        }
        try handle.close()
        // The bytes must be the ones the Mac recorded (`sha256:<hex>`). A mismatch removes the copy: nothing is kept
        // or opened from it.
        let actual = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        let recorded = (item["sha256"]?.string ?? "").replacingOccurrences(of: "sha256:", with: "").lowercased()
        guard actual == recorded else {
            downloads.remove(id: id)
            throw BackendError.refused("This file doesn't match what your Mac has, so it wasn't opened. Try again.")
        }
        try downloads.finish(temporary, as: destination)
        finished = true
        downloads.evict(maxBytes: Self.cacheMaxBytes, keeping: destination)
        progress(1)
        return destination
    }

    public func upload(_ file: UploadFile) async throws -> LibraryItem {
        try await upload(file, progress: { _ in })
    }

    public func upload(_ file: UploadFile, progress: @escaping @Sendable (Double) -> Void) async throws -> LibraryItem {
        guard !file.data.isEmpty else { throw BackendError.refused("That file is empty.") }
        guard file.data.count <= Self.uploadMaxBytes else {
            throw BackendError.refused("That file is bigger than 25 MB. Add it on your Mac instead.")
        }
        // One key per chunk, derived from one id for this upload: a chunk resent after a lost answer is a no-op.
        let token = UUID().uuidString
        let total = file.data.count
        var uploadID: String?
        var sent = 0
        var index = 0
        progress(0)
        while sent < total {
            let end = min(sent + Self.uploadChunkBytes, total)
            let final = end == total
            let bytes = file.data[file.data.startIndex + sent..<file.data.startIndex + end].base64EncodedString()
            var params: [String: JSONValue] = ["name": .string(file.name), "bytes": .string(bytes), "final": .bool(final)]
            if !file.contentType.isEmpty { params["mime"] = .string(file.contentType) }
            if let uploadID { params["uploadId"] = .string(uploadID) }
            // The Gateway takes the thread from the first chunk and keeps it.
            if uploadID == nil, let threadID = file.threadID { params["threadId"] = .string(threadID) }
            let result = try await call("library.upload", .object(params), key: "upload-\(token)-\(index)")
            uploadID = result["uploadId"]?.string ?? uploadID
            sent = end
            index += 1
            progress(Double(sent) / Double(total))
            if final {
                guard let wire = result["item"], let item = Self.libraryItem(from: wire) else {
                    throw BackendError.refused("The Gateway didn't store that file.")
                }
                await client.publishLive(.changed(.library))
                return item
            }
        }
        throw BackendError.refused("The Gateway didn't store that file.")
    }

    public func deleteLibraryItem(id: String) async throws {
        _ = try await call("library.delete", .obj(["itemId": .string(id)]), key: "library-delete-\(id)")
        LibraryDownloads(directory: client.libraryCache).remove(id: id)
        await client.publishLive(.changed(.library))
    }

    // MARK: - Mapping

    static func wireKind(of section: LibrarySection) -> String {
        switch section {
        case .documents: "document"
        case .images: "image"
        case .artifacts: "artifact"
        case .downloads: "download"
        }
    }

    static func section(ofKind kind: String?) -> LibrarySection {
        switch kind {
        case "image": .images
        case "artifact": .artifacts
        case "download": .downloads
        default: .documents  // document, audio, video, recording, system, and kinds a newer Gateway adds
        }
    }

    static func libraryItem(from item: JSONValue, section: LibrarySection? = nil) -> LibraryItem? {
        guard let id = item["id"]?.string else { return nil }
        let name = item["name"]?.string ?? "File"
        let size = item["size"]?.int
        let when = WireFormat.time(item["createdAt"]?.string)
        let detail = [when, size.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} ")
        // The Mac's own gates, read off the item: a quarantined file is never opened here, nor a file over the download cap.
        let refusal: LibraryFileRefusal? =
            item["quarantined"]?.bool == true ? .quarantined : (size ?? 0) > downloadMaxBytes ? .tooLarge : nil
        return LibraryItem(
            id: id, title: name, section: section ?? Self.section(ofKind: item["kind"]?.string),
            fileType: fileType(name: name, mime: item["mime"]?.string), detail: detail,
            threadID: item["threadId"]?.string, evidence: evidence(of: item, threadTitle: nil), refusal: refusal)
    }

    /// "pdf" from `Q3.pdf`; the mime's subtype ("png") when the name has no extension.
    static func fileType(name: String, mime: String?) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        if !ext.isEmpty { return ext }
        guard let subtype = mime?.split(separator: "/").last else { return "" }
        let cleaned = subtype.split(separator: ";").first.map(String.init) ?? String(subtype)
        return cleaned.split(separator: "+").first.map(String.init) ?? cleaned
    }

    /// ["Made for", "Q3 review", "Mon 10:14"]: where it came from, the chat when there is one, and when.
    static func evidence(of item: JSONValue, threadTitle: String?) -> [String] {
        let origin = item["origin"]?.string
        let hasThread = item["threadId"]?.string != nil
        var parts: [String] = []
        switch origin {
        case "agent": parts.append(hasThread ? "Made for" : "Made by Psyche")
        case "upload": parts.append("Uploaded")
        case "download": parts.append("Downloaded")
        case "connector": parts.append("From a connector")
        case "channel": parts.append("Received in a channel")
        default: break
        }
        if let threadTitle { parts.append(threadTitle) }
        let when = WireFormat.time(item["createdAt"]?.string)
        if !when.isEmpty { parts.append(when) }
        return parts
    }
}

/// Files downloaded for Quick Look: the caches directory, one folder per item and version, written protected
/// and excluded from backups. Wiped with everything else when the phone is removed.
struct LibraryDownloads {
    let directory: URL

    /// Files are protected "complete" on the phone. The macOS test host (`swift test`) makes a directory
    /// with that class unwritable (createFile fails, so there is no .part), so it only applies on iOS.
    static var protectedAttributes: [FileAttributeKey: Any]? {
        #if os(iOS)
        [.protectionKey: FileProtectionType.complete]
        #else
        nil
        #endif
    }

    func folder(id: String) -> URL {
        directory.appendingPathComponent(Self.sanitized(id), isDirectory: true)
    }

    /// `<directory>/<id>/<version>/<name>`: a changed file (new hash) is a new download.
    func url(id: String, version: String, name: String) -> URL {
        folder(id: id)
            .appendingPathComponent(version.isEmpty ? "v" : Self.sanitized(version), isDirectory: true)
            .appendingPathComponent(Self.sanitized(name))
    }

    /// Makes the folders and an empty protected file next to `destination` to write into.
    func beginFile(for destination: URL) throws -> URL {
        let folder = destination.deletingLastPathComponent()
        // An older version of the same item is stale now.
        try? FileManager.default.removeItem(at: folder.deletingLastPathComponent())
        try FileManager.default.createDirectory(
            at: folder, withIntermediateDirectories: true,
            attributes: Self.protectedAttributes)
        var root = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
        let part = folder.appendingPathComponent(".part")
        FileManager.default.createFile(atPath: part.path, contents: nil, attributes: Self.protectedAttributes)
        return part
    }

    func finish(_ part: URL, as destination: URL) throws {
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: part, to: destination)
    }

    /// Marks a cached copy as used now, so eviction keeps what the owner opens.
    func touch(_ file: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
    }

    /// Deletes the least recently used copies until the cache holds at most `maxBytes`. Never deletes `keeping`
    /// (the copy just made) or a download still being written (`.part`). Item folders left empty go too.
    func evict(maxBytes: Int, keeping: URL) {
        let keys: Set<URLResourceKey> = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]
        guard let walk = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: Array(keys)) else { return }
        var copies: [(url: URL, date: Date, size: Int)] = []
        for case let url as URL in walk where url.lastPathComponent != ".part" {
            guard let values = try? url.resourceValues(forKeys: keys), values.isRegularFile == true else { continue }
            copies.append((url, values.contentModificationDate ?? .distantPast, values.fileSize ?? 0))
        }
        var total = copies.reduce(0) { $0 + $1.size }
        for copy in copies.sorted(by: { $0.date < $1.date }) where total > maxBytes {
            guard copy.url != keeping else { continue }
            try? FileManager.default.removeItem(at: copy.url)
            total -= copy.size
            let versionFolder = copy.url.deletingLastPathComponent()
            if (try? FileManager.default.contentsOfDirectory(atPath: versionFolder.path))?.isEmpty == true {
                try? FileManager.default.removeItem(at: versionFolder)
            }
        }
    }

    func remove(id: String) {
        try? FileManager.default.removeItem(at: folder(id: id))
    }

    private static func sanitized(_ name: String) -> String {
        let cleaned = name.map { "/\\:\0".contains($0) ? "-" : $0 }
        let text = String(cleaned).trimmingCharacters(in: .whitespaces)
        return text.isEmpty || text == "." || text == ".." ? "file" : text
    }
}
