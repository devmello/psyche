import { createHmac } from "node:crypto";
import { base32Decode } from "./crypto.ts";
import { fail } from "./errors.ts";

/** A parsed TOTP seed (RFC 6238). Stored as the item's `totpSecret`; never resolved itself. */
export interface TotpSeed {
  secret: Buffer;
  algorithm: "sha1" | "sha256" | "sha512";
  digits: number;
  period: number;
}

/** Accepts a base32 seed or an `otpauth://totp/...` URI (1Password, Bitwarden, Chrome exports). */
export function parseTotpSeed(text: string): TotpSeed {
  let secretText = text.trim();
  let algorithm: TotpSeed["algorithm"] = "sha1";
  let digits = 6;
  let period = 30;
  if (/^otpauth:/i.test(secretText)) {
    let url: URL;
    try {
      url = new URL(secretText);
    } catch {
      return fail("invalid_params", "TOTP URI does not parse");
    }
    if (url.host.toLowerCase() !== "totp") return fail("invalid_params", "only TOTP is supported");
    secretText = url.searchParams.get("secret") ?? "";
    const alg = (url.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    if (alg !== "sha1" && alg !== "sha256" && alg !== "sha512") {
      return fail("invalid_params", "unsupported TOTP algorithm");
    }
    algorithm = alg;
    digits = Number(url.searchParams.get("digits") ?? 6);
    period = Number(url.searchParams.get("period") ?? 30);
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    return fail("invalid_params", "TOTP digits must be 6 to 8");
  }
  if (!Number.isInteger(period) || period < 1 || period > 300) {
    return fail("invalid_params", "TOTP period out of range");
  }
  let secret: Buffer;
  try {
    secret = base32Decode(secretText);
  } catch {
    return fail("invalid_params", "TOTP secret is not base32");
  }
  if (secret.length < 10) return fail("invalid_params", "TOTP secret is too short");
  return { secret, algorithm, digits, period };
}

/** The code for `nowMs` (RFC 6238 / RFC 4226 dynamic truncation). */
export function totpCode(seed: TotpSeed, nowMs: number): string {
  const counter = Math.floor(nowMs / 1000 / seed.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(seed.algorithm, seed.secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(bin % 10 ** seed.digits).padStart(seed.digits, "0");
}
