import Foundation
import PsycheClient

/// How the alert engine gets a live Gateway connection when the app was woken for a moment (a notification
/// button, a background check) instead of being in front.
protocol AlertConnection: Sendable {
    /// Connects if needed and waits up to `timeout` for the connection to be live.
    func ensureLive(timeout: Duration) async -> Bool
    /// Lets go of the connection. `appActive` is whether the app is in front, in which case it stays up.
    func release(appActive: Bool) async
}

/// Fixtures have no Mac to reach: always live.
struct FixtureAlertConnection: AlertConnection {
    func ensureLive(timeout: Duration) async -> Bool { true }
    func release(appActive: Bool) async {}
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
}
