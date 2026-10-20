import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { ulid } from "ulid";

/**
 * The node's device identity (security §10): an Ed25519 key that never leaves this machine and
 * a device id. The Gateway pairs the *key*; scopes are chosen by the owner, never by the node.
 */
export interface NodeIdentity {
  deviceId: string;
  /** base64url raw 32-byte public key, as `connect` expects. */
  publicKey: string;
  sign(payload: Uint8Array): string;
}

interface StoredIdentity {
  version: 1;
  deviceId: string;
  publicKey: string;
  /** PKCS#8 DER, base64url. */
  privateKey: string;
}

export function identityPath(home: string): string {
  return join(home, "identity.json");
}

function fromStored(stored: StoredIdentity): NodeIdentity {
  const key = createPrivateKey({
    key: Buffer.from(stored.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    deviceId: stored.deviceId,
    publicKey: stored.publicKey,
    sign: (payload) => sign(null, payload, key).toString("base64url"),
  };
}

/** A fresh identity in memory (tests, `--ephemeral`). */
export function generateIdentity(deviceId: string = ulid()): NodeIdentity {
  return fromStored(generateStored(deviceId));
}

function generateStored(deviceId: string): StoredIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new PsycheError("internal", "Ed25519 export failed");
  return {
    version: 1,
    deviceId,
    publicKey: jwk.x,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

/**
 * Loads `<home>/identity.json`, creating it (mode 0600, written atomically) on first run. A
 * file readable by group or others is refused: the key is the node's whole authority.
 */
export function loadOrCreateIdentity(home: string): NodeIdentity {
  const path = identityPath(home);
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      throw new PsycheError(
        "forbidden",
        `${path} is mode ${mode.toString(8)}; it must be 0600 (chmod 600 ${path})`,
      );
    }
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredIdentity;
    if (stored.version !== 1 || !stored.deviceId || !stored.publicKey || !stored.privateKey) {
      throw new PsycheError("invalid_params", `${path} is not a psyche-node identity file`);
    }
    return fromStored(stored);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stored = generateStored(ulid());
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return fromStored(stored);
}
