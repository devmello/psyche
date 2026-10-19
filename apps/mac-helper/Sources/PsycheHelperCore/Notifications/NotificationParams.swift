import Foundation
import PsycheProtocol

// Parameters of `notify.show` (architecture §6 `notify.*`, feature O10). The shapes follow
// `packages/protocol/src/schemas/surfaces.ts` (`NotificationKind`, `NotificationAction`) and add
// the OS-delivery knobs the Gateway's Notifier needs on the Mac.

/// One button on an OS notification. `requiresAuth` maps to
/// `UNNotificationActionOptions.authenticationRequired` (the device must be unlocked).
public struct NotifyActionParams: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var destructive: Bool?
    public var requiresAuth: Bool?

    public init(id: String, label: String, destructive: Bool? = nil, requiresAuth: Bool? = nil) {
        self.id = id
        self.label = label
        self.destructive = destructive
        self.requiresAuth = requiresAuth
    }
}

/// Inline text reply (`UNTextInputNotificationAction`).
public struct NotifyReplyParams: Codable, Sendable, Equatable {
    public var label: String
    public var placeholder: String?

    public init(label: String, placeholder: String? = nil) {
        self.label = label
        self.placeholder = placeholder
    }
}

/// `UNNotificationInterruptionLevel` subset Psyche uses. Critical alerts are never used.
public enum NotifyInterruptionLevel: String, Codable, Sendable, CaseIterable {
    case passive
    case active
    case timeSensitive
}

/// Quiet-hours window in the helper's local time zone, `"HH:mm"` 24-hour clock.
public struct NotifyQuietHoursParams: Codable, Sendable, Equatable {
    public var start: String
    public var end: String

    public init(start: String, end: String) {
        self.start = start
        self.end = end
    }
}

/// `notify.show` parameters.
public struct NotifyShowParams: Codable, Sendable, Equatable {
    /// The Gateway notification id; also the OS request identifier, so a second `notify.show` with
    /// the same id replaces the first (matches the Notifier's de-duplication).
    public var id: String
    public var kind: NotificationKind
    public var title: String
    public var body: String
    public var subtitle: String?
    /// Custom buttons; replaces the kind's default buttons when present.
    public var actions: [NotifyActionParams]?
    /// Inline text reply; `input_needed` gets one by default.
    public var reply: NotifyReplyParams?
    public var threadId: String?
    /// Deep link inside the app. Accepted for shape parity with `Notification.route`; the Gateway
    /// already knows it, so it is not stored in the OS notification.
    public var route: String?
    public var interruption: NotifyInterruptionLevel?
    public var approvalId: String?
    /// Run Touch ID / device-owner authentication before forwarding a non-destructive action.
    public var requireBiometry: Bool?
    public var quietHours: NotifyQuietHoursParams?
    public var sound: Bool?

    public init(
        id: String, kind: NotificationKind, title: String, body: String, subtitle: String? = nil,
        actions: [NotifyActionParams]? = nil, reply: NotifyReplyParams? = nil, threadId: String? = nil,
        route: String? = nil, interruption: NotifyInterruptionLevel? = nil, approvalId: String? = nil,
        requireBiometry: Bool? = nil, quietHours: NotifyQuietHoursParams? = nil, sound: Bool? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.subtitle = subtitle
        self.actions = actions
        self.reply = reply
        self.threadId = threadId
        self.route = route
        self.interruption = interruption
        self.approvalId = approvalId
        self.requireBiometry = requireBiometry
        self.quietHours = quietHours
        self.sound = sound
    }
}

/// `notify.withdraw` parameters.
public struct NotifyWithdrawParams: Codable, Sendable, Equatable {
    public var id: String

    public init(id: String) { self.id = id }
}

/// `notify.request_authorization` parameters.
public struct NotifyRequestAuthorizationParams: Codable, Sendable, Equatable {
    /// Provisional (quiet, no prompt) by default, per security §12; `false` asks explicitly.
    public var provisional: Bool?

    public init(provisional: Bool? = nil) { self.provisional = provisional }
}

/// Limits and identifier rules shared by the planner and the capability schemas.
public enum NotificationLimits {
    public static let maxTitle = 120
    public static let maxSubtitle = 120
    public static let maxBody = 1000
    public static let maxActionLabel = 64
    public static let maxPlaceholder = 120
    /// macOS shows only a few buttons; Psyche caps the whole set (buttons plus reply) at four.
    public static let maxActions = 4
    public static let maxIdLength = 128
    /// JSON Schema form of the id rule.
    public static let idPattern = "^[A-Za-z0-9_.:-]{1,128}$"

    /// `^[A-Za-z0-9_.:-]{1,128}$`, checked without regex machinery.
    public static func isValidId(_ s: String) -> Bool {
        guard !s.isEmpty, s.utf8.count <= maxIdLength else { return false }
        return s.utf8.allSatisfy { b in
            (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)
                || b == 0x5F || b == 0x2E || b == 0x3A || b == 0x2D
        }
    }

    /// Truncates to at most `max` characters, ending with "…" when shortened.
    public static func truncate(_ s: String, max: Int) -> String {
        guard max > 0 else { return "" }
        guard s.count > max else { return s }
        return String(s.prefix(max - 1)) + "…"
    }
}
