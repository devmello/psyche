import type { MethodName, MethodParams, MethodResult } from "@psyche/protocol";
import { fail } from "./errors.ts";
import type { PaymentBroker } from "./payments/broker.ts";
import type { Vault } from "./vault.ts";

export interface VaultHandlerOptions {
  /** Stripe Link payments (G12); `vault.payments.*` answer `unavailable` without it. */
  payments?: PaymentBroker;
}

export type VaultMethodName = Extract<MethodName, `vault.${string}`>;

export type VaultHandlers = {
  [M in VaultMethodName]: (params: MethodParams<M>) => Promise<MethodResult<M>>;
};

/**
 * `vault.*` handlers for the Gateway's dispatcher (S01). The Gateway validates params and
 * scopes against the protocol registry first and must not log `vault.add` / `vault.update` /
 * `vault.import` / `vault.unlock` params (they carry secrets or the recovery key). Results never
 * carry values. Events: subscribe with `vault.on("vault.locked" | "vault.unlocked" |
 * "credential.updated", …)` and fan them out as event frames.
 */
export function createVaultHandlers(
  vault: Vault,
  options: VaultHandlerOptions = {},
): VaultHandlers {
  const payments = () => {
    if (options.payments === undefined) {
      return fail("unavailable", "Stripe Link is not set up", {
        reason: "payments_not_configured",
      });
    }
    return options.payments;
  };
  return {
    "vault.list": async ({ kind }) => ({
      credentials: (await vault.list()).filter((c) => kind === undefined || c.kind === kind),
    }),
    "vault.get": async ({ credentialId }) => {
      const credential = await vault.get(credentialId);
      if (credential === undefined) return fail("not_found", "credential not found");
      return { credential };
    },
    "vault.status": async () => ({ status: vault.status() }),
    "vault.setup": async ({ slot }) => {
      if (slot !== vault.primarySlot) {
        return fail("invalid_params", `this Gateway's vault slot is ${vault.primarySlot}`);
      }
      return vault.setup();
    },
    "vault.confirmRecovery": async ({ lastGroup }) => ({
      status: await vault.confirmRecovery(lastGroup),
    }),
    "vault.unlock": async ({ reason, recoveryKey }) => ({
      status:
        recoveryKey === undefined
          ? await vault.unlock(reason)
          : await vault.unlockWithRecovery(recoveryKey),
    }),
    "vault.lock": async () => ({ status: vault.lock("manual") }),
    "vault.add": async (p) => {
      const input: Parameters<Vault["add"]>[0] = {
        kind: p.kind,
        name: p.name,
        bindings: p.bindings,
        secret: p.secret,
      };
      if (p.slug !== undefined) input.slug = p.slug;
      if (p.requireAuthEachUse !== undefined) input.requireAuthEachUse = p.requireAuthEachUse;
      return { credential: await vault.add(input) };
    },
    "vault.update": async ({ credentialId, ...patch }) => {
      const input: Parameters<Vault["update"]>[1] = {};
      if (patch.name !== undefined) input.name = patch.name;
      if (patch.bindings !== undefined) input.bindings = patch.bindings;
      if (patch.secret !== undefined) input.secret = patch.secret;
      if (patch.requireAuthEachUse !== undefined)
        input.requireAuthEachUse = patch.requireAuthEachUse;
      return { credential: await vault.update(credentialId, input) };
    },
    "vault.delete": async ({ credentialId }) => ({ deleted: await vault.delete(credentialId) }),
    "vault.import": async ({ format, csv }) => {
      const { imported, skipped } = await vault.importCsv(csv, format);
      return { imported, skipped };
    },
    "vault.uses": async ({ credentialId, limit }) => ({ uses: vault.uses(credentialId, limit) }),
    "vault.linkExternal": async (p) => {
      if (p.source === "bitwarden") {
        return fail("unavailable", "Bitwarden is not configured", {
          reason: "external_unavailable",
        });
      }
      if (!("vault" in p.ref)) {
        return fail("invalid_params", "a 1Password reference needs the vault and the item");
      }
      return {
        credential: await vault.linkOnePassword({
          kind: p.kind,
          name: p.name,
          ...(p.slug === undefined ? {} : { slug: p.slug }),
          bindings: p.bindings,
          ref: p.ref,
          ...(p.fields === undefined ? {} : { fields: p.fields }),
        }),
      };
    },
    "vault.payments.list": async ({ limit, taskId }) => ({
      payments: payments().list({
        ...(limit === undefined ? {} : { limit }),
        ...(taskId === undefined ? {} : { taskId }),
      }),
    }),
    "vault.payments.methods": async () => ({ methods: await payments().methods() }),
  };
}
