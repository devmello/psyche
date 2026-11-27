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
    /// True for a session driven by fixtures (the demo): Settings offers "Exit demo".
    public let isDemo: Bool
    /// Set by "Exit demo"; the app swaps the live client and the scanner back in.
    public private(set) var exitDemoRequested = false

    /// A pairing the person confirmed that has not reached the Mac yet (nothing proven, nothing stored). While it is
    /// set and the connection is still trying or cannot reach the Mac, the pairing screens stay up with a way out.
    public struct PairingAttempt: Equatable, Sendable {
        public var host: String
        public var hostName: String
    }
    public private(set) var pairingAttempt: PairingAttempt?

    private let driver: any SessionDriver
    private var pairing: Task<Void, Never>?
    private var updates: Task<Void, Never>?
    private var scannedCode: String?
    /// Scene changes reach the driver one at a time, in order, off the main actor: a quick background-then-active
    /// can never be applied the other way round.
    private let activeChanges: AsyncStream<Bool>.Continuation

    public init(driver: any SessionDriver = FixtureSessionDriver()) {
        self.driver = driver
        isDemo = driver is FixtureSessionDriver
        self.state = driver.initialState
        self.lastSyncedAt = driver.initialSyncedAt
        let (changes, continuation) = AsyncStream<Bool>.makeStream(bufferingPolicy: .unbounded)
        activeChanges = continuation
        Task.detached(priority: .userInitiated) { [driver] in
            for await active in changes { await driver.setActive(active) }
        }
        let stream = driver.updates
        updates = Task { [weak self] in
            for await update in stream {
                guard let self else { return }
                switch update {
                case .state(let next):
                    self.state = next
                    if next == .live { self.lastSyncedAt = .now }
                    if next != .unpaired { self.pairingPreview = nil }
                    self.settlePairingAttempt(for: next)
                case .pairingFailed(let message):
                    // The client has given the attempt up (and put an earlier pairing back, if there was one).
                    self.pairingError = message
                    self.pairingAttempt = nil
                }
            }
        }
    }

    /// The scene became active or went to the background.
    public func setActive(_ active: Bool) {
        activeChanges.yield(active)
    }

    /// "Try it without a Mac" on the pairing screen.
    public func requestFixtureMode() { fixtureModeRequested = true }

    /// "Exit demo" in Settings.
    public func exitDemo() { exitDemoRequested = true }

    /// Run on a live session the app is about to show again after the demo, so its own requests don't fire twice.
    public func clearDemoRequests() {
        fixtureModeRequested = false
        exitDemoRequested = false
    }

    /// A QR code was scanned or a link pasted. Only `psyche-pair:` links are accepted. A real driver
    /// parses it and asks "Connect to <host>?" first; the fixture pairs at once.
    public func beginPairing(code: String) {
        guard code.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("psyche-pair:") else {
            pairingError = String(localized: "That isn't a Psyche pairing code. On your Mac: Settings > Devices > Pair iPhone.", bundle: .module)
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
        if let preview = pairingPreview { pairingAttempt = PairingAttempt(host: preview.host, hostName: preview.hostName) }
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
                self.settlePairingAttempt(for: next)
            }
        }
    }

    /// The attempt ends once the Mac answered (`pending`, `live`) or the connection gave up on it; it stays through
    /// `connecting` and `unreachable`, where the first pairing to an unreachable Mac would otherwise show empty tabs.
    private func settlePairingAttempt(for next: ConnectionState) {
        switch next {
        case .connecting, .unreachable: break
        default: pairingAttempt = nil
        }
    }

    public func cancelPairing() {
        pairing?.cancel()
        pairing = nil
        pairingError = nil
        pairingPreview = nil
        pairingAttempt = nil
        scannedCode = nil
        state = .unpaired
        let driver = driver
        // An earlier working pairing that was never given up carries on: the client says so, and the scanner must not
        // stay up over a phone that is still paired.
        Task { [weak self] in
            let next = await driver.cancelPairing()
            guard let self, self.state == .unpaired, next != .unpaired else { return }
            self.state = next
        }
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

    /// "Try again" on the identity-changed screen: the client dials at once.
    public func retryConnection() {
        let driver = driver
        Task { await driver.retryConnection() }
    }

    /// "Pair again" on the refused screen: the saved Gateway is forgotten (keys, endpoint, outbox and cache are wiped)
    /// and the scanner comes back. A key that could not be deleted from the Keychain is reported on the scanner.
    public func forgetGateway() async {
        pairing?.cancel()
        pairing = nil
        pairingAttempt = nil
        pairingPreview = nil
        scannedCode = nil
        lastSyncedAt = nil
        do { try await driver.forgetGateway() } catch {
            pairingError = String(localized: "This phone was removed, but its key could not be deleted from the Keychain. Restart your phone, then try again.", bundle: .module)
        }
        state = .unpaired
    }

    /// Dismisses the pairing error banner.
    public func clearPairingError() { pairingError = nil }
}
