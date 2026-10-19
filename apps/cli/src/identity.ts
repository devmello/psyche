import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.ts";

/**
 * The CLI's device identity (security §10): an Ed25519 key pair the CLI signs every
 * `connect.verify` with. Stored at `$PSYCHE_HOME/cli/device.json`, directory 0700, file 0600.
 * The private key never leaves this file; the Gateway learns only the public key.
 */
export interface Identity {
  deviceId: string;
  name: string;
  /** base64url raw Ed25519 public key (32 bytes). */
  publicKey: string;
  sign(payload: Uint8Array): string;
}

interface StoredIdentity {
  version: 1;
  deviceId: string;
  name: string;
  publicKey: string;
  /** base64url PKCS#8 DER. */
  privateKey: string;
  createdAt: string;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (architecture: ids are ULIDs in production). */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

export function identityPath(home: string): string {
  return join(home, "cli", "device.json");
}

function fromStored(stored: StoredIdentity): Identity {
  const key: KeyObject = createPrivateKey({
    key: Buffer.from(stored.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    deviceId: stored.deviceId,
    name: stored.name,
    publicKey: stored.publicKey,
    sign: (payload) => sign(null, payload, key).toString("base64url"),
  };
}

export function loadIdentity(home: string): Identity | null {
  const path = identityPath(home);
  if (!existsSync(path)) return null;
  let stored: StoredIdentity;
  try {
    stored = JSON.parse(readFileSync(path, "utf8")) as StoredIdentity;
  } catch {
    throw new CliError("failure", `Unreadable CLI identity at ${path}; delete it to re-pair`);
  }
  if (stored.version !== 1 || !stored.privateKey || !stored.publicKey || !stored.deviceId) {
    throw new CliError("failure", `Invalid CLI identity at ${path}; delete it to re-pair`);
  }
  return fromStored(stored);
}

/** Loads the identity, creating it (0600) on first use. */
export function loadOrCreateIdentity(home: string, now = new Date()): Identity {
  const existing = loadIdentity(home);
  if (existing) return existing;
  const dir = join(home, "cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const stored: StoredIdentity = {
    version: 1,
    deviceId: ulid(now.getTime()),
    name: `psyche CLI on ${hostname().slice(0, 100)}`,
    publicKey: String(jwk.x),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    createdAt: now.toISOString(),
  };
  const path = identityPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return fromStored(stored);
}
