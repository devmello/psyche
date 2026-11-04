import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PsycheError } from "@psyche/protocol";

/**
 * The Gateway identity key (remote-gateway design §3.3): a long-lived Ed25519 key created at first
 * start, which signs every connect challenge so a client that pinned the public key can tell this
 * Gateway from anything else that answers at the same address. It lives in
 * `$PSYCHE_HOME/identity/gateway.key` (directory 0700, file 0600), outside the vault because the
 * Gateway needs it before the vault unlocks. Shared by the desktop client and the future phone.
 */
export interface GatewayIdentity {
  /** base64url raw 32-byte Ed25519 public key (the JWK `x`). */
  publicKey: string;
  /** `sha256:<hex>` of the raw public key: what the owner compares on the pairing card. */
  fingerprint: string;
  /** Ed25519 signature, base64url. */
  sign(payload: Uint8Array): string;
}

interface IdentityFile {
  v: 1;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string; d: string };
}

export function identityKeyPath(home: string): string {
  return join(home, "identity", "gateway.key");
}

/** `sha256:<hex>` of a raw public key given as base64url. Same format as a device key's. */
export function identityFingerprint(publicKeyB64url: string): string {
  const raw = Buffer.from(publicKeyB64url, "base64url");
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

function fromJwk(jwk: IdentityFile["jwk"]): GatewayIdentity {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  } catch {
    // OpenSSL on Linux checks the pair at import ("Invalid JWK OKP key"); macOS does not.
    throw new PsycheError(
      "internal",
      "identity/gateway.key: the key is invalid or its public key does not match the private",
    );
  }
  // The file's public half must be the private key's: a hand-edited file must not make the
  // Gateway sign with one key while advertising another.
  const derived = createPublicKey(privateKey).export({ format: "jwk" }).x;
  if (derived !== jwk.x) {
    throw new PsycheError(
      "internal",
      "identity/gateway.key: public key does not match the private",
    );
  }
  return {
    publicKey: jwk.x,
    fingerprint: identityFingerprint(jwk.x),
    sign: (payload) => sign(null, payload, privateKey).toString("base64url"),
  };
}

function isIdentityFile(value: unknown): value is IdentityFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<IdentityFile>;
  return (
    v.v === 1 &&
    v.jwk?.kty === "OKP" &&
    v.jwk.crv === "Ed25519" &&
    typeof v.jwk.x === "string" &&
    typeof v.jwk.d === "string"
  );
}

/**
 * Loads the identity, creating it on first start (atomic rename, 0600). A file that exists but
 * cannot be read as a key is an error, never a fresh key: replacing the identity must be loud
 * (every pinned client then stops), so it only happens by `rotateIdentity` or by deleting the
 * file on purpose.
 */
export function loadOrCreateGatewayIdentity(home: string): GatewayIdentity {
  const path = identityKeyPath(home);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PsycheError(
        "internal",
        `${path} is not valid JSON; refusing to replace the Gateway identity`,
      );
    }
    if (!isIdentityFile(parsed)) {
      throw new PsycheError(
        "internal",
        `${path} is not a Gateway identity file; refusing to replace it`,
      );
    }
    chmodSync(path, 0o600);
    return fromJwk(parsed.jwk);
  }
  return writeNewIdentity(path, home, false);
}

/** Replaces the identity with a new key. Every client that pinned the old one must pair again. */
export function rotateGatewayIdentity(home: string): GatewayIdentity {
  return writeNewIdentity(identityKeyPath(home), home, true);
}

/**
 * Writes the file complete, then puts it in place: a first start links it (which fails if a file
 * appeared meanwhile, and the winner's key is then read, never replaced), a rotation renames over
 * the old one. There is never a moment with no identity file, and no partial one.
 */
function writeNewIdentity(path: string, home: string, replace: boolean): GatewayIdentity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new PsycheError("internal", "ed25519 jwk export failed");
  }
  const file: IdentityFile = { v: 1, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d } };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // A leftover from a crash is ours to replace; the file itself is created exclusively, written
    // and flushed, and so is the directory entry, before it is put in place.
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(file)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) {
      renameSync(tmp, path);
    } else {
      try {
        linkSync(tmp, path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          rmSync(tmp, { force: true });
          return loadOrCreateGatewayIdentity(home);
        }
        throw err;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const dirFd = openSync(dirname(path), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return fromJwk(file.jwk);
}
