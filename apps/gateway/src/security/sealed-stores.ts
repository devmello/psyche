import type { PermissionStore } from "@psyche/permissions";

/**
 * Stores whose reads authorize something (the Permission Broker's grants and approvals, the
 * channel allowlists and identities), wrapped so every call first checks the security-state seal
 * (`StateSeal.ensure`: one `PRAGMA data_version`, a full check only after another connection
 * committed). A change made outside the Gateway is undone before the store reads it.
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

export function sealedPermissionStore(
  store: PermissionStore,
  seal: { ensure(): void },
): PermissionStore {
  return sealedReads(store, seal);
}
