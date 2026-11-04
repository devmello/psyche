import Foundation
import Observation

/// What the UI reads about the connection (docs/design/ios-app-2026.md §3.1).
/// Fixture-driven until I2 wires the real `GatewayConnection` behind `SessionDriver`.
@MainActor @Observable
public final class Session {
    public private(set) var state: ConnectionState
    public private(set) var lastSyncedAt: Date?
    /// Set when a scanned code was not a Psyche pairing code. Cleared by the next scan.
    public private(set) var pairingError: String?

    private let driver: any SessionDriver
    private var pairing: Task<Void, Never>?

    public init(driver: any SessionDriver = FixtureSessionDriver()) {
        self.driver = driver
        self.state = driver.initialState
        self.lastSyncedAt = driver.initialSyncedAt
    }

    /// A QR code was scanned. Only `psyche-pair:` links are accepted; I2 parses and verifies them.
    public func beginPairing(code: String) {
        guard code.hasPrefix("psyche-pair:") else {
            pairingError = "That isn't a Psyche pairing code. Open Settings → Devices → Add phone on your Mac."
            return
        }
        pairingError = nil
        pairing?.cancel()
        let stream = driver.pair(code: code)
        pairing = Task { [weak self] in
            for await next in stream {
                guard let self, !Task.isCancelled else { return }
                self.state = next
                if next == .live { self.lastSyncedAt = .now }
            }
        }
    }

    public func cancelPairing() {
        pairing?.cancel()
        pairing = nil
        pairingError = nil
        state = .unpaired
    }

    /// This phone was removed ("Remove this phone" in Settings, after `devices.revoke`). Keys, cache and
    /// outbox are wiped by the real driver (I2); the UI goes back to the pairing screens.
    public func markRevoked() {
        pairing?.cancel()
        pairing = nil
        pairingError = nil
        lastSyncedAt = nil
        state = .revoked
    }

    /// Dismisses the pairing error banner.
    public func clearPairingError() { pairingError = nil }
}
