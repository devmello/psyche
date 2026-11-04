import Foundation
import Testing

@testable import PsycheStore

struct MemorySearchSettingsTests {
    let store = FixtureBackend()

    // MARK: Memory

    @Test func togglingATodoPersistsAndSaysSo() async throws {
        let events = store.events()
        try await Task.sleep(for: .milliseconds(20))
        try await store.setTodo(id: "t1", done: true)
        #expect(try await store.memory().todos.first { $0.id == "t1" }?.done == true)
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .changed(.memory))
        try await store.setTodo(id: "t1", done: false)
        #expect(try await store.memory().todos.first { $0.id == "t1" }?.done == false)
    }

    @Test func unknownTodoIsNotFound() async {
        await #expect(throws: BackendError.notFound) { try await store.setTodo(id: "nope", done: true) }
    }

    @Test func projectPageHoldsItsTodosNotesAndEvidence() async throws {
        let detail = try await store.project(id: "p2")
        #expect(detail.todos.map(\.id) == ["t2"])
        #expect(!detail.notes.isEmpty)
        #expect(!detail.evidence.isEmpty)
        try await store.setTodo(id: "t2", done: true)
        #expect(try await store.project(id: "p2").todos.first?.done == true)
    }

    @Test func factsCanBeConfirmedAndRetracted() async throws {
        let before = try await store.person(id: "pe1")
        let fact = try #require(before.facts.first { !$0.confirmed })
        try await store.confirmFact(personID: "pe1", factID: fact.id)
        #expect(try await store.person(id: "pe1").facts.first { $0.id == fact.id }?.confirmed == true)
        try await store.retractFact(personID: "pe1", factID: fact.id)
        #expect(try await store.person(id: "pe1").facts.allSatisfy { $0.id != fact.id })
        await #expect(throws: BackendError.notFound) { try await store.confirmFact(personID: "pe1", factID: "nope") }
    }

    @Test func aBackendWithoutFactEditsRefusesWithAMessage() async {
        struct Bare: MemoryBackend {
            func memory() async throws -> MemorySnapshot { .skeleton }
            func setTodo(id: String, done: Bool) async throws {}
            func person(id: String) async throws -> PersonDetail { .skeleton }
            func project(id: String) async throws -> ProjectDetail { .skeleton }
        }
        await #expect(throws: BackendError.refused("Edit this on your Mac.")) {
            try await Bare().retractFact(personID: "p", factID: "f")
        }
    }

    @Test func skeletonsHaveEveryShapeTheScreensDraw() {
        let snapshot = MemorySnapshot.skeleton
        #expect(snapshot.todos.contains { $0.bucket == .thisWeek } && snapshot.todos.contains { $0.bucket == .later })
        #expect(!snapshot.projects.isEmpty && !snapshot.people.isEmpty)
    }

    // MARK: Search

    @Test func searchGroupsHitsAndEachCarriesATarget() async throws {
        let rent = try await store.search(query: "rent")
        #expect(rent.hits.contains { $0.target == .todo(id: "t1") })
        #expect(rent.hits.contains { $0.target == .file(id: "lib_lease") })
        #expect(rent.answer?.emphasis == "Friday, November 6")
        let sam = try await store.search(query: "sam")
        #expect(sam.hits.contains { $0.group == .people && $0.target == .person(id: "pe1") })
        let lease = try await store.search(query: "lease")
        #expect(lease.hits.contains { $0.group == .chatsAndFiles && $0.target == .chat(id: "thr_lease") })
        #expect(lease.answer == nil)
        // Every group appears, in the order the screen draws them.
        let all = try await store.search(query: "a")
        #expect(Set(all.hits.map(\.group)) == Set(SearchResults.Hit.Group.allCases))
        #expect(all.hits.allSatisfy { $0.target != nil })
    }

    @Test func aQuestionMatchesOnItsWords() async throws {
        let results = try await store.search(query: "when is rent due")
        #expect(results.answer != nil)
        #expect(results.hits.contains { $0.title == "Pay rent for November" })
    }

    @Test func nothingMatchesNothing() async throws {
        let results = try await store.search(query: "zzzzqq")
        #expect(results.hits.isEmpty && results.answer == nil)
    }

    @Test func recentSearchesStayNewestFirstDedupedAndBounded() throws {
        let suite = "psyche.test.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let recents = RecentSearches(defaults: defaults)
        recents.add("rent")
        recents.add("Dana")
        recents.add("RENT")
        #expect(recents.items == ["RENT", "Dana"])
        recents.add("a")  // too short to keep
        #expect(recents.items.count == 2)
        for index in 0..<12 { recents.add("query \(index)") }
        #expect(recents.items.count == RecentSearches.limit)
        #expect(recents.items.first == "query 11")
        recents.remove("query 11")
        #expect(recents.items.first == "query 10")
        recents.clear()
        #expect(recents.items.isEmpty)
    }

    // MARK: Settings

    @Test func settingsRoundTripAndPublish() async throws {
        let events = store.events()
        try await Task.sleep(for: .milliseconds(20))
        var settings = try await store.settings()
        #expect(settings.taskTitlesOnLockScreen == false)  // off by default
        settings.taskTitlesOnLockScreen = true
        settings.faceIDForApprovals = false
        try await store.updateSettings(settings)
        #expect(try await store.settings() == settings)
        var iterator = events.makeAsyncIterator()
        #expect(await iterator.next() == .changed(.settings))
    }

    @Test func thisPhoneIsDescribed() async throws {
        let device = try await store.device()
        #expect(!device.scopes.isEmpty)
        #expect(device.gatewayFingerprint.hasPrefix("sha256:"))
    }

    @Test func removingThisPhoneIsRecorded() async throws {
        #expect(await store.phoneWasRemoved == false)
        try await store.revokeThisPhone()
        #expect(await store.phoneWasRemoved)
    }
}
