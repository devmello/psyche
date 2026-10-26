import Foundation
import PsycheProtocol

// Shortcuts wave 1 (docs/connectors/apple-apps-2026.md §4.9, K1–K2): pure pieces.

/// `AppleShortcut`.
public struct ShortcutRecord: Codable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var folder: String?
    public var acceptsInput: Bool
    public var actionCount: Int?

    public init(id: String, name: String, folder: String?, acceptsInput: Bool, actionCount: Int?) {
        self.id = id
        self.name = name
        self.folder = folder
        self.acceptsInput = acceptsInput
        self.actionCount = actionCount
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(folder, forKey: .folder)
        try c.encode(acceptsInput, forKey: .acceptsInput)
        try c.encode(actionCount, forKey: .actionCount)
    }
}

/// `AppleShortcutResult`.
public struct ShortcutResultRecord: Codable, Sendable, Equatable {
    public var output: String
    public var outputType: String
    public var truncated: Bool

    public init(output: String, outputType: String, truncated: Bool) {
        self.output = output
        self.outputType = outputType
        self.truncated = truncated
    }
}

public enum ShortcutsWave1 {
    public static let maxOutput = 100_000
    public static let defaultTimeout = 60
    public static let maxTimeout = 120

    /// Shortcut identifiers are UUIDs (so an id can never be read as a CLI flag).
    public static func isId(_ s: String) -> Bool { UUID(uuidString: s) != nil }

    /// `shortcuts list --show-identifiers` lines: `Name (UUID)`.
    public static func parseList(_ text: String, folder: String? = nil) -> [ShortcutRecord] {
        text.split(separator: "\n").compactMap { line -> ShortcutRecord? in
            let l = line.trimmingCharacters(in: .whitespaces)
            guard l.hasSuffix(")"), let open = l.range(of: " (", options: .backwards) else { return nil }
            let id = String(l[open.upperBound..<l.index(before: l.endIndex)])
            guard isId(id) else { return nil }
            return ShortcutRecord(id: id, name: String(l[..<open.lowerBound]), folder: folder, acceptsInput: false, actionCount: nil)
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Output as untrusted text, typed `json` when it parses as a JSON object or array, `none` when empty.
    public static func result(_ raw: String) -> ShortcutResultRecord {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let truncated = raw.count > maxOutput
        let out = truncated ? String(raw.prefix(maxOutput)) : raw
        guard !trimmed.isEmpty else { return ShortcutResultRecord(output: "", outputType: "none", truncated: false) }
        let json = !truncated && (trimmed.hasPrefix("{") || trimmed.hasPrefix("["))
            && (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) != nil
        return ShortcutResultRecord(output: out, outputType: json ? "json" : "text", truncated: truncated)
    }
}
