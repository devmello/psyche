import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

/// The run detail page and its controls: `tasks.get` for the task, `runs.list` for its latest run,
/// `runs.get` for that run's steps, and `tasks.pause/resume/retry/steer` for the owner's actions. Every
/// failure throws, so the page can show it; nothing here is optional.
extension GatewayBackend {
    public func taskRun(taskID: String) async throws -> TaskRunDetail {
        let task = try await call("tasks.get", .obj(["taskId": .string(taskID)]))
        guard let t = task["task"] else { throw BackendError.notFound }
        let runs = try await call("runs.list", .obj(["taskId": .string(taskID), "limit": .number(1)]))
        var steps: [TaskRunStep] = []
        let runID = runs["runs"]?.array?.first?["id"]?.string
        if let runID {
            let run = try await call("runs.get", .obj(["runId": .string(runID)]))
            steps = (run["steps"]?.array ?? []).compactMap(Self.runStep)
        }
        return TaskRunDetail(
            taskID: taskID,
            title: t["title"]?.string ?? "Task",
            // A status this build does not know gets the least powerful controls (cancel only), never a guess.
            state: TaskRunState(rawValue: t["status"]?.string ?? "") ?? .queued,
            startedAt: WireFormat.date(t["createdAt"]?.string),
            endedAt: WireFormat.date(t["completedAt"]?.string),
            summary: t["summary"]?.string.flatMap { $0.isEmpty ? nil : $0 },
            steps: steps,
            limits: Self.taskLimits(t["specialist"]),
            runID: runID)
    }

    public func pauseTask(id: String) async throws {
        _ = try await call("tasks.pause", .obj(["taskId": .string(id)]))
    }

    public func resumeTask(id: String) async throws {
        _ = try await call("tasks.resume", .obj(["taskId": .string(id)]))
    }

    /// Side-effecting: a fresh key per tap, so one tap starts one attempt and a resend of that tap dedupes.
    public func retryTask(id: String) async throws {
        _ = try await call("tasks.retry", .obj(["taskId": .string(id)]), key: "retry-\(id)-\(UUID().uuidString)")
    }

    /// Side-effecting: a fresh key per send, so the same guidance is not steered in twice.
    public func steerTask(id: String, text: String) async throws {
        _ = try await call(
            "tasks.steer", .obj(["taskId": .string(id), "text": .string(text)]),
            key: "steer-\(id)-\(UUID().uuidString)")
    }

    /// Side-effecting: a fresh key per save. Sends only what changed: `budget` carries the changed limits and
    /// `deadline` the new one. The Gateway caps each limit at the role's Settings and refuses a task that has
    /// ended or is not a specialist's job; that refusal throws in the Gateway's own words.
    public func updateTask(id: String, changes: TaskChanges) async throws {
        let budget: JSONValue? = changes.tokens == nil && changes.costUsd == nil && changes.minutes == nil
            ? nil
            : .obj([
                "tokens": changes.tokens.map { JSONValue.number(Double($0)) },
                "costUsd": changes.costUsd.map { JSONValue.number($0) },
                "minutes": changes.minutes.map { JSONValue.number(Double($0)) },
            ])
        let deadline = changes.deadline.map { JSONValue.string($0.formatted(.iso8601)) }
        _ = try await call(
            "tasks.update",
            .obj(["taskId": .string(id), "budget": budget, "deadline": deadline]),
            key: "task-update-\(id)-\(UUID().uuidString)")
    }

    // MARK: -

    /// The limits of a specialist's job, from the task's `specialist` block. Nil when the task has none.
    static func taskLimits(_ specialist: JSONValue?) -> TaskLimits? {
        guard let budget = specialist?["budget"] else { return nil }
        let limit = budget["limit"]
        return TaskLimits(
            tokens: limit?["tokens"]?.double.map { Int($0) },
            costUsd: limit?["costUsd"]?.double,
            minutes: limit?["wallMs"]?.double.map { Int($0 / 60_000) },
            deadline: WireFormat.date(specialist?["deadline"]?.string))
    }

    /// One step of `runs.get`. The label is the past tense once the step ended ok; the result is the error
    /// message when it failed, else the first line of its output preview.
    static func runStep(_ s: JSONValue) -> TaskRunStep? {
        guard let id = s["id"]?.string else { return nil }
        let status = TaskRunStep.Status(rawValue: s["status"]?.string ?? "") ?? .pending
        let label = (status == .ok ? s["doneLabel"]?.string : nil) ?? s["label"]?.string ?? ""
        let raw = s["error"]?["message"]?.string ?? s["preview"]?["output"]?.string
        let firstLine = raw?.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces)
        return TaskRunStep(
            id: id, label: label, status: status,
            startedAt: WireFormat.date(s["startedAt"]?.string), endedAt: WireFormat.date(s["endedAt"]?.string),
            result: firstLine.flatMap { $0.isEmpty ? nil : $0 })
    }
}
