import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// The task edit's Gateway calls: `tasks.update` sends only the changed limits, with an idempotency key, and the
/// Gateway's refusal reaches the owner in its own words. A specialist job's limits are read from `tasks.get`.
struct GatewayTaskUpdateTests {
    @Test func aSpecialistJobReadsItsLimitsAndOffersEditWhileLive() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.get") { _ in .success(.object(["task": .object([
                "id": "task_3", "title": "Compare laptops", "status": "running", "createdAt": "2030-01-01T09:00:00Z",
                "specialist": .object([
                    "role": "researcher",
                    "deadline": "2030-01-02T09:00:00Z",
                    "budget": .object(["limit": .object([
                        "tokens": .number(200_000), "costUsd": .number(2.5), "wallMs": .number(1_800_000),
                    ])]),
                ]),
            ])])) }
            g.on("runs.list") { _ in .success(.object(["runs": .array([]), "nextCursor": .null])) }
        }
        let run = try await backend.taskRun(taskID: "task_3")
        #expect(run.limits == TaskLimits(
            tokens: 200_000, costUsd: 2.5, minutes: 30, deadline: ISO8601DateFormatter().date(from: "2030-01-02T09:00:00Z")))
        #expect(run.controls.canEdit)
    }

    @Test func aTaskThatIsNotASpecialistJobOffersNoEdit() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.get") { _ in .success(.object(["task": .object(["id": "task_4", "title": "Sort", "status": "running"])])) }
            g.on("runs.list") { _ in .success(.object(["runs": .array([]), "nextCursor": .null])) }
        }
        let run = try await backend.taskRun(taskID: "task_4")
        #expect(run.limits == nil)
        #expect(!run.controls.canEdit)
    }

    @Test func anEndedSpecialistJobOffersNoEdit() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.get") { _ in .success(.object(["task": .object([
                "id": "task_5", "title": "Done job", "status": "done", "createdAt": "2030-01-01T09:00:00Z",
                "specialist": .object(["budget": .object(["limit": .object(["tokens": .number(10)])])]),
            ])])) }
            g.on("runs.list") { _ in .success(.object(["runs": .array([]), "nextCursor": .null])) }
        }
        let run = try await backend.taskRun(taskID: "task_5")
        #expect(run.limits?.tokens == 10)
        #expect(!run.controls.canEdit)
    }

    @Test func tasksUpdateSendsOnlyTheChangedLimitsWithAKey() async throws {
        let sent = OutboxTests.Sent()
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.update") { req in
                let budget = req.params?["budget"]
                let tokens = budget?["tokens"]?.double.map { String(Int($0)) } ?? "-"
                let costUsd = budget?["costUsd"]?.double.map { String($0) } ?? "-"
                let minutes = budget?["minutes"]?.double.map { String(Int($0)) } ?? "-"
                let deadline = req.params?["deadline"]?.stringValue ?? "-"
                sent.add("\(req.params?["taskId"]?.stringValue ?? "")|\(tokens)|\(costUsd)|\(minutes)|\(deadline)|\(req.idempotencyKey == nil ? "nokey" : "key")")
                return .success(.object(["task": .object(["id": "task_3", "status": "running"])]))
            }
        }
        try await backend.updateTask(id: "task_3", changes: TaskChanges(tokens: 250_000, minutes: 45))
        try await backend.updateTask(id: "task_3", changes: TaskChanges(costUsd: 4))
        try await backend.updateTask(id: "task_3", changes: TaskChanges(deadline: ISO8601DateFormatter().date(from: "2030-01-02T09:00:00Z")))
        #expect(sent.all == [
            "task_3|250000|-|45|-|key",
            "task_3|-|4.0|-|-|key",
            "task_3|-|-|-|2030-01-02T09:00:00Z|key",
        ])
    }

    @Test func aRefusalFromTheGatewayStaysInItsOwnWords() async throws {
        let (backend, _) = try await GatewayBackendTests().live { g in
            g.on("tasks.update") { _ in .failure(WireError(code: "conflict", message: "task task_3 is done")) }
        }
        await #expect(throws: BackendError.refused("task task_3 is done")) {
            try await backend.updateTask(id: "task_3", changes: TaskChanges(minutes: 45))
        }
    }
}
