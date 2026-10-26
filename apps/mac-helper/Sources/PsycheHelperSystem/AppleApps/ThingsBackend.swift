import AppKit
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Things 3 behind a protocol: reads through scripting, writes through its URL scheme.
public protocol ThingsBackend: Sendable {
    var installed: Bool { get }
    /// In the list's own order; `query` matched by Things (`whose`).
    func list(_ list: String, name: String?, query: String, limit: Int) async throws -> [ThingsTodoRecord]
    /// Opens a `things:///` URL in the background.
    func open(_ url: URL) async throws
}

public final class ThingsScriptingBackend: ThingsBackend, @unchecked Sendable {
    static let bundleId = "com.culturedcode.ThingsMac"
    static let source = ScriptHandler.prelude + """
        on psyche_line(t)
          set fs to character id 31
          tell application "Things3"
            set pj to ""
            try
              set pj to name of project of t
            end try
            set ar to ""
            try
              set ar to name of area of t
            end try
            set ad to ""
            try
              set ad to my psyche_iso(activation date of t)
            end try
            set dd to ""
            try
              set dd to my psyche_iso(due date of t)
            end try
            set md to ""
            try
              set md to my psyche_iso(modification date of t)
            end try
            set tg to ""
            try
              set tg to tag names of t
            end try
            set nt to ""
            try
              set nt to notes of t
            end try
            return (id of t) & fs & my psyche_clean(name of t) & fs & my psyche_clean(nt) & fs & (status of t as text) & fs & ad & fs & dd & fs & my psyche_clean(pj) & fs & my psyche_clean(ar) & fs & my psyche_clean(tg) & fs & md
          end tell
        end psyche_line
        on psyche_list(kindName, listName, q, lim)
          set out to {}
          tell application "Things3"
            if kindName is "project" then
              set src to project listName
            else if kindName is "area" then
              set src to area listName
            else if kindName is "tag" then
              set src to tag listName
            else
              set src to list listName
            end if
            if q is "" then
              set ts to to dos of src
            else
              set ts to (to dos of src whose name contains q or notes contains q)
            end if
            set n to 0
            repeat with t in ts
              if n ≥ (lim as integer) then exit repeat
              set end of out to my psyche_line(t)
              set n to n + 1
            end repeat
          end tell
          return my psyche_join(out, character id 30)
        end psyche_list
        """

    public init() {}

    public var installed: Bool { NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleId) != nil }

    static func day(_ iso: String) -> String? {
        guard let d = AppleDates.fromAppleScript(iso).flatMap(AppleDates.parse) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    public func list(_ list: String, name: String?, query: String, limit: Int) async throws -> [ThingsTodoRecord] {
        guard installed else { throw CapabilityError(.notFound, reason: "app_not_installed", "Things 3 is not installed") }
        let listName = ThingsWave1.builtIn[list] ?? name ?? ""
        let out = try await ScriptHandler.call(Self.source, handler: "psyche_list", [list, listName, query, "\(limit)"], app: Self.bundleId)
        return ScriptRecords.parse(out, fields: 10).map { f in
            let status = ["open", "completed", "canceled"].contains(f[3]) ? f[3] : "open"
            let when = list == "someday" ? "someday" : Self.day(f[4])
            return ThingsTodoRecord(id: f[0], title: f[1], notes: f[2], status: status, when: when, deadline: Self.day(f[5]),
                                    project: f[6].isEmpty ? nil : f[6], area: f[7].isEmpty ? nil : f[7],
                                    tags: f[8].split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty },
                                    modified: AppleDates.fromAppleScript(f[9]))
        }
    }

    public func open(_ url: URL) async throws {
        guard installed else { throw CapabilityError(.notFound, reason: "app_not_installed", "Things 3 is not installed") }
        guard url.scheme == "things" else { throw CapabilityError.invalidParams("not a Things URL") }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        _ = try await NSWorkspace.shared.open(url, configuration: config)
    }
}
