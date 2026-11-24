import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

struct GatewayLibraryPagingTests {
    private static func wire(_ id: String, _ createdAt: String) -> JSONValue {
        .object(["id": .string(id), "name": .string("\(id).pdf"), "kind": "document", "createdAt": .string(createdAt)])
    }

    @Test func aSectionPagesEachKindFromItsOwnCursorAndMergesByDate() async throws {
        let seen = SeenParams()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("library.list") { req in
                seen.add(req.params)
                let kind = req.params?["kind"]?.string
                let cursor = req.params?["cursor"]?.string
                switch (kind, cursor) {
                case ("document", nil):
                    return .success(.object([
                        "items": .array([Self.wire("lib_new", "2026-11-20T10:00:00Z"), Self.wire("lib_mid", "2026-11-10T10:00:00Z")]),
                        "nextCursor": "d2",
                    ]))
                case ("system", nil):
                    return .success(.object([
                        "items": .array([.object(["id": "lib_sys", "name": "Rules", "kind": "system", "createdAt": "2026-10-01T10:00:00Z"])]),
                        "nextCursor": .null,
                    ]))
                case ("document", "d2"):
                    // Repeats "lib_mid" and holds a row newer than the system row, which the first page already had.
                    return .success(.object([
                        "items": .array([Self.wire("lib_mid", "2026-11-10T10:00:00Z"), Self.wire("lib_p2", "2026-10-15T10:00:00Z")]),
                        "nextCursor": .null,
                    ]))
                default:
                    return .success(.object(["items": .array([]), "nextCursor": .null]))
                }
            }
        }

        let first = try await backend.libraryPage(section: .documents, cursor: nil)
        #expect(first.items.map(\.id) == ["lib_new", "lib_mid", "lib_sys"])
        #expect(first.nextCursor != nil)
        // Both kinds were asked for their first page, with the page size.
        #expect(seen.all.count == 2)
        #expect(seen.all.allSatisfy { $0?["limit"]?.int == 100 && $0?["cursor"] == nil })

        seen.reset()
        let second = try await backend.libraryPage(section: .documents, cursor: first.nextCursor)
        // Only "document" still has a cursor, and it is sent its own cursor.
        #expect(seen.all.count == 1)
        #expect(seen.all[0]?["kind"]?.string == "document")
        #expect(seen.all[0]?["cursor"]?.string == "d2")
        #expect(second.nextCursor == nil)

        let shown = LibraryPaging.newestFirst(first.items + second.items)
        #expect(shown.map(\.id) == ["lib_new", "lib_mid", "lib_p2", "lib_sys"])
    }
}
