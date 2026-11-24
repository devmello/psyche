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

    /// `goals.link` with `taskId` or `automationId`. The Gateway answers `ok`; the goal page reloads to show it.
    public func linkGoal(goalID: String, _ target: GoalLinkTarget) async throws {
        _ = try await call("goals.link", .object(Self.linkParams(goalID: goalID, target)))
    }

    /// `goals.link` with `unlink: true`: removes only the link.
    public func unlinkGoal(goalID: String, _ target: GoalLinkTarget) async throws {
        var params = Self.linkParams(goalID: goalID, target)
        params["unlink"] = .bool(true)
        _ = try await call("goals.link", .object(params))
    }

    static func linkParams(goalID: String, _ target: GoalLinkTarget) -> [String: JSONValue] {
        switch target {
        case .task(let id): ["goalId": .string(goalID), "taskId": .string(id)]
        case .automation(let id): ["goalId": .string(goalID), "automationId": .string(id)]
        }
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
        // `links` is the Gateway's list of GoalLink rows (a task, an automation or a watch). Only tasks and automations
        // are shown here. An answer without `links` (older Gateways) falls back to the bare `taskIds`.
        let links: [GoalLinkTarget]
        if result["links"] == nil {
            links = (result["taskIds"]?.array ?? []).compactMap(\.string).map(GoalLinkTarget.task)
        } else {
            links = (result["links"]?.array ?? []).compactMap { link in
                if let task = link["taskId"]?.string { return .task(task) }
                if let automation = link["automationId"]?.string { return .automation(automation) }
                return nil
            }
        }
        return GoalDetail(goal: goal, milestones: milestones, linkedTasks: links.count, links: links)
    }

    static func goal(from wire: JSONValue) -> GoalItem? {
        guard let id = wire["id"]?.string, let title = wire["title"]?.string else { return nil }
        return GoalItem(
            id: id, title: title, category: wire["category"]?.string ?? "other", status: wire["status"]?.string ?? "active",
            cadence: wire["cadence"]?.string, nextCheckinAt: WireFormat.date(wire["nextCheckinAt"]?.string))
    }
}
