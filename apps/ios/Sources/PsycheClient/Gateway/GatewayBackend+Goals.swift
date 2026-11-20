import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Goals over `goals.list/get`. Read-only on the phone: creating and editing goals is a Mac thing.
extension GatewayBackend {
    public func goals() async throws -> [GoalItem] {
        let result = try await call("goals.list", .obj([:]))
        return (result["goals"]?.array ?? []).compactMap(Self.goal(from:))
    }

    public func goalDetail(id: String) async throws -> GoalDetail {
        let result = try await call("goals.get", .obj(["goalId": .string(id)]))
        guard let wire = result["goal"], let goal = Self.goal(from: wire) else { throw BackendError.notFound }
        let milestones: [GoalMilestoneItem] = (result["milestones"]?.array ?? []).compactMap { milestone in
            guard let id = milestone["id"]?.string, let title = milestone["title"]?.string else { return nil }
            return GoalMilestoneItem(
                id: id, title: title, dueAt: WireFormat.date(milestone["dueAt"]?.string), done: milestone["doneAt"]?.string != nil)
        }
        return GoalDetail(goal: goal, milestones: milestones, linkedTasks: result["taskIds"]?.array?.count ?? 0)
    }

    static func goal(from wire: JSONValue) -> GoalItem? {
        guard let id = wire["id"]?.string, let title = wire["title"]?.string else { return nil }
        return GoalItem(
            id: id, title: title, category: wire["category"]?.string ?? "other", status: wire["status"]?.string ?? "active",
            cadence: wire["cadence"]?.string, nextCheckinAt: WireFormat.date(wire["nextCheckinAt"]?.string))
    }
}
