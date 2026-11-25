import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import struct PsycheProtocol.WireError
import Testing

@testable import PsycheClient

/// Memory → Projects over the fake gateway: every project the Gateway lists gets a row, with progress where its
/// read succeeded and without it where it did not.
struct GatewayMemoryProjectsTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> GatewayBackend {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return GatewayBackend(client: h.client)
    }

    /// Twelve projects; the Gateway answers the detail read for projects 0 to 5 and 11 only. Project 11 is past the
    /// first batch of ten, and has one finished to-do.
    @Test func everyFetchedProjectIsListedEvenWithoutProgress() async throws {
        let backend = try await live { g in
            g.on("memory.entities.search") { req in
                let kind = req.params?["kinds"]?.array?.first?.string
                let rows: [JSONValue] = kind == "project"
                    ? (0..<12).map { .object(["id": .string("prj_\($0)"), "kind": "project",
                                              "name": .string("Project \($0)"), "status": "active"]) }
                    : []
                return .success(.object(["entities": .array(rows)]))
            }
            g.on("memory.loops.list") { _ in .success(.object(["loops": .array([])])) }
            g.on("memory.catchup.list") { _ in .success(.object(["items": .array([])])) }
            g.on("memory.entities.get") { req in
                guard let id = req.params?["id"]?.string, let n = Int(id.dropFirst(4)) else {
                    return .failure(WireError(code: "not_found", message: "no such entity"))
                }
                if n == 11 {
                    return .success(.object([
                        "entity": .object(["id": .string(id), "kind": "project", "name": .string("Project 11")]),
                        "facts": .array([]),
                        "edges": .array([.object(["rel": "part_of", "src": "asg_11", "dst": .string(id)])]),
                        "related": .array([.object(["id": "asg_11", "kind": "assignment", "workStatus": "done"])]),
                    ]))
                }
                guard n < 6 else { return .failure(WireError(code: "unavailable", message: "not read")) }
                return .success(.object([
                    "entity": .object(["id": .string(id), "kind": "project", "name": .string("Project \(n)")]),
                    "facts": .array([]), "edges": .array([]), "related": .array([]),
                ]))
            }
        }
        let snapshot = try await backend.memory()
        #expect(snapshot.projects.map(\.id) == (0..<12).map { "prj_\($0)" })
        #expect(snapshot.projects.map(\.title) == (0..<12).map { "Project \($0)" })
        // Projects past the first ten are listed with progress pending, and read on their own.
        #expect(snapshot.progressPending == ["prj_10", "prj_11"])
        #expect(snapshot.projects.last?.fraction == 0)
        #expect(try await backend.projectRow(id: "prj_11").fraction == 1)
        // A project whose read failed keeps its row and shows no progress.
        #expect(snapshot.projects[7].fraction == 0)
    }
}
