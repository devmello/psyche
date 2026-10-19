import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Device identity for the desktop shell: an Ed25519 key pair persisted as JSON with mode 0600.
 * Bootstrap only: S11/S06 move the private key into the macOS keychain (security §4, §10).
 */
export interface DeviceKey {
  deviceId: string;
  /** base64url raw 32-byte Ed25519 public key (the JWK `x`). */
  publicKey: string;
  privateKey: KeyObject;
}

interface DeviceKeyFile {
  v: 1;
  deviceId: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; d: string };
}

/** Stable id derived from the public key: `dev_` + first 22 base64url chars of SHA-256(raw key). */
export function deviceIdFromPublicKey(publicKeyB64Url: string): string {
  const raw = Buffer.from(publicKeyB64Url, "base64url");
  return `dev_${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}`;
}

function fromFile(file: DeviceKeyFile): DeviceKey {
  const privateKey = createPrivateKey({ key: file.jwk, format: "jwk" });
  return { deviceId: file.deviceId, publicKey: file.jwk.x, privateKey };
}

export function generateDeviceKey(): { key: DeviceKey; file: DeviceKeyFile } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string")
    throw new Error("ed25519 jwk export failed");
  const file: DeviceKeyFile = {
    v: 1,
    deviceId: deviceIdFromPublicKey(jwk.x),
    jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d },
  };
  return { key: fromFile(file), file };
}

function isDeviceKeyFile(value: unknown): value is DeviceKeyFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<DeviceKeyFile>;
  return (
    v.v === 1 &&
    typeof v.deviceId === "string" &&
    typeof v.jwk?.x === "string" &&
    typeof v.jwk?.d === "string"
  );
}

/** Load the key at `path`, or create it (directory 0700, file 0600, atomic rename). */
export function loadOrCreateDeviceKey(path: string): DeviceKey {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isDeviceKeyFile(parsed)) {
      chmodSync(path, 0o600);
      return fromFile(parsed);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err instanceof SyntaxError))
      throw err;
  }
  const { key, file } = generateDeviceKey();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return key;
}

/** Ed25519 signature, base64url. */
export function signWithDeviceKey(key: DeviceKey, payload: Uint8Array): string {
  return sign(null, payload, key.privateKey).toString("base64url");
}

/** `DevicePlatform` for this desktop build (macOS first; Linux desktops are a later target). */
export function platformFromNode(platform: NodeJS.Platform): "macos" | "linux" {
  return platform === "darwin" ? "macos" : "linux";
}
