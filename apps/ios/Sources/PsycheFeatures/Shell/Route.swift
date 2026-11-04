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

    /// Maps the desktop's routes so a notification's `route` opens the same thing on the phone.
    /// `/chat/<id>`, `/goals/<id>`, `/people/<id>`, `/library/<id>`, `/inbox`, `/scheduled` and
    /// `/overview` (also `/overview/run/<id>`, which opens the overview). A query or fragment is
    /// ignored. Returns nil for anything unknown (including `/home`); callers then open Home.
    public init?(appPath: String) {
        let path = appPath.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? ""
        let parts = path.split(separator: "/").map(String.init)
        guard let head = parts.first else { return nil }
        switch (head, parts.count) {
        case ("chat", 2): self = .thread(id: parts[1])
        case ("goals", 2): self = .project(id: parts[1])
        case ("people", 2): self = .person(id: parts[1])
        case ("library", 2): self = .file(id: parts[1])
        case ("inbox", 1): self = .inbox
        case ("scheduled", 1): self = .scheduled
        case ("overview", _): self = .overview
        default: return nil
        }
    }
}

public enum AppTab: Hashable, Sendable {
    case home, chat, library, memory, search
}
