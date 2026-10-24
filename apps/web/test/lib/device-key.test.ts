import { describe, expect, it } from "vitest";
import { lazyDeviceKey } from "../../src/gateway.ts";
import { type DeviceKeyStore, indexedDbKeyStore, loadDeviceKey } from "../../src/lib/device-key.ts";

/** IndexedDB's contract for one key: `add` refuses when a pair is already there. */
function memoryStore(): DeviceKeyStore & { saves: number } {
  let kept: CryptoKeyPair | undefined;
  return {
    saves: 0,
    async load() {
      return kept;
    },
    async saveIfAbsent(pair) {
      this.saves++;
      kept ??= pair;
      return kept;
    },
  };
}

/** Just enough IndexedDB for one object store: async requests, `add` refusing an existing key. */
function fakeIndexedDb(): IDBFactory {
  const rows = new Map<string, unknown>();
  let created = false;
  const req = <T>(run: () => T) => {
    const r: { result?: T; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
    setTimeout(() => {
      try {
        r.result = run();
        r.onsuccess?.();
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    });
    return r;
  };
  const db = {
    createObjectStore: () => {
      created = true;
    },
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => req(() => rows.get(k)),
        add: (v: unknown, k: string) =>
          req(() => {
            if (rows.has(k)) throw new Error("ConstraintError");
            rows.set(k, v);
            return k;
          }),
      }),
    }),
  };
  return {
    open: () => {
      const r: Record<string, unknown> & { result?: unknown } = {};
      setTimeout(() => {
        r.result = db;
        if (!created) (r.onupgradeneeded as () => void)();
        (r.onsuccess as () => void)();
      });
      return r;
    },
  } as unknown as IDBFactory;
}

describe("browser device key (#554)", () => {
  it("keeps the pair in IndexedDB; a second tab's save keeps the first pair", async () => {
    const idb = fakeIndexedDb();
    const tab1 = indexedDbKeyStore(idb);
    const tab2 = indexedDbKeyStore(idb);
    const first = await loadDeviceKey(tab1);
    expect((await loadDeviceKey(tab2)).deviceId).toBe(first.deviceId);
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const kept = await tab2?.saveIfAbsent(other);
    expect(kept).not.toBe(other);
    expect((await loadDeviceKey(indexedDbKeyStore(idb))).deviceId).toBe(first.deviceId);
  });

  it("is the same device across page loads and keeps the private key non-extractable", async () => {
    const store = memoryStore();
    const first = await loadDeviceKey(store);
    const reload = await loadDeviceKey(store);
    expect(reload.deviceId).toBe(first.deviceId);
    expect(reload.publicKey).toBe(first.publicKey);
    expect(store.saves).toBe(1);
    const pair = await store.load();
    expect(pair?.privateKey.extractable).toBe(false);
  });

  it("signs with the stored key across loads", async () => {
    const store = memoryStore();
    const a = await loadDeviceKey(store);
    const b = await loadDeviceKey(store);
    const payload = new TextEncoder().encode("challenge");
    const pub = await crypto.subtle.importKey(
      "raw",
      Buffer.from(a.publicKey, "base64url"),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sig = Buffer.from(await b.sign(payload), "base64url");
    await expect(crypto.subtle.verify({ name: "Ed25519" }, pub, sig, payload)).resolves.toBe(true);
  });

  it("two tabs opening at once agree on the first pair stored", async () => {
    const store = memoryStore();
    const [a, b] = await Promise.all([loadDeviceKey(store), loadDeviceKey(store)]);
    expect(a.deviceId).toBe(b.deviceId);
  });

  it("falls back to a key for this page when there is no store or it fails", async () => {
    expect(indexedDbKeyStore(undefined)).toBeUndefined();
    const none = await loadDeviceKey(undefined);
    expect(none.deviceId).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    const broken: DeviceKeyStore = {
      load: () => Promise.reject(new Error("blocked")),
      saveIfAbsent: () => Promise.reject(new Error("blocked")),
    };
    const fallback = await loadDeviceKey(broken);
    expect(fallback.deviceId).toMatch(/^dev_/);
  });

  it("the page loads the key once for the connection and passkeys", async () => {
    let loads = 0;
    const key = lazyDeviceKey(() => {
      loads++;
      return loadDeviceKey(undefined);
    });
    const [a, b] = await Promise.all([key(), key()]);
    expect(a).toBe(b);
    expect(loads).toBe(1);
  });
});
