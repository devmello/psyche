import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import {
  cleanHostName,
  DEFAULT_GATEWAY_PORT,
  GATEWAY_FINGERPRINT_PATTERN,
  type PairingLinkPayload,
  SETUP_TOKEN_PATTERN,
  SETUP_TOKEN_TTL_MS,
} from "@psyche/protocol";
import { fingerprintOf } from "./gateway-identity.ts";

/**
 * Saved Gateways (remote-gateway design §1.3): the Gateways this app can connect to, one active
 * at a time. The list lives on this computer in `<userData>/gateways.json`, never on any Gateway.
 *
 * "This Mac" is implicit: it is always there, is the default, and keeps today's `device-key.json`
 * and storage. Every remote entry gets its own data directory (`<userData>/gateways/<id>`) that
 * holds its device key and, because the app points Electron's `userData` there while that
 * Gateway is active, its own renderer storage, caches and window state: drafts, layout and
 * caches from one Gateway can never show in another. Switching restarts the app so that is true
 * of every module, not only the ones that remembered to namespace themselves.
 */

export const THIS_MAC_ID = "this-mac";

export interface SavedGateway {
  /** `gw_` + 12 lowercase hex characters. */
  id: string;
  /** The Host's name, editable. */
  name: string;
  /** Normalized origin: `https://<host>.<tailnet>.ts.net`, or a loopback origin (SSH tunnel). */
  origin: string;
  /** The pinned Gateway identity key (base64url raw Ed25519), set at the first connect. */
  identityKey?: string;
  /**
   * `sha256:<hex>` of the identity key a pairing link named. Until the key itself is pinned (the
   * first connect that reaches paired), the Gateway must prove a key with this fingerprint: the
   * first connect is verified, not trust-on-first-use.
   */
  identityFingerprint?: string;
  /**
   * The one-time setup token from a pairing link, kept only until this computer pairs, the Host
   * refuses it, or it is older than the Host would accept. A bearer secret for at most ten minutes.
   */
  setupToken?: string;
  /** When the token was saved (ISO). */
  setupTokenAt?: string;
  /**
   * LAN Gateways: the pinned SHA-256 of the TLS certificate's SPKI (base64url). A pairing link
   * carries it (the `psyche-pair:v1` payload's certificate field, when that lands); without a
   * link it is stored at the first pairing, like the identity key. See `lib/lan-tls.ts`.
   */
  certPin?: string;
  /**
   * Reached over the pinned self-signed certificate of a Psyche on the local network (`lan-tls.ts`)
   * rather than the system's trust. Explicit: set when it was picked from Bonjour, or when the
   * owner added a `.local` or private address and chose that in the dialog. An address that only
   * looks local (a reverse proxy with an internal CA) stays an ordinary https Gateway.
   */
  lan?: true;
  /**
   * LAN Gateways picked from Bonjour: the key fingerprint (`sha256:<hex>`) the network said it
   * has. A hint only, checked against the key the Gateway then proves; never a pin.
   */
  advertisedFingerprint?: string;
  lastConnectedAt?: string;
  /** Fields of the file this version does not know, kept so saving never drops them. */
  extra?: Record<string, unknown>;
}

export interface GatewaysFile {
  v: 1;
  /** `THIS_MAC_ID` or a saved remote Gateway's id. */
  active: string;
  gateways: SavedGateway[];
  /** Top-level fields this version does not know, kept on save. */
  extra?: Record<string, unknown>;
}

export const EMPTY_GATEWAYS: GatewaysFile = { v: 1, active: THIS_MAC_ID, gateways: [] };

const ID_PATTERN = /^gw_[0-9a-f]{12}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function gatewaysFilePath(userData: string): string {
  return join(userData, "gateways.json");
}

/** The data directory of a remote Gateway: its device key lives here, and so does its storage. */
export function gatewayDataDir(userData: string, id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`not a saved Gateway id: ${id}`);
  return join(userData, "gateways", id);
}

export type OriginProblem =
  | "empty"
  | "invalid"
  | "needs_full_name"
  | "needs_https"
  | "has_path"
  | "has_credentials";

export class GatewayAddressError extends Error {
  readonly problem: OriginProblem;
  constructor(problem: OriginProblem) {
    super(`gateway address: ${problem}`);
    this.name = "GatewayAddressError";
    this.problem = problem;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Turns what the owner typed into a normalized origin, or throws a `GatewayAddressError`.
 *
 * - `studio-mac.tail1234.ts.net` and `https://studio-mac.tail1234.ts.net/` become
 *   `https://studio-mac.tail1234.ts.net`.
 * - A name with no dot is refused: Tailscale's certificate is for the full MagicDNS name, so the
 *   short name would only ever fail TLS. The app never runs `tailscale` to expand it.
 * - Plain `http` is accepted only for loopback (an SSH tunnel), never across a network.
 * - No credentials and no path: the address is an origin and nothing else.
 */
export function normalizeGatewayOrigin(input: string): string {
  const typed = input.trim();
  if (typed === "") throw new GatewayAddressError("empty");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new GatewayAddressError("invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new GatewayAddressError("invalid");
  if (url.username !== "" || url.password !== "") throw new GatewayAddressError("has_credentials");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new GatewayAddressError("has_path");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "") throw new GatewayAddressError("invalid");
  const loopback = LOOPBACK.has(host);
  if (url.protocol === "http:" && !loopback) throw new GatewayAddressError("needs_https");
  if (!loopback && !host.includes(".") && !host.includes(":")) {
    throw new GatewayAddressError("needs_full_name");
  }
  return url.origin;
}

/** The default name for an address: its first DNS label (`studio-mac`), or the host. */
export function defaultGatewayName(origin: string): string {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  return LOOPBACK.has(host)
    ? `${host}:${new URL(origin).port || DEFAULT_GATEWAY_PORT}`
    : (host.split(".")[0] ?? host);
}

/**
 * Whether the host is one that only exists on a local network: a `.local` name, or a private,
 * link-local or unique-local address. No public CA issues certificates for these, so such a
 * Gateway is reached only through the pinned-certificate path (`lib/lan-tls.ts`), never through
 * the system's trust store. A Tailscale name (`*.ts.net`) is not LAN.
 */
export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h.endsWith(".local")) return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (kind === 6) return /^f[cd]/.test(h) || h.startsWith("fe80:");
  return false;
}

export function isLanOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && isLanHost(url.hostname);
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/**
 * A name as shown in a dialog and the switcher: control and bidirectional-override characters
 * removed (a name typed in the window must not be able to reshape a native dialog), whitespace
 * collapsed, at most 64 characters.
 */
export function cleanGatewayName(name: string): string {
  return (
    cleanHostName(
      name
        // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
        .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " "),
    )
      // Zero-width, format and fill characters are removed too (`cleanHostName`), so a name cannot
      // look blank or hide text from a native dialog.
      .slice(0, 64)
  );
}

function cleanEntry(raw: unknown, now: Date): SavedGateway | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !ID_PATTERN.test(e.id)) return null;
  if (typeof e.origin !== "string") return null;
  let origin: string;
  try {
    origin = normalizeGatewayOrigin(e.origin);
  } catch {
    return null;
  }
  const name =
    typeof e.name === "string" && cleanGatewayName(e.name) !== ""
      ? cleanGatewayName(e.name)
      : defaultGatewayName(origin);
  return {
    id: e.id,
    name,
    origin,
    ...(typeof e.identityKey === "string" && KEY_PATTERN.test(e.identityKey)
      ? { identityKey: e.identityKey }
      : {}),
    ...(typeof e.identityFingerprint === "string" &&
    GATEWAY_FINGERPRINT_PATTERN.test(e.identityFingerprint)
      ? { identityFingerprint: e.identityFingerprint }
      : {}),
    // A token is kept only together with the time it was saved, and only while the Host would
    // still accept it: a lapsed one is dropped whenever the file is read.
    ...(typeof e.setupToken === "string" &&
    SETUP_TOKEN_PATTERN.test(e.setupToken) &&
    typeof e.setupTokenAt === "string" &&
    now.getTime() - Date.parse(e.setupTokenAt) < SETUP_TOKEN_TTL_MS &&
    now.getTime() - Date.parse(e.setupTokenAt) >= 0
      ? { setupToken: e.setupToken, setupTokenAt: e.setupTokenAt }
      : {}),
    ...(e.lan === true ? { lan: true as const } : {}),
    ...(typeof e.certPin === "string" && KEY_PATTERN.test(e.certPin) ? { certPin: e.certPin } : {}),
    ...(typeof e.advertisedFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(e.advertisedFingerprint)
      ? { advertisedFingerprint: e.advertisedFingerprint }
      : {}),
    ...(typeof e.lastConnectedAt === "string" ? { lastConnectedAt: e.lastConnectedAt } : {}),
  };
}

/** Reads the file; a missing or unreadable file is an empty list, never an error. */
export function loadGateways(file: string, now: Date = new Date()): GatewaysFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...EMPTY_GATEWAYS, gateways: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_GATEWAYS, gateways: [] };
  const p = parsed as Record<string, unknown>;
  const seen = new Set<string>();
  const gateways: SavedGateway[] = [];
  for (const raw of Array.isArray(p.gateways) ? p.gateways : []) {
    const entry = cleanEntry(raw, now);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    gateways.push(entry);
  }
  const active =
    typeof p.active === "string" && (p.active === THIS_MAC_ID || seen.has(p.active))
      ? p.active
      : THIS_MAC_ID;
  return { v: 1, active, gateways };
}

export class GatewaysFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewaysFileError";
  }
}

/**
 * Reads the file for anything that will write it back. A missing file is an empty list; a file
 * that exists but cannot be read, parsed or fully understood (a bad entry, a malformed pin, an
 * active id that is not saved) is an error, never an empty list: an empty list is unpinned, and
 * writing it back would erase the pins. Callers refuse to write while this throws.
 */
export function loadGatewaysStrict(file: string, now: Date = new Date()): GatewaysFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_GATEWAYS, gateways: [] };
    }
    throw new GatewaysFileError(`cannot read ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GatewaysFileError(`${file} is not valid JSON`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as GatewaysFile).gateways)
  ) {
    throw new GatewaysFileError(`${file} is not a saved Gateways file`);
  }
  const p = parsed as Record<string, unknown>;
  // A file from a newer version is not rewritten as v1: it fails closed like an unreadable one.
  if (p.v !== 1) throw new GatewaysFileError(`${file} is from another version of Psyche`);
  const seen = new Set<string>();
  const gateways: SavedGateway[] = [];
  for (const raw of p.gateways as unknown[]) {
    const entry = cleanEntry(raw, now);
    const key = (raw as { identityKey?: unknown } | null)?.identityKey;
    const fingerprint = (raw as { identityFingerprint?: unknown } | null)?.identityFingerprint;
    const cert = (raw as { certPin?: unknown } | null)?.certPin;
    if (
      entry === null ||
      seen.has(entry.id) ||
      (key !== undefined && (typeof key !== "string" || !KEY_PATTERN.test(key))) ||
      // A pre-pin that cannot be read is a pin lost: refuse the file rather than run without it.
      (fingerprint !== undefined &&
        (typeof fingerprint !== "string" || !GATEWAY_FINGERPRINT_PATTERN.test(fingerprint))) ||
      (cert !== undefined && (typeof cert !== "string" || !KEY_PATTERN.test(cert)))
    ) {
      throw new GatewaysFileError(`${file} has an entry Psyche cannot read`);
    }
    seen.add(entry.id);
    const unknownEntry = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(([k]) => !ENTRY_FIELDS.has(k)),
    );
    gateways.push(Object.keys(unknownEntry).length > 0 ? { ...entry, extra: unknownEntry } : entry);
  }
  const unknownTop = Object.fromEntries(
    Object.entries(p).filter(([k]) => !["v", "active", "gateways"].includes(k)),
  );
  const active = typeof p.active === "string" ? p.active : THIS_MAC_ID;
  if (active !== THIS_MAC_ID && !seen.has(active)) {
    throw new GatewaysFileError(`${file} names an active Gateway that is not saved`);
  }
  return {
    v: 1,
    active,
    gateways,
    ...(Object.keys(unknownTop).length > 0 ? { extra: unknownTop } : {}),
  };
}

const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "origin",
  "identityKey",
  "identityFingerprint",
  "setupToken",
  "setupTokenAt",
  "certPin",
  "lan",
  "advertisedFingerprint",
  "lastConnectedAt",
]);

export function saveGateways(file: string, data: GatewaysFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const { extra, gateways, ...known } = data;
    const out = {
      ...extra,
      ...known,
      gateways: gateways.map(({ extra: entryExtra, ...entry }) => ({ ...entryExtra, ...entry })),
    };
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function newGatewayId(): string {
  return `gw_${randomBytes(6).toString("hex")}`;
}

export type AddResult = { gateways: GatewaysFile; entry: SavedGateway; existing: boolean };

/**
 * Adds a saved Gateway for what the owner typed. The same origin twice returns the entry already
 * saved. A Gateway never starts pinned: the first connect pins what answers (TOFU), and the
 * splash shows the key's fingerprint next to the pairing code for the owner to compare.
 */
export function addGateway(
  data: GatewaysFile,
  input: {
    address: string;
    name?: string;
    /** From a pairing link (pins) or a Bonjour listing (a fingerprint hint). */
    hints?: {
      certPin?: string;
      identityKey?: string;
      advertisedFingerprint?: string;
      /** A Psyche on the local network: pinned self-signed TLS (see `SavedGateway.lan`). */
      lan?: boolean;
    };
  },
  id: string = newGatewayId(),
): AddResult {
  const origin = normalizeGatewayOrigin(input.address);
  const found = data.gateways.find((g) => g.origin === origin);
  if (found) return { gateways: data, entry: found, existing: true };
  const typedName = input.name === undefined ? "" : cleanGatewayName(input.name);
  const hints = input.hints ?? {};
  const entry: SavedGateway = {
    id,
    name: (typedName ? typedName : defaultGatewayName(origin)).slice(0, 64),
    origin,
    ...(hints.identityKey !== undefined && KEY_PATTERN.test(hints.identityKey)
      ? { identityKey: hints.identityKey }
      : {}),
    ...(hints.lan === true && isLanOrigin(origin) ? { lan: true as const } : {}),
    ...(hints.lan === true &&
    hints.certPin !== undefined &&
    KEY_PATTERN.test(hints.certPin) &&
    isLanOrigin(origin)
      ? { certPin: hints.certPin }
      : {}),
    ...(hints.advertisedFingerprint !== undefined &&
    FINGERPRINT_PATTERN.test(hints.advertisedFingerprint)
      ? { advertisedFingerprint: hints.advertisedFingerprint }
      : {}),
  };
  return {
    gateways: { ...data, gateways: [...data.gateways, entry] },
    entry,
    existing: false,
  };
}

export function renameGateway(data: GatewaysFile, id: string, name: string): GatewaysFile {
  const trimmed = cleanGatewayName(name);
  if (trimmed === "") return data;
  return {
    ...data,
    gateways: data.gateways.map((g) => (g.id === id ? { ...g, name: trimmed } : g)),
  };
}

/** Removes the entry. The active Gateway falls back to This Mac. */
export function removeGateway(data: GatewaysFile, id: string): GatewaysFile {
  return {
    ...data,
    active: data.active === id ? THIS_MAC_ID : data.active,
    gateways: data.gateways.filter((g) => g.id !== id),
  };
}

export function setActiveGateway(data: GatewaysFile, id: string): GatewaysFile {
  if (id !== THIS_MAC_ID && !data.gateways.some((g) => g.id === id)) return data;
  return { ...data, active: id };
}

export function pinGatewayKey(data: GatewaysFile, id: string, key: string): GatewaysFile {
  if (!KEY_PATTERN.test(key)) return data;
  return {
    ...data,
    gateways: data.gateways.map((g) => {
      if (g.id !== id) return g;
      // The key is the pin now; the fingerprint that vouched for it has done its job.
      const { identityFingerprint: _fingerprint, ...rest } = g;
      return { ...rest, identityKey: key };
    }),
  };
}

/** Stores a LAN Gateway's certificate pin (trust on first use, or from a pairing link). */
export function pinGatewayCert(data: GatewaysFile, id: string, spki: string): GatewaysFile {
  if (!KEY_PATTERN.test(spki)) return data;
  return {
    ...data,
    gateways: data.gateways.map((g) => (g.id === id ? { ...g, certPin: spki } : g)),
  };
}

/**
 * Drops the pins, the link's fingerprint and any unused token ("Forget and pair again"): the
 * next connect pins whatever answers.
 */
export function clearGatewayPin(data: GatewaysFile, id: string): GatewaysFile {
  return {
    ...data,
    gateways: data.gateways.map((g) => {
      if (g.id !== id) return g;
      const {
        identityKey: _pin,
        identityFingerprint: _fingerprint,
        setupToken: _token,
        setupTokenAt: _at,
        certPin: _cert,
        advertisedFingerprint: _hint,
        ...rest
      } = g;
      return rest;
    }),
  };
}

export type LinkAddProblem = "pin_mismatch" | "lan_not_supported";

export class GatewayLinkError extends Error {
  readonly problem: LinkAddProblem;
  constructor(problem: LinkAddProblem) {
    super(`pairing link: ${problem}`);
    this.name = "GatewayLinkError";
    this.problem = problem;
  }
}

/**
 * Adds, or updates, the saved Gateway a pairing link names (remote-gateway design §3.4): the
 * address is normalized like a typed one (so a link cannot name anything an address cannot), the
 * link's fingerprint becomes the pre-pin, and its token is kept for the first connect.
 *
 * The same address twice updates the entry. That is refused (`pin_mismatch`) when the entry is
 * already pinned to a different identity than the link names: a link must not quietly replace a
 * pin, so the owner has to "Pair again" first, which is a confirmed, explicit step.
 */
export function addGatewayFromLink(
  data: GatewaysFile,
  link: PairingLinkPayload,
  now: Date,
  id: string = newGatewayId(),
): AddResult {
  const origin = normalizeGatewayOrigin(link.gatewayUrl);
  // A Gateway on the local network is reached over its own pinned certificate (`lan-tls.ts`), and
  // a v1 link carries no certificate pin. Saved as an ordinary https Gateway it would fail TLS, so
  // it is refused until a later link version carries the pin: add it with "Look on this network".
  if (isLanOrigin(origin)) throw new GatewayLinkError("lan_not_supported");
  const found = data.gateways.find((g) => g.origin === origin);
  const token = { setupToken: link.setupToken, setupTokenAt: now.toISOString() };
  if (found) {
    if (
      found.identityKey !== undefined &&
      fingerprintOf(found.identityKey) !== link.gatewayFingerprint
    ) {
      throw new GatewayLinkError("pin_mismatch");
    }
    const updated: SavedGateway = {
      ...found,
      ...(found.identityKey === undefined ? { identityFingerprint: link.gatewayFingerprint } : {}),
      ...token,
    };
    return {
      gateways: { ...data, gateways: data.gateways.map((g) => (g.id === found.id ? updated : g)) },
      entry: updated,
      existing: false,
    };
  }
  // The link's host name is never used here: it is the sender's word, and a dialog or a list
  // must not repeat it. The entry is named by its address until it pairs and the Host's own name
  // (from `gateway.info`) replaces it.
  const entry: SavedGateway = {
    id,
    name: defaultGatewayName(origin),
    origin,
    identityFingerprint: link.gatewayFingerprint,
    ...token,
  };
  return { gateways: { ...data, gateways: [...data.gateways, entry] }, entry, existing: false };
}

/** The setup token still worth presenting: saved less than the Host's lifetime for one ago. */
export function liveSetupToken(entry: SavedGateway, now: Date): string | undefined {
  if (entry.setupToken === undefined || entry.setupTokenAt === undefined) return undefined;
  const age = now.getTime() - Date.parse(entry.setupTokenAt);
  return age >= 0 && age < SETUP_TOKEN_TTL_MS ? entry.setupToken : undefined;
}

/** Forgets the token (it was spent, refused or has lapsed). The pin and fingerprint stay. */
export function clearSetupToken(data: GatewaysFile, id: string): GatewaysFile {
  return {
    ...data,
    gateways: data.gateways.map((g) => {
      if (g.id !== id) return g;
      const { setupToken: _token, setupTokenAt: _at, ...rest } = g;
      return rest;
    }),
  };
}

export function touchGateway(data: GatewaysFile, id: string, at: string): GatewaysFile {
  return {
    ...data,
    gateways: data.gateways.map((g) => (g.id === id ? { ...g, lastConnectedAt: at } : g)),
  };
}

/** What the app connects to for this launch. */
export interface GatewayTarget {
  /** `THIS_MAC_ID`, a saved Gateway's id, or `env` for the dev environment path. */
  id: string;
  name: string;
  origin: string;
  /**
   * A saved remote Gateway: the identity pin is enforced, the data directory is its own, the
   * supervisor starts nothing and nothing here may reach this Mac's own helper or files.
   */
  remote: boolean;
  /** The saved entry is a Psyche on the local network (pinned self-signed TLS). */
  lan?: boolean;
  /** The Electron `userData` for this launch; `null` keeps the base directory (This Mac, env). */
  dataDir: string | null;
}

/**
 * Picks the Gateway for this launch. `PSYCHE_GATEWAY_ORIGIN` (the dev and test path from the
 * server-mode guide) wins and behaves exactly as before: no pin, nothing saved. Otherwise the
 * active saved Gateway, or This Mac.
 */
export function resolveTarget(opts: {
  userData: string;
  env: NodeJS.ProcessEnv;
  data: GatewaysFile;
  /** A packaged build ignores the environment path: it is for development and tests. */
  packaged?: boolean;
}): GatewayTarget {
  const envOrigin = opts.env.PSYCHE_GATEWAY_ORIGIN;
  if (opts.packaged !== true && envOrigin !== undefined && envOrigin !== "") {
    return {
      id: "env",
      name: envOrigin,
      origin: envOrigin,
      remote: false,
      dataDir: null,
    };
  }
  const active = opts.data.gateways.find((g) => g.id === opts.data.active);
  if (active !== undefined) {
    return {
      id: active.id,
      name: active.name,
      origin: active.origin,
      remote: true,
      ...(active.lan === true ? { lan: true } : {}),
      dataDir: gatewayDataDir(opts.userData, active.id),
    };
  }
  return {
    id: THIS_MAC_ID,
    name: "This Mac",
    origin: `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`,
    remote: false,
    dataDir: null,
  };
}

/** Forget this Gateway: its entry, its device key and its storage. */
export function forgetGatewayData(userData: string, id: string): void {
  rmSync(gatewayDataDir(userData, id), { recursive: true, force: true });
}
