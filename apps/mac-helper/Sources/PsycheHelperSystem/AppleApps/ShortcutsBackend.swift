import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Shortcuts wave 1 (K1–K2) behind a protocol, so capabilities are tested with a fake.
public protocol ShortcutsBackend: Sendable {
    func list() async throws -> [ShortcutRecord]
    /// Runs a shortcut by name or id with optional text input; returns its text output.
    func run(_ nameOrId: String, input: String?, timeout: TimeInterval) async throws -> String
}

/// Listing through Shortcuts Events (folder, accepts input, action count), falling back to the
/// `shortcuts` CLI; runs through `/usr/bin/shortcuts` with responsibility disclaimed, so a
/// shortcut never inherits the helper's permissions.
public final class LiveShortcutsBackend: ShortcutsBackend, @unchecked Sendable {
    static let eventsApp = "com.apple.shortcuts.events"
    static let source = ScriptHandler.prelude + """
        on psyche_list()
          set fs to character id 31
          set out to {}
          tell application "Shortcuts Events"
            repeat with s in shortcuts
              set f to ""
              try
                set f to name of folder of s
              end try
              set ai to "false"
              try
                set ai to (accepts input of s as text)
              end try
              set ac to ""
              try
                set ac to (action count of s as text)
              end try
              set end of out to (id of s as text) & fs & my psyche_clean(name of s) & fs & my psyche_clean(f) & fs & ai & fs & ac
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_list
        """

    public init() {}

    public func list() async throws -> [ShortcutRecord] {
        if let out = try? await ScriptHandler.call(Self.source, handler: "psyche_list", [], app: Self.eventsApp) {
            let rows = ScriptRecords.parse(out, fields: 5).compactMap { f -> ShortcutRecord? in
                guard ShortcutsWave1.isId(f[0]) else { return nil }
                return ShortcutRecord(id: f[0], name: f[1], folder: f[2].isEmpty ? nil : f[2], acceptsInput: f[3] == "true", actionCount: Int(f[4]))
            }
            return rows.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        let r = try await DisclaimedProcess.run("/usr/bin/shortcuts", ["list", "--show-identifiers"], timeout: 30)
        guard r.status == 0 else { throw CapabilityError(.unavailable, reason: "shortcuts_list_failed", "Could not list Shortcuts") }
        return ShortcutsWave1.parseList(r.stdout)
    }

    public func run(_ nameOrId: String, input: String?, timeout: TimeInterval) async throws -> String {
        guard !nameOrId.isEmpty, !nameOrId.hasPrefix("-") else { throw CapabilityError.invalidParams("bad shortcut name", field: "name") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("psyche-shortcut-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: dir) }
        var args = ["run", nameOrId]
        if let input {
            let inFile = dir.appendingPathComponent("input.txt")
            try Data(input.utf8).write(to: inFile, options: .atomic)
            args += ["--input-path", inFile.path]
        }
        let outFile = dir.appendingPathComponent("output.txt")
        args += ["--output-path", outFile.path, "--output-type", "public.plain-text"]
        let r = try await DisclaimedProcess.run("/usr/bin/shortcuts", args, timeout: timeout)
        guard r.status == 0 else {
            let notFound = r.stderr.lowercased().contains("couldn’t find") || r.stderr.lowercased().contains("couldn't find")
            throw CapabilityError(notFound ? .notFound : .unavailable, reason: notFound ? "shortcut_not_found" : "shortcut_failed",
                                  notFound ? "No shortcut \(nameOrId)" : "The shortcut failed (exit \(r.status))",
                                  details: ["stderr": .string(String(r.stderr.prefix(2000)))])
        }
        return (try? String(contentsOf: outFile, encoding: .utf8)) ?? r.stdout
    }
}
