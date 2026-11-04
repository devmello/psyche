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

export const PAIRING_LINK_PREFIX = "psyche-pair:v1:";

/** A setup token lives ten minutes (security §10). */
export const SETUP_TOKEN_TTL_MS = 10 * 60 * 1000;

/** `pst_` + base64url of 32 random bytes (256 bits). */
export const SETUP_TOKEN_PATTERN = /^pst_[A-Za-z0-9_-]{43}$/;

/** `sha256:<hex>` of the Gateway's raw identity public key, as the Host shows it. */
export const GATEWAY_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

const MAX_LINK_LENGTH = 2048;
const MAX_URL_LENGTH = 300;
const MAX_NAME_LENGTH = 64;
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

function checkPayload(p: PairingLinkPayload): void {
  if (
    typeof p.gatewayUrl !== "string" ||
    p.gatewayUrl.length === 0 ||
    p.gatewayUrl.length > MAX_URL_LENGTH ||
    UNSAFE_TEXT.test(p.gatewayUrl) ||
    /\s/.test(p.gatewayUrl)
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
    p.hostName.trim().length === 0 ||
    p.hostName.length > MAX_NAME_LENGTH ||
    UNSAFE_TEXT.test(p.hostName)
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
  return payload;
}
