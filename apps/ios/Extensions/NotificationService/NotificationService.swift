import PsycheShared
import UserNotifications

/// Decrypts end-to-end encrypted pushes (companion doc §3.3). M2: today it passes the content through.
final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        contentHandler(request.content)
    }
}
