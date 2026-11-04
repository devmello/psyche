import Foundation
import PsycheStore
import PsycheWire

extension GatewayBackend {
    public func activity() async throws -> AgentActivity {
        async let approvals = settled { try await self.needsYouApprovals() }
        async let questions = settled { try await self.needsYouQuestions() }
        async let now = optional { try await self.runningTasks() }
        async let upcoming = optional { try await self.upcomingItems() }
        async let recent = optional { try await self.recentRuns() }
        let (a, q) = await (approvals, questions)
        if case .failure(let error) = a, case .failure = q { throw error }
        return await AgentActivity(
            needsYou: ((try? a.get()) ?? []) + ((try? q.get()) ?? []),
            now: now ?? [], nextUp: upcoming ?? [], recent: recent ?? [])
    }

    public func persona() async throws -> PersonaSummary {
        let result = try await call("memory.persona.get")
        let identity = result["identity"]
        let description = result["description"]?.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let summary = description.isEmpty
            ? [identity?["tagline"]?.string, identity?["vibe"]?.string].compactMap { $0 }.joined(separator: ". ")
            : String(description.split(separator: "\n\n", maxSplits: 1, omittingEmptySubsequences: true).first ?? "")
        return PersonaSummary(name: identity?["name"]?.string ?? "Psyche", summary: summary, files: ["IDENTITY.md"])
    }

    public func cancelTask(id: String) async throws {
        _ = try await call("tasks.cancel", .obj(["taskId": .string(id)]))
    }

    // MARK: -

    private func upcomingItems() async throws -> [PsycheStore.UpcomingItem] {
        let result = try await call("automations.upcoming", .obj(["limit": .number(8)]))
        return (result["items"]?.array ?? []).compactMap { item in
            guard let id = item["id"]?.string, item["kind"]?.string != "input_request", item["enabled"]?.bool != false else { return nil }
            let when = item["nextRunAt"]?.string.map { WireFormat.time($0) } ?? item["trigger"]?.string ?? ""
            let schedule = item["schedule"]?.string
            return PsycheStore.UpcomingItem(
                id: id, title: item["title"]?.string ?? "Scheduled",
                when: [when, schedule].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        }
    }

    private func recentRuns() async throws -> [RecentRun] {
        let result = try await call(
            "tasks.list", .obj(["status": .array(["done", "failed", "cancelled"]), "limit": .number(8)]))
        return (result["tasks"]?.array ?? []).compactMap { task in
            guard let id = task["id"]?.string, let outcome = RecentRun.Outcome(rawValue: Self.outcome(task["status"]?.string)) else { return nil }
            return RecentRun(
                id: id, title: task["title"]?.string ?? "Task", outcome: outcome,
                time: WireFormat.time(task["completedAt"]?.string ?? task["updatedAt"]?.string))
        }
    }

    private static func outcome(_ status: String?) -> String {
        switch status {
        case "failed": "failed"
        case "cancelled": "cancelled"
        default: "done"
        }
    }
}
