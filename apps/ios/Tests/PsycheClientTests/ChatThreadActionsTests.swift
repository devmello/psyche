import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Pin, archive, rename, delete and export over the Gateway's real `threads.*` and `chat.export` methods.
struct ChatThreadActionsTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func pinAndArchiveSendTheThreadIdAndTheFlag() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.pin") { _ in .success(.object(["thread": .object(["id": "thr_2"])])) }
            g.on("threads.archive") { _ in .success(.object(["thread": .object(["id": "thr_2"])])) }
        }
        try await backend.pinThread(id: "thr_2", pinned: true)
        try await backend.archiveThread(id: "thr_2")
        let pin = h.gateway.received.first { $0.method == "threads.pin" }
        #expect(pin?.params?["threadId"]?.string == "thr_2")
        #expect(pin?.params?["pinned"] == .bool(true))
        #expect(h.gateway.received.first { $0.method == "threads.archive" }?.params?["threadId"]?.string == "thr_2")
    }

    @Test func renameSendsTheTitleAndDeleteSendsTheThread() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.rename") { _ in .success(.object(["thread": .object(["id": "thr_2"])])) }
            g.on("threads.delete") { _ in .success(.object(["ok": .bool(true)])) }
        }
        try await backend.renameThread(id: "thr_2", title: "Trip plans")
        try await backend.deleteThread(id: "thr_2")
        let rename = h.gateway.received.first { $0.method == "threads.rename" }
        #expect(rename?.params?["threadId"]?.string == "thr_2")
        #expect(rename?.params?["title"]?.string == "Trip plans")
        #expect(h.gateway.received.first { $0.method == "threads.delete" }?.params?["threadId"]?.string == "thr_2")
    }

    @Test func exportAsksForMarkdownAndReturnsTheContent() async throws {
        let (backend, h) = try await live { g in
            g.on("chat.export") { _ in .success(.object(["mime": "text/markdown", "content": "# Rent\n\nWhen is rent due?"])) }
        }
        let markdown = try await backend.exportThread(id: "thr_2")
        #expect(markdown == "# Rent\n\nWhen is rent due?")
        let request = h.gateway.received.first { $0.method == "chat.export" }
        #expect(request?.params?["threadId"]?.string == "thr_2")
        #expect(request?.params?["format"]?.string == "markdown")
    }

    @Test func aRefusedPinThrowsSoTheListCanRollBack() async throws {
        let (backend, _) = try await live { g in
            g.on("threads.pin") { _ in .failure(WireError(code: "conflict", message: "The chat is running.")) }
        }
        do {
            try await backend.pinThread(id: "thr_2", pinned: true)
            Issue.record("a refused pin should throw")
        } catch {
            // Thrown, not swallowed: the list model reloads from the Gateway to roll the pin back.
        }
    }
}
