import Foundation
import PsycheHelperCore
import PsycheHelperSystem
import PsycheProtocol
import Testing

private let records: [ContactsList.Record] = [
    .init(id: "3", name: "Bob Zhang", givenName: "Bob", familyName: "Zhang"),
    .init(id: "1", name: "Alice Chen", givenName: "Alice", familyName: "Chen", nickname: "Ali", organization: "UCSC"),
    .init(id: "4", name: "", givenName: "", familyName: "", organization: "Acme Plumbing"),  // nameless: skipped
    .init(id: "2", name: "José Echeverría", givenName: "José", familyName: "Echeverría", nickname: " "),
]

private func invoke(_ params: JSONValue, reader: @escaping ContactsCapabilities.Reader = { records }) async throws -> JSONValue {
    let cap = try #require(ContactsCapabilities.make(reader: reader).first)
    return try await cap.invoke(InvocationContext(invocationId: "i", capability: "contacts.list", params: params, approvalId: nil, emit: { _ in })).result
}

@Suite("contacts.list (issue #121)")
struct ContactsListTests {
    @Test func namesOnlyOrderedByFamilyThenGivenName() async throws {
        let r = try await invoke(["limit": 500, "fields": ["name"]])
        let contacts = try #require(r["contacts"]?.arrayValue)
        #expect(contacts.map { $0["name"] } == ["Alice Chen", "José Echeverría", "Bob Zhang"])
        #expect(contacts[0] == ["id": "1", "name": "Alice Chen", "nickname": "Ali", "organization": "UCSC"])
        #expect(contacts[1]["nickname"] == nil)  // blank values are omitted
        #expect(r["total"] == 4 && r["truncated"] == false)
    }

    @Test func limitTruncatesAndQueryMatchesPrefixes() async throws {
        let cut = try await invoke(["limit": 1])
        #expect(cut["contacts"]?.arrayValue?.count == 1 && cut["truncated"] == true)
        let q = try await invoke(["query": "eche"])  // case- and diacritic-insensitive family-name prefix
        #expect(q["contacts"]?.arrayValue?.map { $0["id"] } == ["2"])
        let given = try await invoke(["query": "Bo"])
        #expect(given["contacts"]?.arrayValue?.map { $0["id"] } == ["3"])
    }

    @Test func invalidParamsAreRejected() async {
        for bad: JSONValue in [["limit": 0], ["limit": 2001], ["fields": ["phone"]], ["fields": []], ["query": .string(String(repeating: "a", count: 81))]] {
            await #expect(throws: CapabilityError.self) { _ = try await invoke(bad) }
        }
    }

    @Test func withoutPermissionItFailsWithoutPrompting() async {
        do {
            _ = try await invoke([:], reader: { nil })
            Issue.record("expected permission_denied")
        } catch let e as CapabilityError {
            #expect(e.code == .forbidden && e.reason == "permission_denied" && e.details["permission"] == "contacts")
        } catch { Issue.record("unexpected \(error)") }
    }

    @Test func specIsAPlainRead() throws {
        let spec = try #require(ContactsCapabilities.make(reader: { [] }).first).spec
        #expect(spec.sideEffect == .read && spec.targetKind == nil && !spec.streaming && spec.permissions.isEmpty)
        #expect(Set(spec.inputSchema["properties"]?.objectValue?.keys ?? [:].keys) == ["limit", "fields", "query"])
    }
}
