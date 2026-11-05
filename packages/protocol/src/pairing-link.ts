/**
 * The `psyche-pair:v1` pairing link (remote-gateway design §3.4, mobile companion §2.2). The Host
 * makes one for a one-time setup token; a Client (a desktop on another computer, later the phone)
 * accepts it pasted or scanned and learns the Gateway's address, the identity it must pin, the
 * token that lets the Host approve it without a second step, and a name to show.
 *
 * Shape: `psyche-pair:v1:` + base64url (no padding) of a JSON object with exactly four string
 * fields. The link holds one short-lived, single-use secret (the token, ten minutes) and no
 * long-lived one: the fingerprint is public (the owner reads it on the Host's screen) and the
 * address is not a secret. Parsing is strict: another version, another field, a missing one or
 * a value of the wrong shape is refused, so a Client never acts on a field it does not understand.
 *
 * It is never an address a page or a deep link chose for a Client (CVE-2026-25253): a Client
 * accepts a link only from a field in its own window (or the OS handing it to the app, which only
 * opens that window), then asks the owner to confirm the normalized address in a native dialog.
 */

import { lanHostKind } from "./lan-address.ts";

export const PAIRING_LINK_PREFIX = "psyche-pair:v1:";

/**
 * `psyche-pair:v2:` is the link for a Gateway on the local network. A LAN Gateway presents a
 * self-signed certificate, so the link carries what a v1 link does not: the Gateway's identity
 * public key (not just its fingerprint) and the SHA-256 of the certificate's SPKI. See
 * `PairingLinkPayloadV2`. v1 stays exactly as it was for Tailscale and every other CA-certified
 * address; `parsePairingLink` still reads v1 only, so code written before v2 fails closed on one.
 */
export const PAIRING_LINK_PREFIX_V2 = "psyche-pair:v2:";

/** A setup token lives ten minutes (security §10). */
export const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;

/** `pst_` + base64url of 32 random bytes (256 bits). */
export const SETUP_TOKEN_PATTERN = /^pst_[A-Za-z0-9_-]{43}$/;

/** `sha256:<hex>` of the Gateway's raw identity public key, as the Host shows it. */
export const GATEWAY_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const MAX_LINK_LENGTH = 2048;
const MAX_URL_LENGTH = 300;
const MAX_NAME_LENGTH = 64;
// Invisible and format characters (zero-width, bidi, tag characters, the Hangul fillers that
// render as blanks) that a name must not carry into a dialog.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u3164\u115f\u1160]/gu;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/;

export interface PairingLinkPayload {
  /** The Gateway's origin, as the Host reaches it (`gateway.publicOrigin`). */
  gatewayUrl: string;
  /** `sha256:<hex>` of the Gateway identity key the Client must pin. */
  gatewayFingerprint: string;
  /** The one-time setup token. */
  setupToken: string;
  /** The Host machine's name. */
  hostName: string;
}

export type PairingLinkProblem =
  | "not_a_pairing_link"
  | "unsupported_version"
  | "malformed"
  | "extra_fields"
  | "bad_field";

export class PairingLinkError extends Error {
  readonly problem: PairingLinkProblem;
  readonly field: string | undefined;
  constructor(problem: PairingLinkProblem, field?: string) {
    super(`pairing link: ${problem}${field === undefined ? "" : ` (${field})`}`);
    this.name = "PairingLinkError";
    this.problem = problem;
    this.field = field;
  }
}

const FIELDS = ["gatewayUrl", "gatewayFingerprint", "setupToken", "hostName"] as const;
const FIELDS_V2 = ["gatewayUrl", "gatewayKey", "certPin", "setupToken", "hostName"] as const;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * A link names a Gateway on another computer by its https origin: no credentials, path, query or
 * fragment, and never a loopback address (that is this computer, or an SSH tunnel, not a Host
 * someone else made a link for).
 */
function isLinkOrigin(text: string): boolean {
  if (text.includes("?") || text.includes("#")) return false;
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.hostname !== "" &&
      !LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "").toLowerCase())
    );
  } catch {
    return false;
  }
}

/** A host name for a dialog: invisible characters removed; empty after that is refused. */
export function cleanHostName(name: string): string {
  return name.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

function checkPayload(p: PairingLinkPayload): void {
  if (
    typeof p.gatewayUrl !== "string" ||
    p.gatewayUrl.length === 0 ||
    p.gatewayUrl.length > MAX_URL_LENGTH ||
    UNSAFE_TEXT.test(p.gatewayUrl) ||
    /\s/.test(p.gatewayUrl) ||
    !isLinkOrigin(p.gatewayUrl)
  ) {
    throw new PairingLinkError("bad_field", "gatewayUrl");
  }
  if (
    typeof p.gatewayFingerprint !== "string" ||
    !GATEWAY_FINGERPRINT_PATTERN.test(p.gatewayFingerprint)
  ) {
    throw new PairingLinkError("bad_field", "gatewayFingerprint");
  }
  if (typeof p.setupToken !== "string" || !SETUP_TOKEN_PATTERN.test(p.setupToken)) {
    throw new PairingLinkError("bad_field", "setupToken");
  }
  if (
    typeof p.hostName !== "string" ||
    p.hostName.length > MAX_NAME_LENGTH ||
    UNSAFE_TEXT.test(p.hostName) ||
    cleanHostName(p.hostName) === ""
  ) {
    throw new PairingLinkError("bad_field", "hostName");
  }
}

/** Builds the link for a payload, validating it with the same rules `parsePairingLink` applies. */
export function encodePairingLink(payload: PairingLinkPayload): string {
  const clean: PairingLinkPayload = {
    gatewayUrl: payload.gatewayUrl,
    gatewayFingerprint: payload.gatewayFingerprint,
    setupToken: payload.setupToken,
    hostName: payload.hostName,
  };
  checkPayload(clean);
  return `${PAIRING_LINK_PREFIX}${toBase64Url(JSON.stringify(clean))}`;
}

/**
 * Parses a pasted or scanned link. Surrounding whitespace is ignored; the scheme is matched
 * without regard to case (an OS may lower-case a URL it hands over), the rest is exact.
 * Throws `PairingLinkError`.
 */
export function parsePairingLink(input: string): PairingLinkPayload {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.length > MAX_LINK_LENGTH) throw new PairingLinkError("malformed");
  if (!/^psyche-pair:/i.test(text)) throw new PairingLinkError("not_a_pairing_link");
  const rest = text.slice("psyche-pair:".length);
  const version = /^([^:]*):/.exec(rest)?.[1];
  if (version === undefined) throw new PairingLinkError("malformed");
  if (version !== "v1") throw new PairingLinkError("unsupported_version");
  const body = fromBase64Url(rest.slice(version.length + 1));
  if (body === null) throw new PairingLinkError("malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PairingLinkError("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PairingLinkError("malformed");
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra !== undefined) throw new PairingLinkError("extra_fields", extra);
  for (const field of FIELDS) {
    if (typeof record[field] !== "string") throw new PairingLinkError("bad_field", field);
  }
  const payload: PairingLinkPayload = {
    gatewayUrl: record.gatewayUrl as string,
    gatewayFingerprint: record.gatewayFingerprint as string,
    setupToken: record.setupToken as string,
    hostName: record.hostName as string,
  };
  checkPayload(payload);
  // What is shown is the name without invisible characters.
  return { ...payload, hostName: cleanHostName(payload.hostName) };
}

// ---------------------------------------------------------------------------------------------
// psyche-pair:v2 (a Gateway on the local network)
// ---------------------------------------------------------------------------------------------

/**
 * The v2 payload: `psyche-pair:v2:` + base64url (no padding) of a JSON object with exactly these
 * five string fields, and no other.
 *
 * - `gatewayUrl`: the LAN origin, `https://<host>` or `https://<host>:<port>` and nothing more,
 *   written the way `URL.origin` writes it (lower case, no default port, an optional final `/`).
 *   The host must be a `.local` name, a private IPv4 address or an IPv6 unique-local address in
 *   brackets (`lanHostKind`); a public, global, link-local or loopback address, or one with a
 *   zone id, is refused.
 * - `gatewayKey`: the Gateway identity public key, 32 raw Ed25519 bytes as base64url (43
 *   characters). The Client pins this key at once (a v1 link only carries its fingerprint).
 * - `certPin`: SHA-256 of the DER SubjectPublicKeyInfo of the Gateway's LAN TLS certificate,
 *   base64url (43 characters). The Client compares the certificate presented on the socket with
 *   it before a single application byte, the setup token included, is sent; and the Gateway's
 *   challenge must carry an identity-key signature over the same SPKI (`lanCertSigningPayload`).
 * - `setupToken`, `hostName`: as in v1.
 *
 * `gatewayKey` and `certPin` are public values; the link's only secret is the ten-minute,
 * single-use token.
 */
export interface PairingLinkPayloadV2 {
  gatewayUrl: string;
  gatewayKey: string;
  certPin: string;
  setupToken: string;
  hostName: string;
}

/** A parsed link of either version; a Client branches on `version`. */
export type ParsedPairingLink =
  | { version: 1; payload: PairingLinkPayload }
  | { version: 2; payload: PairingLinkPayloadV2 };

/** A base64url string that is exactly 32 bytes, with canonical (zero) trailing bits. */
export function isBase64Url32Bytes(text: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return false;
  try {
    const binary = atob(`${text.replace(/-/g, "+").replace(/_/g, "/")}=`);
    return (
      binary.length === 32 &&
      btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === text
    );
  } catch {
    return false;
  }
}

/** A LAN origin written exactly as `URL.origin` writes it (an optional final `/` is allowed). */
function isLanLinkOrigin(text: string): boolean {
  if (text.includes("?") || text.includes("#") || text.includes("%")) return false;
  try {
    const url = new URL(text);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      (text === url.origin || text === `${url.origin}/`) &&
      lanHostKind(url.hostname) !== null
    );
  } catch {
    return false;
  }
}

function checkPayloadV2(p: PairingLinkPayloadV2): void {
  if (
    typeof p.gatewayUrl !== "string" ||
    p.gatewayUrl.length === 0 ||
    p.gatewayUrl.length > MAX_URL_LENGTH ||
    UNSAFE_TEXT.test(p.gatewayUrl) ||
    /\s/.test(p.gatewayUrl) ||
    !isLanLinkOrigin(p.gatewayUrl)
  ) {
    throw new PairingLinkError("bad_field", "gatewayUrl");
  }
  if (typeof p.gatewayKey !== "string" || !isBase64Url32Bytes(p.gatewayKey)) {
    throw new PairingLinkError("bad_field", "gatewayKey");
  }
  if (typeof p.certPin !== "string" || !isBase64Url32Bytes(p.certPin)) {
    throw new PairingLinkError("bad_field", "certPin");
  }
  if (typeof p.setupToken !== "string" || !SETUP_TOKEN_PATTERN.test(p.setupToken)) {
    throw new PairingLinkError("bad_field", "setupToken");
  }
  if (
    typeof p.hostName !== "string" ||
    p.hostName.length > MAX_NAME_LENGTH ||
    UNSAFE_TEXT.test(p.hostName) ||
    cleanHostName(p.hostName) === ""
  ) {
    throw new PairingLinkError("bad_field", "hostName");
  }
}

/** Builds a v2 link, validating it with the same rules `parsePairingLinkAny` applies. */
export function encodePairingLinkV2(payload: PairingLinkPayloadV2): string {
  const clean: PairingLinkPayloadV2 = {
    gatewayUrl: payload.gatewayUrl,
    gatewayKey: payload.gatewayKey,
    certPin: payload.certPin,
    setupToken: payload.setupToken,
    hostName: payload.hostName,
  };
  checkPayloadV2(clean);
  return `${PAIRING_LINK_PREFIX_V2}${toBase64Url(JSON.stringify(clean))}`;
}

/**
 * Parses a v1 or a v2 link. The same rules as `parsePairingLink` (strict, whitespace trimmed,
 * scheme matched without regard to case); any other version is `unsupported_version`.
 */
export function parsePairingLinkAny(input: string): ParsedPairingLink {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.length > MAX_LINK_LENGTH) throw new PairingLinkError("malformed");
  if (!/^psyche-pair:/i.test(text)) throw new PairingLinkError("not_a_pairing_link");
  const rest = text.slice("psyche-pair:".length);
  const version = /^([^:]*):/.exec(rest)?.[1];
  if (version === undefined) throw new PairingLinkError("malformed");
  if (version === "v1") return { version: 1, payload: parsePairingLink(text) };
  if (version !== "v2") throw new PairingLinkError("unsupported_version");
  const body = fromBase64Url(rest.slice(version.length + 1));
  if (body === null) throw new PairingLinkError("malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PairingLinkError("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PairingLinkError("malformed");
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => !(FIELDS_V2 as readonly string[]).includes(k));
  if (extra !== undefined) throw new PairingLinkError("extra_fields", extra);
  for (const field of FIELDS_V2) {
    if (typeof record[field] !== "string") throw new PairingLinkError("bad_field", field);
  }
  const payload: PairingLinkPayloadV2 = {
    gatewayUrl: record.gatewayUrl as string,
    gatewayKey: record.gatewayKey as string,
    certPin: record.certPin as string,
    setupToken: record.setupToken as string,
    hostName: record.hostName as string,
  };
  checkPayloadV2(payload);
  return { version: 2, payload: { ...payload, hostName: cleanHostName(payload.hostName) } };
}
