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

import { isLocalSuffixHost, lanHostKind, parseIpv4, parseIpv6 } from "./lan-address.ts";
import {
  cleanHostName,
  fromBase64Url,
  isBase64Url32Bytes,
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

/**
 * Hosts a CA-certified (no `certPin`) Gateway can never be: this computer, a local network, a
 * link-local or carrier-grade address, or anything that is not a plain public name or address.
 */
function isNonPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h.endsWith(".")) return true; // one canonical spelling only
  if (h === "localhost" || h.endsWith(".localhost") || h === "localhost.localdomain") return true;
  if (isLocalSuffixHost(h) || lanHostKind(h) !== null) return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (bare.includes(":")) {
    const g = parseIpv6(bare);
    if (g === null) return true;
    const [first = 0, second = 0] = g;
    return (
      g.slice(0, 4).every((x) => x === 0) || // ::, ::1, ::a.b.c.d, ::ffff:a.b.c.d, ::ffff:0:a.b.c.d
      (first === 0x64 && second === 0xff9b) || // 64:ff9b::/32 NAT64 (embeds an IPv4 address)
      first === 0x2002 || // 2002::/16 6to4 (embeds an IPv4 address)
      (first === 0x2001 && (second === 0 || second === 0x0db8)) || // Teredo, documentation
      (first === 0x100 && second === 0 && g[2] === 0 && g[3] === 0) || // 100::/64 discard
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
      (first & 0xff00) === 0xff00 // ff00::/8 multicast
    );
  }
  if (/^[0-9.]+$/.test(bare)) {
    const v4 = parseIpv4(bare);
    if (v4 === null) return true;
    const [a, b] = v4;
    const c = v4[2];
    return (
      a === 0 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 192 && b === 0 && c === 2) || // TEST-NET-1
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) // TEST-NET-3
    );
  }
  // A single-label host (`gateway`) or a private-use name has no public certificate.
  return (
    !h.includes(".") ||
    h.endsWith(".internal") ||
    h.endsWith(".home.arpa") ||
    h === "home.arpa" ||
    h.endsWith(".lan") ||
    h.endsWith(".corp") ||
    h.endsWith(".home")
  );
}

/**
 * The Gateway origin exactly as `URL.origin` writes it (an optional final `/` is accepted and
 * dropped), or null. With a `certPin` the host must be a local-network one (the `psyche-pair:v2`
 * rule); without it, a public name or address with a CA-issued certificate. Anything URL would
 * rewrite (case, default port, a backslash, short IPv4 forms) is refused rather than normalized,
 * so the Rust parser sees the same string.
 */
function canonicalGatewayOrigin(text: unknown, lan: boolean): string | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_URL_LENGTH) return null;
  if (UNSAFE_TEXT.test(text) || /\s/.test(text) || /[?#%\\]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === "0" ||
    (text !== url.origin && text !== `${url.origin}/`)
  ) {
    return null;
  }
  // One spelling of a host only: no trailing dot, in either mode.
  if (url.hostname.endsWith(".")) return null;
  if (lan ? lanHostKind(url.hostname) === null : isNonPublicHost(url.hostname)) return null;
  return url.origin;
}

/** A duplicate key at the top level of a JSON object text (JSON.parse keeps the last; serde fails). */
function hasDuplicateKey(body: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let end = i + 1;
      while (end < body.length && body[end] !== '"') end += body[end] === "\\" ? 2 : 1;
      let next = end + 1;
      while (next < body.length && /\s/.test(body[next] ?? "")) next++;
      if (depth === 1 && body[next] === ":") {
        // JSON.parse and serde both decode escapes, so compare the decoded key.
        let key = body.slice(i + 1, end);
        try {
          key = JSON.parse(body.slice(i, end + 1)) as string;
        } catch {
          // The body already parsed as JSON, so this cannot happen; keep the raw text.
        }
        if (seen.has(key)) return true;
        seen.add(key);
      }
      i = end;
    }
  }
  return false;
}

/** Validates a payload and returns it with the canonical `gatewayUrl`. */
function checkPayload(p: MachineLinkPayload): MachineLinkPayload {
  const lan = p.certPin !== undefined;
  const gatewayUrl = canonicalGatewayOrigin(p.gatewayUrl, lan);
  if (gatewayUrl === null) {
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
  return { ...p, gatewayUrl };
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
  const text = `${MACHINE_LINK_PREFIX}${toBase64Url(JSON.stringify(checkPayload(clean)))}`;
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
  if (hasDuplicateKey(body)) throw new MachineLinkError("malformed");
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
  const checked = checkPayload(payload);
  return { ...checked, hostName: cleanHostName(checked.hostName) };
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
