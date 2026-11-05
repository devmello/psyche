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
    /// `staleDate`: when iOS should mark the activity "out of date" if nothing updated it first.
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async
    /// Calls `handler` when the system ends or dismisses an activity on its own (the owner swiped it away).
    func observeChanges(_ handler: @escaping @MainActor () -> Void)
    /// Ends the activity showing `final` for `dismissAfter` seconds (0: remove it at once).
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async
}

extension ActivityHost {
    func observeChanges(_ handler: @escaping @MainActor () -> Void) {}
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
    /// Read from ActivityKit, not this host's own list: the system's record is the same for every part of the
    /// app and survives a relaunch.
    var activeTaskIDs: [String] {
        Activity<PsycheTaskAttributes>.activities.filter { $0.activityState == .active }.map(\.attributes.taskID)
    }

    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool {
        guard isEnabled, activities[taskID] == nil else { return activities[taskID] != nil }
        do {
            // pushType nil: updates come from the app itself over its live connection (no APNs without a
            // paid developer account), so there is no push token to register with the Gateway.
            let activity = try Activity.request(
                attributes: PsycheTaskAttributes(taskID: taskID),
                content: ActivityContent(state: content, staleDate: staleDate), pushType: nil)
            watchForEnd(activity)
            activities[taskID] = activity
            return true
        } catch {
            return false
        }
    }

    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {
        guard let activity = activities[taskID] else { return }
        await Box(activity).update(ActivityContent(state: content, staleDate: staleDate))
    }

    private var changeHandler: (@MainActor () -> Void)?

    func observeChanges(_ handler: @escaping @MainActor () -> Void) {
        changeHandler = handler
        for activity in activities.values { watchForEnd(activity) }
    }

    private var watched: Set<String> = []

    /// One cheap async sequence per activity: it wakes only when the system changes the activity's state.
    private func watchForEnd(_ activity: Activity<PsycheTaskAttributes>) {
        guard changeHandler != nil, watched.insert(activity.id).inserted else { return }
        let box = Box(activity)
        Task { @MainActor [weak self] in
            for await state in box.activity.activityStateUpdates where state == .dismissed || state == .ended {
                if self?.activities[box.activity.attributes.taskID]?.id == box.activity.id {
                    self?.activities[box.activity.attributes.taskID] = nil
                }
                self?.changeHandler?()
                return
            }
        }
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
    func start(taskID: String, content: TaskActivityContent, staleDate: Date?) -> Bool { false }
    func update(taskID: String, content: TaskActivityContent, staleDate: Date?) async {}
    func end(taskID: String, final: TaskActivityContent?, dismissAfter: TimeInterval) async {}
}
