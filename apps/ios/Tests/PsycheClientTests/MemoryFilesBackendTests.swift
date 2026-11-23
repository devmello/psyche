import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// The phone's read-only memory calls (memory.files.list, memory.read, memory.entities.get) over the fake gateway:
/// the rows and text they map to, and the kind an entity id resolves to.
struct MemoryFilesBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    @Test func memoryFilesListsSortedRowsWithProtection() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.files.list") { _ in .success(.object(["files": .array([
                .object(["path": "memory/notes.md", "bytes": .number(2048), "etag": "e2", "protected": .bool(false),
                         "provenance": "agent", "updatedAt": "2026-11-20T10:00:00.000Z"]),
                .object(["path": "SOUL.md", "bytes": .number(120), "etag": "e1", "protected": .bool(true),
                         "provenance": "owner", "updatedAt": "2026-11-19T09:00:00.000Z"]),
                .object(["path": "", "bytes": .number(1), "etag": "e3", "protected": .bool(false),
                         "provenance": "owner", "updatedAt": "2026-11-19T09:00:00.000Z"]),
            ])])) }
        }
        let rows = try await backend.memoryFiles()
        #expect(rows == [
            MemoryFileRow(path: "SOUL.md", bytes: 120, isProtected: true),
            MemoryFileRow(path: "memory/notes.md", bytes: 2048, isProtected: false),
        ])
    }

    @Test func memoryFileReadsTheWholeFileAsPlainText() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.read") { req in
                guard req.params?["path"]?.stringValue == "memory/notes.md" else {
                    return .success(.object(["path": "wrong", "content": "", "updatedAt": "2026-11-20T10:00:00.000Z"]))
                }
                return .success(.object([
                    "path": "memory/notes.md", "content": "# Notes\n- <b>not markup</b>", "updatedAt": "2026-11-20T10:00:00.000Z",
                    "etag": "e2",
                ]))
            }
        }
        let file = try await backend.memoryFile(path: "memory/notes.md")
        #expect(file == MemoryFileContent(path: "memory/notes.md", content: "# Notes\n- <b>not markup</b>"))
    }

    @Test(arguments: [
        ("ent_pe1", "person"), ("ent_org", "org"), ("ent_p1", "project"), ("ent_place", "place"),
    ] as [(String, String)])
    func entityIdResolvesToItsKind(id: String, kind: String) async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.get") { req in
                .success(.object(["entity": .object([
                    "id": .string(req.params?["id"]?.stringValue ?? ""), "kind": .string(kind), "name": "Someone",
                ]), "facts": .array([])]))
            }
        }
        #expect(try await backend.entityKind(id: id) == kind)
    }

    @Test func anEntityWithNoKindIsNotFound() async throws {
        let (backend, _) = try await live { g in
            g.on("memory.entities.get") { _ in .success(.object(["facts": .array([])])) }
        }
        await #expect(throws: BackendError.notFound) {
            try await backend.entityKind(id: "ent_missing")
        }
    }
}
