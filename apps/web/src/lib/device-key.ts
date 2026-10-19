import { toBase64Url } from "../client/encoding.ts";

/**
 * Ephemeral browser device identity: a WebCrypto Ed25519 key pair with a non-extractable private
 * key, held in memory only (stub: a reload creates a new device and a new pairing request).
 * S11 persists it in IndexedDB as a non-extractable CryptoKey and adds passkeys (INT-2).
 */
export interface WebDeviceKey {
  deviceId: string;
  publicKey: string;
  sign(payload: Uint8Array<ArrayBuffer>): Promise<string>;
}

export async function deviceIdFromRawPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `dev_${toBase64Url(digest).slice(0, 22)}`;
}

export async function createEphemeralDeviceKey(): Promise<WebDeviceKey> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
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
