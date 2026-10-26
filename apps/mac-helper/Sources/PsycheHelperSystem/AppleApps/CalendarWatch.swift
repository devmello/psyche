import EventKit
import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Raw calendar-store change notifications. Live: `EKEventStoreChanged`; tests pass a fake.
public protocol CalendarChangeSource: Sendable {
    /// `permission_missing` without full calendar access. Never prompts: the Gateway holds the
    /// watch open in the background, where a TCC prompt would come from nowhere.
    func changes() throws -> AsyncStream<Void>
}

/// `EKEventStoreChanged` on a store of its own. EventKit posts it for any change to the database
/// (this Mac, a sync, another app) without saying what changed.
public final class EventKitChangeSource: CalendarChangeSource, @unchecked Sendable {
    private let store = EKEventStore()

    public init() {}

    public func changes() throws -> AsyncStream<Void> {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
            throw CapabilityError.permissionMissing(.calendars)
        }
        let store = self.store
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let token = NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: nil) { _ in
                continuation.yield()
            }
            let box = UncheckedSendable(token)
            continuation.onTermination = { _ in NotificationCenter.default.removeObserver(box.value) }
        }
    }
}

/// `calendar.watch` (#673 H2): streams `calendar.changed` node events, debounced to 30 s.
public enum CalendarWatchCapabilities {
    public static func make(source: any CalendarChangeSource = EventKitChangeSource(),
                            debounce: Duration = CalendarWatchCore.debounce) -> [any CapabilityHandler] {
        [
            Capability(CapabilitySpec(
                name: "calendar.watch",
                description: "Streams calendar.changed events when the Calendar database changes (this Mac, a sync or another app), at most one per 30 s, until cancelled. Says that something changed, not what: re-read the window you need with calendar.list_events. Needs full Calendar access; never prompts.",
                sideEffect: .read,
                inputSchema: Schema.object([:]),
                streaming: true,
                permissions: [.calendars]
            )) { ctx in
                let changes = try source.changes()
                let sent = await CalendarWatchCore.run(changes: changes, debounce: debounce, emit: ctx.emit)
                try _Concurrency.Task.checkCancellation()
                return CapabilityOutput(["events": .int(sent)])
            },
        ]
    }
}
