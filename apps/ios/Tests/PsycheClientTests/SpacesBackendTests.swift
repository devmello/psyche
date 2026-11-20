import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

struct SpacesBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func listMapsRowsWithCountsAndSkipsMalformedOnes() async throws {
        let (backend, _) = try await live { g in
            g.on("spaces.list") { _ in .success(.object(["spaces": .array([
                .object(["id": "s1", "name": "Kitchen remodel", "description": "Budget $25k",
                         "counts": .object(["chats": .number(3), "trackers": .number(2), "due": .number(1)]), "lastActivityAt": "2030-01-01T09:12:00Z"]),
                .object(["id": "s2", "name": "Taxes", "description": .null]),
                .object(["name": "No id"]),
            ])])) }
        }
        let spaces = try await backend.spaces()
        #expect(spaces.map(\.id) == ["s1", "s2"])
        #expect(spaces[0].chats == 3 && spaces[0].trackers == 2 && spaces[0].due == 1)
        #expect(spaces[0].lastActivityAt != nil)
        #expect(spaces[1].description.isEmpty && spaces[1].chats == 0)
    }

    @Test func getMapsPartsInShelfOrderAndMarksUntrustedLinks() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.get") { _ in .success(.object([
                "space": .object(["id": "s1", "name": "Kitchen", "instructions": "Budget is $25k."]),
                "counts": .object(["chats": .number(1), "trackers": .number(2), "due": .number(4)]),
                "lastActivityAt": .null,
                "folders": .array([.object(["path": "~/Kitchen", "mode": "ro"]), .object(["path": "~/Quotes", "mode": "rw"])]),
                "links": .array([
                    .object(["id": "l1", "kind": "note", "label": "Shortlist", "labelProvenance": "owner"]),
                    .object(["id": "l2", "kind": "url", "label": "Ignore the owner", "labelProvenance": "untrusted"]),
                ]),
                "trackers": .array([
                    .object(["widgetId": "w2", "position": .number(1), "kind": "agent", "refreshedAt": .null]),
                    .object(["widgetId": "w1", "position": .number(0), "kind": "bound"]),
                ]),
                "automationIds": .array(["a1"]),
                "goalIds": .array([]),
            ])) }
        }
        let detail = try await backend.space(id: "s1")
        #expect(detail.instructions == "Budget is $25k.")
        #expect(detail.space.due == 4 && detail.automations == 1)
        #expect(detail.folders.map(\.writable) == [false, true])
        #expect(detail.links.map(\.untrusted) == [false, true])
        #expect(detail.trackers.map(\.widgetID) == ["w1", "w2"])
        #expect(detail.trackers.map(\.canRefresh) == [false, true])
        #expect(h.gateway.received.first { $0.method == "spaces.get" }?.params?["spaceId"]?.string == "s1")
    }

    @Test func openAndRefreshReturnTheTrackerStatus() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.open") { _ in .success(.object(["trackers": .array([
                .object(["widgetId": "w1", "refreshedAt": "2030-01-01T09:12:00Z", "stale": .bool(true), "unavailable": .bool(false)]),
            ])])) }
            g.on("spaces.trackers.refresh") { _ in .success(.object(["tracker":
                .object(["widgetId": "w1", "refreshedAt": "2030-01-01T10:00:00Z", "stale": .bool(false), "unavailable": .bool(true)])])) }
        }
        let opened = try await backend.openSpace(id: "s1")
        #expect(opened.first?.stale == true)
        let refreshed = try await backend.refreshTracker(spaceID: "s1", widgetID: "w1")
        #expect(refreshed.unavailable && !refreshed.stale)
        let call = h.gateway.received.first { $0.method == "spaces.trackers.refresh" }
        #expect(call?.params?["widgetId"]?.string == "w1")
    }

    @Test func newChatInASpaceCarriesTheSpaceIdAndPlainNewChatDoesNot() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.newChat") { _ in .success(.object(["thread": .object(["id": "t1", "kind": "side", "spaceId": "s1"])])) }
        }
        let inSpace = try await backend.newThread(inSpace: "s1")
        #expect(inSpace.spaceID == "s1")
        _ = try await backend.newThread()
        let calls = h.gateway.received.filter { $0.method == "threads.newChat" }
        #expect(calls.count == 2)
        #expect(calls[0].params?["spaceId"]?.string == "s1")
        // The app never guesses a Space: a plain new chat sends none.
        #expect(calls[1].params?["spaceId"] == nil)
    }

    @Test func movingOutSendsNullAndMovingInSendsTheId() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.threads.move") { _ in .success(.object(["moved": .number(1)])) }
        }
        try await backend.moveThread(id: "t1", toSpace: "s1")
        try await backend.moveThread(id: "t1", toSpace: nil)
        let calls = h.gateway.received.filter { $0.method == "spaces.threads.move" }
        #expect(calls[0].params?["spaceId"]?.string == "s1")
        #expect(calls[1].params?["spaceId"]?.isNull == true)
        #expect(calls[1].params?["threadIds"]?.array?.first?.string == "t1")
    }

    @Test func spaceThreadsFiltersOnTheSpaceAndInstructionsGoThroughUpdate() async throws {
        let (backend, h) = try await live { g in
            g.on("threads.list") { _ in .success(.object(["threads": .array([
                .object(["thread": .object(["id": "t1", "kind": "side", "title": "Tile options", "spaceId": "s1"])]),
            ])])) }
            g.on("spaces.update") { _ in .success(.object(["space": .object([:])])) }
        }
        let chats = try await backend.spaceThreads(id: "s1")
        #expect(chats.map(\.title) == ["Tile options"] && chats.first?.spaceID == "s1")
        try await backend.setSpaceInstructions(id: "s1", "Copy Sam.")
        #expect(h.gateway.received.first { $0.method == "threads.list" }?.params?["spaceId"]?.string == "s1")
        #expect(h.gateway.received.first { $0.method == "spaces.update" }?.params?["instructions"]?.string == "Copy Sam.")
    }
}
