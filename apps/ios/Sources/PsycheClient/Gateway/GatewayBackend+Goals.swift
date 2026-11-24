import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue

// Goals over `goals.list/get/update/decide/archive/milestone`. The phone sets a goal's status, decides a suggested
// goal, archives it and edits its milestones. Its title, plan and check-in cadence are a Mac thing.
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

    public func decideGoal(id: String, _ decision: GoalDecision) async throws -> GoalItem {
        let result = try await call("goals.decide", .obj(["goalId": .string(id), "decision": .string(decision.rawValue)]))
        guard let wire = result["goal"], let goal = Self.goal(from: wire) else { throw BackendError.notFound }
        return goal
    }

    public func archiveGoal(id: String) async throws -> GoalItem {
        let result = try await call("goals.archive", .obj(["goalId": .string(id)]))
        guard let wire = result["goal"], let goal = Self.goal(from: wire) else { throw BackendError.notFound }
        return goal
    }

    /// `goals.milestone`: a new milestone takes the title and an optional due date; the others name the milestone.
    public func changeMilestone(goalID: String, _ change: GoalMilestoneChange) async throws -> GoalDetail {
        var params: [String: JSONValue] = ["goalId": .string(goalID)]
        switch change {
        case .add(let title, let dueAt):
            params["title"] = .string(title.trimmingCharacters(in: .whitespacesAndNewlines))
            if let dueAt { params["dueAt"] = .string(dueAt.formatted(.iso8601)) }
        case .setDone(let id, let done):
            params["milestoneId"] = .string(id)
            params["done"] = .bool(done)
        case .remove(let id):
            params["milestoneId"] = .string(id)
            params["remove"] = .bool(true)
        }
        return try Self.goalDetail(from: try await call("goals.milestone", .object(params)))
    }

    /// `goals.suggest`: the idea the Gateway made for the goal's next step, or nil when it made none.
    public func suggestNextStep(goalID: String) async throws -> String? {
        let result = try await call("goals.suggest", .obj(["goalId": .string(goalID)]))
        return result["ideaId"]?.string
    }

    /// `goals.link` with the chat thread as the task. The Gateway answers `ok`; the goal page reloads to show it.
    public func linkThread(goalID: String, threadID: String) async throws {
        _ = try await call("goals.link", .obj(["goalId": .string(goalID), "taskId": .string(threadID)]))
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
        let taskIDs = (result["taskIds"]?.array ?? []).compactMap(\.string)
        return GoalDetail(goal: goal, milestones: milestones, linkedTasks: taskIDs.count, linkedTaskIDs: taskIDs)
    }

    static func goal(from wire: JSONValue) -> GoalItem? {
        guard let id = wire["id"]?.string, let title = wire["title"]?.string else { return nil }
        return GoalItem(
            id: id, title: title, category: wire["category"]?.string ?? "other", status: wire["status"]?.string ?? "active",
            cadence: wire["cadence"]?.string, nextCheckinAt: WireFormat.date(wire["nextCheckinAt"]?.string))
    }
}
