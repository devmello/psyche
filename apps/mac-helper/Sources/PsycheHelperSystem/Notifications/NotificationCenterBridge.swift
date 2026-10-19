import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import UserNotifications

/// Live adapter over `UNUserNotificationCenter` (architecture §6 `notify.*`).
///
/// `UNUserNotificationCenter.current()` crashes in an executable that is not inside an app bundle,
/// so the center is only touched when the process has a bundle identifier; otherwise every call
/// fails with `unavailable` / `not_bundled` (e.g. `swift run`, unit tests).
///
/// Call `start()` once at launch, before the run loop starts, so a click that relaunched the
/// helper is delivered to the delegate.
public final class NotificationCenterBridge: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    public let hub: NotificationResponseHub
    private let center: UNUserNotificationCenter?
    private let log: HelperLog
    private let presence: (any PresenceSigning)?
    private let lock = NSLock()
    /// Every category registered so far: `setNotificationCategories` replaces the whole set.
    private var categories: [String: UNNotificationCategory] = [:]

    /// - Parameter bundleIdentifier: injected for tests; nil means "not bundled".
    public init(
        hub: NotificationResponseHub = NotificationResponseHub(), bundleIdentifier: String? = Bundle.main.bundleIdentifier,
        log: HelperLog = HelperLog(), presence: (any PresenceSigning)? = nil
    ) {
        self.hub = hub
        self.log = log
        self.presence = presence
        self.center = bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
        super.init()
    }

    public var isAvailable: Bool { center != nil }

    /// Installs the delegate and registers the default categories.
    public func start() {
        guard let center else {
            log.info("notify: unavailable (not bundled)")
            return
        }
        center.delegate = self
        lock.withLock {
            for c in NotificationPlan.defaultCategories { categories[c.identifier] = Self.makeCategory(c) }
            center.setNotificationCategories(Set(categories.values))
        }
        log.info("notify: delegate installed, categories=\(NotificationPlan.defaultCategories.count)")
    }

    func requireCenter() throws -> UNUserNotificationCenter {
        guard let center else {
            throw CapabilityError.unavailable(
                "not_bundled", "Notifications need Psyche Helper to run from its signed app bundle (com.psyche.helper)."
            )
        }
        return center
    }

    // MARK: Capabilities

    public struct ShowOutcome: Sendable {
        public var interruptionLevel: NotifyInterruptionLevel
        public var authorization: String
    }

    /// Posts `plan`. Fails with `forbidden` when notifications are denied or not yet requested.
    public func show(_ plan: NotificationPlan) async throws -> ShowOutcome {
        let center = try requireCenter()
        let settings = await center.notificationSettings()
        let status = Self.statusName(settings.authorizationStatus)
        switch settings.authorizationStatus {
        case .authorized, .provisional: break
        case .notDetermined:
            throw CapabilityError(
                .forbidden, reason: "permission_not_determined",
                "Notifications have not been requested yet; call notify.request_authorization first.",
                details: ["permission": "notifications"]
            )
        default:
            throw CapabilityError.permissionMissing(.notifications)
        }

        await register(plan.category, on: center)

        // Without the time-sensitive entitlement (or with the user's switch off) the system shows
        // the notification as active anyway; report what actually happens.
        var level = plan.interruption
        if level == .timeSensitive && settings.timeSensitiveSetting != .enabled { level = .active }

        let content = UNMutableNotificationContent()
        content.title = plan.title
        if let s = plan.subtitle { content.subtitle = s }
        content.body = plan.body
        content.categoryIdentifier = plan.category.identifier
        if let t = plan.threadId { content.threadIdentifier = t }
        content.interruptionLevel = Self.unLevel(level)
        content.sound = plan.playSound ? .default : nil
        content.userInfo = plan.userInfo.dictionary

        let request = UNNotificationRequest(identifier: plan.id, content: content, trigger: nil)
        do {
            try await center.add(request)
        } catch {
            log.error("notify: add failed (\((error as NSError).code))")
            throw CapabilityError.unavailable("delivery_failed", "The system refused the notification.", retryable: true)
        }
        log.info("notify: shown kind=\(plan.kind.rawValue) level=\(level.rawValue) quiet=\(plan.quietHoursApplied)")
        return ShowOutcome(interruptionLevel: level, authorization: status)
    }

    public func withdraw(id: String) throws {
        let center = try requireCenter()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    public func authorizationStatus() async throws -> JSONValue {
        let center = try requireCenter()
        return Self.settingsJSON(await center.notificationSettings())
    }

    public func requestAuthorization(provisional: Bool) async throws -> JSONValue {
        let center = try requireCenter()
        var options: UNAuthorizationOptions = [.alert, .sound, .badge]
        if provisional { options.insert(.provisional) }
        let granted: Bool
        do {
            granted = try await center.requestAuthorization(options: options)
        } catch {
            log.error("notify: requestAuthorization failed (\((error as NSError).code))")
            throw CapabilityError.unavailable("authorization_failed", "The system could not request notification authorization.")
        }
        var result = Self.settingsJSON(await center.notificationSettings()).objectValue ?? [:]
        result["granted"] = .bool(granted)
        log.info("notify: authorization requested provisional=\(provisional) granted=\(granted)")
        return .object(result)
    }

    // MARK: Categories

    private func register(_ plan: NotificationCategoryPlan, on center: UNUserNotificationCenter) async {
        let changed: Bool = lock.withLock {
            guard categories[plan.identifier] == nil else { return false }
            categories[plan.identifier] = Self.makeCategory(plan)
            center.setNotificationCategories(Set(categories.values))
            return true
        }
        // Reading the set back makes sure the registration landed before the request is added.
        if changed { _ = await center.notificationCategories() }
    }

    static func makeCategory(_ plan: NotificationCategoryPlan) -> UNNotificationCategory {
        let actions: [UNNotificationAction] = plan.actions.map { a in
            var options: UNNotificationActionOptions = []
            if a.destructive { options.insert(.destructive) }
            if a.requiresAuth { options.insert(.authenticationRequired) }
            if let t = a.textInput {
                return UNTextInputNotificationAction(
                    identifier: a.id, title: a.label, options: options, textInputButtonTitle: a.label, textInputPlaceholder: t.placeholder
                )
            }
            return UNNotificationAction(identifier: a.id, title: a.label, options: options)
        }
        // customDismissAction so a dismissal reaches the delegate (actionId "dismiss").
        return UNNotificationCategory(identifier: plan.identifier, actions: actions, intentIdentifiers: [], options: [.customDismissAction])
    }

    // MARK: Delegate

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // The helper is an agent app and is often "frontmost" from the system's point of view;
        // show the banner anyway. Passive notifications go to the list only.
        if notification.request.content.interruptionLevel == .passive {
            completionHandler([.list])
        } else {
            completionHandler([.banner, .list, .sound])
        }
    }

    public func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let done = CompletionBox(completionHandler)
        guard let info = NotificationUserInfo(response.notification.request.content.userInfo) else {
            done.call()
            return
        }
        let actionId = NotificationResponse.actionId(
            system: response.actionIdentifier,
            systemDefault: UNNotificationDefaultActionIdentifier,
            systemDismiss: UNNotificationDismissActionIdentifier
        )
        let replyText = (response as? UNTextInputNotificationResponse)?.userText
        let base = NotificationResponse(notificationId: info.notificationId, actionId: actionId, replyText: replyText, approvalId: info.approvalId)
        guard info.needsAuthentication(actionId: actionId) else {
            forward(base)
            done.call()
            return
        }
        let reason = Self.authReason(kind: info.kind)
        let presence = self.presence
        _Concurrency.Task { [weak self] in
            let answer = await Self.answer(base, challenge: info.presenceChallenge, presence: presence, reason: reason)
            self?.forward(answer)
            done.call()
        }
    }

    /// Authenticates an answer. With a presence challenge, Touch ID for the presence key's access
    /// control and the signature happen in one step (`authenticated` then means "signed"); without
    /// a usable key it falls back to device-owner authentication and reports `presenceError`, which
    /// the Gateway treats as no presence (issue #84).
    static func answer(
        _ base: NotificationResponse, challenge: String?, presence: (any PresenceSigning)?, reason: String,
        authenticate: @Sendable (String) async -> String? = { await NotificationCenterBridge.authenticate(reason: $0) }
    ) async -> NotificationResponse {
        var answer = base
        if let challenge, let presence {
            do {
                answer.presence = try await presence.sign(challenge: challenge, reason: reason)
                answer.authenticated = true
                return answer
            } catch let e as CapabilityError where e.code == .cancelled || e.code == .forbidden {
                // The owner cancelled or failed Touch ID: no answer is authenticated.
                answer.authenticated = false
                answer.authError = e.reason
                return answer
            } catch let e as CapabilityError {
                answer.presenceError = e.reason
            } catch {
                answer.presenceError = "presence_failed"
            }
        } else if challenge != nil {
            answer.presenceError = "presence_unavailable"
        }
        let authError = await authenticate(reason)
        answer.authenticated = authError == nil
        answer.authError = authError
        return answer
    }

    private func forward(_ response: NotificationResponse) {
        hub.publish(response)
        log.info(
            "notify: response action=\(Self.logActionClass(response.actionId)) reply=\(response.replyText != nil) authenticated=\(response.authenticated) presence=\(response.presence != nil)"
        )
    }

    // MARK: LocalAuthentication

    /// Runs device-owner authentication (Touch ID, Apple Watch or the login password). Returns nil
    /// on success or a machine reason.
    static func authenticate(reason: String) async -> String? {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return authErrorReason(error)
        }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? nil : "authentication_failed"
        } catch {
            return authErrorReason(error)
        }
    }

    static func authErrorReason(_ error: (any Error)?) -> String {
        guard let la = error as? LAError else { return "authentication_unavailable" }
        switch la.code {
        case .userCancel: return "user_cancelled"
        case .appCancel, .systemCancel: return "system_cancelled"
        case .authenticationFailed: return "authentication_failed"
        case .passcodeNotSet: return "passcode_not_set"
        case .biometryLockout: return "biometry_lockout"
        case .notInteractive: return "not_interactive"
        case .userFallback: return "user_fallback"
        default: return "authentication_unavailable"
        }
    }

    /// Shown in the Touch ID sheet; generic so it never echoes notification content.
    static func authReason(kind: String) -> String {
        switch kind {
        case "approval": return "confirm your answer to a Psyche approval"
        case "input_needed": return "send your reply to Psyche"
        default: return "confirm this Psyche action"
        }
    }

    /// Content-free log label for an action id.
    static func logActionClass(_ id: String) -> String {
        switch id {
        case NotificationResponse.defaultActionId, NotificationResponse.dismissActionId, NotificationPlan.replyActionId: return id
        default: return "custom"
        }
    }

    // MARK: Mapping

    static func unLevel(_ level: NotifyInterruptionLevel) -> UNNotificationInterruptionLevel {
        switch level {
        case .passive: return .passive
        case .active: return .active
        case .timeSensitive: return .timeSensitive
        }
    }

    static func statusName(_ status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .authorized: return "authorized"
        case .provisional: return "provisional"
        // `.ephemeral` is App Clip only (unavailable on macOS).
        @unknown default: return "unknown"
        }
    }

    static func settingName(_ setting: UNNotificationSetting) -> String {
        switch setting {
        case .notSupported: return "notSupported"
        case .disabled: return "disabled"
        case .enabled: return "enabled"
        @unknown default: return "unknown"
        }
    }

    static func settingsJSON(_ s: UNNotificationSettings) -> JSONValue {
        [
            "status": .string(statusName(s.authorizationStatus)),
            "alert": .string(settingName(s.alertSetting)),
            "sound": .string(settingName(s.soundSetting)),
            "badge": .string(settingName(s.badgeSetting)),
            "timeSensitive": .string(settingName(s.timeSensitiveSetting)),
            "notificationCenter": .string(settingName(s.notificationCenterSetting)),
        ]
    }
}

/// Lets the delegate's completion handler cross into the authentication task exactly once.
private final class CompletionBox: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (() -> Void)?

    init(_ handler: @escaping () -> Void) { self.handler = handler }

    func call() {
        let h: (() -> Void)? = lock.withLock {
            defer { handler = nil }
            return handler
        }
        h?()
    }
}
