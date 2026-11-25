import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

/// The review calls (memory.quarantine.*, memory.senders.*) over the fake gateway: the params each sends, and how the
/// rows map back to the models. Decided items and malformed rows are dropped, as the list asks for undecided ones.
struct GatewayReviewBackendTests {
    /// Records the params each call sent, in order. Handlers run off the test's actor, hence the lock.
    final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [(method: String, params: JSONValue?)] = []

        func record(_ method: String, _ params: JSONValue?) {
            lock.lock()
            defer { lock.unlock() }
            calls.append((method, params))
        }

        func params(of method: String) -> [JSONValue] {
            lock.lock()
            defer { lock.unlock() }
            return calls.filter { $0.method == method }.compactMap { $0.params }
        }
    }

    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        let gateway = FakeGateway()
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return (GatewayBackend(client: h.client), h)
    }

    @Test func heldItemsMapTheUndecidedRowsAndSendTheCursor() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.quarantine.list") { req in
                seen.record(req.method, req.params)
                return .success(.object([
                    "items": .array([
                        .object(["id": "qtn_1", "source": "mail", "sourceRef": "m_1",
                                 "senderEntityId": "ent_tomas", "reasons": .array(["instruction_like", "hidden_text"]),
                                 "excerpt": "Please *remember* this.", "createdAt": "2026-11-20T09:00:00.000Z",
                                 "decided": .null, "decidedAt": .null]),
                        .object(["id": "qtn_2", "source": "notes", "sourceRef": "n_1", "senderEntityId": .null,
                                 "reasons": .array(["item_too_large"]), "excerpt": "Long.",
                                 "createdAt": "2026-11-19T09:00:00.000Z", "decided": .null, "decidedAt": .null]),
                        .object(["id": "qtn_3", "source": "mail", "sourceRef": "m_2", "senderEntityId": .null,
                                 "reasons": .array(["schema_invalid"]), "excerpt": "Done.",
                                 "createdAt": "2026-11-18T09:00:00.000Z", "decided": "released",
                                 "decidedAt": "2026-11-18T10:00:00.000Z"]),
                        .object(["id": "", "source": "mail", "excerpt": "No id."]),
                    ]),
                    "nextCursor": "c2",
                ]))
            }
        }
        let page = try await backend.heldItemsPage(cursor: "c1")
        #expect(page == HeldItemsPage(items: [
            HeldItem(id: "qtn_1", source: "mail", createdAt: "2026-11-20T09:00:00.000Z",
                     reasons: ["instruction_like", "hidden_text"], excerpt: "Please *remember* this.",
                     senderEntityID: "ent_tomas"),
            HeldItem(id: "qtn_2", source: "notes", createdAt: "2026-11-19T09:00:00.000Z",
                     reasons: ["item_too_large"], excerpt: "Long.", senderEntityID: nil),
        ], nextCursor: "c2"))
        #expect(seen.params(of: "memory.quarantine.list") == [.object(["limit": .number(20), "cursor": "c1"])])
    }

    @Test func aFirstHeldPageSendsOnlyTheLimit() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.quarantine.list") { req in
                seen.record(req.method, req.params)
                return .success(.object(["items": .array([]), "nextCursor": .null]))
            }
        }
        let page = try await backend.heldItemsPage(cursor: nil)
        #expect(page == HeldItemsPage(items: [], nextCursor: nil))
        #expect(seen.params(of: "memory.quarantine.list") == [.object(["limit": .number(20)])])
    }

    @Test func decidingAHeldItemSendsItsIdAndTheWireAction() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.quarantine.decide") { req in
                seen.record(req.method, req.params)
                return .success(.object(["item": .object(["id": "qtn_1"])]))
            }
        }
        try await backend.decideHeldItem(id: "qtn_1", action: .release)
        try await backend.decideHeldItem(id: "qtn_1", action: .discard)
        try await backend.decideHeldItem(id: "qtn_1", action: .blockSender)
        #expect(seen.params(of: "memory.quarantine.decide") == [
            .object(["id": "qtn_1", "action": "release"]),
            .object(["id": "qtn_1", "action": "discard"]),
            .object(["id": "qtn_1", "action": "block_sender"]),
        ])
    }

    @Test func sendersMapTheOfferedAndTrustedStatesAndDropUnknownOnes() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.senders.list") { req in
                seen.record(req.method, req.params)
                return .success(.object(["senders": .array([
                    .object(["entityId": "ent_mara", "name": "Mara Lindqvist", "confirmed": .number(7), "state": "trusted"]),
                    .object(["entityId": "ent_tomas", "name": "Tomás Ruiz", "confirmed": .number(4), "state": "offered"]),
                    .object(["entityId": "ent_x", "name": "Unknown", "confirmed": .number(1), "state": "blocked"]),
                ])]))
            }
        }
        let senders = try await backend.senderTrust()
        #expect(senders == [
            SenderTrustRow(entityID: "ent_mara", name: "Mara Lindqvist", confirmed: 7, state: .trusted),
            SenderTrustRow(entityID: "ent_tomas", name: "Tomás Ruiz", confirmed: 4, state: .offered),
        ])
        #expect(seen.params(of: "memory.senders.list").isEmpty)
    }

    @Test func decidingASenderSendsItsEntityIdAndTheDecision() async throws {
        let seen = Seen()
        let (backend, _) = try await live { g in
            g.on("memory.senders.decide") { req in
                seen.record(req.method, req.params)
                return .success(.object(["senders": .array([])]))
            }
        }
        try await backend.decideSender(entityID: "ent_tomas", decision: .trust)
        try await backend.decideSender(entityID: "ent_priya", decision: .decline)
        try await backend.decideSender(entityID: "ent_mara", decision: .revoke)
        #expect(seen.params(of: "memory.senders.decide") == [
            .object(["entityId": "ent_tomas", "decision": "trust"]),
            .object(["entityId": "ent_priya", "decision": "decline"]),
            .object(["entityId": "ent_mara", "decision": "revoke"]),
        ])
    }
}
