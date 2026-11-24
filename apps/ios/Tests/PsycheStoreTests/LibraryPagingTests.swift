import Foundation
import Testing

@testable import PsycheStore

struct LibraryPagingTests {
    private func item(_ id: String, _ day: Int?) -> LibraryItem {
        LibraryItem(
            id: id, title: id, section: .documents, fileType: "pdf", detail: "",
            date: day.map { Date(timeIntervalSince1970: TimeInterval($0) * 86_400) })
    }

    @Test func aSecondPageAppendsWithoutRepeatingRowsAndStaysNewestFirst() {
        let first = [item("new", 30), item("mid", 20), item("old", 5)]
        // The second page repeats "mid" and has a row (day 25) newer than "mid" but older than "new".
        let second = [item("mid", 20), item("between", 25), item("oldest", 1)]
        let merged = LibraryPaging.newestFirst(first + second)
        #expect(merged.map(\.id) == ["new", "between", "mid", "old", "oldest"])
        #expect(Set(merged.map(\.id)).count == merged.count)
    }

    @Test func aRepeatedRowKeepsItsFirstCopy() {
        let early = LibraryItem(id: "a", title: "first", section: .documents, fileType: "pdf", detail: "", date: .now)
        let late = LibraryItem(id: "a", title: "second", section: .documents, fileType: "pdf", detail: "", date: .now)
        #expect(LibraryPaging.newestFirst([early, late]).map(\.title) == ["first"])
    }

    @Test func undatedRowsKeepTheirOrderAtTheEnd() {
        let merged = LibraryPaging.newestFirst([item("x", nil), item("b", 2), item("y", nil), item("a", 1)])
        #expect(merged.map(\.id) == ["b", "a", "x", "y"])
    }

    @Test func equalDatesKeepArrivalOrder() {
        let merged = LibraryPaging.newestFirst([item("p", 7), item("q", 7), item("r", 7)])
        #expect(merged.map(\.id) == ["p", "q", "r"])
    }
}
