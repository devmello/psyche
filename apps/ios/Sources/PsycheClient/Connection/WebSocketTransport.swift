import Foundation
import PsycheShared
import Security

/// One WebSocket, as the connection sees it: text frames in, text frames out. The real one wraps
/// `URLSessionWebSocketTask`; tests plug in a fake Gateway.
public protocol WebSocketTransport: Sendable {
    func send(_ frame: Data) async throws
    /// The next frame, or throws when the socket closed.
    func receive() async throws -> Data
    func close()
    /// A WebSocket ping, answered by the Gateway's socket layer: proves the path still works without an app message.
    /// The default does nothing (test transports).
    func ping() async throws
    /// How the TLS certificate of this connection was accepted. Nil when there is no TLS to speak of
    /// (`ws://` to loopback in development, and test transports).
    var peerCertificate: PeerCertificate? { get }
}

extension WebSocketTransport {
    public func ping() async throws {}
    public var peerCertificate: PeerCertificate? { nil }
}

/// How the certificate of a TLS connection was accepted.
public enum PeerCertificate: Equatable, Sendable {
    /// A chain the system trusts for the host name (Tailscale's real certificates, for one).
    case trusted
    /// No chain the system trusts: the Gateway's own certificate on the local network. `spki` is the pin of what
    /// this connection presented; the handshake accepts it only if the Gateway's identity key vouched for it.
    case selfSigned(spki: String)
}

/// What a connection may accept before the handshake has run.
public struct TransportTrust: Equatable, Sendable {
    /// A certificate the system does not trust is accepted for capture, and the handshake decides (LAN only).
    public var allowSelfSigned: Bool
    /// The self-signed certificate's SPKI pin stored at pairing: any other is refused before a byte is written.
    public var pinnedSPKI: String?
    public init(allowSelfSigned: Bool = false, pinnedSPKI: String? = nil) {
        self.allowSelfSigned = allowSelfSigned
        self.pinnedSPKI = pinnedSPKI
    }
}

public typealias TransportFactory = @Sendable (URL, TransportTrust) -> any WebSocketTransport

public struct TransportClosed: Error, Equatable { public init() {} }

/// `wss://host/ws` (or `ws://` to loopback in development).
///
/// Trust: the system evaluates the certificate first, and a chain it trusts is used as is. Only for a LAN
/// Gateway (`TransportTrust.allowSelfSigned`) is a certificate the system rejects kept, and then only to capture
/// its SPKI pin: it is refused outright if it is not the pinned one, and the handshake (`IdentityCheck`) refuses
/// it unless the Gateway's identity key signed that very SPKI into the challenge, before the phone signs or
/// sends anything. A relay with its own certificate fails there. Trust is never switched off on the session.
public final class URLSessionTransport: WebSocketTransport, @unchecked Sendable {
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private let delegate: TrustDelegate

    public init(url: URL, trust: TransportTrust = TransportTrust()) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 15
        delegate = TrustDelegate(trust: trust)
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 2 * 1_048_576
        task.resume()
    }

    public var peerCertificate: PeerCertificate? { delegate.peerCertificate }

    public func send(_ frame: Data) async throws {
        try await task.send(.string(String(decoding: frame, as: UTF8.self)))
    }

    public func receive() async throws -> Data {
        switch try await task.receive() {
        case .string(let text): return Data(text.utf8)
        case .data(let data): return data
        @unknown default: throw TransportClosed()
        }
    }

    public func ping() async throws {
        // Cancelling the ping closes the socket, which makes the pending `sendPing` fail instead of waiting forever.
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                task.sendPing { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        } onCancel: {
            task.cancel(with: .goingAway, reason: nil)
        }
    }

    public func close() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    /// `https://host[:port]` -> `wss://host[:port]/ws`; `http://` -> `ws://`, but only for exactly `localhost`,
    /// `127.0.0.1` or `::1`. Any other scheme, or `http` to any other host, gives nil.
    public static func socketURL(forOrigin origin: String) -> URL? {
        guard var parts = URLComponents(string: origin), let scheme = parts.scheme?.lowercased(),
              let host = parts.host, !host.isEmpty
        else { return nil }
        switch scheme {
        case "https": parts.scheme = "wss"
        case "http":
            guard GatewayEndpoint.isLoopbackName(host) else { return nil }
            parts.scheme = "ws"
        default: return nil
        }
        parts.path = "/ws"
        return parts.url
    }
}

/// Evaluates the server trust of one connection (see `URLSessionTransport`).
final class TrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let trust: TransportTrust
    private let lock = NSLock()
    private var certificate: PeerCertificate?

    init(trust: TransportTrust) {
        self.trust = trust
    }

    var peerCertificate: PeerCertificate? {
        lock.lock()
        defer { lock.unlock() }
        return certificate
    }

    private func record(_ value: PeerCertificate) {
        lock.lock()
        certificate = value
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // The system's answer for this host name comes first, and a good one is final.
        var error: CFError?
        if SecTrustEvaluateWithError(serverTrust, &error) {
            record(.trusted)
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard trust.allowSelfSigned,
              let leaf = (SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate])?.first,
              let spki = CertificatePin.spki(ofCertificate: SecCertificateCopyData(leaf) as Data)
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if let pinned = trust.pinnedSPKI, pinned != spki {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        record(.selfSigned(spki: spki))
        completionHandler(.useCredential, URLCredential(trust: serverTrust))
    }
}
