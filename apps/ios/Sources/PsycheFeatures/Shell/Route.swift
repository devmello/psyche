import Foundation

/// Where a push goes inside a tab's NavigationStack (docs/design/ios-app-2026.md §4).
public enum Route: Hashable, Sendable {
    case thread(id: String)
    case project(id: String)
    case person(id: String)
    case file(id: String)
    /// An artifact's viewer (`/artifacts/<id>`, an artifact card's tap): its content and versions.
    case artifact(id: String)
    /// The Soul & Memory file list (`/agent/soul` with no query), and one workspace file in it (`/agent/soul?file=…`).
    case memoryFiles
    case memoryFile(path: String)
    /// Memory's learning screens: what Psyche learned, claims to confirm, and recent changes with undo.
    case learning
    case claims
    case recentChanges
    case reviewQueue
    /// A person, organisation, project or other entity (`/agent/soul?entity=…`). Its kind decides the page; the
    /// phone resolves it with `memory.entities.get` when the page opens, since an id doesn't say which it is.
    case entity(id: String)
    /// Home's "More" pages (I5).
    case inbox
    case scheduled
    case overview
    /// Home's Feed, Ideas and Goals pages.
    case feed
    case ideas
    case goals
    /// A Space page (`/spaces/<id>`), pushed from Home.
    case space(id: String)
    /// A running task (`psyche://task/<id>`, the Live Activity's tap target): opens the agent sheet.
    case task(id: String)

    /// Maps the desktop's routes so a notification's `route` opens the same thing on the phone.
    /// `/chat/<id>`, `/goals/<id>`, `/people/<id>`, `/library/<id>`, `/inbox`, `/scheduled` and
    /// `/overview` (also `/overview/run/<id>`, which opens the overview), and the Gateway's search routes:
    /// `/library/<view>?item=<id>` opens that Library item, `/agent/activity/<id>` opens the agent sheet for a
    /// task. The query of `/chat/<id>?message=…`, `/feed?post=…` and `/ideas?idea=…` is ignored: those open the
    /// thread, the Feed and the Ideas. `/agent/soul` opens the memory file list, `/agent/soul?file=<path>` one file
    /// and `/agent/soul?entity=<id>` an entity. A file path that is absolute, has a `\`, `//`, an empty, `.` or `..`
    /// segment, or a control character is refused (nil), as is a bad `%` escape. Returns nil for anything unknown
    /// (including `/home`); callers then open Home.
    public init?(appPath: String) {
        let beforeFragment = appPath.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
        let pieces = beforeFragment.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let parts = (pieces.first.map(String.init) ?? "").split(separator: "/").map(String.init)
        let query = pieces.count == 2 ? String(pieces[1]) : ""
        guard let head = parts.first else { return nil }
        switch (head, parts.count) {
        case ("chat", 2): self = .thread(id: parts[1])
        case ("goals", 2): self = .project(id: parts[1])
        case ("people", 2): self = .person(id: parts[1])
        case ("library", 2):
            if let item = Self.queryValue("item", in: query) {
                self = .file(id: item)
            } else if Self.libraryViews.contains(parts[1]) {
                return nil  // `/library/all` with no item names a view, not a file
            } else {
                self = .file(id: parts[1])
            }
        case ("artifacts", 2): self = .artifact(id: parts[1])
        case ("inbox", 1): self = .inbox
        case ("scheduled", 1): self = .scheduled
        case ("overview", _): self = .overview
        case ("feed", 1): self = .feed
        case ("ideas", 1): self = .ideas
        case ("goals", 1): self = .goals
        case ("spaces", 2): self = .space(id: parts[1])
        case ("task", 2): self = .task(id: parts[1])
        case ("agent", 3) where parts[1] == "activity": self = .task(id: parts[2])
        case ("agent", 2) where parts[1] == "soul":
            // A file or an entity, never both. A query with neither key, or a bad value, is refused.
            if let file = Self.queryValue("file", in: query) {
                guard Self.isSafeMemoryPath(file) else { return nil }
                self = .memoryFile(path: file)
            } else if let entity = Self.queryValue("entity", in: query) {
                self = .entity(id: entity)
            } else if query.isEmpty {
                self = .memoryFiles
            } else {
                return nil
            }
        default: return nil
        }
    }

    /// A workspace-relative path (`memory/notes.md`): no leading `/`, no `\`, and every segment non-empty and not `.`
    /// or `..`, with no control or line-break character. Mirrors `WorkspacePath` in packages/protocol.
    static func isSafeMemoryPath(_ path: String) -> Bool {
        guard !path.isEmpty, path.utf8.count <= 1024, !path.hasPrefix("/") else { return false }
        if path.unicodeScalars.contains(where: { $0 == "\\" || $0.properties.generalCategory == .control || $0.properties.isWhitespace && $0 != " " }) {
            return false
        }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        return segments.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// The Library's views on desktop (`/library/all`, `/library/documents`, …): a view, never an item.
    private static let libraryViews: Set<String> = ["all", "documents", "images", "artifacts", "downloads"]

    /// The decoded value of `key` in a query (`item=mail%3Am1` reads `mail:m1`). Nil when the key is missing, empty,
    /// or its value is not valid percent-encoding.
    private static func queryValue(_ key: String, in query: String) -> String? {
        for pair in query.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard kv.count == 2, kv[0] == key else { continue }
            guard let value = String(kv[1]).removingPercentEncoding, !value.isEmpty else { return nil }
            return value
        }
        return nil
    }
}

public enum AppTab: Hashable, Sendable {
    case home, chat, library, memory, search
}
