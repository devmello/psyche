import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// The run page's Gateway calls: the task and its latest run's steps are read, and each owner action sends
/// the method, the params and an idempotency key where the method is side-effecting.
struct GatewayTaskRunTests {
    @Test func aTaskReadsItsStateAndLatestRunsSteps() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.get") { _ in .success(.object(["task": .object([
                "id": "task_1", "title": "Sort the receipts", "status": "paused", "summary": .null,
                "createdAt": "2030-01-01T09:00:00Z", "completedAt": .null,
            ])])) }
            g.on("runs.list") { req in
                guard req.params?["taskId"]?.stringValue == "task_1" else { return .failure(WireError(code: "not_found", message: "wrong task")) }
                return .success(.object(["runs": .array([.object(["id": "run_1"])]), "nextCursor": .null]))
            }
            g.on("runs.get") { req in
                guard req.params?["runId"]?.stringValue == "run_1" else { return .failure(WireError(code: "not_found", message: "wrong run")) }
                return .success(.object(["steps": .array([
                    .object([
                        "id": "stp_1", "label": "Reading receipts", "doneLabel": "Read receipts", "status": "ok",
                        "startedAt": "2030-01-01T09:00:01Z", "endedAt": "2030-01-01T09:00:09Z",
                        "preview": .object(["output": "12 files\nmore output"]),
                    ]),
                    .object([
                        "id": "stp_2", "label": "Sending the summary", "status": "failed",
                        "startedAt": "2030-01-01T09:00:10Z", "endedAt": "2030-01-01T09:00:11Z",
                        "error": .object(["code": "mail", "message": "The mail server refused it", "retryable": .bool(true)]),
                    ]),
                ])]))
            }
        }
        let run = try await backend.taskRun(taskID: "task_1")
        #expect(run.title == "Sort the receipts")
        #expect(run.state == TaskRunState.paused)
        #expect(run.controls.canResume && run.controls.canCancel && !run.controls.canPause)
        #expect(run.endedAt == nil)
        #expect(run.steps.map { $0.label } == ["Read receipts", "Sending the summary"])
        let statuses: [TaskRunStep.Status] = run.steps.map { $0.status }
        #expect(statuses == [TaskRunStep.Status.ok, TaskRunStep.Status.failed])
        #expect(run.steps.map { $0.result } == ["12 files", "The mail server refused it"])
    }

    @Test func aRunsChildrenMapToHelperRowsWithTheirBudgetsAndDeadlines() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("runs.children") { req in
                guard req.params?["runId"]?.stringValue == "run_1" else { return .failure(WireError(code: "not_found", message: "wrong run")) }
                return .success(.object(["runs": .array([
                    // A specialist priced in cost: the cost limit wins over the token limit.
                    .object([
                        "id": "run_c1", "title": "Total the receipts", "kind": "subagent", "status": "done",
                        "budget": .object([
                            "limit": .object(["costUsd": .number(2.5), "tokens": .number(200_000)]),
                            "used": .object(["tokens": .number(1200), "costUsd": .number(0.42), "steps": .number(3), "wallMs": .number(9000)]),
                        ]),
                    ]),
                    // A helper with a token budget and a deadline, waiting on the owner.
                    .object([
                        "id": "run_c2", "kind": "task", "status": "awaiting_approval",
                        "deadline": "2030-01-01T10:00:00Z",
                        "budget": .object([
                            "limit": .object(["tokens": .number(5000)]),
                            "used": .object(["tokens": .number(800), "steps": .number(1), "wallMs": .number(100)]),
                        ]),
                    ]),
                    // An unpriced run: its cost limit is null, so the tokens are what it spends against.
                    .object([
                        "id": "run_c3", "kind": "subagent", "status": "mystery",
                        "budget": .object([
                            "limit": .object(["costUsd": .null, "tokens": .number(9000)]),
                            "used": .object(["tokens": .number(100), "costUsd": .null, "steps": .number(1), "wallMs": .number(1)]),
                        ]),
                    ]),
                    // No budget at all: no spend, and no deadline.
                    .object(["id": "run_c4", "kind": "subagent", "status": "running"]),
                ]), "nextCursor": .null]))
            }
        }
        let helpers = try await backend.runChildren(runID: "run_1")
        #expect(helpers.map(\.id) == ["run_c1", "run_c2", "run_c3", "run_c4"])
        #expect(helpers[0].title == "Total the receipts")
        #expect(helpers[0].kind == .specialist)
        #expect(helpers[0].state == .done)
        #expect(helpers[0].spend == .cost(spent: 0.42, limit: 2.5))
        #expect(helpers[0].deadline == nil)
        #expect(helpers[1].title == nil)
        #expect(helpers[1].kind == .helper)
        #expect(helpers[1].state == .awaitingApproval)
        #expect(helpers[1].spend == .tokens(spent: 800, limit: 5000))
        #expect(helpers[1].deadline == ISO8601DateFormatter().date(from: "2030-01-01T10:00:00Z"))
        #expect(helpers[2].spend == .tokens(spent: 100, limit: 9000))
        #expect(helpers[2].state == .queued)
        #expect(helpers[3].spend == nil)
        #expect(helpers[3].state == .running)
    }

    @Test func aRunWithNoChildrenHasNoHelpers() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("runs.children") { _ in .success(.object(["runs": .array([])])) }
        }
        #expect(try await backend.runChildren(runID: "run_1").isEmpty)
    }

    @Test func aTaskWithNoRunYetHasNoSteps() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.get") { _ in .success(.object(["task": .object(["id": "task_2", "title": "New", "status": "queued", "createdAt": "2030-01-01T09:00:00Z"])])) }
            g.on("runs.list") { _ in .success(.object(["runs": .array([]), "nextCursor": .null])) }
        }
        let run = try await backend.taskRun(taskID: "task_2")
        #expect(run.state == .queued)
        #expect(run.steps.isEmpty)
    }

    @Test func ownerActionsSendTheirMethodsParamsAndKeys() async throws {
        let sent = OutboxTests.Sent()
        let (backend, _) = try await GatewayBackendTests().live { g in
            for method in ["tasks.pause", "tasks.resume", "tasks.retry", "tasks.steer"] {
                g.on(method) { req in
                    let text = req.params?["text"]?.stringValue ?? "-"
                    sent.add("\(method)|\(req.params?["taskId"]?.stringValue ?? "")|\(text)|\(req.idempotencyKey == nil ? "nokey" : "key")")
                    return .success(.object(["task": .object(["id": "task_1", "status": "running"])]))
                }
            }
        }
        try await backend.pauseTask(id: "task_1")
        try await backend.resumeTask(id: "task_1")
        try await backend.retryTask(id: "task_1")
        try await backend.steerTask(id: "task_1", text: "Use the Q3 file")
        #expect(sent.all == [
            "tasks.pause|task_1|-|key",
            "tasks.resume|task_1|-|key",
            "tasks.retry|task_1|-|key",
            "tasks.steer|task_1|Use the Q3 file|key",
        ])
    }
}
