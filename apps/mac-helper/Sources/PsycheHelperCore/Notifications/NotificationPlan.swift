import CryptoKit
import Foundation
import PsycheProtocol

/// One action of a notification category, in framework-neutral form (the System layer turns it
/// into `UNNotificationAction` / `UNTextInputNotificationAction`).
public struct NotificationActionPlan: Sendable, Equatable, Hashable {
    public var id: String
    public var label: String
    public var destructive: Bool
    public var requiresAuth: Bool
    /// Present for the inline text-reply action.
    public var textInput: TextInput?

    public struct TextInput: Sendable, Equatable, Hashable {
        public var placeholder: String

        public init(placeholder: String) { self.placeholder = placeholder }
    }

    public init(id: String, label: String, destructive: Bool = false, requiresAuth: Bool = false, textInput: TextInput? = nil) {
        self.id = id
        self.label = label
        self.destructive = destructive
        self.requiresAuth = requiresAuth
        self.textInput = textInput
    }
}

/// A notification category (`UNNotificationCategory`): an identifier plus its ordered actions.
public struct NotificationCategoryPlan: Sendable, Equatable, Hashable {
    public var identifier: String
    public var actions: [NotificationActionPlan]

    public init(identifier: String, actions: [NotificationActionPlan]) {
        self.identifier = identifier
        self.actions = actions
    }
}

/// Everything the System layer needs to post one OS notification, computed purely from a
/// `notify.show` request, the clock and the calendar.
public struct NotificationPlan: Sendable, Equatable {
    public var id: String
    public var kind: NotificationKind
    public var title: String
    public var subtitle: String?
    public var body: String
    public var threadId: String?
    public var category: NotificationCategoryPlan
    /// Level after the quiet-hours downgrade.
    public var interruption: NotifyInterruptionLevel
    /// Level before quiet hours (explicit request or the kind's default).
    public var requestedInterruption: NotifyInterruptionLevel
    public var quietHoursApplied: Bool
    public var playSound: Bool
    public var approvalId: String?
    public var requireBiometry: Bool

    /// The ids-only metadata stored in the OS notification's `userInfo`.
    public var userInfo: NotificationUserInfo {
        NotificationUserInfo(
            notificationId: id, kind: kind.rawValue, approvalId: approvalId, requireBiometry: requireBiometry,
            destructiveActionIds: category.actions.filter(\.destructive).map(\.id)
        )
    }
}

// MARK: - Planning

extension NotificationPlan {
    /// Default reply action id; reserved alongside `default` and `dismiss`.
    public static let replyActionId = "reply"
    static let reservedActionIds: Set<String> = [NotificationResponse.defaultActionId, NotificationResponse.dismissActionId]

    /// Builds the plan, validating ids and limits. Throws `invalid_params` on bad input.
    public static func make(_ p: NotifyShowParams, now: Date = Date(), calendar: Calendar = .current) throws -> NotificationPlan {
        guard NotificationLimits.isValidId(p.id) else {
            throw CapabilityError.invalidParams("id must match \(NotificationLimits.idPattern)", field: "id")
        }
        if let t = p.threadId, !NotificationLimits.isValidId(t) {
            throw CapabilityError.invalidParams("threadId must match \(NotificationLimits.idPattern)", field: "threadId")
        }
        if let a = p.approvalId, !NotificationLimits.isValidId(a) {
            throw CapabilityError.invalidParams("approvalId must match \(NotificationLimits.idPattern)", field: "approvalId")
        }
        let title = p.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { throw CapabilityError.invalidParams("title must not be empty", field: "title") }

        let actions = try actionList(kind: p.kind, buttons: p.actions, reply: p.reply)
        let category = category(for: actions)

        var quiet: QuietHours?
        if let q = p.quietHours {
            guard let parsed = QuietHours(start: q.start, end: q.end) else {
                throw CapabilityError.invalidParams("quietHours.start and quietHours.end must be HH:mm", field: "quietHours")
            }
            quiet = parsed
        }

        let requested = p.interruption ?? defaultInterruption(for: p.kind)
        let inQuietHours = quiet?.contains(now, calendar: calendar) ?? false
        let level: NotifyInterruptionLevel = inQuietHours ? .passive : requested
        let sound = inQuietHours ? false : (p.sound ?? (requested != .passive))

        let subtitle = p.subtitle.map { NotificationLimits.truncate($0, max: NotificationLimits.maxSubtitle) }
        return NotificationPlan(
            id: p.id, kind: p.kind,
            title: NotificationLimits.truncate(title, max: NotificationLimits.maxTitle),
            subtitle: subtitle?.isEmpty == true ? nil : subtitle,
            body: NotificationLimits.truncate(p.body, max: NotificationLimits.maxBody),
            threadId: p.threadId, category: category,
            interruption: level, requestedInterruption: requested, quietHoursApplied: inQuietHours,
            playSound: sound, approvalId: p.approvalId, requireBiometry: p.requireBiometry ?? false
        )
    }

    /// Approvals and input requests break through (time-sensitive); proactive posts and briefings
    /// never interrupt (passive); everything else is a normal banner.
    public static func defaultInterruption(for kind: NotificationKind) -> NotifyInterruptionLevel {
        switch kind {
        case .approval, .inputNeeded: return .timeSensitive
        case .proactive, .briefing: return .passive
        case .taskDone, .taskFailed, .reminder, .system: return .active
        }
    }

    /// Default buttons per kind (the reply action is added separately).
    public static func defaultButtons(for kind: NotificationKind) -> [NotificationActionPlan] {
        switch kind {
        case .approval:
            return [
                NotificationActionPlan(id: "approve", label: "Approve"),
                NotificationActionPlan(id: "deny", label: "Deny", destructive: true),
            ]
        case .inputNeeded: return []
        case .taskFailed:
            return [NotificationActionPlan(id: "open", label: "Open"), NotificationActionPlan(id: "retry", label: "Retry")]
        case .reminder:
            return [NotificationActionPlan(id: "open", label: "Open"), NotificationActionPlan(id: "snooze", label: "Snooze")]
        case .taskDone, .proactive, .briefing, .system:
            return [NotificationActionPlan(id: "open", label: "Open")]
        }
    }

    public static let defaultReply = NotifyReplyParams(label: "Reply", placeholder: "Type your answer")

    /// The fixed categories registered at startup, keyed by the default action list they carry.
    public static let defaultCategories: [NotificationCategoryPlan] = [
        NotificationCategoryPlan(identifier: "psyche.approval", actions: defaultButtons(for: .approval)),
        NotificationCategoryPlan(identifier: "psyche.input_needed", actions: [replyAction(defaultReply)]),
        NotificationCategoryPlan(identifier: "psyche.task_failed", actions: defaultButtons(for: .taskFailed)),
        NotificationCategoryPlan(identifier: "psyche.reminder", actions: defaultButtons(for: .reminder)),
        NotificationCategoryPlan(identifier: "psyche.open", actions: defaultButtons(for: .system)),
    ]

    static func replyAction(_ r: NotifyReplyParams) -> NotificationActionPlan {
        NotificationActionPlan(
            id: replyActionId, label: NotificationLimits.truncate(r.label, max: NotificationLimits.maxActionLabel),
            textInput: .init(placeholder: NotificationLimits.truncate(r.placeholder ?? "", max: NotificationLimits.maxPlaceholder))
        )
    }

    /// Reply action first (when any), then the buttons (custom, or the kind's defaults).
    public static func actionList(kind: NotificationKind, buttons: [NotifyActionParams]?, reply: NotifyReplyParams?) throws -> [NotificationActionPlan] {
        var list: [NotificationActionPlan] = []
        if let r = reply ?? (kind == .inputNeeded ? defaultReply : nil) {
            guard !r.label.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw CapabilityError.invalidParams("reply.label must not be empty", field: "reply.label")
            }
            list.append(replyAction(r))
        }
        if let buttons {
            for (i, b) in buttons.enumerated() {
                guard NotificationLimits.isValidId(b.id) else {
                    throw CapabilityError.invalidParams("actions[\(i)].id must match \(NotificationLimits.idPattern)", field: "actions")
                }
                guard !reservedActionIds.contains(b.id) else {
                    throw CapabilityError.invalidParams("actions[\(i)].id \(b.id) is reserved", field: "actions")
                }
                guard !b.label.trimmingCharacters(in: .whitespaces).isEmpty else {
                    throw CapabilityError.invalidParams("actions[\(i)].label must not be empty", field: "actions")
                }
                list.append(
                    NotificationActionPlan(
                        id: b.id, label: NotificationLimits.truncate(b.label, max: NotificationLimits.maxActionLabel),
                        destructive: b.destructive ?? false, requiresAuth: b.requiresAuth ?? false
                    )
                )
            }
        } else {
            list.append(contentsOf: defaultButtons(for: kind))
        }
        guard list.count <= NotificationLimits.maxActions else {
            throw CapabilityError.invalidParams("at most \(NotificationLimits.maxActions) actions (including the reply)", field: "actions")
        }
        guard Set(list.map(\.id)).count == list.count else {
            throw CapabilityError.invalidParams("action ids must be unique (\"reply\" is used by the text reply)", field: "actions")
        }
        return list
    }

    /// A default category when the action list matches one exactly, otherwise a deterministic
    /// `psyche.custom.<hash>` id (SHA-256 of the canonical action list, so it is stable across
    /// launches, unlike Swift's seeded `Hasher`).
    public static func category(for actions: [NotificationActionPlan]) -> NotificationCategoryPlan {
        if let known = defaultCategories.first(where: { $0.actions == actions }) { return known }
        return NotificationCategoryPlan(identifier: customCategoryId(for: actions), actions: actions)
    }

    public static func customCategoryId(for actions: [NotificationActionPlan]) -> String {
        let canonical = actions.map { a in
            [a.id, a.label, a.destructive ? "d" : "-", a.requiresAuth ? "a" : "-", a.textInput.map { "t:" + $0.placeholder } ?? "-"]
                .joined(separator: "\u{1F}")
        }.joined(separator: "\u{1E}")
        let digest = SHA256.hash(data: Data(("v1\u{1D}" + canonical).utf8))
        let hex = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
        return "psyche.custom." + hex
    }
}
