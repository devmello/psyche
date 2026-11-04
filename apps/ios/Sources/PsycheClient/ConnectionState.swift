import Foundation
import PsycheShared

/// The states the UI must draw (docs/design/ios-app-2026.md §3.2).
public enum ConnectionState: Equatable, Sendable {
    /// No endpoint stored: show the pairing screens.
    case unpaired
    /// `connect` returned `pending`: "Approve this phone on your Mac".
    case pending(PendingApproval)
    /// The first 1.5 s of a connect. The UI draws nothing until it passes.
    case connecting
    case live
    /// Cached content stays readable; answers wait.
    case unreachable(UnreachableReason)
    /// Full-screen stop with no retry (companion M1 acceptance 2).
    case refused(RefusalReason)
    /// `devices.revoke`: keys, cache and outbox are wiped; back to pairing.
    case revoked

    /// True while the pairing screens own the window.
    public var needsPairing: Bool {
        switch self {
        case .unpaired, .pending, .revoked: true
        case .connecting, .live, .unreachable, .refused: false
        }
    }

    /// Whether answers (approvals, questions, sends) can go out right now.
    public var canAnswer: Bool {
        switch self {
        case .live, .connecting: true
        case .unpaired, .pending, .unreachable, .refused, .revoked: false
        }
    }
}

public enum UnreachableReason: Equatable, Sendable {
    /// LAN endpoint, Bonjour finds nothing.
    case awayFromHome
    /// Tailscale is up, the Gateway is not answering.
    case gatewayOff
    /// `*.ts.net` does not resolve.
    case tailscaleOff
}

public enum RefusalReason: Equatable, Sendable {
    /// The Gateway's identity-key signature did not match the pinned key.
    case identityMismatch
}

public struct PendingApproval: Equatable, Sendable {
    /// The 6-digit code both screens show, grouped: "482 917".
    public var code: String
    public var endpoint: GatewayEndpoint
    /// What the Mac will call this phone.
    public var deviceName: String

    public init(code: String, endpoint: GatewayEndpoint, deviceName: String) {
        self.code = code
        self.endpoint = endpoint
        self.deviceName = deviceName
    }
}
