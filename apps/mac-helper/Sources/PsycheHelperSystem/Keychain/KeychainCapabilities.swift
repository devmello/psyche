import Foundation
import PsycheHelperCore
import PsycheProtocol

/// `keychain.*` capabilities (architecture §6, security §4.2, feature G1). Results never echo secret
/// values except `unwrap_key` (the DEK) and `retrieve` (the item); the Gateway must treat both as
/// secrets: never in model-visible text, tool results, logs or notifications.
public enum KeychainCapabilities {
    public static func make(vault: KeychainVault = KeychainVault()) -> [any CapabilityHandler] {
        [wrapKey(vault), unwrapKey(vault), store(vault), retrieve(vault), delete(vault), status(vault)]
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
