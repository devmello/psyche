import { Type } from "@sinclair/typebox";
import { Id, StringEnum } from "../common.ts";
import {
  BitwardenRef,
  CredentialBinding,
  CredentialKind,
  CredentialMeta,
  CredentialSecretInput,
  CredentialUse,
  LinkPaymentMethod,
  OnePasswordRef,
  VaultPayment,
  VaultStatus,
} from "../schemas/integrations.ts";
import { defineMethod } from "./define.ts";

/** `vault.*` (data model §6; security §4). */

const Slug = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" });

/**
 * Vault metadata and management. Secret values travel only client → Gateway (`vault.add`,
 * `vault.update`, `vault.import`); no result or event carries one. Fills happen inside the
 * broker. Unlocking is a device action: the agent has no tool for it.
 */
export const VaultMethods = {
  "vault.list": defineMethod({
    params: Type.Object({ kind: Type.Optional(CredentialKind) }),
    result: Type.Object({ credentials: Type.Array(CredentialMeta) }),
    scope: "operator.read",
    description: "Lists credential metadata (never values).",
  }),
  "vault.get": defineMethod({
    params: Type.Object({ credentialId: Id }),
    result: Type.Object({ credential: CredentialMeta }),
    scope: "operator.read",
    description: "Returns one credential's metadata (never its value).",
  }),
  "vault.status": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ status: VaultStatus }),
    scope: "operator.read",
    description:
      "Returns whether the vault exists and is locked, its key slots and idle lock time.",
  }),
  "vault.setup": defineMethod({
    params: Type.Object({ slot: StringEnum(["keychain", "safe_storage", "key_file"]) }),
    result: Type.Object({
      status: VaultStatus,
      /** Shown once; never stored by the Gateway in plaintext. */
      recoveryKey: Type.String(),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Creates the vault with a random key wrapped by the chosen slot plus a recovery key, returned once. Side-effecting.",
  }),
  "vault.confirmRecovery": defineMethod({
    params: Type.Object({
      /** The last group of the recovery key, typed back by the owner. */
      lastGroup: Type.String({ minLength: 1 }),
    }),
    result: Type.Object({ status: VaultStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Completes setup once the owner proves the recovery key is stored. Side-effecting.",
  }),
  "vault.unlock": defineMethod({
    params: Type.Object({
      /** Shown in the Touch ID / password prompt. */
      reason: Type.String({ minLength: 1, maxLength: 200 }),
      /** Unlock with the recovery key instead (after biometric re-enrollment or a restore). */
      recoveryKey: Type.Optional(Type.String()),
    }),
    result: Type.Object({ status: VaultStatus }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Unlocks the vault through its key slot (Touch ID on macOS) or the recovery key. Side-effecting.",
  }),
  "vault.lock": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ status: VaultStatus }),
    scope: "operator.write",
    sideEffecting: true,
    description: "Locks the vault and zeroizes the key in memory. Side-effecting.",
  }),
  "vault.add": defineMethod({
    params: Type.Object({
      kind: CredentialKind,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      slug: Type.Optional(Slug),
      bindings: Type.Array(CredentialBinding),
      secret: CredentialSecretInput,
      requireAuthEachUse: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ credential: CredentialMeta }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Adds an item. Card numbers, CVVs, bank account numbers and government ids are refused (policy_denied). Side-effecting.",
  }),
  "vault.update": defineMethod({
    params: Type.Object({
      credentialId: Id,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      bindings: Type.Optional(Type.Array(CredentialBinding)),
      /** Replaces the given secret fields; omitted fields are kept. */
      secret: Type.Optional(CredentialSecretInput),
      requireAuthEachUse: Type.Optional(Type.Boolean()),
    }),
    result: Type.Object({ credential: CredentialMeta }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Edits an item's name, bindings or secret fields. Side-effecting.",
  }),
  "vault.delete": defineMethod({
    params: Type.Object({ credentialId: Id }),
    result: Type.Object({ deleted: Type.Boolean() }),
    scope: "operator.admin",
    sideEffecting: true,
    description: "Overwrites and deletes an item. Side-effecting.",
  }),
  "vault.import": defineMethod({
    params: Type.Object({
      format: StringEnum(["auto", "1password", "bitwarden", "chrome"]),
      csv: Type.String({ maxLength: 10_000_000 }),
    }),
    result: Type.Object({
      imported: Type.Array(CredentialMeta),
      skipped: Type.Array(Type.Object({ row: Type.Integer(), reason: Type.String() })),
    }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Imports a CSV export from 1Password, Bitwarden or Chrome; refused rows are reported, never their values. Side-effecting.",
  }),
  "vault.uses": defineMethod({
    params: Type.Object({
      credentialId: Id,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
    }),
    result: Type.Object({ uses: Type.Array(CredentialUse) }),
    scope: "operator.read",
    description: "Lists an item's recent fills and denials, newest first (default 50).",
  }),
  "vault.linkExternal": defineMethod({
    params: Type.Object({
      source: StringEnum(["1password", "bitwarden"]),
      kind: StringEnum(["login", "api_key", "ssh_key", "note"]),
      name: Type.String({ minLength: 1, maxLength: 200 }),
      slug: Type.Optional(Slug),
      bindings: Type.Array(CredentialBinding),
      /** `{vault, item}` for 1Password, `{item}` for Bitwarden. */
      ref: Type.Union([OnePasswordRef, BitwardenRef]),
      /** Fields the item offers; default by kind (login: username + password). */
      fields: Type.Optional(
        Type.Array(StringEnum(["username", "password", "totp", "token", "privateKey", "text"]), {
          minItems: 1,
        }),
      ),
    }),
    result: Type.Object({ credential: CredentialMeta }),
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Links an item held in 1Password (G10) or Bitwarden (G11) by reference: Psyche stores the item's names or id, never a value, and reads one field at fill time. Side-effecting.",
  }),
  "vault.payments.list": defineMethod({
    params: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      taskId: Type.Optional(Id),
    }),
    result: Type.Object({ payments: Type.Array(VaultPayment) }),
    scope: "operator.read",
    description:
      "Lists Stripe Link payments, newest first, with their hold / capture / refund state and merchant references; brand and last4 only.",
  }),
  "vault.payments.methods": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ methods: Type.Array(LinkPaymentMethod) }),
    scope: "operator.read",
    description: "Lists the owner's Link payment methods (redacted) that can fund purchases.",
  }),
} as const;
