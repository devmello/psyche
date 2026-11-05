import Foundation
import PsycheClient

/// How the alert engine gets a live Gateway connection when the app was woken for a moment (a notification
/// button, a background check) instead of being in front.
protocol AlertConnection: Sendable {
    /// Connects if needed and waits up to `timeout` for the connection to be live.
    func ensureLive(timeout: Duration) async -> Bool
    /// Lets go of the connection. `appActive` is whether the app is in front, in which case it stays up.
    func release(appActive: Bool) async
    /// "Stay connected while a task runs": hold the connection open (and reconnect) while the app is in the background.
    func setKeepConnected(_ keep: Bool) async
    /// Whether the connection is live, now and on every change. Event-driven: nothing is polled.
    func liveStates() -> AsyncStream<Bool>
}

/// Fixtures have no Mac to reach: always live.
struct FixtureAlertConnection: AlertConnection {
    func ensureLive(timeout: Duration) async -> Bool { true }
    func release(appActive: Bool) async {}
    func setKeepConnected(_ keep: Bool) async {}
    func liveStates() -> AsyncStream<Bool> { AsyncStream { $0.yield(true) } }
}

struct GatewayAlertConnection: AlertConnection {
    let client: GatewayClient

    func ensureLive(timeout: Duration) async -> Bool {
        await client.setActive(true)
        if case .live = await client.currentState { return true }
        let states = client.states()
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await state in states {
                    if case .live = state { return true }
                    if state.needsPairing { return false }
                }
                return false
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    func release(appActive: Bool) async {
        // Not active: the client closes the socket a few seconds later, as it does after backgrounding.
        await client.setActive(appActive)
    }

    func setKeepConnected(_ keep: Bool) async {
        await client.setKeepConnected(keep)
    }

    func liveStates() -> AsyncStream<Bool> {
        let states = client.states()
        return AsyncStream { continuation in
            let task = Task {
                for await state in states {
                    if case .live = state { continuation.yield(true) } else { continuation.yield(false) }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
