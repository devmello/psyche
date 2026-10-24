import { toBase64Url } from "../client/encoding.ts";

/**
 * Browser device identity: a WebCrypto Ed25519 key pair whose private key is non-extractable,
 * kept in IndexedDB as CryptoKey objects (#554), so a browser stays one device across reloads and
 * keeps the passkeys it registered. Page script can sign with the key but never read it. Where
 * IndexedDB is unavailable (some private windows) the key lives in memory and a reload pairs a
 * new device, as before.
 */
export interface WebDeviceKey {
  deviceId: string;
  publicKey: string;
  sign(payload: Uint8Array<ArrayBuffer>): Promise<string>;
}

/** Where the key pair is kept between page loads. */
export interface DeviceKeyStore {
  load(): Promise<CryptoKeyPair | undefined>;
  /** Stores `pair` unless one is already there; returns the pair that is kept. */
  saveIfAbsent(pair: CryptoKeyPair): Promise<CryptoKeyPair>;
}

export async function deviceIdFromRawPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `dev_${toBase64Url(digest).slice(0, 22)}`;
}

function generatePair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

async function deviceKeyFrom(pair: CryptoKeyPair): Promise<WebDeviceKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    deviceId: await deviceIdFromRawPublicKey(raw),
    publicKey: toBase64Url(raw),
    async sign(payload) {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payload);
      return toBase64Url(new Uint8Array(sig));
    },
  };
}

export async function createEphemeralDeviceKey(): Promise<WebDeviceKey> {
  return deviceKeyFrom(await generatePair());
}

/**
 * This browser's device key: the stored one, else a new pair saved for next time. Two tabs
 * opening at once agree on one pair (the first save wins). A store that fails falls back to an
 * in-memory key for this page.
 */
export async function loadDeviceKey(
  store: DeviceKeyStore | undefined = indexedDbKeyStore(),
): Promise<WebDeviceKey> {
  if (store) {
    try {
      const kept = (await store.load()) ?? (await store.saveIfAbsent(await generatePair()));
      return await deviceKeyFrom(kept);
    } catch {
      // IndexedDB refused (quota, blocked, private mode): this page gets a key of its own.
    }
  }
  return createEphemeralDeviceKey();
}

const DB_NAME = "psyche";
const STORE = "device-key";
const KEY = "current";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function isKeyPair(v: unknown): v is CryptoKeyPair {
  const p = v as Partial<CryptoKeyPair> | undefined;
  return typeof p?.privateKey === "object" && typeof p?.publicKey === "object";
}

/** The key pair in this origin's IndexedDB; undefined where IndexedDB doesn't exist. */
export function indexedDbKeyStore(
  idb: IDBFactory | undefined = globalThis.indexedDB,
): DeviceKeyStore | undefined {
  if (!idb) return undefined;
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB blocked"));
    });
    return opened;
  };
  const load = async (): Promise<CryptoKeyPair | undefined> => {
    const db = await open();
    const got: unknown = await request(
      db.transaction(STORE, "readonly").objectStore(STORE).get(KEY),
    );
    return isKeyPair(got) ? got : undefined;
  };
  return {
    load,
    async saveIfAbsent(pair) {
      const db = await open();
      try {
        // `add` fails when another tab stored its pair first; that one is kept.
        await request(db.transaction(STORE, "readwrite").objectStore(STORE).add(pair, KEY));
        return pair;
      } catch {
        const kept = await load();
        if (kept) return kept;
        throw new Error("device key not stored");
      }
    },
  };
}
