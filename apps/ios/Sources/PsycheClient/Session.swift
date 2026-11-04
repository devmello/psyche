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

    /// A scanned link waiting for "Connect to <host>?" to be confirmed. Nothing has been sent yet.
    public private(set) var pairingPreview: PairingPreview?
    /// Set by "Try it without a Mac"; the app swaps in the fixture session and backend.
    public private(set) var fixtureModeRequested = false

    private let driver: any SessionDriver
    private var pairing: Task<Void, Never>?
    private var updates: Task<Void, Never>?
    private var scannedCode: String?

    public init(driver: any SessionDriver = FixtureSessionDriver()) {
        self.driver = driver
        self.state = driver.initialState
        self.lastSyncedAt = driver.initialSyncedAt
        let stream = driver.updates
        updates = Task { [weak self] in
            for await update in stream {
                guard let self else { return }
                switch update {
                case .state(let next):
                    self.state = next
                    if next == .live { self.lastSyncedAt = .now }
                    if next != .unpaired { self.pairingPreview = nil }
                case .pairingFailed(let message):
                    self.pairingError = message
                }
            }
        }
    }

    /// The scene became active or went to the background.
    public func setActive(_ active: Bool) {
        let driver = driver
        Task { await driver.setActive(active) }
    }

    /// "Try it without a Mac" on the pairing screen.
    public func requestFixtureMode() { fixtureModeRequested = true }

    /// A QR code was scanned or a link pasted. Only `psyche-pair:` links are accepted. A real driver
    /// parses it and asks "Connect to <host>?" first; the fixture pairs at once.
    public func beginPairing(code: String) {
        guard code.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("psyche-pair:") else {
            pairingError = "That isn't a Psyche pairing code. Open Settings → Server & remote access → Pair another computer on your Mac."
            return
        }
        pairingError = nil
        do {
            if let preview = try driver.preview(code: code) {
                scannedCode = code
                pairingPreview = preview
                return
            }
        } catch {
            pairingError = error.localizedDescription
            return
        }
        startPairing(code: code)
    }

    /// The person confirmed "Connect to <host>?".
    public func confirmPairing() {
        guard let code = scannedCode else { return }
        scannedCode = nil
        pairingPreview = nil
        startPairing(code: code)
    }

    /// The person declined; the scanner comes back.
    public func declinePairing() {
        scannedCode = nil
        pairingPreview = nil
    }

    private func startPairing(code: String) {
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
        pairingPreview = nil
        scannedCode = nil
        state = .unpaired
        let driver = driver
        Task { await driver.cancelPairing() }
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
