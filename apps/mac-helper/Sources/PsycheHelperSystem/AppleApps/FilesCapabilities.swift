import Foundation
import PsycheHelperCore
import PsycheProtocol
import UniformTypeIdentifiers

// Files wave 1 (docs/connectors/apple-apps-2026.md §4.8, F1–F3) on Foundation: granted folders
// only (the same root checks as finder.list). Nothing here launches Finder.
extension AppleAppsCapabilities {
    struct FilesRecent: Decodable {
        var folder: String
        var addedSince: String?
        var addedBefore: String?
        var contentTypes: [String]?
        var limit: Int?
    }
    struct FilesMoveItem: Decodable {
        var path: String
        var to: String
        var name: String?
    }
    struct FilesMove: Decodable { var items: [FilesMoveItem] }
    struct FilesRename: Decodable {
        var path: String
        var name: String
    }
    struct FilesTrash: Decodable { var paths: [String] }

    static let fileKeys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey, .contentModificationDateKey,
                                            .addedToDirectoryDateKey, .contentTypeKey, .isHiddenKey]

    static func fileItem(_ url: URL) -> FileItemRecord {
        let v = try? url.resourceValues(forKeys: Set(fileKeys))
        let kind = v?.isSymbolicLink == true ? "symlink" : v?.isDirectory == true ? "directory" : v?.isRegularFile == true ? "file" : "other"
        return FileItemRecord(name: url.lastPathComponent, path: url.path, kind: kind, size: kind == "file" ? v?.fileSize : nil,
                              modified: v?.contentModificationDate.map(AppleDates.string), added: v?.addedToDirectoryDate.map(AppleDates.string),
                              contentType: v?.contentType?.identifier)
    }

    /// UTType ids (`com.adobe.pdf`, `public.image`) or extensions (`pdf`), matched by conformance.
    static func types(_ xs: [String]?) throws -> [UTType]? {
        guard let xs, !xs.isEmpty else { return nil }
        guard xs.count <= 20 else { throw CapabilityError.invalidParams("at most 20 contentTypes", field: "contentTypes") }
        return try xs.map { s in
            let t = s.trimmingCharacters(in: .whitespaces).lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            if let u = UTType(t) ?? UTType(filenameExtension: t) { return u }
            throw CapabilityError.invalidParams("unknown content type \(s)", field: "contentTypes")
        }
    }

    static func filesWave1(_ b: Backends) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "files.recent",
                description: "Files in a granted folder (e.g. ~/Downloads), newest added first, optionally added since / before and of some types (UTType ids or extensions such as pdf). Not recursive; hidden files left out. Read-only.",
                sideEffect: .read, targetKind: .path,
                inputSchema: Schema.object(["folder": Schema.string("A granted folder"), "addedSince": isoSchema, "addedBefore": isoSchema,
                                            "contentTypes": Schema.array(Schema.string(maxLength: 100), maxItems: 20), "limit": limitSchema], required: ["folder"])
            )) { ctx in
                let p = try ctx.decode(FilesRecent.self)
                let dir = try FilesWave1.folder(p.folder, roots: b.roots(), field: "folder")
                let since = try p.addedSince.map { try AppleDates.param($0, field: "addedSince") }
                let before = try p.addedBefore.map { try AppleDates.param($0, field: "addedBefore") }
                let wanted = try types(p.contentTypes)
                let urls = (try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: dir), includingPropertiesForKeys: fileKeys,
                                                                         options: [.skipsHiddenFiles])) ?? []
                let items = urls.compactMap { u -> FileItemRecord? in
                    let v = try? u.resourceValues(forKeys: Set(fileKeys))
                    guard v?.isDirectory != true else { return nil }
                    let added = v?.addedToDirectoryDate ?? v?.contentModificationDate
                    if let since, (added ?? .distantPast) < since { return nil }
                    if let before, (added ?? .distantFuture) >= before { return nil }
                    if let wanted, !(v?.contentType.map { t in wanted.contains { t.conforms(to: $0) } } ?? false) { return nil }
                    return fileItem(u)
                }
                return untrustedList("files", try json(Array(FilesWave1.newestAdded(items).prefix(try limit(p.limit, default: 20)))))
            },
            Capability(CapabilitySpec(
                name: "files.move",
                description: "Move up to 100 files or folders into granted folders, optionally renaming each. Never overwrites: an existing name is refused before anything moves.",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object(["items": Schema.array(Schema.object([
                    "path": Schema.string(), "to": Schema.string("Destination folder (granted)"), "name": Schema.string("New file name", maxLength: 255),
                ], required: ["path", "to"]), maxItems: FilesWave1.maxMove)], required: ["items"]),
                receiptKind: "connector_action"
            )) { ctx in
                let p = try ctx.decode(FilesMove.self)
                guard (1...FilesWave1.maxMove).contains(p.items.count) else { throw CapabilityError.invalidParams("1–100 items", field: "items") }
                let roots = b.roots()
                // Check every item first, so a refusal moves nothing.
                var plan: [(from: String, to: String)] = []
                var targets = Set<String>()
                for it in p.items {
                    let from = try FilesWave1.item(it.path, roots: roots)
                    let dir = try FilesWave1.folder(it.to, roots: roots)
                    let name = it.name ?? (from as NSString).lastPathComponent
                    try FilesWave1.checkName(name)
                    let to = (dir as NSString).appendingPathComponent(name)
                    if dir == from || dir.hasPrefix(from + "/") { throw CapabilityError.invalidParams("cannot move a folder into itself", field: "to") }
                    var st = stat()
                    guard to != from, lstat(to, &st) != 0, targets.insert(to.lowercased()).inserted else {
                        throw CapabilityError(.conflict, reason: "file_exists", "\(name) already exists in \(it.to)", details: ["path": .string(to)])
                    }
                    plan.append((from, to))
                }
                var moved: [JSONValue] = []
                for m in plan {
                    do { try FileManager.default.moveItem(atPath: m.from, toPath: m.to) } catch {
                        throw CapabilityError(.unavailable, reason: "move_failed", "Could not move \((m.from as NSString).lastPathComponent)",
                                              details: ["moved": .array(moved), "failed": .string(m.from)])
                    }
                    moved.append(["from": .string(m.from), "to": .string(m.to)])
                }
                return CapabilityOutput(["moved": .array(moved)], receipt: ReceiptDraft(outcome: .ok, summary: "Moved \(moved.count) item(s)"))
            },
            Capability(CapabilitySpec(
                name: "files.rename", description: "Rename a file or folder inside a granted folder (never overwrites).",
                sideEffect: .write, targetKind: .path,
                inputSchema: Schema.object(["path": Schema.string(), "name": Schema.string(maxLength: 255)], required: ["path", "name"]),
                receiptKind: "connector_action"
            )) { ctx in
                let p = try ctx.decode(FilesRename.self)
                let from = try FilesWave1.item(p.path, roots: b.roots())
                try FilesWave1.checkName(p.name)
                let to = ((from as NSString).deletingLastPathComponent as NSString).appendingPathComponent(p.name)
                var st = stat()
                // A case-only rename is the same file on APFS: allowed.
                guard lstat(to, &st) != 0 || to.lowercased() == from.lowercased(), to != from else {
                    throw CapabilityError(.conflict, reason: "file_exists", "\(p.name) already exists", details: ["path": .string(to)])
                }
                do { try FileManager.default.moveItem(atPath: from, toPath: to) } catch {
                    throw CapabilityError(.unavailable, reason: "rename_failed", "Could not rename \((from as NSString).lastPathComponent)")
                }
                return CapabilityOutput(["file": try json(fileItem(URL(fileURLWithPath: to)))], receipt: ReceiptDraft(outcome: .ok, summary: "Renamed to \(p.name)"))
            },
            Capability(CapabilitySpec(
                name: "files.trash",
                description: "Move up to 200 files or folders inside granted folders to the Trash (never empties it; the owner can put them back). Always asks.",
                sideEffect: .destructive, targetKind: .path,
                inputSchema: Schema.object(["paths": Schema.array(Schema.string(), maxItems: FilesWave1.maxTrash)], required: ["paths"]),
                receiptKind: "connector_action"
            )) { ctx in
                let p = try ctx.decode(FilesTrash.self)
                guard (1...FilesWave1.maxTrash).contains(p.paths.count) else { throw CapabilityError.invalidParams("1–200 paths", field: "paths") }
                let roots = b.roots()
                let items = try p.paths.map { try FilesWave1.item($0, roots: roots, field: "paths") }
                var trashed: [JSONValue] = []
                for path in Array(Set(items)).sorted() {
                    do {
                        let where_ = try b.trash(URL(fileURLWithPath: path))
                        trashed.append(["path": .string(path), "trashPath": where_.map { .string($0.path) } ?? .null])
                    } catch {
                        throw CapabilityError(.unavailable, reason: "trash_failed", "Could not move \((path as NSString).lastPathComponent) to the Trash",
                                              details: ["trashed": .array(trashed), "failed": .string(path)])
                    }
                }
                return CapabilityOutput(["trashed": .array(trashed)], receipt: ReceiptDraft(outcome: .ok, summary: "Moved \(trashed.count) item(s) to the Trash"))
            },
        ]
    }
}
