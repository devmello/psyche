import type { PermissionStore } from "@psyche/permissions";
import type { StateSeal } from "./state-seal.ts";

/**
 * Stores whose reads authorize something (the Permission Broker's grants and approvals, the
 * connector registry), wrapped so every call first checks the security-state seal
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

interface ConnectorStoreLike<R extends { id: string }> {
  get(id: string): Promise<R | undefined>;
  list(): Promise<R[]>;
}

/**
 * The connector registry's store (L1): checked before every call, and while untrusted a
 * connector row that is not genuine (its scope mode, its action matrix) is not there at all, so
 * no connector is brought back or run from it.
 */
export function sealedConnectorStore<R extends { id: string }, S extends ConnectorStoreLike<R>>(
  store: S,
  seal: Seal,
): S {
  const inner = sealedReads(store, seal);
  const ok = (id: string) => seal.untrusted() === null || seal.genuine("connectors", id);
  return new Proxy(inner, {
    get(t, prop) {
      if (prop === "get") {
        return async (id: string) => {
          const r = await t.get(id);
          return r !== undefined && ok(r.id) ? r : undefined;
        };
      }
      if (prop === "list") return async () => (await t.list()).filter((r) => ok(r.id));
      return Reflect.get(t, prop, t);
    },
  });
}
