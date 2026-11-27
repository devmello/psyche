import Foundation

/// Where a push goes inside a tab's NavigationStack (docs/design/ios-app-2026.md §4).
public enum Route: Hashable, Sendable {
    case thread(id: String)
    /// A chat's fork-a-plan view (`/chat/<thread>?fork=<fork>`, the fork card's tap): the lanes and the comparison.
    case planFork(threadID: String, forkID: String)
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
    /// One goal (`/goals/<id>`): the Goals list with that goal's sheet open. Goal notifications send this.
    case goal(id: String)
    /// One Feed post (`/feed/<id>`): the Feed with that card opened.
    case feedPost(id: String)
    /// A Space page (`/spaces/<id>`), pushed from Home.
    case space(id: String)
    /// A Night shift review (`/home?review=<id>`, the "Prepared overnight" card and its notification), pushed from Home.
    case nightShift(id: String)
    /// A running task or its run page (`psyche://task/<id>`, `/tasks/<id>`, the Live Activity's tap target): opens
    /// the agent sheet on that task's run page.
    case task(id: String)
    /// The agent sheet on its Approvals segment (`/agent/approvals`). Never pushed; the router opens the sheet.
    case agentApprovals
    /// A tab's root (`/home`, `/chat`, `/memory`, `/search`, `/library/<view>`, `/memory/review`, `/spaces`). Never pushed.
    case tab(AppTab)
    /// Settings (`/settings`, `/settings/<section>`). The phone's Settings has no section pages yet, so every section
    /// opens the sheet. Never pushed.
    case settings

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
        case ("chat", 2):
            if let fork = Self.queryValue("fork", in: query) {
                self = .planFork(threadID: parts[1], forkID: fork)
            } else {
                self = .thread(id: parts[1])
            }
        case ("goals", 2): self = .goal(id: parts[1])
        case ("people", 2): self = .person(id: parts[1])
        case ("library", 1): self = .tab(.library)
        case ("library", 2):
            if let item = Self.queryValue("item", in: query) {
                self = .file(id: item)
            } else if Self.libraryViews.contains(parts[1]) {
                self = .tab(.library)  // `/library/all` with no item names a view: the Library tab
            } else {
                self = .file(id: parts[1])
            }
        case ("home", 1) where Self.queryValue("review", in: query) != nil:
            self = .nightShift(id: Self.queryValue("review", in: query) ?? "")
        case ("home", 1): self = .tab(.home)
        case ("chat", 1): self = .tab(.chat)
        case ("memory", 1): self = .tab(.memory)
        case ("memory", 2) where parts[1] == "review": self = .tab(.memory)  // the review screen lands with #1633
        case ("search", 1): self = .tab(.search)
        case ("spaces", 1): self = .tab(.home)  // Spaces live on Home; there is no separate list page
        case ("settings", _): self = .settings
        case ("artifacts", 2): self = .artifact(id: parts[1])
        case ("inbox", 1): self = .inbox
        case ("scheduled", 1): self = .scheduled
        case ("overview", _): self = .overview
        case ("feed", 1): self = .feed
        case ("feed", 2): self = .feedPost(id: parts[1])
        case ("ideas", 1): self = .ideas
        case ("goals", 1): self = .goals
        case ("spaces", 2): self = .space(id: parts[1])
        case ("task", 2), ("tasks", 2): self = .task(id: parts[1])
        case ("agent", 3) where parts[1] == "activity": self = .task(id: parts[2])
        case ("agent", 2) where parts[1] == "approvals": self = .agentApprovals
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
