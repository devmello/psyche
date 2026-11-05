import type { PermissionStore } from "@psyche/permissions";
import type { StateSeal } from "./state-seal.ts";

/**
 * Stores whose reads authorize something (the Permission Broker's grants and approvals, the
 * channel allowlists and identities), wrapped so every call first checks the security-state seal
 * (`StateSeal.ensure`: cheap unless another connection committed). A change made outside the
 * Gateway is undone before the store reads it. While the seal is untrusted the one rule applies:
 * a row authorizes something only if it is genuine (`StateSeal.genuine`).
 */
export function sealedReads<T extends object>(target: T, seal: { ensure(): void }): T {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        seal.ensure();
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
}

type Seal = Pick<StateSeal, "ensure" | "untrusted" | "genuine">;

export function sealedPermissionStore(store: PermissionStore, seal: Seal): PermissionStore {
  const inner = sealedReads(store, seal);
  const grantOk = (id: string) => seal.untrusted() === null || seal.genuine("grants", id);
  const approvalOk = (id: string) => seal.untrusted() === null || seal.genuine("approvals", id);
  return {
    transaction: (fn) => inner.transaction(fn),
    insertApproval: (rec) => inner.insertApproval(rec),
    updateApproval: (rec) => inner.updateApproval(rec),
    insertGrant: (rec) => inner.insertGrant(rec),
    updateGrant: (rec) => inner.updateGrant(rec),
    getApproval(id) {
      const r = inner.getApproval(id);
      return r !== undefined && approvalOk(id) ? r : undefined;
    },
    listApprovals(filter) {
      return inner.listApprovals(filter).filter((r) => approvalOk(r.approval.id));
    },
    getGrant(id) {
      const r = inner.getGrant(id);
      return r !== undefined && grantOk(id) ? r : undefined;
    },
    listGrants() {
      return inner.listGrants().filter((r) => grantOk(r.grant.id));
    },
  };
}

interface ChannelLike {
  id: string;
  dmPolicy?: unknown;
  allowFrom?: unknown;
  groupAllowFrom?: unknown;
  ownerIds?: unknown;
}

/**
 * While untrusted, a channel row that is not genuine keeps existing (so nothing tries to create
 * it again) but lets nobody in: DMs disabled, no allowlists, no owner identities. Identities that
 * are not genuine are left out.
 */
function narrowed<C extends ChannelLike>(c: C): C {
  return { ...c, dmPolicy: "disabled", allowFrom: [], groupAllowFrom: [], ownerIds: [] };
}

export function sealedChannelStore<
  S extends {
    listChannels(): Promise<ChannelLike[]>;
    getChannel(id: string): Promise<ChannelLike | undefined>;
    listIdentities(): Promise<{ id: string }[]>;
  },
>(store: S, seal: Seal | undefined, ensure: () => void): S {
  const inner = sealedReads(store, { ensure });
  if (seal === undefined) return inner;
  const ok = (table: string, id: string) => seal.untrusted() === null || seal.genuine(table, id);
  return new Proxy(inner, {
    get(t, prop) {
      if (prop === "listChannels") {
        return async () =>
          (await t.listChannels()).map((c) => (ok("channels", c.id) ? c : narrowed(c)));
      }
      if (prop === "getChannel") {
        return async (id: string) => {
          const c = await t.getChannel(id);
          return c === undefined || ok("channels", c.id) ? c : narrowed(c);
        };
      }
      if (prop === "listIdentities") {
        return async () => (await t.listIdentities()).filter((i) => ok("identities", i.id));
      }
      return Reflect.get(t, prop, t);
    },
  });
}
