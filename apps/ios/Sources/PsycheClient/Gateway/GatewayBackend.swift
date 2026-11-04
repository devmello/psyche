import Foundation
import PsycheStore
import enum PsycheProtocol.JSONValue
import PsycheWire

/// The real `PsycheBackend`: reads and writes go over the Gateway connection (`GatewayClient`), writes
/// that can wait go through the outbox, and everything that changes later arrives as a `LiveEvent`.
/// One file per feature (`GatewayBackend+Chat.swift`, …) maps the wire onto the feature's own types by
/// constructing values, so a feature gaining a field or a case never breaks this file.
public final class GatewayBackend: PsycheBackend, Sendable {
    let client: GatewayClient
    let mainThread = MainThreadCache()

    public init(client: GatewayClient) { self.client = client }

    // LiveUpdates
    public func events() -> AsyncStream<LiveEvent> { client.liveEvents() }

    // MARK: - Helpers shared by the feature files

    func call(_ method: String, _ params: JSONValue? = nil, key: String? = nil) async throws -> JSONValue {
        try await client.call(method, params: params, idempotencyKey: key)
    }

    /// Runs optional pieces of a screen: a failure leaves that section empty instead of failing the whole read.
    func optional<T: Sendable>(_ work: @Sendable () async throws -> T) async -> T? {
        try? await work()
    }

    func settled<T: Sendable>(_ work: @Sendable () async throws -> T) async -> Result<T, any Error> {
        do { return .success(try await work()) } catch { return .failure(error) }
    }

    /// "send_email" -> "Send email".
    static func humanized(_ snake: String) -> String {
        let words = snake.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

/// The main thread's id, once known, so a message to "the main thread" can be queued while offline.
actor MainThreadCache {
    private var id: String?
    func get() -> String? { id }
    func set(_ newValue: String) { id = newValue }
}
