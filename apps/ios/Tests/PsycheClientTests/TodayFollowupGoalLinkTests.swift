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

    @Test func linkThreadSendsTheThreadAsTheTask() async throws {
        let (backend, h) = try await live { g in
            g.on("goals.link") { _ in .success(.object(["ok": .bool(true)])) }
        }
        try await backend.linkThread(goalID: "g1", threadID: "thr_q3")
        let call = h.gateway.received.filter { $0.method == "goals.link" }.first
        #expect(call?.params?["goalId"]?.string == "g1")
        #expect(call?.params?["taskId"]?.string == "thr_q3")
        #expect(call?.params?["unlink"] == nil)
    }

    @Test func goalDetailKeepsTheLinkedTaskIds() async throws {
        let (backend, _) = try await live { g in
            g.on("goals.get") { _ in .success(.object([
                "goal": .object(["id": "g1", "title": "Half marathon", "category": "health", "status": "active"]),
                "taskIds": .array(["thr_q3", "task_invoice"]),
            ])) }
        }
        let detail = try await backend.goalDetail(id: "g1")
        #expect(detail.linkedTaskIDs == ["thr_q3", "task_invoice"])
        #expect(detail.linkedTasks == 2)
    }
}
