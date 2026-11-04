import Foundation



extension FixtureBackend: SearchBackend {
    public func search(query: String) async throws -> SearchResults {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return SearchResults(answer: nil, hits: []) }
        await pause()
        let hits = FixtureData.searchIndex.filter {
            $0.title.lowercased().contains(needle) || $0.detail.lowercased().contains(needle)
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
        .init(id: "s1", group: .todo, symbol: "circle", title: "Pay rent for November", detail: "Due Fri · Home"),
        .init(id: "s2", group: .todo, symbol: "circle", title: "Renew renter's insurance", detail: "Due Dec 1 · Home"),
        .init(
            id: "s3", group: .chatsAndFiles, symbol: "bubble.left", title: "Lease renewal questions",
            detail: "Chat · Oct 28"),
        .init(
            id: "s4", group: .chatsAndFiles, symbol: "doc", title: "lease-2026.pdf",
            detail: "Library · p. 3 \"rent is due on the 6th\""),
        .init(
            id: "s5", group: .chatsAndFiles, symbol: "doc", title: "Q3-review-v4.key",
            detail: "Library · Monday 10:14"),
        .init(id: "s6", group: .people, symbol: "person", title: "Sam Ortiz", detail: "Landlord · last mail Oct 28"),
        .init(id: "s7", group: .people, symbol: "person", title: "Dana Reyes", detail: "Work · Q3 review"),
    ]
}
