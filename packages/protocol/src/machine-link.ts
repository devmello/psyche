/**
 * The `psyche-machine:v1` link (docs/design/linux-helper-only-2026.md, section 4.3). The Host
 * makes one for a `purpose: "machine"` setup token; `psyche-helper pair '<link>'` on a Linux
 * computer accepts it, pins the Gateway's identity key and presents the token so the owner's
 * approval of the pairing is already given.
 *
 * Shape: `psyche-machine:v1:` + base64url (no padding) of a JSON object with exactly these string
 * fields: `gatewayUrl`, `gatewayKey`, `certPin` (optional), `setupToken`, `hostName`. The link
 * holds one short-lived, single-use secret (the token, ten minutes) and nothing long-lived.
 *
 * - With `certPin` the Gateway is on the local network: `gatewayUrl` must be a LAN origin written
 *   as `URL.origin` writes it, and `certPin` is the SHA-256 of the LAN certificate's SPKI.
 * - Without it `gatewayUrl` is a CA-certified https origin (Tailscale Serve), as in `psyche-pair:v1`.
 *
 * The scheme is separate from `psyche-pair:` on purpose: a desktop app never accepts it and the
 * helper never accepts a `psyche-pair:` link (`parseMachineLink` refuses one as
 * `not_a_machine_link`, `parsePairingLink` refuses this one as `not_a_pairing_link`). A device
 * token never pairs a machine and a machine token never pairs a client. Parsing is strict: another
 * version, another field, a missing one or a value of the wrong shape is refused.
 *
 * SECURITY: a machine link is only an invitation. The `machine` node kind is granted by the
 * owner's approval on the Gateway (wave H3), never by anything a node or a link declares.
 */

import { lanHostKind } from "./lan-address.ts";
import {
  cleanHostName,
  fromBase64Url,
  isBase64Url32Bytes,
  isLanLinkOrigin,
  isLinkOrigin,
  MAX_LINK_LENGTH,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
  SETUP_TOKEN_PATTERN,
  toBase64Url,
  UNSAFE_TEXT,
} from "./pairing-link.ts";

export const MACHINE_LINK_PREFIX = "psyche-machine:v1:";

export interface MachineLinkPayload {
  /** The Gateway's origin, as the machine will dial it. */
  gatewayUrl: string;
  /** The Gateway identity public key (32 raw Ed25519 bytes, base64url) the machine pins. */
  gatewayKey: string;
  /** LAN only: base64url SHA-256 of the DER SPKI of the Gateway's LAN certificate. */
  certPin?: string;
  /** The one-time `purpose: machine` setup token. */
  setupToken: string;
  /** The Host's name, for the machine's own prompt. */
  hostName: string;
}

export type MachineLinkProblem =
  | "not_a_machine_link"
  | "unsupported_version"
  | "malformed"
  | "extra_fields"
  | "bad_field";

export class MachineLinkError extends Error {
  readonly problem: MachineLinkProblem;
  readonly field: string | undefined;
  constructor(problem: MachineLinkProblem, field?: string) {
    super(`machine link: ${problem}${field === undefined ? "" : ` (${field})`}`);
    this.name = "MachineLinkError";
    this.problem = problem;
    this.field = field;
  }
}

const REQUIRED_FIELDS = ["gatewayUrl", "gatewayKey", "setupToken", "hostName"] as const;
const ALL_FIELDS = ["gatewayUrl", "gatewayKey", "certPin", "setupToken", "hostName"] as const;

/** A local-network address has a self-signed certificate, so it can only go with a `certPin`. */
function isLanHostOrigin(text: string): boolean {
  try {
    return lanHostKind(new URL(text).hostname) !== null;
  } catch {
    return true;
  }
}

function checkPayload(p: MachineLinkPayload): void {
  const lan = p.certPin !== undefined;
  if (
    typeof p.gatewayUrl !== "string" ||
    p.gatewayUrl.length === 0 ||
    p.gatewayUrl.length > MAX_URL_LENGTH ||
    UNSAFE_TEXT.test(p.gatewayUrl) ||
    /\s/.test(p.gatewayUrl) ||
    !(lan
      ? isLanLinkOrigin(p.gatewayUrl)
      : isLinkOrigin(p.gatewayUrl) && !isLanHostOrigin(p.gatewayUrl))
  ) {
    throw new MachineLinkError("bad_field", "gatewayUrl");
  }
  if (typeof p.gatewayKey !== "string" || !isBase64Url32Bytes(p.gatewayKey)) {
    throw new MachineLinkError("bad_field", "gatewayKey");
  }
  if (lan && (typeof p.certPin !== "string" || !isBase64Url32Bytes(p.certPin))) {
    throw new MachineLinkError("bad_field", "certPin");
  }
  if (typeof p.setupToken !== "string" || !SETUP_TOKEN_PATTERN.test(p.setupToken)) {
    throw new MachineLinkError("bad_field", "setupToken");
  }
  if (
    typeof p.hostName !== "string" ||
    p.hostName.length > MAX_NAME_LENGTH ||
    UNSAFE_TEXT.test(p.hostName) ||
    cleanHostName(p.hostName) === ""
  ) {
    throw new MachineLinkError("bad_field", "hostName");
  }
}

/** Builds the link for a payload, validating it with the same rules `parseMachineLink` applies. */
export function formatMachineLink(payload: MachineLinkPayload): string {
  const clean: MachineLinkPayload = {
    gatewayUrl: payload.gatewayUrl,
    gatewayKey: payload.gatewayKey,
    ...(payload.certPin === undefined ? {} : { certPin: payload.certPin }),
    setupToken: payload.setupToken,
    hostName: payload.hostName,
  };
  checkPayload(clean);
  const text = `${MACHINE_LINK_PREFIX}${toBase64Url(JSON.stringify(clean))}`;
  if (text.length > MAX_LINK_LENGTH) throw new MachineLinkError("malformed");
  return text;
}

/**
 * Parses a pasted link. Surrounding whitespace is ignored and the scheme is matched without
 * regard to case; the rest is exact. Throws `MachineLinkError`.
 */
export function parseMachineLink(input: string): MachineLinkPayload {
  const text = typeof input === "string" ? input.trim() : "";
  if (text.length > MAX_LINK_LENGTH) throw new MachineLinkError("malformed");
  if (!/^psyche-machine:/i.test(text)) throw new MachineLinkError("not_a_machine_link");
  const rest = text.slice("psyche-machine:".length);
  const version = /^([^:]*):/.exec(rest)?.[1];
  if (version === undefined) throw new MachineLinkError("malformed");
  if (version !== "v1") throw new MachineLinkError("unsupported_version");
  const body = fromBase64Url(rest.slice(version.length + 1));
  if (body === null) throw new MachineLinkError("malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MachineLinkError("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MachineLinkError("malformed");
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).find((k) => !(ALL_FIELDS as readonly string[]).includes(k));
  if (extra !== undefined) throw new MachineLinkError("extra_fields", extra);
  for (const field of REQUIRED_FIELDS) {
    if (typeof record[field] !== "string") throw new MachineLinkError("bad_field", field);
  }
  if (Object.hasOwn(record, "certPin") && typeof record.certPin !== "string") {
    throw new MachineLinkError("bad_field", "certPin");
  }
  const payload: MachineLinkPayload = {
    gatewayUrl: record.gatewayUrl as string,
    gatewayKey: record.gatewayKey as string,
    ...(typeof record.certPin === "string" ? { certPin: record.certPin } : {}),
    setupToken: record.setupToken as string,
    hostName: record.hostName as string,
  };
  checkPayload(payload);
  return { ...payload, hostName: cleanHostName(payload.hostName) };
}

/**
 * The scopes a setup token of a purpose carries, or why the request is refused. `device` needs
 * the owner's non-empty choice of operator scopes (never `node`); `machine` takes none and always
 * gets exactly `["node"]`: a caller cannot widen a machine token or make a device token a node.
 */
export function setupTokenScopesFor(
  purpose: "device" | "machine" | undefined,
  scopes: readonly string[] | undefined,
):
  | { ok: true; scopes: string[] }
  | { ok: false; reason: "scopes_required" | "scopes_not_allowed" | "node_scope_not_allowed" } {
  if (purpose === "machine") {
    if (scopes !== undefined && scopes.length > 0)
      return { ok: false, reason: "scopes_not_allowed" };
    return { ok: true, scopes: ["node"] };
  }
  if (scopes === undefined || scopes.length === 0) return { ok: false, reason: "scopes_required" };
  if (scopes.includes("node")) return { ok: false, reason: "node_scope_not_allowed" };
  return { ok: true, scopes: [...new Set(scopes)] };
}
