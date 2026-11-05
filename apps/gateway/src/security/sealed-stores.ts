import type { PermissionStore } from "@psyche/permissions";
import { PsycheError } from "@psyche/protocol";
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
  status?: unknown;
  updatedAt?: unknown;
}

/**
 * While untrusted, a channel row that is not genuine keeps existing (so nothing tries to create
 * it again) but lets nobody in: DMs disabled, no allowlists, no owner identities. Identities that
 * are not genuine are left out.
 */
function narrowed<C extends ChannelLike>(c: C): C {
  return { ...c, dmPolicy: "disabled", allowFrom: [], groupAllowFrom: [], ownerIds: [] };
}

/** Fields a save may change on a channel that is not genuine (M2: never its allowlists). */
const STATUS_FIELDS = new Set(["status", "updatedAt"]);

export function sealedChannelStore<
  S extends {
    listChannels(): Promise<ChannelLike[]>;
    getChannel(id: string): Promise<ChannelLike | undefined>;
    saveChannel(channel: never): Promise<ChannelLike>;
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
      if (prop === "saveChannel") {
        // M2: the service caches the narrowed view; saving it back (a status change) must not
        // wipe the stored allowlists and owners. A channel that is not genuine takes only a new
        // status; any other change waits for a re-seal.
        return async (c: ChannelLike) => {
          const save = t.saveChannel as unknown as (x: ChannelLike) => Promise<ChannelLike>;
          const stored = await t.getChannel(c.id);
          if (stored === undefined || ok("channels", c.id)) return save.call(t, c);
          const view = narrowed(stored) as unknown as Record<string, unknown>;
          const next = c as unknown as Record<string, unknown>;
          for (const k of new Set([...Object.keys(view), ...Object.keys(next)])) {
            if (STATUS_FIELDS.has(k)) continue;
            if (JSON.stringify(view[k]) !== JSON.stringify(next[k])) {
              throw new PsycheError(
                "unavailable",
                "This channel can't be changed while Psyche's security records are untrusted",
                { details: { reason: "state_untrusted" } },
              );
            }
          }
          return narrowed(
            await save.call(t, { ...stored, status: c.status, updatedAt: c.updatedAt }),
          );
        };
      }
      if (prop === "listIdentities") {
        return async () => (await t.listIdentities()).filter((i) => ok("identities", i.id));
      }
      return Reflect.get(t, prop, t);
    },
  });
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
