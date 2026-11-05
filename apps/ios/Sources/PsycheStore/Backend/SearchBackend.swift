import Foundation

// Search (§4.6): the search tab and Ask your life. Owner: the Memory session (I7). Gateway methods:
// search.query, memory.life.answer.

public protocol SearchBackend: Sendable {
    func search(query: String) async throws -> SearchResults
    /// `memory.life.answer`: one answer to a question. `passages` is true only after the owner tapped "Answer from my
    /// mail, messages and files"; `previous` makes it a follow-up. Nil when the Gateway has no grounded answer.
    func lifeAnswer(question: String, passages: Bool, previous: LifeTurn?) async throws -> SearchResults.Answer?
    /// `search.document`: the text of one cited passage, or nil when this phone may not open it ("Open on your Mac").
    func sourceDocument(id: String) async throws -> SourceDocument?
}

/// A source passage an answer cites (`[Pn]`): what a chip shows. The text is fetched with `sourceDocument`.
public struct LifePassage: Sendable, Equatable, Identifiable {
    public var id: String
    public var source: String
    public var title: String
    public var date: Date?
    public init(id: String, source: String, title: String, date: Date? = nil) {
        self.id = id
        self.source = source
        self.title = title
        self.date = date
    }
}

/// The turn before a follow-up, as `memory.life.answer` takes it in `previous`. Only ids travel: the Gateway reads
/// them again under this connection's rules and trusts nothing in here as a source.
public struct LifeTurn: Sendable, Equatable {
    public static let maxQuestion = 500
    public static let maxAnswer = 900
    public static let maxFactIDs = 12
    public static let maxPassageIDs = 8

    public var question: String
    public var answer: String
    public var factIDs: [String]
    public var passageIDs: [String]

    public init(question: String, answer: String, factIDs: [String], passageIDs: [String]) {
        self.question = String(question.prefix(Self.maxQuestion))
        self.answer = String(answer.prefix(Self.maxAnswer))
        self.factIDs = Array(factIDs.prefix(Self.maxFactIDs))
        self.passageIDs = Array(passageIDs.prefix(Self.maxPassageIDs))
    }
}

/// One passage opened for reading (`search.document`).
public struct SourceDocument: Sendable, Equatable {
    public var id: String
    public var source: String
    public var title: String
    public var text: String
    public var truncated: Bool
    public var date: Date?
    public init(id: String, source: String, title: String, text: String, truncated: Bool = false, date: Date? = nil) {
        self.id = id
        self.source = source
        self.title = title
        self.text = text
        self.truncated = truncated
        self.date = date
    }
}

/// An answer cut into claims: the words before a run of `[n]` / `[Pn]` markers, and the passages that run cites.
public struct LifeClaim: Sendable, Equatable {
    public var text: String
    public var passages: [LifePassage]
}

public struct SearchResults: Sendable, Equatable {
    public struct Answer: Sendable, Equatable {
        public var text: String
        public var emphasis: String
        public var evidence: [String]
        /// The ids of the facts the answer cites, in order (`[n]` is the nth). Sent back as `previous.factIds`.
        public var factIDs: [String]
        /// The passages the answer cites, in order (`[Pn]` is the nth). Empty unless the owner asked for them.
        public var passages: [LifePassage]
        public init(
            text: String, emphasis: String, evidence: [String], factIDs: [String] = [], passages: [LifePassage] = []
        ) {
            self.text = text
            self.emphasis = emphasis
            self.evidence = evidence
            self.factIDs = factIDs
            self.passages = passages
        }

        /// This answer as the `previous` of a follow-up.
        public func turn(question: String) -> LifeTurn {
            LifeTurn(question: question, answer: text, factIDs: factIDs, passageIDs: passages.map(\.id))
        }

        /// The text cut at its markers. `[n]` (a fact) is dropped from the words, since the Sources line holds the
        /// facts; `[Pn]` becomes a passage on the claim. A marker naming nothing returned is dropped. Words after
        /// the last marker stay, as a claim with no chip.
        public var claims: [LifeClaim] {
            var out: [LifeClaim] = []
            var words = ""
            var cited: [LifePassage] = []
            var inRun = false
            func flush() {
                let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    out.append(LifeClaim(text: trimmed, passages: cited))
                } else if !cited.isEmpty, !out.isEmpty {
                    out[out.count - 1].passages += cited.filter { !out[out.count - 1].passages.contains($0) }
                }
                words = ""
                cited = []
                inRun = false
            }
            var i = text.startIndex
            while i < text.endIndex {
                if let (marker, next) = Self.marker(in: text, at: i) {
                    if case .passage(let n) = marker, passages.indices.contains(n - 1), !cited.contains(passages[n - 1]) {
                        cited.append(passages[n - 1])
                    }
                    inRun = true
                    i = next
                    continue
                }
                let c = text[i]
                if inRun {
                    // Space before a marker is not part of the claim; punctuation after it is.
                    while let last = words.last, last.isWhitespace { words.removeLast() }
                    if ".!?".contains(c) {
                        words.append(c)
                        if cited.isEmpty { inRun = false } else { flush() }
                    } else if c.isWhitespace {
                        i = text.index(after: i)
                        continue
                    } else if cited.isEmpty {
                        // Only fact markers (or ones naming nothing): the sentence goes on.
                        inRun = false
                        if let last = words.last, !".!?,;:".contains(c), !last.isWhitespace { words.append(" ") }
                        words.append(c)
                    } else {
                        flush()
                        words.append(c)
                    }
                } else {
                    words.append(c)
                }
                i = text.index(after: i)
            }
            flush()
            return out
        }

        enum Marker { case fact(Int), passage(Int) }

        /// `[3]` or `[P2]` at `index`, and where it ends.
        static func marker(in text: String, at index: String.Index) -> (Marker, String.Index)? {
            guard text[index] == "[", let close = text[index...].prefix(5).firstIndex(of: "]") else { return nil }
            let inner = text[text.index(after: index)..<close]
            let digits = inner.hasPrefix("P") ? inner.dropFirst() : inner
            guard (1...2).contains(digits.count), digits.allSatisfy(\.isASCII), let n = Int(digits), n >= 1 else { return nil }
            return (inner.hasPrefix("P") ? .passage(n) : .fact(n), text.index(after: close))
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
    /// The query reads as a question, so the card offers "Answer from my mail, messages and files" even when the
    /// facts alone had no answer.
    public var canAskLife: Bool

    public init(answer: Answer?, hits: [Hit], canAskLife: Bool = false) {
        self.answer = answer
        self.hits = hits
        self.canAskLife = canAskLife
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
