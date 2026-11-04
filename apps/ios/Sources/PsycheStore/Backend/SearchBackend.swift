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

        public init(id: String, group: Group, symbol: String, title: String, detail: String) {
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
