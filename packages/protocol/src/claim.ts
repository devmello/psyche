import type { DeviceScope } from "./common.ts";
import { PsycheError } from "./errors.ts";

/**
 * Claiming a fresh psyche-server from the desktop app (remote-gateway design §3.6). A server with
 * no admin device is "unclaimed": it makes a one-time setup code, and the owner types it into the
 * app. Both sides prove they know the code before either trusts the other (`gateway.claim.hello`,
 * `gateway.claim.prove`). This file is the wire-level part both sides share and has no Node
 * dependency; the key derivation, the proofs and the code file are in `claim-node.ts`.
 */

/** Crockford base32: no I, L, O or U, so a code read aloud or off a screen is typed right. */
export const SETUP_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Ten characters of 32: 50 bits. Shown as two groups of five (`7K3QM-XR2TD`). */
export const SETUP_CODE_LENGTH = 10;
/** A code lasts a day; `psyche setup code` makes a new one. */
export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The scopes the claiming computer gets: the same as a `psyche devices link --lan --admin` link
 * gives (`operator.read`, `operator.write`, `operator.approvals`, `operator.admin`). Never `node`.
 */
export const CLAIM_SCOPES: readonly DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];

/** The Bonjour TXT key (value `"1"`) an unclaimed server adds to `_psyche._tcp`. */
export const CLAIM_TXT_KEY = "claim";

/** Characters people type for a code character, mapped as Crockford does. */
const LOOKALIKE: Record<string, string> = { O: "0", I: "1", L: "1" };

/**
 * The code as typed, normalized: upper case, spaces and dashes dropped, `O` read as `0` and `I`
 * or `L` as `1`. `null` when what is left is not exactly ten characters of the alphabet.
 */
export function normalizeSetupCode(input: string): string | null {
  if (typeof input !== "string" || input.length > 64) return null;
  const out = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[OIL]/g, (c) => LOOKALIKE[c] ?? c);
  if (out.length !== SETUP_CODE_LENGTH) return null;
  for (const c of out) if (!SETUP_CODE_ALPHABET.includes(c)) return null;
  return out;
}

/** `7K3QM-XR2TD`: how a code is shown. */
export function formatSetupCode(code: string): string {
  const n = normalizeSetupCode(code);
  if (n === null) throw new PsycheError("invalid_params", "not a setup code");
  return `${n.slice(0, 5)}-${n.slice(5)}`;
}

export const CLAIM_TRANSCRIPT_PREFIX = "psyche-claim-v1";

export interface ClaimTranscriptInput {
  /** base64url, 32 random bytes from the client. */
  clientNonce: string;
  /** base64url, 32 random bytes from the server, fresh per connection. */
  serverNonce: string;
  /** base64url, the salt the server stored with the code. */
  salt: string;
  /** The server's identity public key (base64url raw Ed25519). */
  gatewayKey: string;
  /** SHA-256 (base64url) of the SPKI of the LAN certificate this TLS connection presented. */
  certSpki: string;
  deviceId: string;
  /** The claiming device's public key (base64url raw Ed25519): the key that becomes admin. */
  devicePublicKey: string;
}

/**
 * What both proofs are over: every value the two sides must agree on, one per line, after the
 * protocol label. Binding the certificate's SPKI ties the proof to this TLS connection (a relay
 * with its own certificate gets a transcript the real server will not accept), binding the
 * identity key makes the server's proof vouch for the key the client then pins, and binding the
 * device key makes the client's proof name the one key that becomes admin.
 */
export function claimTranscript(input: ClaimTranscriptInput): string {
  const order: (keyof ClaimTranscriptInput)[] = [
    "clientNonce",
    "serverNonce",
    "salt",
    "gatewayKey",
    "certSpki",
    "deviceId",
    "devicePublicKey",
  ];
  const lines = order.map((key) => {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
      throw new PsycheError("invalid_params", `${key} must be a non-empty single-line string`);
    }
    return value;
  });
  return [CLAIM_TRANSCRIPT_PREFIX, ...lines].join("\n");
}

/** Why a claim was refused, in `details.reason` of the error the server answers with. */
export type ClaimRefusal =
  /** This server is set up already (or was never a psyche-server): nothing to claim. */
  | "not_claimable"
  /** The code is older than a day: `psyche setup code` on the server makes a new one. */
  | "code_expired"
  /** The proof did not match: the code was mistyped (`details.attemptsLeft`). */
  | "wrong_code"
  /** Too many wrong codes from this address for now (`details.retryAfterSec`). */
  | "too_many_attempts";
