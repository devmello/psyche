import Foundation
import Testing

@testable import PsycheStore

/// The demo fixtures cover the memory reads and the person and project edit sheets, so demo mode can reach them.
struct FixtureMemoryTests {
    @Test func memoryFilesListsTheFixtureFilesWithSoulProtected() async throws {
        let rows = try await FixtureBackend().memoryFiles()
        #expect(rows.map(\.path) == ["SOUL.md", "USER.md", "memory/2026-11-20.md", "memory/notes.md"])
        #expect(rows.first { $0.path == "SOUL.md" }?.isProtected == true)
        #expect(rows.first { $0.path == "memory/notes.md" }?.isProtected == false)
    }

    @Test func aFileReadsItsWholeText() async throws {
        let file = try await FixtureBackend().memoryFile(path: "memory/notes.md")
        #expect(file.path == "memory/notes.md")
        #expect(file.content.hasPrefix("# Notes"))
    }

    @Test func anUnknownFileIsNotFound() async {
        await #expect(throws: BackendError.notFound) { try await FixtureBackend().memoryFile(path: "nope.md") }
    }

    @Test func fixturePeopleAndProjectsResolveToTheirKinds() async throws {
        let store = FixtureBackend()
        #expect(try await store.entityKind(id: "pe1") == "person")
        #expect(try await store.entityKind(id: "p2") == "project")
        await #expect(throws: BackendError.notFound) { try await store.entityKind(id: "ghost") }
    }

    @Test func thePersonAndProjectPagesCarryAnEditableCard() async throws {
        let store = FixtureBackend()
        let person = try await store.person(id: "pe1")
        #expect(person.card?.name == "Sam Ortiz")
        #expect(person.card?.etag != nil)
        let project = try await store.project(id: "p2")
        #expect(project.card?.projectStatus == .active)
        #expect(project.card?.dueAt != nil)
    }

    @Test func anEditIsAppliedAndShowsOnReload() async throws {
        let store = FixtureBackend()
        let before = try await store.person(id: "pe2").card
        try await store.updateEntity(id: "pe2", changes: EntityChanges(name: "Dana R.", aliases: ["Dana"]), ifMatch: before?.etag)
        let after = try await store.person(id: "pe2")
        #expect(after.person.name == "Dana R.")
        #expect(after.card?.aliases == ["Dana"])
        #expect(after.card?.etag != before?.etag)
    }

    @Test func aStaleEtagIsRefused() async {
        let store = FixtureBackend()
        await #expect(throws: BackendError.self) {
            try await store.updateEntity(id: "pe2", changes: EntityChanges(name: "X"), ifMatch: "old")
        }
    }

    @Test func aProjectDueDateCanBeClearedAndSetAgain() async throws {
        let store = FixtureBackend()
        try await store.updateEntity(id: "p2", changes: EntityChanges(dueAt: .clear), ifMatch: nil)
        #expect(try await store.project(id: "p2").card?.dueAt == nil)
        let date = Date(timeIntervalSince1970: 1_796_000_000)
        try await store.updateEntity(id: "p2", changes: EntityChanges(dueAt: .set(date)), ifMatch: nil)
        #expect(try await store.project(id: "p2").card?.dueAt == date)
    }
}
