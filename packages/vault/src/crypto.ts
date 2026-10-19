import {
  argon2Sync,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { fail } from "./errors.ts";

/** Data-encryption key length: SQLCipher takes a raw 256-bit key (security §4.1). */
export const DEK_BYTES = 32;

export function randomKey(bytes = DEK_BYTES): Buffer {
  return randomBytes(bytes);
}

/** Overwrite a key buffer in place. */
export function zeroize(buf: Buffer | Uint8Array | undefined): void {
  buf?.fill(0);
}

/** AES-256-GCM box: `{nonce, ct, tag}` in base64, with `aad` bound to the slot. */
export interface SealedBox {
  alg: "aes-256-gcm";
  nonce: string;
  ct: string;
  tag: string;
}

export function seal(key: Buffer, plaintext: Buffer, aad: string): SealedBox {
  if (key.length !== 32) throw new RangeError("seal: key must be 32 bytes");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    alg: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Rejects with `unauthorized` when the key or AAD is wrong or the box was altered. */
export function open(key: Buffer, box: SealedBox, aad: string): Buffer {
  if (box.alg !== "aes-256-gcm") return fail("invalid_params", "unknown key-slot algorithm");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]);
  } catch {
    return fail("unauthorized", "key slot did not open");
  }
}

/** Argon2id parameters stored with the recovery slot (security §4.2). */
export interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
}

/** 64 MiB, 3 passes: memory and passes of RFC 9106's second recommended setting (one lane). */
export const DEFAULT_ARGON2: Argon2Params = { memory: 65_536, passes: 3, parallelism: 1 };

export function deriveArgon2id(secret: Buffer, salt: Buffer, params: Argon2Params): Buffer {
  return argon2Sync("argon2id", {
    message: secret,
    nonce: salt,
    memory: params.memory,
    passes: params.passes,
    parallelism: params.parallelism,
    tagLength: 32,
  });
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient decode: ignores spaces, dashes and `=`; case-insensitive. Throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new RangeError("base32: invalid character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 32 random bytes as grouped base32: 13 groups of 4 (security §4.2, "shown once"). */
export function formatRecoveryKey(bytes: Buffer): string {
  const text = base32Encode(bytes);
  return (text.match(/.{1,4}/g) ?? []).join("-");
}

export function parseRecoveryKey(text: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = base32Decode(text);
  } catch {
    return fail("invalid_params", "recovery key is not base32");
  }
  if (bytes.length !== DEK_BYTES)
    return fail("invalid_params", "recovery key has the wrong length");
  return bytes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
