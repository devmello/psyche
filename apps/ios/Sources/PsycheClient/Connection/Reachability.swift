import Foundation
import Network
import PsycheShared

/// What the client can tell about the network when a connect fails (§3.2).
public protocol Reachability: Sendable {
    /// Whether `host` resolves to an address (MagicDNS for `*.ts.net`, mDNS for `*.local`).
    func resolves(_ host: String) async -> Bool
    /// Whether the phone is on a Wi-Fi or wired network, where a LAN Gateway could be.
    func onLocalNetwork() async -> Bool
}

public enum UnreachableClassifier {
    /// Which §3.2 state a failed connect to `endpoint` means.
    /// - Tailscale: a name that does not resolve means Tailscale is off; one that resolves but gets no answer means the Gateway is off.
    /// - LAN: off the home network, or a `.local` name that does not resolve, means away from home; otherwise the Gateway is off.
    public static func classify(_ endpoint: GatewayEndpoint, reachability: any Reachability) async -> UnreachableReason {
        let host = endpoint.host
        if isLoopback(host) { return .gatewayOff }
        switch endpoint.transport {
        case .tailscale:
            return await reachability.resolves(host) ? .gatewayOff : .tailscaleOff
        case .lan:
            guard await reachability.onLocalNetwork() else { return .awayFromHome }
            return await reachability.resolves(host) ? .gatewayOff : .awayFromHome
        }
    }

    static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }
}

/// `getaddrinfo` for resolution and `NWPathMonitor` for the interface type.
public struct SystemReachability: Reachability {
    public init() {}

    public func resolves(_ host: String) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                var hints = addrinfo()
                hints.ai_socktype = SOCK_STREAM
                var result: UnsafeMutablePointer<addrinfo>?
                let status = getaddrinfo(host, nil, &hints, &result)
                if let result { freeaddrinfo(result) }
                continuation.resume(returning: status == 0)
            }
        }
    }

    public func onLocalNetwork() async -> Bool {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            let queue = DispatchQueue(label: "psyche.reachability")
            let once = Once()
            monitor.pathUpdateHandler = { path in
                guard once.take() else { return }
                monitor.cancel()
                let local = path.status == .satisfied
                    && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
                continuation.resume(returning: local)
            }
            monitor.start(queue: queue)
        }
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.withLock { defer { taken = true }; return !taken } }
}
