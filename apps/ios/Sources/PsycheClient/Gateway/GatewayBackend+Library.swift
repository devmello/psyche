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

    /// Downloads the file into the caches directory (protected, kept out of backups) and returns where it is.
    /// Nil when the phone should not open it: quarantined, or bigger than `downloadMaxBytes`.
    public func libraryFile(id: String) async throws -> URL? {
        let result = try await call("library.get", .obj(["itemId": .string(id)]))
        guard let item = result["item"], let path = item["path"]?.string, !path.isEmpty else { throw BackendError.notFound }
        if item["quarantined"]?.bool == true { return nil }
        let size = item["size"]?.int ?? 0
        if size > Self.downloadMaxBytes { return nil }
        let name = item["name"]?.string ?? "file"
        let version = String((item["sha256"]?.string ?? "").prefix(12))
        let downloads = LibraryDownloads(directory: client.libraryCache)
        let destination = downloads.url(id: id, version: version, name: name)
        if FileManager.default.fileExists(atPath: destination.path) { return destination }

        let temporary = try downloads.beginFile(for: destination)
        var finished = false
        defer { if !finished { try? FileManager.default.removeItem(at: temporary) } }
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close() }
        var offset = 0
        var etag: String?
        while true {
            let chunk = try await call("files.read", .obj(["libraryPath": .string(path), "offset": .number(Double(offset))]))
            if let etag, let now = chunk["etag"]?.string, now != etag {
                throw BackendError.refused("This file changed while it downloaded. Try again.")
            }
            etag = chunk["etag"]?.string
            guard let encoded = chunk["bytes"]?.string, let bytes = Data(base64Encoded: encoded) else {
                throw BackendError.refused("The Gateway sent a file this phone can't read.")
            }
            try handle.write(contentsOf: bytes)
            offset += bytes.count
            if offset > Self.downloadMaxBytes { return nil }
            // nextOffset is null on the last chunk.
            guard let next = chunk["nextOffset"]?.int, !bytes.isEmpty else { break }
            offset = next
        }
        try handle.close()
        try downloads.finish(temporary, as: destination)
        finished = true
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
        return LibraryItem(
            id: id, title: name, section: section ?? Self.section(ofKind: item["kind"]?.string),
            fileType: fileType(name: name, mime: item["mime"]?.string), detail: detail,
            threadID: item["threadId"]?.string, evidence: evidence(of: item, threadTitle: nil))
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
            attributes: [.protectionKey: FileProtectionType.complete])
        var root = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
        let part = folder.appendingPathComponent(".part")
        FileManager.default.createFile(atPath: part.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
        return part
    }

    func finish(_ part: URL, as destination: URL) throws {
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: part, to: destination)
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
