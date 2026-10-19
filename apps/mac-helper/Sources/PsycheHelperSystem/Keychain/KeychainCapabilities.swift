import Foundation
import PsycheHelperCore
import PsycheProtocol

/// Keychain capabilities on S06's contract (`packages/vault` README "Mac helper contract"; security
/// §4.2; G1): `keychain.set`, `vault.unlock`, `keychain.delete`, plus `keychain.status`. The Gateway
/// seals the DEK itself; the helper only holds the KEK behind Touch ID. These are Gateway-internal:
/// no agent tool may reach them through `nodes.invoke`, and `vault.unlock`'s result is a secret.
/// (`wrapKey` / `store` on `KeychainVault` remain for helper-side use; they are not exposed.)
public enum KeychainCapabilities {
    public static func make(vault: KeychainVault = KeychainVault()) -> [any CapabilityHandler] {
        [set(vault), unlock(vault), deleteKey(vault), status(vault)]
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

    static let slotSchema = Schema.string("Vault key slot, ^[a-z0-9._-]{1,64}$", maxLength: KeychainNames.maxLength)
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

    struct WrapParams: Decodable {
        var slot: String
        var dek: String
        var replace: Bool?
        var reason: String?
    }

    struct UnwrapParams: Decodable {
        var slot: String
        var wrapped: String
        var reason: String
    }

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

    struct DeleteParams: Decodable {
        var slot: String?
        var name: String?
        var reason: String?
    }

    // MARK: - Capabilities

    static func wrapKey(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.wrap_key",
                description: "Create a vault key slot: generate a random 256-bit key-encryption key in the data-protection "
                    + "keychain (Touch ID or login password to read, this device only, never synced) and return the given "
                    + "32-byte DEK wrapped under it (AES-256-GCM, v1 blob, base64url). No prompt at creation. Fails with "
                    + "conflict/duplicate_item if the slot exists unless replace is true, which makes blobs previously "
                    + "wrapped for the slot unopenable (keep the recovery slot).",
                sideEffect: .write,
                inputSchema: Schema.object(
                    [
                        "slot": slotSchema,
                        "dek": Schema.string("The 32-byte data-encryption key, base64url", maxLength: 64),
                        "replace": Schema.boolean("Replace an existing slot (default false)"),
                        "reason": reasonSchema(false),
                    ],
                    required: ["slot", "dek"]
                ),
                receiptKind: "vault_key"
            )
        ) { ctx in
            let p = try ctx.decode(WrapParams.self)
            _ = try KeychainNames.validateReason(p.reason, required: false)
            guard let dek = Base64URL.decode(p.dek) else { throw CapabilityError.invalidParams("dek must be base64url", field: "dek") }
            let out = try await vault.wrapKey(slot: p.slot, dek: dek, replace: p.replace ?? false)
            return CapabilityOutput(
                ["slot": .string(p.slot), "wrapped": .string(out.wrapped), "version": .int(Int(KeyWrap.version)), "replaced": .bool(out.replaced)],
                receipt: ReceiptDraft(
                    outcome: .ok, summary: out.replaced ? "Replaced vault key slot \(p.slot)" : "Created vault key slot \(p.slot)",
                    externalRefs: ["slot": .string(p.slot)]
                )
            )
        }
    }

    static func unwrapKey(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.unwrap_key",
                description: "Unwrap a vault DEK: read the slot's key-encryption key (prompts Touch ID or the login password "
                    + "with reason) and return the DEK, base64url. SECRET RESULT: the Gateway must hold `dek` only in memory "
                    + "and never put it in model-visible text, tool results, logs or notifications. Errors: "
                    + "cancelled/user_cancelled, not_found/item_not_found (also after Touch ID re-enrolment invalidated the "
                    + "slot: use the recovery key), unavailable/missing_entitlement.",
                sideEffect: .read,
                inputSchema: Schema.object(
                    [
                        "slot": slotSchema,
                        "wrapped": Schema.string("The blob keychain.wrap_key returned", maxLength: 128),
                        "reason": reasonSchema(true),
                    ],
                    required: ["slot", "wrapped", "reason"]
                )
            )
        ) { ctx in
            let p = try ctx.decode(UnwrapParams.self)
            let reason = try KeychainNames.validateReason(p.reason, required: true) ?? ""
            let dek = try await vault.unwrapKey(slot: p.slot, wrapped: p.wrapped, reason: reason)
            return CapabilityOutput(["slot": .string(p.slot), "dek": .string(Base64URL.encode(dek))])
        }
    }

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

    static func delete(_ vault: KeychainVault) -> Capability {
        Capability(
            CapabilitySpec(
                name: "keychain.delete",
                description: "Delete a vault key slot (slot) or a Psyche keychain item (name); exactly one of the two. "
                    + "Deleting a slot makes every blob wrapped for it unopenable except through the recovery key.",
                sideEffect: .destructive,
                inputSchema: Schema.object(["slot": slotSchema, "name": nameSchema, "reason": reasonSchema(false)]),
                receiptKind: "keychain_item"
            )
        ) { ctx in
            let p = try ctx.decode(DeleteParams.self)
            _ = try KeychainNames.validateReason(p.reason, required: false)
            let target: KeychainVault.Target
            switch (p.slot, p.name) {
            case (let slot?, nil): target = .slot(slot)
            case (nil, let name?): target = .item(name)
            default: throw CapabilityError.invalidParams("pass exactly one of slot or name")
            }
            try await vault.delete(target)
            let (kind, id, summary): (String, String, String) =
                switch target {
                case .slot(let s): ("slot", s, "Deleted vault key slot \(s)")
                case .item(let n): ("item", n, "Deleted keychain item \(n)")
                }
            return CapabilityOutput(
                ["deleted": true, "kind": .string(kind), "id": .string(id)],
                receipt: ReceiptDraft(outcome: .ok, summary: summary, externalRefs: [kind: .string(id)])
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
