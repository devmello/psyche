import Foundation
import PsycheShared
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
#endif

/// The Live Activities for chat replies that run long: at most one per chat. A protocol so the engine can be
/// tested without ActivityKit. (Task activities have their own host, `ActivityHost`; the two never share a key.)
@MainActor
protocol ChatTurnActivityHost: AnyObject {
    /// `ActivityAuthorizationInfo().areActivitiesEnabled`.
    var isEnabled: Bool { get }
    /// Chats with a live activity, including one iOS has marked stale (still on screen, still ours to update).
    var activeThreadIDs: [String] { get }
    func start(threadID: String, content: ChatTurnContent, staleDate: Date?) -> Bool
    func update(threadID: String, content: ChatTurnContent, staleDate: Date?) async
    /// Ends the activity showing `final` for `dismissAfter` seconds (0: remove it at once).
    func end(threadID: String, final: ChatTurnContent?, dismissAfter: TimeInterval) async
    /// Calls `handler` when the system ends or dismisses an activity on its own.
    func observeChanges(_ handler: @escaping @MainActor () -> Void)
}

extension ChatTurnActivityHost {
    func observeChanges(_ handler: @escaping @MainActor () -> Void) {}
}

#if canImport(ActivityKit) && os(iOS)
@MainActor
final class SystemChatTurnActivityHost: ChatTurnActivityHost {
    private var activities: [String: Activity<PsycheChatTurnAttributes>] = [:]
    private var changeHandler: (@MainActor () -> Void)?
    private var watched: Set<String> = []

    init() {
        // A relaunch finds the activities the system kept: adopt them, and end any beyond the first for a chat.
        for activity in Activity<PsycheChatTurnAttributes>.activities where Self.isLive(activity.activityState) {
            if activities[activity.attributes.threadID] == nil {
                activities[activity.attributes.threadID] = activity
            } else {
                let duplicate = Box(activity)
                Task { await duplicate.end(nil, dismissalPolicy: .immediate) }
            }
        }
    }

    var isEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    var activeThreadIDs: [String] {
        Activity<PsycheChatTurnAttributes>.activities.filter { Self.isLive($0.activityState) }.map(\.attributes.threadID)
    }

    private static func isLive(_ state: ActivityState) -> Bool { state == .active || state == .stale }

    func start(threadID: String, content: ChatTurnContent, staleDate: Date?) -> Bool {
        // One per chat: an existing one (even stale) is the one to update, never a second.
        guard isEnabled, activities[threadID] == nil else { return activities[threadID] != nil }
        do {
            let activity = try Activity.request(
                attributes: PsycheChatTurnAttributes(threadID: threadID),
                content: ActivityContent(state: content, staleDate: staleDate), pushType: nil)
            activities[threadID] = activity
            watchForEnd(activity)
            return true
        } catch {
            return false
        }
    }

    func update(threadID: String, content: ChatTurnContent, staleDate: Date?) async {
        guard let activity = activities[threadID] else { return }
        await Box(activity).update(ActivityContent(state: content, staleDate: staleDate))
    }

    func end(threadID: String, final: ChatTurnContent?, dismissAfter: TimeInterval) async {
        guard let removed = activities.removeValue(forKey: threadID) else { return }
        let content = final.map { ActivityContent(state: $0, staleDate: nil) }
        await Box(removed).end(content, dismissalPolicy: dismissAfter > 0 ? .after(.now + dismissAfter) : .immediate)
    }

    func observeChanges(_ handler: @escaping @MainActor () -> Void) {
        changeHandler = handler
        for activity in activities.values { watchForEnd(activity) }
    }

    private func watchForEnd(_ activity: Activity<PsycheChatTurnAttributes>) {
        guard changeHandler != nil, watched.insert(activity.id).inserted else { return }
        let box = Box(activity)
        Task { @MainActor [weak self] in
            for await state in box.activity.activityStateUpdates where state == .dismissed || state == .ended {
                if self?.activities[box.activity.attributes.threadID]?.id == box.activity.id {
                    self?.activities[box.activity.attributes.threadID] = nil
                }
                self?.changeHandler?()
                return
            }
        }
    }

    private struct Box: @unchecked Sendable {
        let activity: Activity<PsycheChatTurnAttributes>
        init(_ activity: Activity<PsycheChatTurnAttributes>) { self.activity = activity }
        func update(_ content: ActivityContent<ChatTurnContent>) async { await activity.update(content) }
        func end(_ content: ActivityContent<ChatTurnContent>?, dismissalPolicy: ActivityUIDismissalPolicy) async {
            await activity.end(content, dismissalPolicy: dismissalPolicy)
        }
    }
}
#endif

/// Where there is no ActivityKit (macOS test runs): chat Live Activities are simply off.
@MainActor
final class NoChatTurnActivityHost: ChatTurnActivityHost {
    var isEnabled: Bool { false }
    var activeThreadIDs: [String] { [] }
    func start(threadID: String, content: ChatTurnContent, staleDate: Date?) -> Bool { false }
    func update(threadID: String, content: ChatTurnContent, staleDate: Date?) async {}
    func end(threadID: String, final: ChatTurnContent?, dismissAfter: TimeInterval) async {}
}
