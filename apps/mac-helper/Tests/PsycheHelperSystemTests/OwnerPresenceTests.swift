import CryptoKit
import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import PsycheWire
import Testing

@testable import PsycheHelperSystem

/// Fake owner sheet: never an `LAContext`, never a keychain item.
private final class FakeOwner: OwnerAuthenticating, @unchecked Sendable {
    private let lock = NSLock()
    private var _reasons: [String] = []
    var outcome: CapabilityError?
    var gate: (@Sendable () async -> Void)?

    var reasons: [String] { lock.withLock { _reasons } }

    func authenticate(reason: String) async throws {
        lock.withLock { _reasons.append(reason) }
        await gate?()
        if let outcome { throw outcome }
    }
}

private let challenge = String(repeating: "ab", count: 32)
private let cancelled = CapabilityError(.cancelled, reason: "user_cancelled", "cancelled")

@Suite("owner presence: system sheet, then the device key signs")
struct OwnerPresenceTests {
    let identity = DeviceIdentity()

    @Test func signsOnlyAfterTheSheetPassedAndTheSignatureVerifies() async throws {
        let owner = FakeOwner()
        let presence = DeviceIdentityPresence(identity: identity, owner: owner)
        let signed = try await presence.sign(challenge: challenge, reason: "approve it")
        #expect(owner.reasons == ["approve it"])
        let raw = identity.privateKey.publicKey.rawRepresentation
        #expect(signed.keyId == PresenceMessage.keyId(publicKey: raw))
        let sig = try #require(Base64URL.decode(signed.signature))
        #expect(sig.count == 64)
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: raw)
        #expect(key.isValidSignature(sig, for: PresenceMessage.bytes(challenge: challenge)))
        #expect(!key.isValidSignature(sig, for: PresenceMessage.bytes(challenge: String(repeating: "cd", count: 32))))
    }

    @Test func aCancelledSheetSignsNothing() async {
        let owner = FakeOwner()
        owner.outcome = cancelled
        let presence = DeviceIdentityPresence(identity: identity, owner: owner)
        do {
            _ = try await presence.sign(challenge: challenge, reason: "r")
            Issue.record("signed after a cancel")
        } catch let e as CapabilityError {
            #expect(e.code == .cancelled && e.reason == "user_cancelled")
        } catch {
            Issue.record("unexpected \(error)")
        }
        #expect(owner.reasons.count == 1)
    }

    @Test func aFailedSheetSignsNothingAndFreesTheGate() async throws {
        let owner = FakeOwner()
        owner.outcome = CapabilityError(.forbidden, reason: "authentication_failed", "no")
        let presence = DeviceIdentityPresence(identity: identity, owner: owner)
        await #expect(throws: CapabilityError.self) { try await presence.sign(challenge: challenge, reason: "r") }
        owner.outcome = nil
        _ = try await presence.sign(challenge: challenge, reason: "r")
        #expect(owner.reasons.count == 2)
    }

    @Test func aSecondRequestWhileASheetIsOpenFailsBusyWithoutAnotherSheet() async throws {
        let owner = FakeOwner()
        let open = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        owner.gate = {
            open.continuation.yield()
            for await _ in release.stream { break }
        }
        let presence = DeviceIdentityPresence(identity: identity, owner: owner)
        let first = _Concurrency.Task { try await presence.sign(challenge: challenge, reason: "first") }
        for await _ in open.stream { break }
        do {
            _ = try await presence.sign(challenge: challenge, reason: "second")
            Issue.record("a second sheet was allowed")
        } catch let e as CapabilityError {
            #expect(e.code == .unavailable && e.reason == "presence_busy")
        }
        #expect(owner.reasons == ["first"])
        release.continuation.yield()
        _ = try await first.value
    }

    @Test(arguments: [
        "sha256:" + String(repeating: "ab", count: 32), String(repeating: "a", count: 63), String(repeating: "a", count: 65),
        String(repeating: "zz", count: 32), "",
    ])
    func invalidChallengesNeverShowASheet(_ bad: String) async {
        let owner = FakeOwner()
        let presence = DeviceIdentityPresence(identity: identity, owner: owner)
        await #expect(throws: CapabilityError.self) { try await presence.sign(challenge: bad, reason: "r") }
        #expect(owner.reasons.isEmpty)
    }

    @Test func laErrorsMapToQuietCancelAndDistinctFailures() {
        func map(_ c: LAError.Code) -> CapabilityError { LiveOwnerAuthenticator.map(LAError(c)) }
        for c in [LAError.Code.userCancel, .appCancel, .systemCancel] {
            #expect(map(c).code == .cancelled && map(c).reason == "user_cancelled")
        }
        #expect(map(.authenticationFailed).code == .forbidden && map(.authenticationFailed).reason == "authentication_failed")
        #expect(map(.passcodeNotSet).reason == "passcode_not_set" && map(.passcodeNotSet).code == .unavailable)
        #expect(map(.notInteractive).reason == "not_interactive")
        #expect(map(.biometryLockout).reason == "biometry_lockout")
        #expect(LiveOwnerAuthenticator.map(NSError(domain: "x", code: 1)).reason == "authentication_unavailable")
    }
}

@Suite("presence capabilities")
struct PresenceCapabilityTests {
    let identity = DeviceIdentity()

    private func run(_ owner: FakeOwner, _ name: String, _ params: JSONValue) async throws -> CapabilityOutput {
        let registry = CapabilityRegistry(PresenceCapabilities.make(key: DeviceIdentityPresence(identity: identity, owner: owner)))
        let ctx = InvocationContext(invocationId: "inv", capability: name, params: params, approvalId: nil, emit: { _ in })
        return try await registry[name]!.invoke(ctx)
    }

    @Test func publicKeyReportsTheDeviceKeyAndNeverShowsASheet() async throws {
        let owner = FakeOwner()
        let out = try await run(owner, "presence.public_key", .null)
        let raw = identity.privateKey.publicKey.rawRepresentation
        #expect(out.result["publicKey"] == .string(Base64URL.encode(raw)))
        #expect(out.result["keyId"] == .string(PresenceMessage.keyId(publicKey: raw)))
        #expect(out.result["kind"] == "device_identity" && out.result["algorithm"] == "ed25519")
        #expect(out.result["publicKey"] == .string(identity.publicKey))
        #expect(owner.reasons.isEmpty)
    }

    @Test func confirmShowsExactlyOneSheetNamingTheApproval() async throws {
        let owner = FakeOwner()
        let out = try await run(owner, "presence.confirm", ["challenge": .string(challenge), "summary": "Buy a book\nfor $5", "code": "ab12-cd34"])
        #expect(owner.reasons == ["approve code ab12-cd34: \u{201C}Buy a book for $5\u{201D} in Psyche"])
        #expect(out.result["signature"] != nil && out.result["keyId"] != nil)
    }

    @Test func confirmCancelIsACancelledError() async {
        let owner = FakeOwner()
        owner.outcome = cancelled
        do {
            _ = try await run(owner, "presence.confirm", ["challenge": .string(challenge), "summary": "x", "code": "ab12-cd34"])
            Issue.record("did not throw")
        } catch let e as CapabilityError {
            #expect(e.code == .cancelled && e.reason == "user_cancelled")
        } catch {
            Issue.record("unexpected \(error)")
        }
    }

    @Test func confirmRejectsABadChallengeBeforeAnySheet() async {
        let owner = FakeOwner()
        await #expect(throws: CapabilityError.self) {
            _ = try await run(owner, "presence.confirm", ["challenge": .string("sha256:" + String(repeating: "a", count: 57)), "summary": "x", "code": "ab12-cd34"])
        }
        #expect(owner.reasons.isEmpty)
    }
}

@Suite("notification answers: one sheet")
struct NotificationAnswerTests {
    let identity = DeviceIdentity()
    let base = NotificationResponse(notificationId: "apr_1", actionId: "approve", approvalId: "apr_1")

    /// Counts calls of the plain `authenticate` fallback, which must stay unused with a challenge.
    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        func hit() -> String? { lock.withLock { n += 1 }; return nil }
        var count: Int { lock.withLock { n } }
    }

    @Test func theNotificationSheetNamesTheApprovalNotAGenericLine() {
        #expect(NotificationCenterBridge.authReason(kind: "approval", title: "Run a command on your Mac")
            == "approve \u{201C}Run a command on your Mac\u{201D} in Psyche")
        // A header with a line break or a control character is shown as one clean line.
        #expect(NotificationCenterBridge.authReason(kind: "approval", title: "Pay\n$5\u{07}")
            == "approve \u{201C}Pay $5\u{201D} in Psyche")
        #expect(NotificationCenterBridge.authReason(kind: "approval", title: "") == "confirm your answer to a Psyche approval")
        #expect(NotificationCenterBridge.authReason(kind: "input_needed", title: "x") == "send your reply to Psyche")
    }

    @Test func approveSignsAfterOneSheet() async {
        let owner = FakeOwner()
        let counter = Counter()
        let answer = await NotificationCenterBridge.answer(
            base, challenge: challenge, presence: DeviceIdentityPresence(identity: identity, owner: owner), reason: "why",
            authenticate: { _ in counter.hit() }
        )
        #expect(answer.authenticated && answer.presence != nil && answer.presenceError == nil)
        #expect(owner.reasons == ["why"] && counter.count == 0)
    }

    @Test func cancelIsQuietNotApprovedAndNeverRaisesASecondSheet() async {
        let owner = FakeOwner()
        owner.outcome = cancelled
        let counter = Counter()
        let answer = await NotificationCenterBridge.answer(
            base, challenge: challenge, presence: DeviceIdentityPresence(identity: identity, owner: owner), reason: "why",
            authenticate: { _ in counter.hit() }
        )
        #expect(!answer.authenticated && answer.presence == nil)
        #expect(answer.authError == "user_cancelled" && answer.presenceError == nil)
        #expect(owner.reasons.count == 1 && counter.count == 0)
    }

    @Test func noSignerWithAChallengeIsUnavailableWithoutASheet() async {
        let counter = Counter()
        let answer = await NotificationCenterBridge.answer(base, challenge: challenge, presence: nil, reason: "why", authenticate: { _ in counter.hit() })
        #expect(!answer.authenticated && answer.presenceError == "presence_unavailable" && counter.count == 0)
    }

    @Test func aBusyOrUnavailableSheetReportsThePresenceError() async {
        let owner = FakeOwner()
        owner.outcome = CapabilityError(.unavailable, reason: "passcode_not_set", "x")
        let answer = await NotificationCenterBridge.answer(
            base, challenge: challenge, presence: DeviceIdentityPresence(identity: identity, owner: owner), reason: "why",
            authenticate: { _ in nil }
        )
        #expect(!answer.authenticated && answer.presenceError == "passcode_not_set")
    }

    @Test func withoutAChallengeThePlainSheetStillRuns() async {
        let counter = Counter()
        let answer = await NotificationCenterBridge.answer(base, challenge: nil, presence: nil, reason: "why", authenticate: { _ in counter.hit() })
        #expect(answer.authenticated && counter.count == 1)
    }
}
