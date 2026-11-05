import Foundation
import PsycheStore
import UserNotifications

/// Receives notification taps and buttons, and decides how a notification shows while the app is open.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    private let center: AlertCenter

    init(center: AlertCenter) {
        self.center = center
    }

    private static func incoming(_ response: UNNotificationResponse) -> IncomingNotification {
        let request = response.notification.request
        let info = request.content.userInfo
        let action = response.actionIdentifier == UNNotificationDefaultActionIdentifier ? "" : response.actionIdentifier
        return IncomingNotification(
            actionID: action,
            id: (info[AlertUserInfo.id] as? String) ?? request.identifier,
            category: AlertCategory(rawValue: request.content.categoryIdentifier),
            threadID: info[AlertUserInfo.thread] as? String,
            route: info[AlertUserInfo.route] as? String)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let thread = notification.request.content.userInfo[AlertUserInfo.thread] as? String
        let banner = await self.center.shouldBanner(threadID: thread)
        return banner ? [.banner, .list, .sound] : [.list]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        let incoming = Self.incoming(response)
        await self.center.handle(incoming)
    }
}
