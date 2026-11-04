import Foundation
import PsycheShared

/// The real `SessionDriver`: parses the scanned link, shows what to confirm, and hands the rest to `GatewayClient`.
public struct LiveSessionDriver: SessionDriver {
    public let client: GatewayClient
    private let storedEndpoint: GatewayEndpoint?

    /// `endpoint` is what `EndpointStore` held at launch, so the first frame can already say "paired".
    public init(client: GatewayClient, endpoint: GatewayEndpoint?) {
        self.client = client
        storedEndpoint = endpoint
    }

    public var initialState: ConnectionState { storedEndpoint == nil ? .unpaired : .connecting }
    public var initialSyncedAt: Date? { nil }

    public func preview(code: String) throws -> PairingPreview? {
        let link = try PairingLink.parse(code)
        return PairingPreview(hostName: link.hostName, host: link.host, fingerprint: link.fingerprint, transport: link.transport)
    }

    public func pair(code: String) -> AsyncStream<ConnectionState> {
        // States arrive through `updates`; this only starts the attempt.
        guard let link = try? PairingLink.parse(code) else { return AsyncStream { $0.finish() } }
        Task { await client.beginPairing(link) }
        return AsyncStream { $0.finish() }
    }

    public var updates: AsyncStream<DriverUpdate> {
        let states = client.states()
        let failures = client.pairingFailures()
        return AsyncStream { continuation in
            let a = Task { for await s in states { continuation.yield(.state(s)) } }
            let b = Task { for await m in failures { continuation.yield(.pairingFailed(m)) } }
            continuation.onTermination = { _ in a.cancel(); b.cancel() }
        }
    }

    public func setActive(_ active: Bool) async { await client.setActive(active) }
    public func cancelPairing() async { await client.cancelPairing() }
}
