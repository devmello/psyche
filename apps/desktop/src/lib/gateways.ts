import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_GATEWAY_PORT,
  PAIRING_LINK_PREFIX,
  type PairingLinkPayload,
  PsycheError,
  parsePairingLink,
  SETUP_TOKEN_TTL_MS,
} from "@psyche/protocol";

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
  lastConnectedAt?: string;
  /**
   * The single-use token from the pairing link this entry was added with, kept only until the
   * first connect has been answered (pending or paired) and for at most ten minutes. It holds no
   * authority by itself: the owner still approves this computer on the Host.
   */
  setupToken?: string;
  /** When `setupToken` was saved (ISO). */
  setupTokenAt?: string;
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
    name
      // Control, format (bidi marks and overrides, zero-width, tag characters), line and
      // paragraph separators, and the Hangul fillers that render as nothing.
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u3164]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
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
    ...(typeof e.lastConnectedAt === "string" ? { lastConnectedAt: e.lastConnectedAt } : {}),
    // A token past its ten minutes is dropped here, so it never lingers in the file.
    ...(typeof e.setupToken === "string" &&
    KEY_PATTERN.test(e.setupToken) &&
    typeof e.setupTokenAt === "string" &&
    liveSetupToken({ setupToken: e.setupToken, setupTokenAt: e.setupTokenAt }, now) !== undefined
      ? { setupToken: e.setupToken, setupTokenAt: e.setupTokenAt }
      : {}),
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
    if (
      entry === null ||
      seen.has(entry.id) ||
      (key !== undefined && (typeof key !== "string" || !KEY_PATTERN.test(key)))
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
  "lastConnectedAt",
  "setupToken",
  "setupTokenAt",
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
  input: { address: string; name?: string },
  id: string = newGatewayId(),
): AddResult {
  const origin = normalizeGatewayOrigin(input.address);
  const found = data.gateways.find((g) => g.origin === origin);
  if (found) return { gateways: data, entry: found, existing: true };
  const typedName = input.name === undefined ? "" : cleanGatewayName(input.name);
  const entry: SavedGateway = {
    id,
    name: (typedName ? typedName : defaultGatewayName(origin)).slice(0, 64),
    origin,
  };
  return {
    gateways: { ...data, gateways: [...data.gateways, entry] },
    entry,
    existing: false,
  };
}

/** True when the text is a pairing link (so it is parsed as one and never as an address). */
export function isPairingLinkText(input: string): boolean {
  return input.trim().startsWith(PAIRING_LINK_PREFIX);
}

/** `sha256:<hex>` of a raw base64url Ed25519 key: what the Host shows as the Gateway's fingerprint. */
export function identityKeyFingerprint(keyB64url: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(keyB64url, "base64url")).digest("hex")}`;
}

/** Parses a pasted pairing link; any fault is a `bad_link` problem that is safe to show. */
export function parseLinkInput(input: string): PairingLinkPayload {
  try {
    const link = parsePairingLink(input);
    // The same address rules as a typed address, so a link cannot reach what typing cannot.
    return { ...link, gatewayUrl: normalizeGatewayOrigin(link.gatewayUrl) };
  } catch (err) {
    if (err instanceof GatewayAddressError || err instanceof PsycheError) {
      throw new PairingLinkError("bad_link");
    }
    throw err;
  }
}

export class PairingLinkError extends Error {
  readonly problem: "bad_link" | "pin_mismatch";
  constructor(problem: "bad_link" | "pin_mismatch") {
    super(`pairing link: ${problem}`);
    this.name = "PairingLinkError";
    this.problem = problem;
  }
}

export type AddFromLinkResult = AddResult & { link: PairingLinkPayload };

/**
 * Adds (or updates) the saved Gateway for a pasted pairing link. The link's address and identity
 * key become the entry's origin and pin, so nothing is trusted on first use, and its setup token
 * is kept for the first connect. An entry for the same address that is already pinned to a
 * different key is refused (`pin_mismatch`): use "Forget and pair again" for a Gateway whose
 * identity changed on purpose.
 */
export function addGatewayFromLink(
  data: GatewaysFile,
  input: { link: string; name?: string },
  now: Date,
  id: string = newGatewayId(),
): AddFromLinkResult {
  const link = parseLinkInput(input.link);
  const found = data.gateways.find((g) => g.origin === link.gatewayUrl);
  const stamp = { setupToken: link.setupToken, setupTokenAt: now.toISOString() };
  if (found) {
    if (found.identityKey !== undefined && found.identityKey !== link.gatewayIdentityKey) {
      throw new PairingLinkError("pin_mismatch");
    }
    const entry: SavedGateway = { ...found, identityKey: link.gatewayIdentityKey, ...stamp };
    return {
      gateways: { ...data, gateways: data.gateways.map((g) => (g.id === found.id ? entry : g)) },
      entry,
      existing: true,
      link,
    };
  }
  const typedName = input.name === undefined ? "" : cleanGatewayName(input.name);
  const hostName = cleanGatewayName(link.hostName);
  const entry: SavedGateway = {
    id,
    name: (typedName || hostName || defaultGatewayName(link.gatewayUrl)).slice(0, 64),
    origin: link.gatewayUrl,
    identityKey: link.gatewayIdentityKey,
    ...stamp,
  };
  return {
    gateways: { ...data, gateways: [...data.gateways, entry] },
    entry,
    existing: false,
    link,
  };
}

/** The saved setup token if it is still within its ten minutes, else undefined. */
export function liveSetupToken(
  entry: Pick<SavedGateway, "setupToken" | "setupTokenAt">,
  now: Date,
): string | undefined {
  if (entry.setupToken === undefined || entry.setupTokenAt === undefined) return undefined;
  const at = Date.parse(entry.setupTokenAt);
  if (Number.isNaN(at) || now.getTime() - at > SETUP_TOKEN_TTL_MS || now.getTime() < at) {
    return undefined;
  }
  return entry.setupToken;
}

/** Drops the saved setup token (spent, or past its ten minutes). */
export function clearSetupToken(data: GatewaysFile, id: string): GatewaysFile {
  return {
    ...data,
    gateways: data.gateways.map((g) => {
      if (g.id !== id) return g;
      const { setupToken: _t, setupTokenAt: _a, ...rest } = g;
      return rest;
    }),
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
    gateways: data.gateways.map((g) => (g.id === id ? { ...g, identityKey: key } : g)),
  };
}

/** Drops the pin ("Forget and pair again"): the next connect pins whatever answers. */
export function clearGatewayPin(data: GatewaysFile, id: string): GatewaysFile {
  return {
    ...data,
    gateways: data.gateways.map((g) => {
      if (g.id !== id) return g;
      const { identityKey: _pin, ...rest } = g;
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
    return { id: "env", name: envOrigin, origin: envOrigin, remote: false, dataDir: null };
  }
  const active = opts.data.gateways.find((g) => g.id === opts.data.active);
  if (active !== undefined) {
    return {
      id: active.id,
      name: active.name,
      origin: active.origin,
      remote: true,
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
