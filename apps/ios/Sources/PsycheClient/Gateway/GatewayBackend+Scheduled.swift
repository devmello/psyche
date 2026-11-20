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
        var items = wireRuns.compactMap(Self.scheduledRun(from:))
        for index in items.indices where items[index].state == .running {
            let id = items[index].id
            guard let automationID = wireRuns.first(where: { $0["id"]?.string == id })?["automationId"]?.string else { continue }
            let history = await optional { try await self.call("automations.runs", .obj(["automationId": .string(automationID), "limit": .number(5)])) }
            items[index].retryAt = Self.retryAt(ofRun: id, in: history)
        }
        return ScheduledOverview(upcoming: Self.upcoming(from: jobs), runs: items)
    }

    // MARK: - Mapping

    /// Active items with a next time, soonest first.
    static func upcoming(from items: [JSONValue]) -> [ScheduledJob] {
        items.compactMap { item -> ScheduledJob? in
            guard let id = item["id"]?.string, let title = item["title"]?.string,
                  item["state"]?.string == "active", let next = WireFormat.date(item["nextRunAt"]?.string) else { return nil }
            return ScheduledJob(
                id: id, title: title, summary: item["summary"]?.string ?? "", state: "active",
                isRoutine: item["group"]?.string == "routine", nextRunAt: next, lastRunAt: WireFormat.date(item["lastRunAt"]?.string))
        }
        .sorted { ($0.nextRunAt ?? .distantFuture) < ($1.nextRunAt ?? .distantFuture) }
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
