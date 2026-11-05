import Foundation
import PsycheShared
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// The Live Activities the app has running, one per watched task. A protocol so the engine can be tested
/// without ActivityKit.
@MainActor
protocol ActivityHost: AnyObject {
    /// `ActivityAuthorizationInfo().areActivitiesEnabled`: the system toggle for Psyche.
    var isEnabled: Bool { get }
    /// Task ids that already have an activity (kept across an app relaunch by the system).
    var activeTaskIDs: [String] { get }
    func start(taskID: String, content: TaskActivityContent) -> Bool
    func update(taskID: String, content: TaskActivityContent) async
    /// Ends the activity showing `final` for `dismissAfter` seconds (0: remove it at once).
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async
}

#if canImport(ActivityKit) && os(iOS)
@MainActor
final class SystemActivityHost: ActivityHost {
    private var activities: [String: Activity<PsycheTaskAttributes>] = [:]

    init() {
        for activity in Activity<PsycheTaskAttributes>.activities where activity.activityState == .active {
            activities[activity.attributes.taskID] = activity
        }
    }

    var isEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var activeTaskIDs: [String] { Array(activities.keys) }

    func start(taskID: String, content: TaskActivityContent) -> Bool {
        guard isEnabled, activities[taskID] == nil else { return activities[taskID] != nil }
        do {
            // pushType nil: updates come from the app itself over its live connection (no APNs without a
            // paid developer account), so there is no push token to register with the Gateway.
            let activity = try Activity.request(
                attributes: PsycheTaskAttributes(taskID: taskID),
                content: ActivityContent(state: content, staleDate: nil), pushType: nil)
            activities[taskID] = activity
            return true
        } catch {
            return false
        }
    }

    func update(taskID: String, content: TaskActivityContent) async {
        guard let activity = activities[taskID] else { return }
        await Box(activity).update(ActivityContent(state: content, staleDate: nil))
    }

    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {
        guard let removed = activities.removeValue(forKey: taskID) else { return }
        let content = final.map { ActivityContent(state: $0, staleDate: nil) }
        await Box(removed).end(content, dismissalPolicy: dismissAfter > 0 ? .after(.now + dismissAfter) : .immediate)
    }

    /// ActivityKit's `Activity` is not Sendable; it is only ever created and kept on the main actor, and its
    /// update and end calls are safe to await from there.
    private struct Box: @unchecked Sendable {
        let activity: Activity<PsycheTaskAttributes>
        init(_ activity: Activity<PsycheTaskAttributes>) { self.activity = activity }
        func update(_ content: ActivityContent<TaskActivityContent>) async { await activity.update(content) }
        func end(_ content: ActivityContent<TaskActivityContent>?, dismissalPolicy: ActivityUIDismissalPolicy) async {
            await activity.end(content, dismissalPolicy: dismissalPolicy)
        }
    }
}
#endif

/// Where there is no ActivityKit (macOS test runs): Live Activities are simply off.
@MainActor
final class NoActivityHost: ActivityHost {
    var isEnabled: Bool { false }
    var activeTaskIDs: [String] { [] }
    func start(taskID: String, content: TaskActivityContent) -> Bool { false }
    func update(taskID: String, content: TaskActivityContent) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {}
}
