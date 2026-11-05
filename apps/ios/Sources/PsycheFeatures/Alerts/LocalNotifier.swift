import Foundation
import PsycheStore
import UserNotifications

/// What the alert engine needs from the notification center, so tests can swap in a fake.
protocol LocalNotifier: Sendable {
    func authorization() async -> NotifierAuthorization
    /// Shows the system prompt. Only ever called from the Settings toggle or when the first approval arrives.
    func requestAuthorization() async -> Bool
    func post(_ payload: AlertPayload) async
    func removeDelivered(ids: [String]) async
    /// Notifications of ours still in Notification Center.
    func delivered() async -> [DeliveredAlert]
}

enum NotifierAuthorization: Sendable { case notDetermined, denied, allowed }

struct DeliveredAlert: Sendable, Equatable {
    var id: String
    var category: AlertCategory?
}

/// A tap on a notification or one of its buttons, reduced to plain values the engine can act on.
struct IncomingNotification: Sendable, Equatable {
    var actionID: String
    var id: String
    var category: AlertCategory?
    var threadID: String?
    var route: String?
}

enum AlertUserInfo {
    static let id = "psycheAlertID"
    static let category = "psycheAlertCategory"
    static let thread = "psycheAlertThread"
    static let route = "psycheAlertRoute"
}

/// The real notification center. Posting is local: the app builds the notification itself from what its live
/// connection (or a background check) just read, so nothing about it goes through Apple.
struct SystemNotifier: LocalNotifier {
    private var center: UNUserNotificationCenter { .current() }

    /// Categories can be registered without permission. Approve and Deny exist only for `write` approvals;
    /// presence-gated kinds get "Review…" alone, and nothing here can answer without the connection being live.
    static func categories() -> Set<UNNotificationCategory> {
        func action(_ a: AlertAction) -> UNNotificationAction {
            switch a {
            case .approve: UNNotificationAction(identifier: a.rawValue, title: "Approve", options: [.authenticationRequired])
            case .deny: UNNotificationAction(identifier: a.rawValue, title: "Deny", options: [.destructive])
            case .review: UNNotificationAction(identifier: a.rawValue, title: "Review…", options: [.foreground])
            case .open: UNNotificationAction(identifier: a.rawValue, title: "Open", options: [.foreground])
            }
        }
        return Set(AlertCategory.allCategories.map { category in
            UNNotificationCategory(
                identifier: category.rawValue, actions: AlertPolicy.actions(for: category).map(action),
                intentIdentifiers: [], options: [])
        })
    }

    func authorization() async -> NotifierAuthorization {
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined: .notDetermined
        case .denied: .denied
        case .authorized, .provisional, .ephemeral: .allowed
        @unknown default: .denied
        }
    }

    func requestAuthorization() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func post(_ payload: AlertPayload) async {
        let content = UNMutableNotificationContent()
        content.title = payload.title
        content.body = payload.body
        content.categoryIdentifier = payload.category.rawValue
        content.threadIdentifier = payload.threadID ?? payload.category.rawValue
        content.interruptionLevel = payload.level == .passive ? .passive : .active
        content.sound = payload.level == .passive ? nil : .default
        var info: [String: String] = [AlertUserInfo.id: payload.id, AlertUserInfo.category: payload.category.rawValue]
        if let thread = payload.threadID { info[AlertUserInfo.thread] = thread }
        if let route = payload.route { info[AlertUserInfo.route] = route }
        content.userInfo = info
        // The identifier is the approval id: posting again replaces it, and answering anywhere removes it.
        try? await center.add(UNNotificationRequest(identifier: payload.id, content: content, trigger: nil))
    }

    func removeDelivered(ids: [String]) async {
        guard !ids.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    func delivered() async -> [DeliveredAlert] {
        await center.deliveredNotifications().map {
            DeliveredAlert(
                id: $0.request.identifier,
                category: AlertCategory(rawValue: $0.request.content.categoryIdentifier))
        }
    }
}

extension AlertCategory {
    static var allCategories: [AlertCategory] { allCases }
}
