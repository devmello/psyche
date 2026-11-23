import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Scheduled work over `scheduled.list` and `scheduled.runs`. A run that is `running` may be waiting for its
// next attempt after a transient model error; that `retryAt` is only on `automations.runs`, so those few
// runs are looked up there. A failed lookup just leaves the run without a retry time.
extension GatewayBackend {
    public func scheduled() async throws -> ScheduledOverview {
        async let list = call("scheduled.list", .obj([:]))
        async let runs = call("scheduled.runs", .obj(["limit": .number(20)]))
        let jobs = (try await list)["items"]?.array ?? []
        let wireRuns = (try await runs)["runs"]?.array ?? []
        var runItems = wireRuns.compactMap(Self.scheduledRun(from:))
        for index in runItems.indices where runItems[index].state == .running {
            let id = runItems[index].id
            guard let automationID = wireRuns.first(where: { $0["id"]?.string == id })?["automationId"]?.string else { continue }
            let history = await optional { try await self.call("automations.runs", .obj(["automationId": .string(automationID), "limit": .number(5)])) }
            runItems[index].retryAt = Self.retryAt(ofRun: id, in: history)
        }
        let all = Self.jobs(from: jobs)
        return ScheduledOverview(upcoming: ScheduledOverview.upcomingOf(all), items: all, runs: runItems)
    }

    /// Pause or resume one automation or routine. Returns the state the Gateway now reports.
    public func setScheduledPaused(id: String, paused: Bool) async throws -> String {
        let result = try await call("scheduled.pause", .obj(["id": .string(id), "paused": .bool(paused)]))
        return result["item"]?["state"]?.string ?? (paused ? "paused" : "active")
    }

    /// Run now. A key per tap: a second tap is a second run, and a retry of this one is not.
    public func runScheduledNow(id: String) async throws {
        _ = try await call("automations.run", .obj(["automationId": .string(id)]), key: "automation-run-\(id)-\(UUID().uuidString)")
    }

    // MARK: - Mapping

    /// Every item the Gateway lists, active first (soonest first), then paused, then off. Items with no id
    /// or title, or a state this app doesn't know, are left out rather than shown without their controls.
    static func jobs(from items: [JSONValue]) -> [ScheduledJob] {
        let known = ["active", "paused", "off"]
        return items.compactMap { item -> ScheduledJob? in
            guard let id = item["id"]?.string, let title = item["title"]?.string,
                  let state = item["state"]?.string, known.contains(state) else { return nil }
            let isRoutine = item["group"]?.string == "routine"
            let approvals = item["approvals"]?.array ?? []
            return ScheduledJob(
                id: id, title: title, summary: item["summary"]?.string ?? "", state: state, isRoutine: isRoutine,
                nextRunAt: WireFormat.date(item["nextRunAt"]?.string), lastRunAt: WireFormat.date(item["lastRunAt"]?.string),
                confirmsRunNow: !isRoutine || !approvals.isEmpty)
        }
        .sorted { lhs, rhs in
            let order = ["active": 0, "paused": 1, "off": 2]
            if order[lhs.state] != order[rhs.state] { return order[lhs.state]! < order[rhs.state]! }
            return (lhs.nextRunAt ?? .distantFuture) < (rhs.nextRunAt ?? .distantFuture)
        }
    }

    static func scheduledRun(from run: JSONValue) -> ScheduledRunItem? {
        guard let id = run["id"]?.string, let title = run["title"]?.string else { return nil }
        // An unknown state from a newer Gateway reads as a quiet skipped run rather than dropping the row.
        let state = run["state"]?.string.flatMap(ScheduledRunState.init(rawValue:)) ?? .skipped
        return ScheduledRunItem(
            id: id, title: title, state: state, startedAt: WireFormat.date(run["startedAt"]?.string),
            summary: run["summary"]?.string, reason: run["reason"]?.string)
    }

    /// The `retryAt` of one run in an `automations.runs` answer; nil when absent or null.
    static func retryAt(ofRun id: String, in history: JSONValue?) -> Date? {
        guard let run = history?["runs"]?.array?.first(where: { $0["id"]?.string == id }) else { return nil }
        return WireFormat.date(run["retryAt"]?.string)
    }
}
