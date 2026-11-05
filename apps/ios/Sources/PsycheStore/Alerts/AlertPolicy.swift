import Foundation
import PsycheShared

// What the phone says when something needs the owner (docs/design/mobile-companion-2026.md §4), as plain
// values: which notification category an item gets, what the notification says, how loudly. The UI layer
// turns these into `UNNotificationRequest`s; keeping the choice here keeps it testable off the device.

/// The notification categories, one per kind of ask. The raw value is the `UNNotificationCategory` identifier.
public enum AlertCategory: String, CaseIterable, Sendable {
    /// A `write` approval: Approve (authentication required) and Deny (destructive).
    case approvalWrite = "psyche.approval.write"
    /// A presence-gated approval (payments, anything with a `presenceNote`): only "Review…", which opens the
    /// full card. A lock-screen banner always truncates, and these cards must never be truncated.
    case approvalReview = "psyche.approval.review"
    /// A question: "Open".
    case question = "psyche.question"
    /// A finished task: passive, no actions.
    case finished = "psyche.finished"
    /// "Reconnect to answer": replaces an approval notification when the Mac could not be reached.
    case reconnect = "psyche.reconnect"
}

public enum AlertAction: String, Sendable {
    case approve = "psyche.action.approve"
    case deny = "psyche.action.deny"
    case review = "psyche.action.review"
    case open = "psyche.action.open"
}

/// How loudly a notification arrives. Maps onto `UNNotificationInterruptionLevel` (`passive`, `active`).
/// Time-sensitive needs a capability a free Apple ID cannot sign, so nothing here asks for it.
public enum AlertLevel: String, Sendable { case passive, active }

public struct AlertPayload: Equatable, Sendable {
    /// Stable: the approval, question or task id (finished tasks use `done-<id>`), so answering anywhere can
    /// remove the delivered notification.
    public var id: String
    public var title: String
    public var body: String
    public var category: AlertCategory
    public var level: AlertLevel
    /// The thread it belongs to, so the foreground banner skips the thread already on screen.
    public var threadID: String?
    /// A desktop route the router maps (`/chat/<id>`); nil opens Home.
    public var route: String?

    public init(
        id: String, title: String, body: String, category: AlertCategory, level: AlertLevel,
        threadID: String? = nil, route: String? = nil
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.category = category
        self.level = level
        self.threadID = threadID
        self.route = route
    }
}

public enum AlertPolicy {
    /// Presence-gated kinds are those whose approval carries a `presenceNote` (payments, device-only,
    /// credential fills). They never get an Approve button on the lock screen.
    public static func category(for item: NeedsYouItem) -> AlertCategory {
        switch item.kind {
        case .approval: item.approval?.presenceNote == nil ? .approvalWrite : .approvalReview
        case .question, .task: .question
        }
    }

    /// Whether the Dynamic Island may answer this item with its own Deny and Approve buttons: the same rule as
    /// the lock-screen notification's Approve button. Presence-gated approvals and questions never qualify.
    public static func answersInline(_ item: NeedsYouItem) -> Bool {
        item.kind == .approval && category(for: item) == .approvalWrite
    }

    public static func payload(for item: NeedsYouItem) -> AlertPayload {
        let category = category(for: item)
        switch category {
        case .approvalWrite:
            return AlertPayload(
                id: item.id, title: item.title, body: item.source, category: category, level: .active,
                threadID: item.threadID)
        case .approvalReview:
            // Nothing from the card goes on the lock screen: the title may name an amount or a payee.
            let what = item.approval?.kindLabel.lowercased() ?? "request"
            return AlertPayload(
                id: item.id, title: "A \(what) needs your review", body: "Open Psyche to see the details",
                category: category, level: .active, threadID: item.threadID)
        case .question, .finished, .reconnect:
            return AlertPayload(
                id: item.id, title: "Psyche has a question", body: item.title, category: .question, level: .active,
                threadID: item.threadID, route: item.threadID.map { "/chat/\($0)" })
        }
    }

    /// A passive note when a task the owner was watching finishes.
    public static func finished(taskID: String, title: String, failed: Bool) -> AlertPayload {
        AlertPayload(
            id: "done-\(taskID)", title: failed ? "A task failed" : "A task finished", body: title,
            category: .finished, level: .passive, route: "/overview")
    }

    /// Replaces an approval's notification when the Mac cannot be reached. Approvals are never queued.
    public static func reconnect(for id: String) -> AlertPayload {
        AlertPayload(
            id: id, title: "Reconnect to answer", body: "Your Mac isn't reachable right now. Open Psyche when you're back on your network or Tailscale.",
            category: .reconnect, level: .active)
    }

    /// Replaces an approval's notification when the Gateway refused the answer from the lock screen.
    public static func couldNotAnswer(_ id: String, message: String) -> AlertPayload {
        AlertPayload(id: id, title: "Couldn't answer", body: message, category: .reconnect, level: .active)
    }

    /// The action buttons a category offers, in order. Approve needs authentication; Deny is destructive;
    /// Review and Open bring the app forward.
    public static func actions(for category: AlertCategory) -> [AlertAction] {
        switch category {
        case .approvalWrite: [.approve, .deny]
        case .approvalReview: [.review]
        case .question, .reconnect: [.open]
        case .finished: []
        }
    }

    /// Whether a delivered notification of this category stands for something still waiting on the owner.
    public static func isWaitingOnOwner(_ category: AlertCategory) -> Bool {
        switch category {
        case .approvalWrite, .approvalReview, .question, .reconnect: true
        case .finished: false
        }
    }
}
