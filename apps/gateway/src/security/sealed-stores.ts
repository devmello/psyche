import type { PermissionStore } from "@psyche/permissions";
import type { StateSeal } from "./state-seal.ts";

/**
 * Stores whose reads authorize something (the Permission Broker's grants and approvals, the
 * channel allowlists and identities), wrapped so every call first checks the security-state seal
 * (`StateSeal.ensure`: cheap unless another connection committed). A change made outside the
 * Gateway is undone before the store reads it, and while the seal is untrusted the rows it cannot
 * vouch for are not returned at all (a grant or approval nobody can prove is the owner's does not
 * authorize anything).
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

type Seal = Pick<StateSeal, "ensure" | "untrusted" | "rowTrusted" | "rowAcceptable">;

export function sealedPermissionStore(store: PermissionStore, seal: Seal): PermissionStore {
  const inner = sealedReads(store, seal);
  const grantOk = (id: string) => seal.untrusted() === null || seal.rowTrusted("grants", id);
  const approvalOk = (id: string) => seal.untrusted() === null || seal.rowTrusted("approvals", id);
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

/** Channel rows the seal knows were changed outside are left out while it is untrusted. */
export function sealedChannelStore<
  S extends {
    listChannels(): Promise<{ id: string }[]>;
    getChannel(id: string): Promise<{ id: string } | undefined>;
    listIdentities(): Promise<{ id: string }[]>;
  },
>(store: S, seal: Seal | undefined, ensure: () => void): S {
  const inner = sealedReads(store, { ensure });
  if (seal === undefined) return inner;
  // Untrusted since boot the rows are taken as stored (the channels must keep working; their
  // owner identities cannot widen presence or admin, which are closed then).
  const ok = (table: string, id: string) => seal.rowAcceptable(table, id);
  return new Proxy(inner, {
    get(t, prop) {
      if (prop === "listChannels") {
        return async () => (await t.listChannels()).filter((c) => ok("channels", c.id));
      }
      if (prop === "getChannel") {
        return async (id: string) => {
          const c = await t.getChannel(id);
          return c !== undefined && ok("channels", c.id) ? c : undefined;
        };
      }
      if (prop === "listIdentities") {
        return async () => (await t.listIdentities()).filter((i) => ok("identities", i.id));
      }
      return Reflect.get(t, prop, t);
    },
  });
}
