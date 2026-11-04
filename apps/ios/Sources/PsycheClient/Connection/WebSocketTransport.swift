import Foundation

/// One WebSocket, as the connection sees it: text frames in, text frames out. The real one wraps
/// `URLSessionWebSocketTask`; tests plug in a fake Gateway.
public protocol WebSocketTransport: Sendable {
    func send(_ frame: Data) async throws
    /// The next frame, or throws when the socket closed.
    func receive() async throws -> Data
    func close()
}

public typealias TransportFactory = @Sendable (URL) -> any WebSocketTransport

public struct TransportClosed: Error, Equatable { public init() {} }

/// `wss://host/ws` (or `ws://` to loopback) over the system trust store. There is deliberately no
/// custom trust handler: the identity-key pin proves *who* answered, but only TLS keeps a relay from
/// reading the traffic, so a self-signed LAN certificate needs its own SPKI pin first (not built yet).
public final class URLSessionTransport: WebSocketTransport, @unchecked Sendable {
    private let session: URLSession
    private let task: URLSessionWebSocketTask

    public init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 2 * 1_048_576
        task.resume()
    }

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

    public func close() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    /// `https://host[:port]` -> `wss://host[:port]/ws`; `http://` (loopback) -> `ws://`.
    public static func socketURL(forOrigin origin: String) -> URL? {
        guard var parts = URLComponents(string: origin) else { return nil }
        parts.scheme = parts.scheme == "http" ? "ws" : "wss"
        parts.path = "/ws"
        return parts.url
    }
}
