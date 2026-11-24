import Foundation
import Testing

@testable import PsycheStore

/// The demo fixtures show a fact's earlier values, and an owner's edit adds the replaced value to them.
struct FixtureFactHistoryTests {
    @Test func aFixtureFactShowsItsCurrentValueThenItsEarlierValuesNewestFirst() async throws {
        let versions = try await FixtureBackend().entityHistory(entityID: "pe1", attribute: "city")
        #expect(versions.map(\.value) == ["Oakland", "Berkeley", "San Francisco"])
        #expect(versions.map(\.isCurrent) == [true, false, false])
        #expect(versions.allSatisfy { !$0.evidence.isEmpty })
    }

    @Test func aProjectFactHasEarlierValuesToo() async throws {
        let versions = try await FixtureBackend().entityHistory(entityID: "p1", attribute: "next_step")
        #expect(versions.count == 3)
        #expect(versions.first?.isCurrent == true)
    }

    @Test func anAttributeWithNoHistoryIsEmpty() async throws {
        let versions = try await FixtureBackend().entityHistory(entityID: "pe2", attribute: "city")
        #expect(versions.isEmpty)
    }

    @Test func anEditKeepsTheReplacedValueInTheHistory() async throws {
        let backend = FixtureBackend()
        try await backend.editFact(personID: "pe1", attribute: "city", value: "Alameda")
        let versions = try await backend.entityHistory(entityID: "pe1", attribute: "city")
        #expect(versions.map(\.value) == ["Alameda", "Oakland", "Berkeley", "San Francisco"])
        #expect(versions.first?.isCurrent == true)
        #expect(versions[1].isCurrent == false)
    }
}
