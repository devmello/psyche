import Foundation
import enum PsycheProtocol.JSONValue
import PsycheStore
import Testing

@testable import PsycheClient

struct AutomationRunsBackendTests {
    @Test func runsDecodeEveryStatusAndKeepTheGatewayCursor() async throws {
        let (backend, h) = try await ProactiveBackendTests().live { g in
            g.on("automations.runs") { _ in .success(.object([
                "runs": .array([
                    .object(["id": "r3", "automationId": "a1", "status": "failed", "startedAt": "2030-01-03T09:00:00Z",
                             "endedAt": "2030-01-03T09:00:40Z", "summary": "Timed out.", "taskId": "t9", "runId": "run_x"]),
                    .object(["id": "r2", "automationId": "a1", "status": "no_reply", "startedAt": "2030-01-02T09:00:00Z", "endedAt": .null]),
                    .object(["id": "r1", "automationId": "a1", "status": "from_the_future", "startedAt": "2030-01-01T09:00:00Z"]),
                    .object(["id": "r0", "automationId": "a1", "status": "running"]),
                ]),
                "nextCursor": "page-2",
            ])) }
        }
        let page = try await backend.automationRuns(id: "a1", cursor: "page-1")
        // A run without a start time is left out; an unknown status reads as skipped.
        #expect(page.runs.map(\.id) == ["r3", "r2", "r1"])
        #expect(page.runs[0].status == .failed)
        #expect(page.runs[0].summary == "Timed out.")
        #expect(page.runs[0].taskID == "t9")
        #expect(page.runs[0].duration == 40)
        #expect(page.runs[1].status == .noReply)
        #expect(page.runs[1].duration == nil && page.runs[1].taskID == nil)
        #expect(page.runs[2].status == .skipped)
        #expect(page.nextCursor == "page-2")
        let call = h.gateway.received.last { $0.method == "automations.runs" }
        #expect(call?.params?["automationId"]?.string == "a1")
        #expect(call?.params?["cursor"]?.string == "page-1")
    }

    @Test func aLastPageHasNoCursor() async throws {
        let (backend, h) = try await ProactiveBackendTests().live { g in
            g.on("automations.runs") { _ in .success(.object(["runs": .array([]), "nextCursor": .null])) }
        }
        let page = try await backend.automationRuns(id: "a1", cursor: nil)
        #expect(page.runs.isEmpty)
        #expect(page.nextCursor == nil)
        let call = h.gateway.received.last { $0.method == "automations.runs" }
        #expect(call?.params?["cursor"] == nil)
    }
}
