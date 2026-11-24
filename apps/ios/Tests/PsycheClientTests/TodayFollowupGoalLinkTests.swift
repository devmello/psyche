import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Today follow-ups (`daily.followups.update`) and the goal suggest and link calls (`goals.suggest`, `goals.link`).
struct TodayFollowupGoalLinkTests {
    func live(_ configure: (FakeGateway) -> Void) async throws -> (GatewayBackend, GatewayClientTests.Harness) {
        try await GatewayBackendTests().live(configure)
    }

    @Test func followupDoneSendsTheActionWithoutAnUntil() async throws {
        let (backend, h) = try await live { g in
            g.on("daily.followups.update") { _ in .success(.object(["followup": .object(["id": "f1", "status": "done"])])) }
        }
        try await backend.actOnFollowup(id: "f1", action: .done, until: nil)
        let call = h.gateway.received.filter { $0.method == "daily.followups.update" }.first
        #expect(call?.params?["id"]?.string == "f1")
        #expect(call?.params?["action"]?.string == "done")
        #expect(call?.params?["until"] == nil)
    }

    @Test func followupSnoozeSendsTheUntilTime() async throws {
        let (backend, h) = try await live { g in
            g.on("daily.followups.update") { _ in .success(.object(["followup": .object(["id": "f1", "status": "snoozed"])])) }
        }
        try await backend.actOnFollowup(id: "f1", action: .snooze, until: Date(timeIntervalSince1970: 1_900_000_000))
        let call = h.gateway.received.filter { $0.method == "daily.followups.update" }.first
        #expect(call?.params?["action"]?.string == "snooze")
        #expect(call?.params?["until"]?.string != nil)
    }

    @Test func followupRefusalShowsTheGatewaysWords() async throws {
        let (backend, _) = try await live { g in
            g.on("daily.followups.update") { _ in .failure(WireError(code: "forbidden", message: "That follow-up is already closed.")) }
        }
        await #expect(throws: BackendError.refused("That follow-up is already closed.")) {
            try await backend.actOnFollowup(id: "f1", action: .dismiss, until: nil)
        }
    }

    @Test func suggestReadsTheIdeaTheGatewayMadeOrNil() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.suggest") { req in
                req.params?["goalId"]?.string == "g2"
                    ? .success(.object(["ideaId": .null]))
                    : .success(.object(["ideaId": "idea_9"]))
            }
        }
        #expect(try await backend.suggestNextStep(goalID: "g1") == "idea_9")
        #expect(try await backend.suggestNextStep(goalID: "g2") == nil)
        #expect(h.gateway.received.filter { $0.method == "goals.suggest" }.count == 2)
    }

    @Test func linkSendsTheTaskOrAutomationIdAndUnlinkSetsTheFlag() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.link") { _ in .success(.object([:])) }
        }
        try await backend.linkGoal(goalID: "g1", .task("task_q3"))
        try await backend.linkGoal(goalID: "g1", .automation("auto_2"))
        try await backend.unlinkGoal(goalID: "g1", .automation("auto_2"))
        let calls = h.gateway.received.filter { $0.method == "goals.link" }
        #expect(calls.count == 3)
        #expect(calls[0].params?["taskId"]?.string == "task_q3")
        #expect(calls[0].params?["automationId"] == nil)
        #expect(calls[0].params?["unlink"] == nil)
        #expect(calls[1].params?["automationId"]?.string == "auto_2")
        #expect(calls[1].params?["taskId"] == nil)
        #expect(calls[2].params?["unlink"]?.bool == true)
        #expect(calls[2].params?["automationId"]?.string == "auto_2")
    }

    @Test func goalDetailReadsTheLinksOfEachKind() async throws {
        let (backend, _) = try await live { g in
            g.on("goals.get") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "active"]),
                "taskIds": .array(["t1"]),
                "links": .array([
                    .object(["goalId": "g1", "taskId": "t1", "automationId": .null, "watchId": .null]),
                    .object(["goalId": "g1", "taskId": .null, "automationId": "a1", "watchId": .null]),
                    .object(["goalId": "g1", "taskId": .null, "automationId": .null, "watchId": "w1"]),
                ]),
            ])) }
        }
        let detail = try await backend.goalDetail(id: "g1")
        #expect(detail.links == [.task("t1"), .automation("a1")])
        #expect(detail.linkedTasks == 2)
    }

    @Test func goalDetailWithoutLinksFallsBackToTheTaskIds() async throws {
        let (backend, _) = try await live { g in
            g.on("goals.get") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "active"]),
                "taskIds": .array(["t1", "t2"]),
            ])) }
        }
        #expect(try await backend.goalDetail(id: "g1").links == [.task("t1"), .task("t2")])
    }
}
