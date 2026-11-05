import Foundation

extension FixtureBackend: SearchBackend {
    public func search(query: String) async throws -> SearchResults {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return SearchResults(answer: nil, hits: []) }
        await pause()
        // A question like "when is rent due" matches on its meaningful words, not the whole phrase.
        let skip: Set<String> = ["when", "what", "who", "how", "where", "the", "and", "for", "are", "was", "my"]
        let words = needle.split(separator: " ").map(String.init).filter { $0.count >= 3 && !skip.contains($0) }
        let hits = FixtureData.searchIndex.filter { hit in
            let haystack = (hit.title + " " + hit.detail).lowercased()
            return haystack.contains(needle) || words.contains { haystack.contains($0) }
        }
        let answer = needle.contains("rent") ? FixtureData.rentAnswer : nil
        return SearchResults(answer: answer, hits: hits, canAskLife: needle.contains("rent"))
    }

    /// The answer card's two other calls. Passages come only when asked for (the owner's button), and a follow-up
    /// is answered only when the turn before it names the ids it cited, as the Gateway reads them again.
    public func lifeAnswer(question: String, passages: Bool, previous: LifeTurn?) async throws -> SearchResults.Answer? {
        await pause()
        if let previous {
            guard !previous.factIDs.isEmpty || !previous.passageIDs.isEmpty else { return nil }
            return passages ? FixtureData.autopayFollowUp : FixtureData.autopayFollowUpFacts
        }
        guard question.lowercased().contains("rent") else { return nil }
        return passages ? FixtureData.rentAnswerWithPassages : FixtureData.rentAnswer
    }

    /// `search.document`: the lease and the mail open here; the Notes passage is one this phone may not open.
    public func sourceDocument(id: String) async throws -> SourceDocument? {
        await pause()
        return FixtureData.sourceDocuments[id]
    }
}

extension FixtureData {
    // MARK: Search

    static let rentAnswer = SearchResults.Answer(
        text: "Rent is due Friday, November 6: $1,850 to Sam Ortiz. Autopay is paused this month.",
        emphasis: "Friday, November 6",
        evidence: ["lease-2026.pdf", "mail Oct 28", "todo_rent"], factIDs: ["fact_rent_due"])

    static let rentPassages = [
        LifePassage(id: "mail:msg_sam_rent", source: "mail", title: "Re: November rent", date: Date(timeIntervalSince1970: 1_761_650_000)),
        LifePassage(id: "library:lib_lease", source: "files", title: "lease-2026.pdf", date: Date(timeIntervalSince1970: 1_759_300_000)),
        LifePassage(id: "notes:autopay", source: "notes", title: "Autopay and the bank", date: Date(timeIntervalSince1970: 1_761_700_000)),
    ]

    static let rentAnswerWithPassages = SearchResults.Answer(
        text: "Rent is due Friday, November 6 [1][P1]. Sam asked for $1,850 [P1][P2]. Autopay is paused this month [P3].",
        emphasis: "", evidence: ["lease-2026.pdf", "mail Oct 28", "todo_rent"], factIDs: ["fact_rent_due"], passages: rentPassages)

    static let autopayFollowUpFacts = SearchResults.Answer(
        text: "Autopay was switched off on October 28 [1].", emphasis: "", evidence: ["mail Oct 28"], factIDs: ["fact_autopay"])

    static let autopayFollowUp = SearchResults.Answer(
        text: "Autopay was switched off on October 28 [1][P1], and it comes back on December 1 [P3].",
        emphasis: "", evidence: ["mail Oct 28"], factIDs: ["fact_autopay"], passages: [rentPassages[0], rentPassages[2]])

    static let sourceDocuments: [String: SourceDocument] = [
        "mail:msg_sam_rent": SourceDocument(
            id: "mail:msg_sam_rent", source: "mail", title: "Re: November rent",
            text: "Hi, rent for November is $1,850, due Friday the 6th. I turned autopay off while the bank switch settles.\n\nSam",
            date: Date(timeIntervalSince1970: 1_761_650_000)),
        "library:lib_lease": SourceDocument(
            id: "library:lib_lease", source: "files", title: "lease-2026.pdf",
            text: "3. Rent. Tenant pays $1,850 per month on or before the 6th day of each month.",
            date: Date(timeIntervalSince1970: 1_759_300_000)),
    ]

    static let searchIndex: [SearchResults.Hit] = [
        .init(id: "s1", group: .todo, symbol: "circle", title: "Pay rent for November", detail: "Due Fri · Home", target: .todo(id: "t1")),
        .init(id: "s2", group: .todo, symbol: "circle", title: "Renew renter's insurance", detail: "Due Dec 1 · Home", target: .todo(id: "t5")),
        .init(
            id: "s3", group: .chatsAndFiles, symbol: "bubble.left", title: "Lease renewal questions",
            detail: "Chat · Oct 28", target: .chat(id: "thr_lease")),
        .init(
            id: "s4", group: .chatsAndFiles, symbol: "doc", title: "lease-2026.pdf",
            detail: "Library · p. 3 \"rent is due on the 6th\"", target: .file(id: "lib_lease")),
        .init(
            id: "s5", group: .chatsAndFiles, symbol: "doc", title: "Q3-review-v4.key",
            detail: "Library · Monday 10:14", target: .file(id: "lib_8f2a")),
        .init(id: "s6", group: .people, symbol: "person", title: "Sam Ortiz", detail: "Landlord · last mail Oct 28", target: .person(id: "pe1")),
        .init(id: "s7", group: .people, symbol: "person", title: "Dana Reyes", detail: "Work · Q3 review", target: .person(id: "pe2")),
    ]
}
