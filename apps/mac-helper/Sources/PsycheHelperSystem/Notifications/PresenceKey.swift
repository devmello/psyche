import Foundation
import LocalAuthentication
import PsycheHelperCore
import PsycheProtocol
import PsycheWire

/// Signs presence assertions (security §3.7): shows the owner sheet, then signs the Gateway's
/// challenge with the helper's device key.
public protocol PresenceSigning: Sendable {
    /// Raw 32-byte Ed25519 public key and its `keyId`. Never shows a sheet.
    func publicKey() throws -> (raw: Data, keyId: String)
    /// Shows the owner sheet with `reason` (exactly one), then, only if the owner passed it, signs
    /// `PresenceMessage.bytes(challenge)`. Throws `cancelled` / `user_cancelled` when the owner cancels.
    func sign(challenge: String, reason: String) async throws -> PresenceSignature
}

/// The system's owner-authentication sheet: Touch ID, with the "Use Password…" fallback to the Mac
/// login password (`LAContext` `.deviceOwnerAuthentication`). Tests pass a fake: nothing but the
/// live implementation ever opens a real sheet.
public protocol OwnerAuthenticating: Sendable {
    /// Returns when the owner passed; throws a `CapabilityError` otherwise.
    func authenticate(reason: String) async throws
}

public struct LiveOwnerAuthenticator: OwnerAuthenticating {
    public init() {}

    public func authenticate(reason: String) async throws {
        let context = LAContext()
        // A fresh sheet for every approval: never a reused earlier unlock.
        context.touchIDAuthenticationAllowableReuseDuration = 0
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
                throw Self.map(LAError(.authenticationFailed))
            }
        } catch let e as CapabilityError {
            throw e
        } catch {
            throw Self.map(error)
        }
    }

    /// Cancelling is not a failure; a wrong password or finger is; the rest is "cannot run here".
    static func map(_ error: any Error) -> CapabilityError {
        guard let la = error as? LAError else {
            return CapabilityError(.unavailable, reason: "authentication_unavailable", "The system could not ask for the owner")
        }
        switch la.code {
        case .userCancel, .appCancel, .systemCancel:
            return CapabilityError(.cancelled, reason: "user_cancelled", "The owner cancelled")
        case .authenticationFailed:
            return CapabilityError(.forbidden, reason: "authentication_failed", "The owner could not be confirmed")
        case .passcodeNotSet:
            return CapabilityError(.unavailable, reason: "passcode_not_set", "This Mac has no login password set")
        case .notInteractive:
            return CapabilityError(.unavailable, reason: "not_interactive", "The Mac cannot show a sheet right now")
        case .biometryLockout:
            return CapabilityError(.unavailable, reason: "biometry_lockout", "Touch ID is locked; use the Mac password")
        default:
            return CapabilityError(.unavailable, reason: "authentication_unavailable", "The system could not ask for the owner")
        }
    }
}

/// The presence signer: one owner sheet per approval, then an Ed25519 signature by the helper's
/// own device identity (`DeviceIdentity`, the key it paired with, kept without any access control
/// list). There is no second key and no registration; the Gateway reads the public key from the
/// paired device. Only one sheet at a time: a second request while one is open fails with
/// `unavailable/presence_busy` instead of stacking sheets.
public final class DeviceIdentityPresence: PresenceSigning, @unchecked Sendable {
    private let identity: DeviceIdentity
    private let owner: any OwnerAuthenticating
    private let lock = NSLock()
    private var busy = false

    public init(identity: DeviceIdentity, owner: any OwnerAuthenticating = LiveOwnerAuthenticator()) {
        self.identity = identity
        self.owner = owner
    }

    public func publicKey() throws -> (raw: Data, keyId: String) {
        let raw = identity.privateKey.publicKey.rawRepresentation
        return (raw, PresenceMessage.keyId(publicKey: raw))
    }

    private func enter() -> Bool {
        lock.withLock {
            if busy { return false }
            busy = true
            return true
        }
    }

    public func sign(challenge: String, reason: String) async throws -> PresenceSignature {
        guard PresenceMessage.isValidChallenge(challenge) else {
            throw CapabilityError.invalidParams("presenceChallenge must be 64 hex characters", field: "presenceChallenge")
        }
        guard enter() else {
            throw CapabilityError(.unavailable, reason: "presence_busy", "Another approval sheet is open")
        }
        defer { lock.withLock { busy = false } }
        try await owner.authenticate(reason: reason)
        let key = try publicKey()
        let signature = try identity.privateKey.signature(for: PresenceMessage.bytes(challenge: challenge))
        return PresenceSignature(signature: Base64URL.encode(signature), keyId: key.keyId)
    }
}

/// `presence.confirm` parameters: the approval's presence challenge, its one-line summary and the
/// short code the card shows next to Touch ID (derived from the binding hash), both named in the
/// Touch ID sheet so the owner can tell which approval they confirm.
public struct PresenceConfirmParams: Codable, Sendable, Equatable {
    public var challenge: String
    public var summary: String
    public var code: String

    public init(challenge: String, summary: String, code: String) {
        self.challenge = challenge
        self.summary = summary
        self.code = code
    }
}

/// `presence.public_key`: the helper's device public key (the one it paired with), which the
/// Gateway already holds; reported so the desktop and tests can show which key signs.
///
/// `presence.confirm`: the owner sheet (Touch ID or the Mac password), then a signature over one
/// approval's presence challenge, for an approval the owner allowed in the Psyche window (the
/// window cannot sign; the Gateway asks the helper). The Gateway never lets `nodes.invoke` or an
/// agent tool reach `presence.*`, so only it chooses the challenge, and the sheet's wording is
/// fixed here around the approval's summary.
public enum PresenceCapabilities {
    public static let maxSummary = 100

    /// `xxxx-xxxx`, lower-case hex: the approval code the card shows.
    static func isValidCode(_ s: String) -> Bool {
        let parts = s.split(separator: "-", omittingEmptySubsequences: false)
        return parts.count == 2 && parts.allSatisfy { p in
            p.utf8.count == 4 && p.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
        }
    }

    /// What the owner sheet says after "psyche-helper is trying to": fixed wording around the
    /// approval's one-line summary and its code.
    static func confirmReason(summary: String, code: String) -> String {
        let oneLine = summary.split(whereSeparator: \.isNewline).joined(separator: " ")
            .filter { !$0.isASCII || $0.asciiValue.map { $0 >= 0x20 && $0 != 0x7F } == true }
        // The code first: it is what the owner compares with the card, and a long summary is cut.
        return "approve code \(code): \u{201C}\(NotificationLimits.truncate(oneLine, max: maxSummary))\u{201D} in Psyche"
    }

    public static func make(key: any PresenceSigning) -> [any CapabilityHandler] {
        [publicKey(key), confirm(key)]
    }

    static func confirm(_ key: any PresenceSigning) -> Capability {
        Capability(CapabilitySpec(
            name: "presence.confirm",
            description: "Shows the system's owner sheet (Touch ID, or the Mac password) naming the approval, then signs one approval's presence challenge with the helper's device key (an approval allowed in the Psyche window). "
                + "Returns signature (Ed25519, base64url) and keyId. Fails cancelled/user_cancelled when the owner cancels, unavailable/presence_busy while another sheet is open.",
            sideEffect: .write,
            inputSchema: Schema.object(
                [
                    "challenge": Schema.string("Hex SHA-256 presence challenge of the approval", maxLength: 64),
                    "summary": Schema.string("The approval's one-line summary, named in the owner sheet", maxLength: maxSummary * 4),
                    "code": Schema.string("The approval code the card shows (xxxx-xxxx hex)", maxLength: 9),
                ],
                required: ["challenge", "summary", "code"]
            ),
            receiptKind: "approval_presence"
        )) { ctx in
            let p = try ctx.decode(PresenceConfirmParams.self)
            guard PresenceMessage.isValidChallenge(p.challenge) else {
                throw CapabilityError.invalidParams("challenge must be 64 hex characters", field: "challenge")
            }
            guard !p.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CapabilityError.invalidParams("summary must not be empty", field: "summary")
            }
            guard isValidCode(p.code) else {
                throw CapabilityError.invalidParams("code must be xxxx-xxxx hex", field: "code")
            }
            let signed = try await key.sign(challenge: p.challenge, reason: confirmReason(summary: p.summary, code: p.code))
            return CapabilityOutput(
                ["signature": .string(signed.signature), "keyId": .string(signed.keyId)],
                receipt: ReceiptDraft(
                    outcome: .ok, summary: "Confirmed an approval with the owner sheet",
                    externalRefs: ["approvalCode": .string(p.code), "keyId": .string(signed.keyId)]
                )
            )
        }
    }

    static func publicKey(_ key: any PresenceSigning) -> Capability {
        Capability(CapabilitySpec(
            name: "presence.public_key",
            description: "The helper's device public key that signs presence assertions (Ed25519, raw 32 bytes, base64url), keyId (hex SHA-256 of it), kind (device_identity) and algorithm (ed25519). Never shows a sheet and touches no keychain item of its own.",
            sideEffect: .read
        )) { _ in
            let (raw, keyId) = try key.publicKey()
            return CapabilityOutput([
                "publicKey": .string(Base64URL.encode(raw)), "keyId": .string(keyId),
                "kind": .string("device_identity"), "algorithm": .string("ed25519"),
            ])
        }
    }
}
