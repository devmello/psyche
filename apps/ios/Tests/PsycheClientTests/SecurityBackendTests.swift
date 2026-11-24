import Foundation
import enum PsycheProtocol.JSONValue
import struct PsycheProtocol.WireError
import PsycheStore
import Testing

@testable import PsycheClient

/// Cancelling a waiting recovery from its notice: `security.state.get` to find it, `security.recoveries.cancel` to
/// cancel it, and the button only for a phone the Gateway granted `operator.admin`.
struct SecurityBackendTests {
    /// Every fixture request applies at this time (the recovery's `notBefore`).
    static let when = ISO8601DateFormatter().date(from: "2030-01-02T09:00:00Z")!

    static func state(_ recoveries: [JSONValue]) -> JSONValue {
        .object(["status": "sealed", "reason": .null, "alerts": .array([]), "recoveries": .array(recoveries)])
    }

    static func recovery(
        _ id: String, op: String = "devices.grant", status: String = "waiting", notBefore: String = "2030-01-02T09:00:00Z", name: String? = "Work laptop",
        fingerprint: String? = "sha256:0123456789abcdef0123456789abcdef"
    ) -> JSONValue {
        var r: [String: JSONValue] = [
            "id": .string(id), "op": .string(op), "status": .string(status),
            "requestedAt": "2030-01-01T09:00:00Z", "notBefore": .string(notBefore), "decidedAt": .null, "outcome": .null,
        ]
        if let name { r["deviceName"] = .string(name) }
        if let fingerprint { r["deviceFingerprint"] = .string(fingerprint) }
        return .object(r)
    }

    func live(admin: Bool, _ configure: (FakeGateway) -> Void) async throws -> GatewayBackend {
        let gateway = FakeGateway()
        if admin { gateway.pairedScopes = ["operator.read", "operator.write", "operator.approvals", "operator.admin"] }
        configure(gateway)
        let h = GatewayClientTests.Harness(gateway: gateway)
        await h.client.beginPairing(try GatewayClientTests.link())
        #expect(await GatewayClientTests.wait(h.client) { $0 == .live } == .live)
        return GatewayBackend(client: h.client)
    }

    @Test func theButtonNeedsTheAdminScopeThePhoneWasGranted() async throws {
        let admin = try await live(admin: true) { _ in }
        #expect(await admin.canCancelRecoveries())
        let reader = try await live(admin: false) { _ in }
        #expect(await reader.canCancelRecoveries() == false)
    }

    @Test func cancelsTheWaitingRequestTheNoticeNamesAndNothingElse() async throws {
        let cancelled = OutboxTests.Sent()
        let backend = try await live(admin: true) { g in
            g.on("security.state.get") { _ in
                .success(Self.state([
                    Self.recovery("rc_mine"),
                    // Same op, another device key: not the one the notice names.
                    Self.recovery("rc_other_key", fingerprint: "sha256:ffffffffffffffff0000"),
                    // Same device, another op, and one that was already decided.
                    Self.recovery("rc_other_op", op: "devices.approve"),
                    Self.recovery("rc_done", status: "cancelled"),
                ]))
            }
            g.on("security.recoveries.cancel") { req in
                cancelled.add(req.params?["id"]?.stringValue ?? "")
                return .success(.object(["recovery": Self.recovery("rc_mine", status: "cancelled")]))
            }
        }
        let outcome = try await backend.cancelRecovery(
            for: RecoveryNotice(op: "grant", device: "Work laptop", key: "0123456789abcdef", when: Self.when))
        #expect(outcome == .cancelled(1))
        #expect(cancelled.all == ["rc_mine"])
    }

    @Test func aNoticeWithoutAKeyMatchesTheDeviceNameAndOneWithoutDeviceMatchesItsOp() async throws {
        let cancelled = OutboxTests.Sent()
        let backend = try await live(admin: true) { g in
            g.on("security.state.get") { _ in
                .success(Self.state([
                    Self.recovery("rc_named", fingerprint: nil),
                    Self.recovery("rc_stranger", name: "Someone else", fingerprint: nil),
                    Self.recovery("rc_presence", op: "presence.reset", name: nil, fingerprint: nil),
                ]))
            }
            g.on("security.recoveries.cancel") { req in
                cancelled.add(req.params?["id"]?.stringValue ?? "")
                return .success(.object(["recovery": Self.recovery("x", status: "cancelled")]))
            }
        }
        #expect(try await backend.cancelRecovery(for: RecoveryNotice(op: "grant", device: "Work laptop", when: Self.when)) == .cancelled(1))
        #expect(try await backend.cancelRecovery(for: RecoveryNotice(op: "presence", when: Self.when)) == .cancelled(1))
        #expect(cancelled.all == ["rc_named", "rc_presence"])
    }

    @Test func nothingWaitingMakesNoCancelCall() async throws {
        let cancelled = OutboxTests.Sent()
        let backend = try await live(admin: true) { g in
            g.on("security.state.get") { _ in .success(Self.state([Self.recovery("rc_done", status: "applied")])) }
            g.on("security.recoveries.cancel") { req in
                cancelled.add(req.params?["id"]?.stringValue ?? "")
                return .success(.object([:]))
            }
        }
        let outcome = try await backend.cancelRecovery(for: RecoveryNotice(op: "grant", device: "Work laptop", when: Self.when))
        #expect(outcome == .nothingWaiting)
        #expect(cancelled.all.isEmpty)
    }

    @Test func theGatewaysRefusalComesBackInItsOwnWords() async throws {
        let backend = try await live(admin: true) { g in
            g.on("security.state.get") { _ in .success(Self.state([Self.recovery("rc_seal", op: "seal.reset", name: nil, fingerprint: nil)])) }
            g.on("security.recoveries.cancel") { _ in
                .failure(WireError(code: "forbidden", message: "A re-seal can be cancelled only from an admin device Psyche still trusts"))
            }
        }
        await #expect(throws: BackendError.refused("A re-seal can be cancelled only from an admin device Psyche still trusts")) {
            _ = try await backend.cancelRecovery(for: RecoveryNotice(op: "seal", when: Self.when))
        }
    }

    @Test func anUnknownOpMatchesNothing() {
        let state = Self.state([Self.recovery("rc", op: "devices.grant")])
        #expect(GatewayBackend.waitingRecoveryIDs(matching: RecoveryNotice(op: "other", when: Self.when), in: state).isEmpty)
        // A notice that names a key never matches a request whose key is missing.
        #expect(GatewayBackend.waitingRecoveryIDs(
            matching: RecoveryNotice(op: "grant", device: "Work laptop", key: "0123456789abcdef", when: Self.when),
            in: Self.state([Self.recovery("rc", fingerprint: nil)])).isEmpty)
    }

    @Test func anOldNoticeNeverCancelsANewerRequestOfTheSameOp() async throws {
        let cancelled = OutboxTests.Sent()
        let backend = try await live(admin: true) { g in
            g.on("security.state.get") { _ in
                .success(Self.state([
                    Self.recovery("rc_june", op: "seal.reset", notBefore: "2030-06-02T09:00:00.250Z", name: nil, fingerprint: nil),
                    Self.recovery("rc_presence_june", op: "presence.reset", notBefore: "2030-06-02T09:00:00Z", name: nil, fingerprint: nil),
                ]))
            }
            g.on("security.recoveries.cancel") { req in
                cancelled.add(req.params?["id"]?.stringValue ?? "")
                return .success(.object(["recovery": Self.recovery("x", status: "cancelled")]))
            }
        }
        let march = ISO8601DateFormatter().date(from: "2030-03-02T09:00:00Z")!
        let june = ISO8601DateFormatter().date(from: "2030-06-02T09:00:00Z")!
        let old = RecoveryNotice(op: "seal", when: march)
        let current = RecoveryNotice(op: "seal", when: june)
        // The March notice shows no button and cancels nothing; one with no time never matches.
        #expect(await backend.cancellable([old, RecoveryNotice(op: "seal"), RecoveryNotice(op: "presence", when: march)]).isEmpty)
        #expect(try await backend.cancelRecovery(for: old) == .nothingWaiting)
        #expect(try await backend.cancelRecovery(for: RecoveryNotice(op: "seal")) == .nothingWaiting)
        #expect(cancelled.all.isEmpty)
        // The matching one (to the second, a fractional notBefore included) cancels only that request.
        #expect(await backend.cancellable([old, current]) == [current])
        #expect(try await backend.cancelRecovery(for: current) == .cancelled(1))
        #expect(cancelled.all == ["rc_june"])
    }
}
