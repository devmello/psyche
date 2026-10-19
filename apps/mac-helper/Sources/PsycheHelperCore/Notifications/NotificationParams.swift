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
    /// Hex SHA-256 from the Gateway (`presenceChallenge(approvalId, bindingHash, answerToken)`);
    /// the helper signs it with its Secure Enclave key after Touch ID (issue #84).
    public var presenceChallenge: String?

    public init(
        id: String, kind: NotificationKind, title: String, body: String, subtitle: String? = nil,
        actions: [NotifyActionParams]? = nil, reply: NotifyReplyParams? = nil, threadId: String? = nil,
        route: String? = nil, interruption: NotifyInterruptionLevel? = nil, approvalId: String? = nil,
        requireBiometry: Bool? = nil, quietHours: NotifyQuietHoursParams? = nil, sound: Bool? = nil,
        presenceChallenge: String? = nil
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
        self.presenceChallenge = presenceChallenge
    }
}

extension NotifyShowParams {
    private enum CodingKeys: String, CodingKey {
        case id, kind, title, body, subtitle, actions, reply, threadId, route, interruption, approvalId, requireBiometry,
             quietHours, sound, presenceChallenge
        // S15's `NotifyShowParams` (packages/notifications/src/surfaces.ts) names.
        case category, interruptionLevel
    }

    /// S15 action shape: `{id, label, destructive, authenticationRequired, textInput}`.
    private struct WireAction: Decodable {
        var id: String
        var label: String
        var destructive: Bool?
        var requiresAuth: Bool?
        var authenticationRequired: Bool?
        var textInput: Bool?
    }

    /// Accepts both this helper's names and S15's (`category` for `kind`, `interruptionLevel`
    /// for `interruption`, `authenticationRequired` for `requiresAuth`, a `textInput` action for
    /// `reply`). `null` optionals decode as absent.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        guard let k = try c.decodeIfPresent(NotificationKind.self, forKey: .kind)
            ?? c.decodeIfPresent(NotificationKind.self, forKey: .category)
        else { throw DecodingError.keyNotFound(CodingKeys.kind, .init(codingPath: c.codingPath, debugDescription: "kind or category")) }
        kind = k
        title = try c.decode(String.self, forKey: .title)
        body = try c.decode(String.self, forKey: .body)
        subtitle = try c.decodeIfPresent(String.self, forKey: .subtitle)
        reply = try c.decodeIfPresent(NotifyReplyParams.self, forKey: .reply)
        if let wire = try c.decodeIfPresent([WireAction].self, forKey: .actions) {
            var buttons: [NotifyActionParams] = []
            for a in wire {
                if a.textInput == true {
                    reply = reply ?? NotifyReplyParams(label: a.label)
                } else {
                    buttons.append(NotifyActionParams(id: a.id, label: a.label, destructive: a.destructive,
                                                      requiresAuth: a.requiresAuth ?? a.authenticationRequired))
                }
            }
            // An empty list from S15 means "use the kind's defaults".
            actions = buttons.isEmpty ? nil : buttons
        } else {
            actions = nil
        }
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
        route = try c.decodeIfPresent(String.self, forKey: .route)
        interruption = try c.decodeIfPresent(NotifyInterruptionLevel.self, forKey: .interruption)
            ?? c.decodeIfPresent(NotifyInterruptionLevel.self, forKey: .interruptionLevel)
        approvalId = try c.decodeIfPresent(String.self, forKey: .approvalId)
        requireBiometry = try c.decodeIfPresent(Bool.self, forKey: .requireBiometry)
        quietHours = try c.decodeIfPresent(NotifyQuietHoursParams.self, forKey: .quietHours)
        sound = try c.decodeIfPresent(Bool.self, forKey: .sound)
        presenceChallenge = try c.decodeIfPresent(String.self, forKey: .presenceChallenge)
        if let pc = presenceChallenge, !PresenceMessage.isValidChallenge(pc) {
            throw DecodingError.dataCorruptedError(forKey: .presenceChallenge, in: c, debugDescription: "presenceChallenge must be 64 hex characters")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(title, forKey: .title)
        try c.encode(body, forKey: .body)
        try c.encodeIfPresent(subtitle, forKey: .subtitle)
        try c.encodeIfPresent(actions, forKey: .actions)
        try c.encodeIfPresent(reply, forKey: .reply)
        try c.encodeIfPresent(threadId, forKey: .threadId)
        try c.encodeIfPresent(route, forKey: .route)
        try c.encodeIfPresent(interruption, forKey: .interruption)
        try c.encodeIfPresent(approvalId, forKey: .approvalId)
        try c.encodeIfPresent(requireBiometry, forKey: .requireBiometry)
        try c.encodeIfPresent(quietHours, forKey: .quietHours)
        try c.encodeIfPresent(sound, forKey: .sound)
        try c.encodeIfPresent(presenceChallenge, forKey: .presenceChallenge)
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
