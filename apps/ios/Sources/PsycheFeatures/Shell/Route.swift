import Foundation

/// Where a push goes inside a tab's NavigationStack (docs/design/ios-app-2026.md §4).
public enum Route: Hashable, Sendable {
    case thread(id: String)
    case project(id: String)
    case person(id: String)
    case file(id: String)

    /// Maps the desktop's routes so a notification's `route` opens the same thing on the phone.
    /// Returns nil for anything unknown; callers then open Home.
    public init?(appPath: String) {
        let parts = appPath.split(separator: "/").map(String.init)
        guard parts.count == 2 else { return nil }
        switch parts[0] {
        case "chat": self = .thread(id: parts[1])
        case "goals": self = .project(id: parts[1])
        case "people": self = .person(id: parts[1])
        case "library": self = .file(id: parts[1])
        default: return nil
        }
    }
}

public enum AppTab: Hashable, Sendable {
    case home, chat, library, memory, search
}
