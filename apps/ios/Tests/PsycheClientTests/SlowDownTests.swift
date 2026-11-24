import Foundation
import PsycheShared
import PsycheStore
import Testing
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError

@testable import PsycheClient

/// The Gateway's per-device model budget reaches the owner as one plain sentence, not the English message.
@Suite("Slow down")
struct SlowDownTests {
    private func limited(retryAfterMs: Double?, reason: String = "model_budget") -> ConnectionFailure {
        var details: [String: JSONValue] = ["scope": .string("model_calls"), "reason": .string(reason)]
        if let retryAfterMs { details["retryAfterMs"] = .number(retryAfterMs) }
        return .remote(
            WireError(code: "rate_limited", message: "Too many requests from this device. Try again in 1 minute.",
                      details: .object(details), retryable: true))
    }

    @Test func roundsTheWaitUpToWholeMinutes() {
        #expect(GatewayClient.backendError(limited(retryAfterMs: 60_000)) == .slowDown(minutes: 1))
        #expect(GatewayClient.backendError(limited(retryAfterMs: 61_000)) == .slowDown(minutes: 2))
        #expect(GatewayClient.backendError(limited(retryAfterMs: 1_800_000)) == .slowDown(minutes: 30))
    }

    @Test func aMissingWaitIsAMinute() {
        #expect(GatewayClient.backendError(limited(retryAfterMs: nil)) == .slowDown(minutes: 1))
        #expect(GatewayClient.backendError(limited(retryAfterMs: -5)) == .slowDown(minutes: 1))
    }

    @Test func saysItInPlainWords() {
        let text = BackendError.slowDown(minutes: 5).errorDescription ?? ""
        #expect(text.contains("5"))
        #expect(!text.contains("Gateway"))
    }

    @Test func otherRateLimitsStayOrdinaryRefusals() {
        let plain = ConnectionFailure.remote(
            WireError(code: "rate_limited", message: "Too many requests from this device; slow down",
                      details: .object(["scope": .string("requests"), "retryAfterSec": .number(5)]), retryable: true))
        #expect(GatewayClient.backendError(plain) == .refused("Too many requests from this device; slow down"))
        #expect(GatewayClient.backendError(limited(retryAfterMs: 1000, reason: "other"))
            == .refused("Too many requests from this device. Try again in 1 minute."))
    }
}
