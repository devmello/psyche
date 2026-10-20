import Foundation
import PsycheProtocol

/// The ids-only metadata carried in an OS notification's `userInfo` (never title or body text), so
/// a response can be mapped even after the helper was relaunched by the click.
public struct NotificationUserInfo: Sendable, Equatable {
    public var notificationId: String
    public var kind: String
    public var approvalId: String?
    public var requireBiometry: Bool
    public var destructiveActionIds: [String]
    /// What the presence key signs after Touch ID (not a secret: the answer token stays in the Gateway).
    public var presenceChallenge: String?

    public init(
        notificationId: String, kind: String, approvalId: String?, requireBiometry: Bool, destructiveActionIds: [String],
        presenceChallenge: String? = nil
    ) {
        self.notificationId = notificationId
        self.kind = kind
        self.approvalId = approvalId
        self.requireBiometry = requireBiometry
        self.destructiveActionIds = destructiveActionIds
        self.presenceChallenge = presenceChallenge
    }

    enum Key {
        static let notificationId = "psyche.notificationId"
        static let kind = "psyche.kind"
        static let approvalId = "psyche.approvalId"
        static let requireBiometry = "psyche.requireBiometry"
        static let destructive = "psyche.destructiveActionIds"
        static let presenceChallenge = "psyche.presenceChallenge"
    }

    /// Property-list form for `UNMutableNotificationContent.userInfo`.
    public var dictionary: [String: Any] {
        var d: [String: Any] = [
            Key.notificationId: notificationId,
            Key.kind: kind,
            Key.requireBiometry: requireBiometry,
            Key.destructive: destructiveActionIds,
        ]
        if let approvalId { d[Key.approvalId] = approvalId }
        if let presenceChallenge { d[Key.presenceChallenge] = presenceChallenge }
        return d
    }

    /// Reads back a `userInfo` dictionary. Returns nil when it is not one of Psyche's.
    public init?(_ d: [AnyHashable: Any]) {
        guard let id = d[Key.notificationId] as? String, NotificationLimits.isValidId(id) else { return nil }
        self.notificationId = id
        self.kind = d[Key.kind] as? String ?? "system"
        self.approvalId = d[Key.approvalId] as? String
        self.requireBiometry = d[Key.requireBiometry] as? Bool ?? false
        self.destructiveActionIds = d[Key.destructive] as? [String] ?? []
        self.presenceChallenge = (d[Key.presenceChallenge] as? String).flatMap { PresenceMessage.isValidChallenge($0) ? $0 : nil }
    }

    /// Whether answering with `actionId` must pass device-owner authentication first: only when the
    /// request asked for it, and never for a dismissal, a plain tap on the banner (it only opens
    /// the app, so it decides nothing) or a destructive action (deny is always allowed).
    public func needsAuthentication(actionId: String) -> Bool {
        guard requireBiometry else { return false }
        if actionId == NotificationResponse.dismissActionId || actionId == NotificationResponse.defaultActionId { return false }
        return !destructiveActionIds.contains(actionId)
    }
}

/// A user's answer to an OS notification, forwarded to the Gateway as a `notify.response` event.
public struct NotificationResponse: Sendable, Equatable {
    public static let defaultActionId = "default"
    public static let dismissActionId = "dismiss"

    public var notificationId: String
    /// `default` (banner tapped), `dismiss`, or a custom action id.
    public var actionId: String
    public var replyText: String?
    public var approvalId: String?
    /// True only when device-owner authentication ran and succeeded for this answer.
    public var authenticated: Bool
    /// Machine reason when authentication was required and failed (`user_cancelled`, …).
    public var authError: String?
    /// The Secure Enclave assertion over `PresenceMessage.bytes(challenge)` (issue #84).
    public var presence: PresenceSignature?
    /// Why no assertion was made although one was asked for (e.g. `missing_entitlement`).
    public var presenceError: String?

    public init(
        notificationId: String, actionId: String, replyText: String? = nil, approvalId: String? = nil,
        authenticated: Bool = false, authError: String? = nil
    ) {
        self.notificationId = notificationId
        self.actionId = actionId
        self.replyText = replyText
        self.approvalId = approvalId
        self.authenticated = authenticated
        self.authError = authError
    }

    /// Maps the system's default/dismiss identifiers onto Psyche's vocabulary.
    public static func actionId(system: String, systemDefault: String, systemDismiss: String) -> String {
        if system == systemDefault { return defaultActionId }
        if system == systemDismiss { return dismissActionId }
        return system
    }

    /// Node event payload (`ctx.emit` on `notify.subscribe`).
    public var payload: JSONValue {
        var o: [String: JSONValue] = [
            "type": "notify.response",
            "notificationId": .string(notificationId),
            "actionId": .string(actionId),
            "authenticated": .bool(authenticated),
        ]
        if let replyText {
            o["replyText"] = .string(replyText)
            o["text"] = .string(replyText)  // S15's Notifier reads `text` (docs/status/s15.md)
        }
        if let approvalId { o["approvalId"] = .string(approvalId) }
        if let authError { o["authError"] = .string(authError) }
        if let presence { o["presence"] = ["signature": .string(presence.signature), "keyId": .string(presence.keyId)] }
        if let presenceError { o["presenceError"] = .string(presenceError) }
        return .object(o)
    }
}
