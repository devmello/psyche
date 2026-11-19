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
  LinkSetupStatus,
  OnePasswordRef,
  OnePasswordSetupStatus,
  OnePasswordTestResult,
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
    description:
      'Overwrites and deletes an item the owner created (any kind, external-manager links included), revokes its credential_fill grants and wipes secret env leases and unused fill handles drawn from it; audited. A Gateway-owned item (a provider key, a channel token, a connector\'s token) is refused forbidden with details {reason: "gateway_owned", kind, setting}: remove it through that setting. Side-effecting.',
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
  "vault.onePassword.status": defineMethod({
    params: Type.Object({ probe: Type.Optional(Type.Boolean()) }),
    result: OnePasswordSetupStatus,
    scope: "operator.admin",
    description:
      "Where the 1Password setup stands: op not installed, app integration off, locked, or signed in (with the account address and email). Finds and checks the op file (state found) without running it; op's account commands run only with probe true, or while connected (cached 60 s). Never reads an item or a secret; 1Password may show its own unlock prompt.",
  }),
  "vault.onePassword.test": defineMethod({
    params: Type.Object({}),
    result: OnePasswordTestResult,
    scope: "operator.admin",
    description:
      "Test connection: lists the account's vaults through op and returns how many there are. A harmless read: no names, no items, no secret values.",
  }),
  "vault.onePassword.connect": defineMethod({
    params: Type.Object({}),
    result: OnePasswordSetupStatus,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Lets linked 1Password items be read through the 1Password app's CLI integration, once op answers signed in. Psyche finds op itself (a real file owned by the user or root that others cannot write, outside its own data folder) and takes no path from the caller. Read-only, takes effect at once, audited. conflict while credentials.onePassword in config.json supplies the source. Side-effecting.",
  }),
  "vault.onePassword.disconnect": defineMethod({
    params: Type.Object({}),
    result: OnePasswordSetupStatus,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Stops reading 1Password through the app integration: linked items answer unavailable. Items already linked, and 1Password itself, are untouched. Side-effecting.",
  }),
  "payments.link.status": defineMethod({
    params: Type.Object({}),
    result: LinkSetupStatus,
    scope: "operator.read",
    description:
      "Where Stripe Link stands (Settings → Credentials → Payments): Link CLI not found, found, signed out, signing in or connected. Looks for the CLI in the usual npm locations and checks that it is safe to run; never installs anything. Carries no token.",
  }),
  "payments.link.connect": defineMethod({
    params: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1024 }),
      approvalId: Type.Optional(Id),
    }),
    result: LinkSetupStatus,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Saves the Link CLI Psyche may run, after checking that it resolves to a real file owned by the user or root and not writable by group or others, with the same for every parent folder. Running a program is a security change: needs fresh presence once the Gateway has a verifier (approval_required with details.approvalId, then retry with approvalId). Takes effect at once. Side-effecting.",
  }),
  "payments.link.signIn": defineMethod({
    params: Type.Object({}),
    result: LinkSetupStatus,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Starts Link's sign-in with the connected CLI and returns Link's own page (signIn.verificationUrl) and the phrase to compare. The owner signs in on that page; Psyche never sees a password. The Gateway watches for the result and publishes payments.link.changed. Side-effecting.",
  }),
  "payments.link.disconnect": defineMethod({
    params: Type.Object({
      /** Give up payments still open (cancelled where Link allows) instead of refusing. */
      force: Type.Optional(Type.Boolean()),
    }),
    result: LinkSetupStatus,
    scope: "operator.admin",
    sideEffecting: true,
    description:
      "Signs out of Link (best effort at Link, then deletes the auth file in the vault folder) and forgets the saved CLI. Fails conflict (details.reason payment_in_progress, with the merchants) while a payment is open, unless force is true, which gives those payments up and is audited. Narrowing, so admin only. Side-effecting.",
  }),
} as const;
