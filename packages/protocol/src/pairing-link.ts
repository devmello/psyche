import { PsycheError } from "./errors.ts";

/**
 * The `psyche-pair:v1` pairing link (remote-gateway design §3.4, mobile companion §2.2, security
 * §10). An admin device makes one with `devices.pairing.createLink`; a phone scans it as a QR code
 * with its own scanner and a remote desktop pastes it into Add a Gateway. It is the one place a
 * Gateway address comes from, and it is never a URL: the link has no `https:` form, so no browser,
 * deep link or query parameter can carry it (the CVE-2026-25253 rule).
 *
 * The link holds no long-lived secret. The `setupToken` is random, single use and lasts ten
 * minutes; presenting it only marks a pairing request as expected, and the owner still approves
 * the device and chooses its scopes.
 */

export const PAIRING_LINK_PREFIX = "psyche-pair:v1:";

/** How long a setup token lives (security §10). */
export const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;

/** What a link carries. The Gateway key is the pin the client trusts from then on. */
export interface PairingLinkPayload {
  /** The Gateway's origin: `https://host[:port]`, or `http://` for loopback (an SSH tunnel). */
  gatewayUrl: string;
  /** The Gateway identity public key, base64url raw Ed25519 (43 characters). */
  gatewayIdentityKey: string;
  /** Single-use bootstrap token, base64url of 32 random bytes (43 characters). */
  setupToken: string;
  /** The Host machine's name, shown as "Connect to studio-mac?". */
  hostName: string;
}

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** A decoded link above this size is refused before it is parsed. */
const MAX_LINK_CHARS = 2048;
const MAX_HOST_NAME = 128;

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlToBytes(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new PsycheError("invalid_params", "pairing link is not base64url");
  }
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Validates a Gateway origin for a link: https (or http to loopback), a host, no credentials, path,
 * query or fragment. Returns the normalized origin. Throws `invalid_params`.
 */
export function pairingLinkOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PsycheError("invalid_params", "gatewayUrl is not a URL");
  }
  // Exactly these three names: a name like foo.localhost is not guaranteed to reach loopback on
  // every resolver, and the phone reuses this rule.
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new PsycheError("invalid_params", "gatewayUrl must be https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PsycheError("invalid_params", "gatewayUrl must not carry credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new PsycheError(
      "invalid_params",
      "gatewayUrl must be an origin: no path, query or fragment",
    );
  }
  return url.origin;
}

/**
 * Control, format (bidi marks and overrides, zero-width joiners, tag characters), line and
 * paragraph separators, and the Hangul fillers that render as nothing. A host name is shown in
 * "Connect to studio-mac?", so one that could reshape or hide part of the sentence is refused
 * rather than cleaned.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u3164]/u;

function hasInvisibleChar(text: string): boolean {
  return INVISIBLE.test(text);
}

function check(payload: PairingLinkPayload): PairingLinkPayload {
  if (!KEY_RE.test(payload.gatewayIdentityKey)) {
    throw new PsycheError("invalid_params", "gatewayIdentityKey must be a base64url Ed25519 key");
  }
  if (!KEY_RE.test(payload.setupToken)) {
    throw new PsycheError("invalid_params", "setupToken must be 32 random bytes, base64url");
  }
  if (
    typeof payload.hostName !== "string" ||
    payload.hostName.trim() === "" ||
    payload.hostName.length > MAX_HOST_NAME ||
    hasInvisibleChar(payload.hostName)
  ) {
    throw new PsycheError("invalid_params", "hostName must be 1-128 printable characters");
  }
  return {
    gatewayUrl: pairingLinkOrigin(payload.gatewayUrl),
    gatewayIdentityKey: payload.gatewayIdentityKey,
    setupToken: payload.setupToken,
    hostName: payload.hostName,
  };
}

/** `psyche-pair:v1:<base64url JSON {gatewayUrl, gatewayIdentityKey, setupToken, hostName}>`. */
export function encodePairingLink(payload: PairingLinkPayload): string {
  const clean = check(payload);
  const json = JSON.stringify({
    gatewayUrl: clean.gatewayUrl,
    gatewayIdentityKey: clean.gatewayIdentityKey,
    setupToken: clean.setupToken,
    hostName: clean.hostName,
  });
  return PAIRING_LINK_PREFIX + bytesToBase64url(new TextEncoder().encode(json));
}

/**
 * Parses a pasted or scanned link. Surrounding whitespace is ignored; anything else that is not a
 * well-formed v1 link throws `invalid_params` with a message safe to show. Unknown fields in the
 * JSON are ignored so a later minor revision (for example `spkiPins`) still parses.
 */
export function parsePairingLink(text: string): PairingLinkPayload {
  const link = text.trim();
  if (link.length > MAX_LINK_CHARS) {
    throw new PsycheError("invalid_params", "pairing link is too long");
  }
  if (!link.startsWith(PAIRING_LINK_PREFIX)) {
    throw new PsycheError("invalid_params", "not a psyche-pair:v1 link");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        base64urlToBytes(link.slice(PAIRING_LINK_PREFIX.length)),
      ),
    );
  } catch (err) {
    if (err instanceof PsycheError) throw err;
    throw new PsycheError("invalid_params", "pairing link is damaged");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PsycheError("invalid_params", "pairing link is damaged");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["gatewayUrl", "gatewayIdentityKey", "setupToken", "hostName"] as const) {
    if (typeof record[key] !== "string") {
      throw new PsycheError("invalid_params", `pairing link is missing ${key}`);
    }
  }
  return check(record as unknown as PairingLinkPayload);
}
