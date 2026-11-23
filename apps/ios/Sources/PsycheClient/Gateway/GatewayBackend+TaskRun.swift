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
        if let runID = runs["runs"]?.array?.first?["id"]?.string {
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
            steps: steps)
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

    // MARK: -

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
