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
        return SearchResults(answer: answer, hits: hits)
    }
}

extension FixtureData {
    // MARK: Search

    static let rentAnswer = SearchResults.Answer(
        text: "Rent is due Friday, November 6: $1,850 to Sam Ortiz. Autopay is paused this month.",
        emphasis: "Friday, November 6",
        evidence: ["lease-2026.pdf", "mail Oct 28", "todo_rent"])

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
