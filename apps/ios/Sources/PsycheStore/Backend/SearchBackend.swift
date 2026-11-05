import Foundation

// Search (§4.6): the search tab and Ask your life. Owner: the Memory session (I7). Gateway methods:
// search.query, memory.life.answer.

public protocol SearchBackend: Sendable {
    func search(query: String) async throws -> SearchResults
}

public struct SearchResults: Sendable, Equatable {
    public struct Answer: Sendable, Equatable {
        public var text: String
        public var emphasis: String
        public var evidence: [String]
        public init(text: String, emphasis: String, evidence: [String]) {
            self.text = text
            self.emphasis = emphasis
            self.evidence = evidence
        }
    }

    public struct Hit: Sendable, Equatable, Identifiable {
        public enum Group: String, Sendable, CaseIterable {
            case todo = "To-do"
            case chatsAndFiles = "Chats and files"
            case people = "People"
        }

        public var id: String
        public var group: Group
        public var symbol: String
        public var title: String
        public var detail: String
        /// What tapping the hit opens. Nil when the Gateway sent no target.
        public var target: Target?

        public enum Target: Sendable, Equatable {
            case todo(id: String)
            case chat(id: String)
            case file(id: String)
            case person(id: String)
            /// A project or course page in Memory (the entity id).
            case project(id: String)
            /// A task: opens the agent sheet's Activity tab.
            case task(id: String)
        }

        public init(
            id: String, group: Group, symbol: String, title: String, detail: String, target: Target? = nil
        ) {
            self.target = target
            self.id = id
            self.group = group
            self.symbol = symbol
            self.title = title
            self.detail = detail
        }
    }

    public var answer: Answer?
    public var hits: [Hit]

    public init(answer: Answer?, hits: [Hit]) {
        self.answer = answer
        self.hits = hits
    }
}

/// Recent searches, kept on this device only (UserDefaults, never sent to the Gateway), newest first.
public struct RecentSearches: Sendable {
    public static let key = "psyche.recentSearches"
    public static let limit = 8

    private nonisolated(unsafe) let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var items: [String] { defaults.stringArray(forKey: Self.key) ?? [] }

    /// Remembers a search the owner submitted or followed; the same text moves to the top.
    public func add(_ query: String) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 2 else { return }
        var next = items.filter { $0.caseInsensitiveCompare(text) != .orderedSame }
        next.insert(text, at: 0)
        defaults.set(Array(next.prefix(Self.limit)), forKey: Self.key)
    }

    public func remove(_ query: String) {
        defaults.set(items.filter { $0 != query }, forKey: Self.key)
    }

    public func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}
