import Foundation

/// Where a push goes inside a tab's NavigationStack (docs/design/ios-app-2026.md §4).
public enum Route: Hashable, Sendable {
    case thread(id: String)
    case project(id: String)
    case person(id: String)
    case file(id: String)
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
    /// thread, the Feed and the Ideas. `/agent/soul?file=…` and `?entity=…` have no phone screen, so they return
    /// nil. Returns nil for anything unknown (including `/home`); callers then open Home.
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
        case ("inbox", 1): self = .inbox
        case ("scheduled", 1): self = .scheduled
        case ("overview", _): self = .overview
        case ("feed", 1): self = .feed
        case ("ideas", 1): self = .ideas
        case ("goals", 1): self = .goals
        case ("spaces", 2): self = .space(id: parts[1])
        case ("task", 2): self = .task(id: parts[1])
        case ("agent", 3) where parts[1] == "activity": self = .task(id: parts[2])
        default: return nil
        }
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
