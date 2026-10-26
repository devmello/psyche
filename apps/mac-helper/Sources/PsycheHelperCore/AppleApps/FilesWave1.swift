import Foundation
import PsycheProtocol

// Files wave 1 (docs/connectors/apple-apps-2026.md §4.8, F1–F3): granted folders only, with the
// same root checks as `finder.list`.

/// `AppleFileItem`.
public struct FileItemRecord: Codable, Sendable, Equatable {
    public var name: String
    public var path: String
    public var kind: String
    public var size: Int?
    public var modified: String?
    public var added: String?
    public var contentType: String?

    public init(name: String, path: String, kind: String, size: Int?, modified: String?, added: String?, contentType: String?) {
        self.name = name
        self.path = path
        self.kind = kind
        self.size = size
        self.modified = modified
        self.added = added
        self.contentType = contentType
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(path, forKey: .path)
        try c.encode(kind, forKey: .kind)
        try c.encode(size, forKey: .size)
        try c.encode(modified, forKey: .modified)
        try c.encode(added, forKey: .added)
        try c.encode(contentType, forKey: .contentType)
    }
}

public enum FilesWave1 {
    public static let maxMove = 100
    public static let maxTrash = 200

    /// A file name: no separators, not `.` / `..`, no control characters, ≤ 255 UTF-8 bytes.
    public static func checkName(_ name: String, field: String = "name") throws {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != ".", n != "..", !n.contains("/"), !n.contains(":"), n.utf8.count <= 255,
              !n.unicodeScalars.contains(where: { $0.properties.generalCategory == .control })
        else { throw CapabilityError.invalidParams("\(field) is a plain file name", field: field) }
    }

    /// The item itself (a symlink is the link, not its target): the parent must be inside a granted
    /// root, and a granted root itself is never moved or trashed.
    public static func item(_ path: String, roots: FinderRoots, field: String = "path") throws -> String {
        let expanded = (path as NSString).expandingTildeInPath
        guard expanded.hasPrefix("/") else { throw CapabilityError.invalidParams("\(field) must be absolute", field: field) }
        let std = (expanded as NSString).standardizingPath
        let name = (std as NSString).lastPathComponent
        let parent = try roots.resolve((std as NSString).deletingLastPathComponent)
        let full = (parent as NSString).appendingPathComponent(name)
        if roots.roots.contains(full) || roots.roots.contains(FinderRoots.canonical(full)) && FinderRoots.canonical(full) == full {
            throw CapabilityError(.policyDenied, reason: "granted_root", "\(path) is a granted folder itself", details: ["path": .string(path)])
        }
        var st = stat()
        guard lstat(full, &st) == 0 else { throw CapabilityError(.notFound, reason: "not_found", "\(path) does not exist", details: ["path": .string(path)]) }
        return full
    }

    /// A destination folder inside the granted roots that exists.
    public static func folder(_ path: String, roots: FinderRoots, field: String = "to") throws -> String {
        let dir = try roots.resolve(path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else {
            throw CapabilityError(.notFound, reason: "folder_not_found", "\(path) is not a folder", details: ["path": .string(path)])
        }
        return dir
    }

    /// Newest added first (falls back to modified), then by name.
    public static func newestAdded(_ xs: [FileItemRecord]) -> [FileItemRecord] {
        xs.sorted { a, b in
            let x = a.added ?? a.modified ?? "", y = b.added ?? b.modified ?? ""
            return x == y ? a.name < b.name : x > y
        }
    }
}
