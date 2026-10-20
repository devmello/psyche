import Foundation
import PsycheHelperCore

/// Assembles every capability group into one registry (the capability manifest).
public final class HelperRuntime: @unchecked Sendable {
    public let log: HelperLog
    public let computer: ComputerUse
    public let notifications: NotificationCenterBridge
    public let preflight = LivePreflight()
    public let registry: CapabilityRegistry

    public init(log: HelperLog = HelperLog(), environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.log = log
        computer = ComputerUse(environment: environment, log: log)
        let presence = PresenceKey()
        notifications = NotificationCenterBridge(log: log, presence: presence)
        var handlers: [any CapabilityHandler] = []
        handlers += PermissionsCapabilities.make(preflight: preflight)
        handlers += ComputerCapabilities.make(computer)
        handlers += ScreenshotCapabilities.make(computer)
        handlers += AppsCapabilities.make(computer)
        handlers += NotifyCapabilities.make(bridge: notifications)
        handlers += SpeechCapabilities.make(preflight: preflight, log: log)
        handlers += KeychainCapabilities.make()
        handlers += PresenceCapabilities.make(key: presence)
        handlers += ContactsCapabilities.make()
        handlers += MessagesCapabilities.make()
        handlers += VMCapabilities.make(VMManager(backend: VZBackend(), environment: environment, log: log))
        registry = CapabilityRegistry(handlers)
    }

    /// Call on the main thread before the run loop starts, so a notification click that relaunched
    /// the helper reaches the delegate.
    public func start() {
        notifications.start()
    }
}
