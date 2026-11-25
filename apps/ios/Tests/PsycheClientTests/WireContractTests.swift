import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireEventFrame
import PsycheStore
import Testing

@testable import PsycheClient

/// What the phone sends must match `packages/protocol`: the fixtures accept anything, so these use the fake
/// that enforces what the real Gateway enforces.
struct WireContractTests {
    // MARK: idempotency keys

    @Test func theFakeRefusesASideEffectingMethodWithoutAKey() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("goals.update") { _ in .success(.object([:])) }
            g.on("threads.list") { _ in .success(.object(["threads": .array([])])) }
        }
        // Positive control: the same call with a key goes through; a read needs none.
        _ = try await backend.client.call("goals.update", params: .object([:]), idempotencyKey: "k1")
        _ = try await backend.client.call("threads.list")
        await #expect(throws: (any Error).self) {
            _ = try await backend.client.call("goals.update", params: .object([:]))
        }
    }

    @Test func theSideEffectingListIsGeneratedFromTheProtocol() {
        let names = FakeGateway.sideEffectingMethods
        #expect(names.count > 100)
        for method in ["goals.update", "proposals.approve", "models.setRole", "mailFollowups.act", "daily.followups.update"] {
            #expect(names.contains(method), "\(method)")
        }
        #expect(!names.contains("threads.list") && !names.contains("runs.frame"))
    }

    /// Every side-effecting method called through the backend carries a key the caller did not supply.
    @Test func everySideEffectingMethodCalledThroughTheBackendCarriesAKey() async throws {
        let methods = FakeGateway.sideEffectingMethods.sorted()
        let (backend, h) = try await GatewayBackendTests().live { g in
            for method in methods { g.on(method) { _ in .success(.object([:])) } }
        }
        for method in methods { _ = try await backend.call(method, .object([:])) }
        let sent = h.gateway.received.filter { methods.contains($0.method) }
        #expect(sent.count == methods.count)
        #expect(sent.allSatisfy { !($0.idempotencyKey ?? "").isEmpty })
        #expect(Set(sent.compactMap(\.idempotencyKey)).count == methods.count)
    }

    @Test func anExplicitKeyIsKept() async throws {
        let (backend, h) = try await GatewayBackendTests().live { g in
            g.on("goals.archive") { _ in .success(.object([:])) }
        }
        _ = try await backend.call("goals.archive", .object([:]), key: "outbox-7")
        #expect(h.gateway.received.last { $0.method == "goals.archive" }?.idempotencyKey == "outbox-7")
    }

    // MARK: checklist status

    @Test func aRunningTaskCountsCompletedChecklistItems() {
        let task: JSONValue = .object([
            "id": "t1", "title": "Pay rent", "createdAt": "2030-01-01T09:00:00Z",
            "checklist": .array([
                .object(["text": "Find invoice", "status": "completed"]),
                .object(["text": "Open bank", "status": "in_progress"]),
                .object(["text": "Pay", "status": "pending"]),
            ]),
        ])
        let running = GatewayBackend.running(task: task)
        #expect(running?.step == 2 && running?.stepCount == 3)
        #expect(running?.detail == "Open bank")
    }

    // MARK: upcoming items

    @Test func anEventAutomationsTriggerObjectDoesNotBreakUpcoming() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("approvals.list") { _ in .success(.object(["approvals": .array([])])) }
            g.on("questions.list") { _ in .success(.object(["inputRequests": .array([])])) }
            g.on("automations.upcoming") { _ in .success(.object(["items": .array([
                .object(["id": "a1", "kind": "event", "title": "File receipts", "enabled": .bool(true),
                         "trigger": .object(["type": "event", "source": "mail.received", "filter": .object(["fromContains": "dana"])])]),
                .object(["id": "a2", "kind": "cron", "title": "Digest", "enabled": .bool(true), "nextRunAt": "2030-01-02T07:00:00Z"]),
            ])])) }
        }
        let activity = try await backend.activity()
        #expect(activity.nextUp.map(\.id) == ["a1", "a2"])
        #expect(activity.nextUp[0].when == "")
        #expect(!activity.nextUp[1].when.isEmpty)
    }

    // MARK: events

    @Test func onlyTheRealLibraryEventMapsToALibraryRefetch() async {
        var m = EventMapper(lookupQuestion: { _ in nil })
        func map(_ e: String) async -> [LiveEvent] {
            await m.map(WireEventFrame(event: e, payload: .object([:]), seq: 1, stateVersion: 1), ownDeviceID: "d").events
        }
        #expect(await map("library.item.changed") == [.changed(.library)])
        for dead in ["library.item.created", "library.item.updated", "library.item.deleted"] {
            #expect(await map(dead).isEmpty, "\(dead)")
        }
    }
}
