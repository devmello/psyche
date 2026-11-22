import {
  createHmac,
  randomBytes,
  randomInt,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  normalizeSetupCode,
  SETUP_CODE_ALPHABET,
  SETUP_CODE_LENGTH,
  SETUP_CODE_TTL_MS,
} from "./claim.ts";
import { PsycheError } from "./errors.ts";

/**
 * The Node half of claiming a server (remote-gateway design §3.6): the key derived from the setup
 * code, the two proofs, and the code file the Gateway and `psyche setup code` share. Node-only
 * (`node:crypto`, `node:fs`): import it as `@psyche/protocol/claim-node`, never from a page.
 *
 * The primitive is a mutual HMAC over a transcript, keyed by scrypt of the code. It is not a PAKE:
 * whoever sees one side's proof (an impostor server the client talked to) can test guesses of the
 * code offline. The code has 50 bits and scrypt makes each guess cost about 32 MiB and tens of
 * milliseconds, and a code is single-use and lasts a day, so that search does not finish while
 * the code means anything. No audited SPAKE2 or OPAQUE package is in the tree, and a hand-rolled
 * PAKE is the thing not to do.
 */

/**
 * Fixed on both sides, never taken from the wire: a server cannot talk a client into a cheaper
 * derivation (which would make its proof cheaper to attack offline).
 */
export const CLAIM_KDF = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, maxmem: 64 * 1024 * 1024 } as const;
export const CLAIM_SALT_BYTES = 16;

/** scrypt(normalized code, salt). Rejects a code that does not normalize. */
export function deriveClaimKey(code: string, salt: Buffer): Promise<Buffer> {
  const normalized = normalizeSetupCode(code);
  if (normalized === null) {
    return Promise.reject(new PsycheError("invalid_params", "not a setup code"));
  }
  const opts: ScryptOptions = {
    N: CLAIM_KDF.N,
    r: CLAIM_KDF.r,
    p: CLAIM_KDF.p,
    maxmem: CLAIM_KDF.maxmem,
  };
  return new Promise((resolve, reject) => {
    scrypt(normalized, salt, CLAIM_KDF.keyLen, opts, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * One side's proof: HMAC-SHA256(key, role + "\n" + transcript), base64url. The role keeps one
 * side's proof from being sent back as the other's.
 */
export function claimProof(key: Buffer, role: "client" | "server", transcript: string): string {
  return createHmac("sha256", key).update(`${role}\n${transcript}`).digest("base64url");
}

/** Constant-time comparison of two base64url proofs. */
export function proofsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "base64url");
  const y = Buffer.from(b, "base64url");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** A new code from the system's random source, unformatted (`7K3QMXR2TD`). */
export function randomSetupCode(): string {
  let out = "";
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) {
    out += SETUP_CODE_ALPHABET[randomInt(SETUP_CODE_ALPHABET.length)];
  }
  return out;
}

/** `$PSYCHE_HOME/identity/setup-code.json`: the code's salt and derived key, never the code. */
export function setupCodePath(home: string): string {
  return join(home, "identity", "setup-code.json");
}

/** `$PSYCHE_HOME/identity/claimed.json`: written once the server has an admin device. */
export function claimedMarkerPath(home: string): string {
  return join(home, "identity", "claimed.json");
}

export interface StoredSetupCode {
  salt: Buffer;
  /** scrypt of the code: what the server keys its proof with. A secret like the code itself. */
  key: Buffer;
  createdAt: string;
  expiresAt: string;
}

/** Writes `text` to `path` with mode 0600 through a temporary file and a rename. */
function writePrivate(path: string, text: string): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Makes a new setup code and replaces any earlier one (it stops working). Only the salt and the
 * derived key are written, at 0600; the code itself is returned to be shown once.
 */
export async function makeSetupCode(
  home: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const code = randomSetupCode();
  const salt = randomBytes(CLAIM_SALT_BYTES);
  const key = await deriveClaimKey(code, salt);
  const expiresAt = new Date(now.getTime() + SETUP_CODE_TTL_MS).toISOString();
  writePrivate(
    setupCodePath(home),
    `${JSON.stringify({
      v: 1,
      salt: salt.toString("base64url"),
      key: key.toString("base64url"),
      createdAt: now.toISOString(),
      expiresAt,
    })}\n`,
  );
  return { code, expiresAt };
}

/** The stored code, `"expired"` once its day is over, or `null` when there is none (or it is unreadable). */
export function readSetupCode(
  home: string,
  now: Date = new Date(),
): StoredSetupCode | "expired" | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(setupCodePath(home), "utf8"));
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r !== "object" ||
    r === null ||
    r.v !== 1 ||
    typeof r.salt !== "string" ||
    typeof r.key !== "string" ||
    typeof r.createdAt !== "string" ||
    typeof r.expiresAt !== "string"
  ) {
    return null;
  }
  const salt = Buffer.from(r.salt, "base64url");
  const key = Buffer.from(r.key, "base64url");
  const expires = Date.parse(r.expiresAt);
  if (
    salt.length !== CLAIM_SALT_BYTES ||
    key.length !== CLAIM_KDF.keyLen ||
    Number.isNaN(expires)
  ) {
    return null;
  }
  if (now.getTime() >= expires) return "expired";
  return { salt, key, createdAt: r.createdAt, expiresAt: r.expiresAt };
}

/** Removes the code: it was used, or the server was set up another way. */
export function removeSetupCode(home: string): void {
  rmSync(setupCodePath(home), { force: true });
}

export function isClaimedHome(home: string): boolean {
  return existsSync(claimedMarkerPath(home));
}

/** Records that the server is set up (`via`: `claim` from the app, `terminal` otherwise). */
export function markClaimed(home: string, via: "claim" | "terminal", now: Date = new Date()): void {
  if (isClaimedHome(home)) return;
  writePrivate(
    claimedMarkerPath(home),
    `${JSON.stringify({ v: 1, via, at: now.toISOString() })}\n`,
  );
}
