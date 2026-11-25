import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Full access: `threads.update` with `permissionMode`, and which chats may offer it.
struct FullAccessBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    static func head(kind: String, key: String, mode: String) -> JSONValue {
        .object([
            "thread": .object([
                "id": "thr_2", "kind": .string(kind), "title": "T", "sessionKey": .string(key),
                "permissionMode": .string(mode), "imported": .null,
            ])
        ])
    }

    @Test func turningOnSendsFullAndTurningOffSendsBalanced() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.update") { _ in .success(.object(["thread": .object(["id": "thr_2"])])) }
        }
        try await backend.setFullAccess(threadID: "thr_2", enabled: true)
        try await backend.setFullAccess(threadID: "thr_2", enabled: false)
        let updates = h.gateway.received.filter { $0.method == "threads.update" }
        #expect(updates.count == 2)
        #expect(updates[0].params?["threadId"]?.string == "thr_2")
        #expect(updates[0].params?["permissionMode"]?.string == "full")
        #expect(updates[1].params?["permissionMode"]?.string == "balanced")
    }

    @Test func aRefusalThrowsWithTheGatewaysWords() async throws {
        let reason = "Only the Mac app or a device paired as admin can turn on Full access."
        let (backend, _) = try await live { g in
            g.on("threads.update") { _ in .failure(WireError(code: "forbidden", message: reason)) }
        }
        do {
            try await backend.setFullAccess(threadID: "thr_2", enabled: true)
            Issue.record("a refused Full access should throw")
        } catch {
            #expect(error.localizedDescription.contains(reason))
        }
    }

    @Test func onlyTheOwnersOwnChatsAllowIt() {
        // Positive controls first: the owner's chats.
        #expect(ThreadFullAccess.isAllowed(kind: "main", imported: false, sessionKey: "owner:main"))
        #expect(ThreadFullAccess.isAllowed(kind: "side", imported: false, sessionKey: "owner:abc"))
        #expect(ThreadFullAccess.isAllowed(kind: "incognito", imported: false, sessionKey: "main"))
        // Refused kinds, imported chats, other session keys, and missing fields.
        for kind in ["channel", "automation", "subagent"] {
            #expect(!ThreadFullAccess.isAllowed(kind: kind, imported: false, sessionKey: "owner:x"))
        }
        #expect(!ThreadFullAccess.isAllowed(kind: "side", imported: true, sessionKey: "owner:x"))
        #expect(!ThreadFullAccess.isAllowed(kind: "side", imported: false, sessionKey: "telegram:peer:1"))
        #expect(!ThreadFullAccess.isAllowed(kind: "side", imported: false, sessionKey: "ownerx"))
        #expect(!ThreadFullAccess.isAllowed(kind: "side", imported: false, sessionKey: nil))
        #expect(!ThreadFullAccess.isAllowed(kind: nil, imported: false, sessionKey: "owner:x"))
    }

    @Test func theThreadReadCarriesTheModeAndWhetherItIsAllowed() async throws {
        for (kind, key, mode, allowed) in [("side", "owner:a", "full", true), ("channel", "telegram:peer:1", "balanced", false)] {
            let (backend, _) = try await live { g in
                g.on("threads.get") { _ in .success(Self.head(kind: kind, key: key, mode: mode)) }
                g.on("chat.history") { _ in .success(.object(["messages": .array([])])) }
            }
            let thread = try await backend.thread(id: "thr_2")
            #expect(thread.permissionMode == mode)
            #expect(thread.isFullAccess == (mode == "full"))
            #expect(thread.fullAccessAllowed == allowed)
        }
    }
}
