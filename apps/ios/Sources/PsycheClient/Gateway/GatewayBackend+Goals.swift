import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Goals over `goals.list/get/update`. The phone sets a goal's status; editing its title, plan or cadence is a Mac thing.
extension GatewayBackend {
    public func goals() async throws -> [GoalItem] {
        let result = try await call("goals.list", .obj([:]))
        return (result["goals"]?.array ?? []).compactMap(Self.goal(from:))
    }

    public func goalDetail(id: String) async throws -> GoalDetail {
        try Self.goalDetail(from: try await call("goals.get", .obj(["goalId": .string(id)])))
    }

    public func setGoalStatus(id: String, _ status: GoalStatusChange) async throws -> GoalDetail {
        try Self.goalDetail(from: try await call("goals.update", .obj(["goalId": .string(id), "status": .string(status.rawValue)])))
    }

    /// `goals.create` with the Mac dialog's two fields: the title (trimmed) and the category.
    public func createGoal(title: String, category: GoalCategoryChoice) async throws -> GoalDetail {
        let params: JSONValue = .obj([
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "category": .string(category.rawValue),
        ])
        return try Self.goalDetail(from: try await call("goals.create", params))
    }

    /// A `goals.get` or `goals.update` answer: the goal, its milestones and its linked tasks.
    static func goalDetail(from result: JSONValue) throws -> GoalDetail {
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
