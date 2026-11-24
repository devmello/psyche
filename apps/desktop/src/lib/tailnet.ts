import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PsycheError } from "@psyche/protocol";
import { cleanGatewayName, normalizeGatewayOrigin } from "./gateways.ts";

/**
 * Finding Psyche Gateways on the owner's tailnet (remote-gateway design §3.2, "Pick from your
 * tailnet"). The main process runs the local `tailscale` CLI with `execFile` (never a shell) and
 * reads `tailscale status --json`, which only talks to the local tailscaled. Peers that carry
 * `tag:psyche` are listed; untagged online peers are listed only when they answer
 * `GET /healthz` with `{"ok":true}` (probing touches the peer, so it runs only on the owner's
 * click). Everything the CLI prints is untrusted text: it is parsed defensively, size-capped and
 * re-validated. A listing proves nothing. Connecting to one goes through `gateways.add` with the
 * same confirmation, no pin and the first-connect pin as typing the address does.
 */

export type TailnetState = "off" | "missing" | "ok";

export interface TailnetPeer {
  /** Stable id for this listing (what the window sends back to connect). */
  id: string;
  name: string;
  dnsName: string;
  online: boolean;
  tagged: boolean;
}

export interface TailnetListing {
  state: TailnetState;
  peers: TailnetPeer[];
}

export const TAILSCALE_APP = "/Applications/Tailscale.app";
/** Known install locations, searched after PATH. Fixed paths only: nothing the renderer sends. */
export const TAILSCALE_CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];
export const STATUS_TIMEOUT_MS = 3_000;
export const MAX_STATUS_BYTES = 1024 * 1024;
export const MAX_PEERS = 64;
/** Peers read from the JSON before filtering: a hard ceiling on the work a hostile output causes. */
const MAX_PEER_ENTRIES = 512;
export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_CONCURRENCY = 4;
export const MAX_PROBES = 16;
const MAX_PROBE_BYTES = 256;
export const PSYCHE_TAG = "tag:psyche";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/;

export type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; error: "enoent" | "timeout" | "too_large" | "failed" };

export interface TailnetDeps {
  /** Whether a path is an existing file. */
  isFile(path: string): boolean;
  pathEnv: string;
  exec(file: string, args: string[]): Promise<ExecResult>;
  fetch: typeof fetch;
}

/** The real CLI call: no shell, a 3 s timeout and a stdout cap. */
export function execTailscale(file: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: STATUS_TIMEOUT_MS,
        maxBuffer: MAX_STATUS_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (!err) return resolve({ ok: true, stdout: String(stdout) });
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return resolve({ ok: false, error: "enoent" });
        if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          return resolve({ ok: false, error: "too_large" });
        if ((err as { killed?: boolean }).killed === true)
          return resolve({ ok: false, error: "timeout" });
        resolve({ ok: false, error: "failed" });
      },
    );
  });
}

export const realTailnetDeps = (): TailnetDeps => ({
  isFile: (p) => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  },
  pathEnv: process.env.PATH ?? "",
  exec: execTailscale,
  fetch: globalThis.fetch,
});

/** The `tailscale` CLI to run: the first existing candidate on PATH, then the known locations. */
export function findTailscaleCli(
  deps: Pick<TailnetDeps, "isFile" | "pathEnv">,
): string | undefined {
  const onPath = deps.pathEnv
    .split(delimiter)
    .filter((d) => d !== "")
    .map((d) => join(d, "tailscale"));
  return [...onPath, ...TAILSCALE_CANDIDATES].find((p) => deps.isFile(p));
}

function plainLabel(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase().replace(/\.$/, "");
  return LABEL.test(s) ? s : undefined;
}

function plainDnsName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase().replace(/\.$/, "");
  if (!DNS_NAME.test(s)) return undefined;
  // A `.local` name is a LAN name (never a tailnet one), and an all-digit last label is an address.
  const last = s.slice(s.lastIndexOf(".") + 1);
  if (s.endsWith(".local") || !/[a-z]/.test(last)) return undefined;
  // The same check a typed address gets: a name that would not be accepted is not listed.
  try {
    return normalizeGatewayOrigin(`https://${s}`) === `https://${s}` ? s : undefined;
  } catch {
    return undefined;
  }
}

export interface ParsedStatus {
  running: boolean;
  peers: Array<{ name: string; dnsName: string; online: boolean; tagged: boolean }>;
}

/**
 * Reads `tailscale status --json`. Returns null for anything that is not a JSON object (garbage).
 * Peers without a usable name, or whose name would not be accepted as an address, are dropped.
 */
export function parseTailnetStatus(text: string): ParsedStatus | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return null;
  const r = root as Record<string, unknown>;
  const tailnet =
    typeof r.CurrentTailnet === "object" && r.CurrentTailnet !== null
      ? (r.CurrentTailnet as Record<string, unknown>)
      : {};
  // The tailnet's MagicDNS suffix (`tail1234.ts.net`), used only for a peer with no DNSName.
  const suffix = plainDnsName(`x.${String(tailnet.MagicDNSSuffix ?? "")}`)?.slice(2);
  const peerMap = typeof r.Peer === "object" && r.Peer !== null ? Object.values(r.Peer) : [];
  const peers: ParsedStatus["peers"] = [];
  for (const raw of peerMap.slice(0, MAX_PEER_ENTRIES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as Record<string, unknown>;
    const label = plainLabel(p.HostName);
    // The name the status gives is used as it is; only a peer with no DNSName gets the suffix.
    const dnsName =
      p.DNSName === undefined
        ? label !== undefined && suffix !== undefined
          ? plainDnsName(`${label}.${suffix}`)
          : undefined
        : plainDnsName(p.DNSName);
    if (dnsName === undefined) continue;
    const tags = Array.isArray(p.Tags)
      ? p.Tags.filter((t): t is string => typeof t === "string")
      : [];
    peers.push({
      name: cleanGatewayName(label ?? dnsName.split(".")[0] ?? dnsName) || dnsName,
      dnsName,
      online: p.Online === true,
      tagged: tags.includes(PSYCHE_TAG),
    });
  }
  return { running: r.BackendState === "Running", peers };
}

/** Reads a response body up to `max` bytes; anything longer is not a Psyche healthz. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when `https://<dnsName>/healthz` answers `{"ok":true}` (what the Gateway serves). */
export async function probeHealthz(dnsName: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`https://${dnsName}/healthz`, {
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const text = await readCapped(res, MAX_PROBE_BYTES);
    if (text === undefined) return false;
    const body = JSON.parse(text) as unknown;
    return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const tailnetPeerId = (dnsName: string): string =>
  createHash("sha256").update(`tailnet:${dnsName}`).digest("hex").slice(0, 16);

/**
 * The listing for the Add a Gateway sheet. `probe: false` reads only the local CLI (no peer is
 * contacted); `probe: true` also asks each untagged online peer (up to MAX_PROBES) for /healthz.
 */
export async function readTailnet(
  opts: { probe: boolean },
  deps: TailnetDeps = realTailnetDeps(),
): Promise<TailnetListing> {
  const cli = findTailscaleCli(deps);
  if (cli === undefined) return { state: "missing", peers: [] };
  const res = await deps.exec(cli, ["status", "--json"]);
  if (!res.ok) {
    // Installed but unreadable: tailscaled is not running, logged out or not answering.
    if (res.error === "too_large") return { state: "ok", peers: [] };
    if (res.error === "enoent") return { state: "missing", peers: [] };
    return { state: "off", peers: [] };
  }
  const parsed = parseTailnetStatus(res.stdout);
  if (parsed === null) return { state: "ok", peers: [] };
  if (!parsed.running) return { state: "off", peers: [] };
  const tagged = parsed.peers.filter((p) => p.tagged);
  const candidates = parsed.peers.filter((p) => !p.tagged && p.online).slice(0, MAX_PROBES);
  const probed = opts.probe
    ? await mapLimited(candidates, PROBE_CONCURRENCY, async (p) =>
        (await probeHealthz(p.dnsName, deps.fetch)) ? p : undefined,
      )
    : [];
  const found = probed.filter((p): p is (typeof candidates)[number] => p !== undefined);
  const peers = [...tagged, ...found]
    .slice(0, MAX_PEERS)
    .map((p) => ({ id: tailnetPeerId(p.dnsName), ...p }));
  return { state: "ok", peers };
}

/**
 * The address a listed peer connects to, as the window's Connect sends only its id. Refused for
 * an id this process did not list, so the window can never name an address of its own.
 */
export function tailnetOriginFor(
  listing: Map<string, TailnetPeer>,
  id: string,
): { origin: string; name: string } {
  const peer = listing.get(id);
  if (peer === undefined) throw new PsycheError("not_found", "Look on your tailnet again");
  return { origin: normalizeGatewayOrigin(`https://${peer.dnsName}`), name: peer.name };
}
