import Foundation
import PsycheShared

/// What the "Connect to <host>?" screen shows before anything is sent to the Gateway.
public struct PairingPreview: Equatable, Sendable {
    public var hostName: String
    public var host: String
    /// "7F3A 91C2 E04B": the first bytes of SHA-256 of the identity key in the link. The Mac shows the same.
    public var fingerprint: String
    public var transport: GatewayEndpoint.Transport

    public init(hostName: String, host: String, fingerprint: String, transport: GatewayEndpoint.Transport) {
        self.hostName = hostName
        self.host = host
        self.fingerprint = fingerprint
        self.transport = transport
    }
}

/// Things a driver reports outside a pairing attempt: the connection moved on its own, or pairing failed.
public enum DriverUpdate: Equatable, Sendable {
    case state(ConnectionState)
    /// Shown on the pairing screen, e.g. "That pairing link expired or was already used. Make a new link on your Mac."
    case pairingFailed(String)
}

/// What drives a `Session`: the fixture for previews and screenshots, `LiveSessionDriver` for the
/// real connection (identity pin, `connect`, resync). The UI only ever sees `Session`.
public protocol SessionDriver: Sendable {
    var initialState: ConnectionState { get }
    /// When the cache was last refreshed, for "Updated 8:12 · cached".
    var initialSyncedAt: Date? { get }
    /// A pairing code was scanned. Emits states until the attempt settles.
    func pair(code: String) -> AsyncStream<ConnectionState>

    /// Parses a scanned code and returns what to confirm with the person ("Connect to studio-mac?").
    /// nil means pair at once (the fixture). Throws a message-bearing error for a code that must not be used.
    func preview(code: String) throws -> PairingPreview?
    /// Changes that happen on their own: reconnects, `unreachable`, revoke, pairing failures.
    var updates: AsyncStream<DriverUpdate> { get }
    /// `scenePhase == .active` (connect) or not (close after a few seconds).
    func setActive(_ active: Bool) async
    func cancelPairing() async
}

extension SessionDriver {
    public func preview(code: String) throws -> PairingPreview? { nil }
    public var updates: AsyncStream<DriverUpdate> { AsyncStream { $0.finish() } }
    public func setActive(_ active: Bool) async {}
    public func cancelPairing() async {}
}

/// A scripted driver for previews, screenshots and the skeleton. It accepts any code that looks like
/// a pairing link and "approves" after a short wait.
public struct FixtureSessionDriver: SessionDriver {
    public enum Scenario: String, Sendable, CaseIterable {
        case unpaired, pending, live, away, gatewayOff, tailscaleOff, mismatch
    }

    public var scenario: Scenario
    public var approvalDelay: Duration

    public init(scenario: Scenario = .unpaired, approvalDelay: Duration = .seconds(4)) {
        self.scenario = scenario
        self.approvalDelay = approvalDelay
    }

    /// Reads `-psycheScenario <name>` from the launch arguments (simctl launch ... -psycheScenario away).
    public static func fromLaunchArguments(_ defaults: UserDefaults = .standard) -> FixtureSessionDriver {
        let name = defaults.string(forKey: "psycheScenario") ?? ""
        return FixtureSessionDriver(scenario: Scenario(rawValue: name) ?? .unpaired)
    }

    public static let fixtureEndpoint = GatewayEndpoint(
        host: "studio-mac.tail3b2c.ts.net", fingerprint: "7F3A 91C2 E04B", transport: .tailscale)

    public static let fixturePending = PendingApproval(
        code: "482 917", endpoint: fixtureEndpoint, deviceName: "iPhone")

    public var initialState: ConnectionState {
        switch scenario {
        case .unpaired: .unpaired
        case .pending: .pending(Self.fixturePending)
        case .live: .live
        case .away: .unreachable(.awayFromHome)
        case .gatewayOff: .unreachable(.gatewayOff)
        case .tailscaleOff: .unreachable(.tailscaleOff)
        case .mismatch: .refused(.identityMismatch)
        }
    }

    public var initialSyncedAt: Date? {
        switch scenario {
        case .unpaired, .pending: nil
        default: Calendar.current.date(bySettingHour: 8, minute: 12, second: 0, of: .now)
        }
    }

    public func pair(code: String) -> AsyncStream<ConnectionState> {
        let delay = approvalDelay
        return AsyncStream { continuation in
            let task = Task {
                continuation.yield(.pending(Self.fixturePending))
                try? await Task.sleep(for: delay)
                if !Task.isCancelled { continuation.yield(.live) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
