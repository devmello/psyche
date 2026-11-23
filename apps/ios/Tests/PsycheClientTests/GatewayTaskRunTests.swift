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
            "tasks.pause|task_1|-|nokey",
            "tasks.resume|task_1|-|nokey",
            "tasks.retry|task_1|-|key",
            "tasks.steer|task_1|Use the Q3 file|key",
        ])
    }
}
