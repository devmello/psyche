import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Keychain capabilities on S06's contract (`packages/vault` README "Mac helper contract"; security
/// §4.2; G1): `keychain.set`, `vault.unlock`, `keychain.delete`, plus `keychain.status`. The Gateway
/// seals the DEK itself; the helper only holds the KEK behind Touch ID. These are Gateway-internal:
/// no agent tool may reach them through `nodes.invoke`, and `vault.unlock`'s result is a secret.
/// System keychain mode (G9, S06 `packages/vault/src/slots/KeychainItems.ts`) adds item capabilities:
/// `keychain.store`, `keychain.retrieve` and `keychain.delete_item` (its own name: `keychain.delete`
/// is the vault-key delete). `retrieve` returns a secret.
public enum KeychainCapabilities {
    public static func make(vault: KeychainVault = KeychainVault()) -> [any CapabilityHandler] {
        [set(vault), unlock(vault), deleteKey(vault), store(vault), retrieve(vault), deleteItem(vault), status(vault)]
    }

    static let service = "com.psyche.vault"
    static let accessControl = ["biometryCurrentSet", "or", "devicePasscode"]

    struct SetParams: Decodable {
        var service: String
        var account: String
        var value: String
        var accessControl: [String]
        var accessible: String
        var synchronizable: Bool
        var dataProtection: Bool
    }

    struct UnlockParams: Decodable {
        var service: String
        var account: String
        var reason: String
        var reuseDurationSeconds: Double?
    }

    struct DeleteKeyParams: Decodable {
        var service: String
        var account: String
    }

    static func checkService(_ s: String) throws {
        guard s == service else { throw CapabilityError.invalidParams("service must be \(service)", field: "service") }
    }

    static let accountSchema = Schema.string("Vault account (one key item per vault), ^[A-Za-z0-9._-]{1,64}$", maxLength: KeychainNames.maxLength)

    static func set(_ vault: KeychainVault) -> Capability {
        Capability(CapabilitySpec(
            name: "keychain.set",
            description: "Store the vault's key-encryption key in the data-protection keychain behind Touch ID or the device passcode "
                + "([biometryCurrentSet, or, devicePasscode], whenPasscodeSetThisDeviceOnly, not synchronized). Replaces an existing "
                + "key for the account. No prompt. Gateway-internal: never reachable from agent tools.",
            sideEffect: .write,
            inputSchema: Schema.object([
                "service": Schema.string(enum: [service]), "account": accountSchema,
                "value": Schema.string("base64 key bytes", maxLength: 128),
                "accessControl": Schema.array(Schema.string(enum: accessControl)),
                "accessible": Schema.string(enum: ["whenPasscodeSetThisDeviceOnly"]),
                "synchronizable": Schema.boolean(), "dataProtection": Schema.boolean(),
            ], required: ["service", "account", "value", "accessControl", "accessible", "synchronizable", "dataProtection"]),
            receiptKind: "vault_key"
        )) { ctx in
            let p = try ctx.decode(SetParams.self)
            try checkService(p.service)
            // The protection is fixed by security §4.2; refuse anything else rather than weaken it.
            guard p.accessControl == accessControl, p.accessible == "whenPasscodeSetThisDeviceOnly", !p.synchronizable, p.dataProtection else {
                throw CapabilityError.invalidParams("only [biometryCurrentSet, or, devicePasscode], whenPasscodeSetThisDeviceOnly, non-synchronizable, data protection keychain is supported")
            }
            guard let value = Data(base64Encoded: p.value) else { throw CapabilityError.invalidParams("value must be base64", field: "value") }
            let replaced = try await vault.setVaultKey(account: p.account, value: value)
            return CapabilityOutput([:], receipt: ReceiptDraft(outcome: .ok, summary: replaced ? "Replaced the vault key" : "Stored the vault key",
                                                               externalRefs: ["account": .string(p.account)]))
        }
    }

    static func unlock(_ vault: KeychainVault) -> Capability {
        Capability(CapabilitySpec(
            name: "vault.unlock",
            description: "Read the vault's key-encryption key: shows the Touch ID / password prompt with `reason`. Returns {value} (base64), "
                + "a secret: never in model-visible text, logs or notifications. Cancel → cancelled. Gateway-internal.",
            sideEffect: .read,
            inputSchema: Schema.object([
                "service": Schema.string(enum: [service]), "account": accountSchema,
                "reason": Schema.string("Prompt text (1–120 characters)", maxLength: KeychainNames.reasonMaxLength),
                "reuseDurationSeconds": Schema.number("Touch ID reuse window, 0–300 (0 for per-fill items)", min: 0, max: 300),
            ], required: ["service", "account", "reason"])
        )) { ctx in
            let p = try ctx.decode(UnlockParams.self)
            try checkService(p.service)
            let reason = try KeychainNames.validateReason(p.reason, required: true) ?? p.reason
            let reuse = min(300, max(0, p.reuseDurationSeconds ?? 0))
            let value = try await vault.unlockVaultKey(account: p.account, reason: reason, reuseSeconds: reuse)
            return CapabilityOutput(["value": .string(value.base64EncodedString())])
        }
    }

    static func deleteKey(_ vault: KeychainVault) -> Capability {
        Capability(CapabilitySpec(
            name: "keychain.delete",
            description: "Delete the vault's key-encryption key (the vault then opens only with the recovery key). Gateway-internal.",
            sideEffect: .destructive,
            inputSchema: Schema.object(["service": Schema.string(enum: [service]), "account": accountSchema], required: ["service", "account"]),
            receiptKind: "vault_key"
        )) { ctx in
            let p = try ctx.decode(DeleteKeyParams.self)
            try checkService(p.service)
            try await vault.delete(.slot(try KeychainNames.validate(p.account, field: "account")))
            return CapabilityOutput([:], receipt: ReceiptDraft(outcome: .ok, summary: "Deleted the vault key", externalRefs: ["account": .string(p.account)]))
        }
    }

    // MARK: - Schemas

    static let nameSchema = Schema.string("Item name, ^[a-z0-9._-]{1,64}$", maxLength: KeychainNames.maxLength)
    static func reasonSchema(_ prompts: Bool) -> JSONValue {
        Schema.string(
            prompts
                ? "Shown in the Touch ID / password prompt (1–120 characters, one line), e.g. \"unlock your Psyche vault\""
                : "Why this is happening (1–120 characters); no prompt is shown for this operation",
            maxLength: KeychainNames.reasonMaxLength
        )
    }

    // MARK: - Params

    struct StoreParams: Decodable {
        var name: String
        var value: String
        var requireAuth: Bool?
        var replace: Bool?
        var reason: String?
    }

    struct RetrieveParams: Decodable {
        var name: String
        var reason: String
    }

    // MARK: - Capabilities



    static func store(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.store",
                description: "Store a value (base64url, up to 16 KiB) as a Psyche item in the data-protection keychain, "
                    + "this device only. requireAuth (default true) gates reads behind Touch ID or the login password; "
                    + "false makes it readable without a prompt while the Mac is unlocked. Fails with "
                    + "conflict/duplicate_item if the name exists unless replace is true. The value is never echoed.",
                sideEffect: .write,
                inputSchema: Schema.object(
                    [
                        "name": nameSchema,
                        "value": Schema.string("The value, base64url", maxLength: 21_848),
                        "requireAuth": Schema.boolean("Require Touch ID / password to read (default true)"),
                        "replace": Schema.boolean("Replace an existing item (default false)"),
                        "reason": reasonSchema(false),
                    ],
                    required: ["name", "value"]
                ),
                receiptKind: "keychain_item"
            )
        ) { ctx in
            let p = try ctx.decode(StoreParams.self)
            _ = try KeychainNames.validateReason(p.reason, required: false)
            guard let value = Base64URL.decode(p.value) else { throw CapabilityError.invalidParams("value must be base64url", field: "value") }
            let requireAuth = p.requireAuth ?? true
            let replaced = try await vault.store(name: p.name, value: value, requireAuth: requireAuth, replace: p.replace ?? false)
            return CapabilityOutput(
                ["name": .string(p.name), "stored": true, "requireAuth": .bool(requireAuth), "replaced": .bool(replaced)],
                receipt: ReceiptDraft(
                    outcome: .ok, summary: replaced ? "Replaced keychain item \(p.name)" : "Stored keychain item \(p.name)",
                    externalRefs: ["name": .string(p.name)]
                )
            )
        }
    }

    static func retrieve(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.retrieve",
                description: "Read a Psyche keychain item (prompts Touch ID or the login password with reason when it was "
                    + "stored with requireAuth) and return its value, base64url. SECRET RESULT: never put `value` in "
                    + "model-visible text.",
                sideEffect: .read,
                inputSchema: Schema.object(["name": nameSchema, "reason": reasonSchema(true)], required: ["name", "reason"])
            )
        ) { ctx in
            let p = try ctx.decode(RetrieveParams.self)
            let reason = try KeychainNames.validateReason(p.reason, required: true) ?? ""
            let value = try await vault.retrieve(name: p.name, reason: reason)
            return CapabilityOutput(["name": .string(p.name), "value": .string(Base64URL.encode(value))])
        }
    }


    struct DeleteItemParams: Decodable {
        var name: String
        var reason: String?
    }

    static func deleteItem(_ vault: KeychainVault) -> Capability {
        Capability(CapabilitySpec(
            name: "keychain.delete_item",
            description: "Delete a Psyche item stored with keychain.store (system keychain mode). No prompt. "
                + "A missing item is not_found/item_not_found. Gateway-internal.",
            sideEffect: .destructive,
            inputSchema: Schema.object(["name": nameSchema, "reason": reasonSchema(false)], required: ["name"]),
            receiptKind: "keychain_item"
        )) { ctx in
            let p = try ctx.decode(DeleteItemParams.self)
            _ = try KeychainNames.validateReason(p.reason, required: false)
            try await vault.delete(.item(p.name))
            return CapabilityOutput(
                ["deleted": true, "name": .string(p.name)],
                receipt: ReceiptDraft(outcome: .ok, summary: "Deleted keychain item \(p.name)", externalRefs: ["name": .string(p.name)])
            )
        }
    }

    static func status(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.status",
                description: "Whether the data-protection keychain is usable (available | missing_entitlement | error: a "
                    + "build without a keychain access group entitlement reports missing_entitlement) and whether Touch ID "
                    + "and the login-password fallback are available. Never prompts.",
                sideEffect: .read,
                inputSchema: Schema.object([:])
            )
        ) { _ in
            CapabilityOutput(await vault.status().json)
        }
    }
}
