import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import struct PsycheProtocol.WireReqFrame
import PsycheStore
import Testing

@testable import PsycheClient

/// The param shapes the phone sends for Space edits (packages/protocol/src/methods/spaces.ts).
struct SpacesEditBackendTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    func spaceMethods(_ h: GatewayClientTests.Harness) -> [WireReqFrame] {
        h.gateway.received.filter { $0.method.hasPrefix("spaces.") }
    }

    @Test func archivedListAsksForArchivedSpacesAndMarksThem() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.list") { _ in .success(.object(["spaces": .array([
                .object(["id": "s1", "name": "House sale", "archivedAt": "2030-01-01T09:12:00Z"]),
                .object(["id": "s2", "name": "Kitchen", "archivedAt": .null]),
            ])])) }
        }
        let archived = try await backend.archivedSpaces()
        #expect(archived.map(\.id) == ["s1", "s2"])
        #expect(archived.map(\.archived) == [true, false])
        #expect(h.gateway.received.first { $0.method == "spaces.list" }?.params?["archived"]?.bool == true)
    }

    @Test func archiveAndRestoreSendOnlyTheSpaceId() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.archive") { _ in .success(.object(["space": .object(["id": "s1", "name": "K"])])) }
            g.on("spaces.restore") { _ in .success(.object(["space": .object(["id": "s1", "name": "K"])])) }
        }
        try await backend.setSpaceArchived(id: "s1", true)
        try await backend.setSpaceArchived(id: "s1", false)
        let calls = spaceMethods(h)
        #expect(calls.map(\.method) == ["spaces.archive", "spaces.restore"])
        #expect(calls.allSatisfy { $0.params?["spaceId"]?.string == "s1" })
    }

    @Test func addingATrackerSendsATemplateNotAWidget() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.trackers.add") { _ in .success(.object(["space": .object(["id": "s1"])])) }
        }
        try await backend.addTracker(spaceID: "s1", template: .automationStatus)
        let params = try #require(h.gateway.received.first { $0.method == "spaces.trackers.add" }?.params)
        #expect(params["spaceId"]?.string == "s1")
        #expect(params["template"]?.string == "automation_status")
        #expect(params["widgetId"] == nil)
    }

    @Test func removingATrackerSendsItsWidgetId() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.trackers.remove") { _ in .success(.object(["space": .object(["id": "s1"])])) }
        }
        try await backend.removeTracker(spaceID: "s1", widgetID: "w9")
        let params = h.gateway.received.first { $0.method == "spaces.trackers.remove" }?.params
        #expect(params?["spaceId"]?.string == "s1")
        #expect(params?["widgetId"]?.string == "w9")
    }

    @Test func reorderSendsTheWholeShelfInTheNewOrder() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.trackers.reorder") { _ in .success(.object(["space": .object(["id": "s1"])])) }
        }
        try await backend.reorderTrackers(spaceID: "s1", widgetIDs: ["w2", "w3", "w1"])
        let ids = h.gateway.received.first { $0.method == "spaces.trackers.reorder" }?.params?["widgetIds"]?.array
        #expect(ids?.compactMap(\.string) == ["w2", "w3", "w1"])
    }

    @Test func aLinkWithoutATitleIsLabelledWithItsAddress() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.links.add") { _ in .success(.object(["link": .object(["id": "l1"])])) }
        }
        try await backend.addLink(spaceID: "s1", url: "https://example.com/tiles", title: "   ")
        let params = h.gateway.received.first { $0.method == "spaces.links.add" }?.params
        #expect(params?["kind"]?.string == "url")
        #expect(params?["ref"]?.string == "https://example.com/tiles")
        #expect(params?["label"]?.string == "https://example.com/tiles")
    }

    @Test func aLinkTitleIsTrimmedAndClampedToTheProtocolLimit() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.links.add") { _ in .success(.object(["link": .object(["id": "l1"])])) }
        }
        try await backend.addLink(spaceID: "s1", url: "https://example.com", title: "  " + String(repeating: "T", count: 200))
        let label = h.gateway.received.first { $0.method == "spaces.links.add" }?.params?["label"]?.string
        #expect(label?.count == 120)
        #expect(label?.hasPrefix("T") == true)
    }

    @Test func removingALinkSendsItsId() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.links.remove") { _ in .success(.object([:])) }
        }
        try await backend.removeLink(spaceID: "s1", linkID: "l7")
        let params = h.gateway.received.first { $0.method == "spaces.links.remove" }?.params
        #expect(params?["spaceId"]?.string == "s1")
        #expect(params?["linkId"]?.string == "l7")
    }

    @Test func suggestionsMapTitlesAndMarkOutsideContent() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.proposals.list") { _ in .success(.object(["proposals": .array([
                .object([
                    "id": "p1", "name": "Lisbon trip", "reason": "Flights and a hotel.", "status": "open",
                    "taint": .array([]), "chats": .array([.object(["id": "t1", "title": "Flights"])]),
                    "projectName": .null,
                ]),
                .object([
                    "id": "p2", "name": "Tile shopping", "reason": "From a web page.", "status": "open",
                    "taint": .array([.object(["sourceKind": "web"])]), "chats": .array([]),
                ]),
                .object(["name": "No id"]),
            ])])) }
        }
        let proposals = try await backend.spaceProposals()
        #expect(proposals.map(\.id) == ["p1", "p2"])
        #expect(proposals.map(\.untrusted) == [false, true])
        #expect(proposals[0].chatTitles == ["Flights"])
        #expect(h.gateway.received.first { $0.method == "spaces.proposals.list" } != nil)
    }

    @Test func acceptingSendsTheProposalIdAndReturnsTheNewSpace() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.proposals.accept") { _ in .success(.object(["space": .object(["id": "s9", "name": "Lisbon"])])) }
        }
        let spaceID = try await backend.acceptProposal(id: "p1")
        #expect(spaceID == "s9")
        let params = h.gateway.received.first { $0.method == "spaces.proposals.accept" }?.params
        #expect(params?["proposalId"]?.string == "p1")
        #expect(params?["name"] == nil)
    }

    @Test func dismissingSendsTheProposalId() async throws {
        let (backend, h) = try await live { g in
            g.on("spaces.proposals.dismiss") { _ in .success(.object([:])) }
        }
        try await backend.dismissProposal(id: "p1")
        #expect(h.gateway.received.first { $0.method == "spaces.proposals.dismiss" }?.params?["proposalId"]?.string == "p1")
    }

    @Test func aRefusalShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("spaces.trackers.reorder") { _ in .failure(WireError(code: "invalid_request", message: "The shelf changed.")) }
        }
        do {
            try await backend.reorderTrackers(spaceID: "s1", widgetIDs: ["w1"])
            Issue.record("expected a refusal")
        } catch {
            // The Gateway's words reach the owner through the error's description.
            #expect(error as? BackendError == .refused("The shelf changed."))
        }
    }
}
