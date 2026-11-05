import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { PsycheError } from "@psyche/protocol";
import { MAX_BUNDLE_BYTES } from "./bundle.ts";

/** Options for downloading a bundle (tests inject `fetchImpl` and `resolveHost`). */
export interface BundleFetchOptions {
  /** Replaces the pinned HTTPS transport (tests). Called with the URL and the pinned address. */
  fetchImpl?: (url: string, init: RequestInit, pinnedAddress: string) => Promise<Response>;
  /** Replaces DNS (tests): every address the host name resolves to. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Milliseconds for a bundle download (default 30 s). */
  fetchTimeoutMs?: number;
  /** Largest download in bytes (default: the bundle cap; a revocation notice asks for far less). */
  maxBytes?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** The one message for anything that goes wrong on the network: no oracle for the local network. */
const GENERIC = "could not download the bundle from that link";

function blockedLink(): PsycheError {
  return new PsycheError("invalid_params", "that link is not allowed; use a public https link");
}

/** Four bytes of a canonical dotted IPv4 address, or `undefined` for any other spelling. */
function v4Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined;
}

function privateV4([a = 0, b = 0, c = 0]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Sixteen bytes of any spelling of an IPv6 address (compressed, mixed-case, dotted tail). */
function v6Bytes(address: string): number[] | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1] !== undefined) {
    const v4 = v4Bytes(dotted[1]);
    if (v4 === undefined) return undefined;
    const hex = (x: number, y: number) => ((x << 8) | y).toString(16);
    text = `${text.slice(0, -dotted[1].length)}${hex(v4[0] ?? 0, v4[1] ?? 0)}:${hex(v4[2] ?? 0, v4[3] ?? 0)}`;
  }
  const [head = "", tail, ...rest] = text.split("::");
  if (rest.length > 0) return undefined;
  const groups = (x: string) => (x === "" ? [] : x.split(":"));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return undefined;
  const all = [...h, ...Array(fill).fill("0"), ...t];
  if (all.length !== 8) return undefined;
  const out: number[] = [];
  for (const g of all) {
    const n = Number.parseInt(g, 16);
    if (!/^[0-9a-f]{1,4}$/.test(g) || Number.isNaN(n)) return undefined;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

/**
 * Whether an address is anything but a public unicast one: loopback, private, shared, link-local,
 * site-local, unique-local, multicast, documentation (the TEST-NETs and 2001:db8::/32), 6to4,
 * Teredo, NAT64 and the IPv4-in-IPv6 forms (`::a.b.c.d`, `::ffff:a.b.c.d`, `::ffff:0:a.b.c.d`, which
 * are judged by the IPv4 address inside). Any spelling that does not parse is refused too.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = v4Bytes(address);
  if (v4 !== undefined) return privateV4(v4);
  const b = v6Bytes(address);
  if (b === undefined) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const tail = b.slice(12, 16);
  // IPv4-compatible (::a.b.c.d, also :: and ::1) and IPv4-translated (::ffff:0:a.b.c.d) are
  // deprecated forms nothing public answers on: refused whatever the address inside is.
  if (zero(0, 12)) return true;
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true;
  // IPv4-mapped (::ffff:a.b.c.d) is judged by the IPv4 address inside.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateV4(tail);
  // Only global unicast 2000::/3 is public, minus the ranges that are not routed to the world.
  if (((b[0] ?? 0) & 0xe0) !== 0x20) return true;
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 6to4 2002::/16
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && ((b[3] ?? 0) & 0xf0) === 0x10) return true; // ORCHID
  return false;
}

/**
 * An https URL a bundle may be fetched from: no credentials, no host that names this machine or
 * its network (`localhost`, `.local`, `.internal`, a single-label name, any IP literal), judged
 * with a trailing dot removed (`localhost.` is `localhost`). The host name is resolved later, on
 * every hop (`fetchBundleText`).
 */
export function checkBundleUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PsycheError("invalid_params", "not a URL");
  }
  if (u.protocol !== "https:") throw new PsycheError("invalid_params", "the URL must be https://");
  if (u.username !== "" || u.password !== "")
    throw new PsycheError("invalid_params", "the URL must not contain credentials");
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    host === "" ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    /^0x[0-9a-f]+$/i.test(host) ||
    !host.includes(".")
  )
    throw blockedLink();
  return u;
}

async function defaultResolve(host: string): Promise<string[]> {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

/**
 * The `lookup` for a connection pinned to `address`. Node 20 and later connect with
 * `autoSelectFamily`, which asks for every address (`{all: true}`) and wants a list back; older
 * callers want one address. Both forms answer with the pinned address only.
 */
export function pinnedLookup(address: string) {
  const family = isIP(address);
  return (
    _host: string,
    options: { all?: boolean } | number | undefined,
    cb: (
      err: Error | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    if (typeof options === "object" && options?.all === true) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * The default transport: HTTPS to the address that was checked, with the real host name for the
 * certificate (`servername`) and the system's trusted CAs. `tls.ca` exists for tests only.
 */
export function pinnedFetch(
  url: string,
  init: RequestInit,
  address: string,
  tls: { ca?: string } = {},
): Promise<Response> {
  const u = new URL(url);
  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port === "" ? 443 : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { ...(init.headers as Record<string, string>), "user-agent": "psyche-skills" },
        servername: u.hostname.replace(/\.+$/, ""),
        agent: false,
        // The connection goes to the address that passed the check, never to a second lookup.
        lookup: pinnedLookup(address) as never,
        ...(tls.ca === undefined ? {} : { ca: tls.ca }),
        signal: init.signal as AbortSignal,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (typeof v === "string") headers.set(k, v);
        const status = res.statusCode ?? 0;
        const nullBody = status < 200 || status === 204 || status === 205 || REDIRECTS.has(status);
        if (nullBody) res.resume();
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Rejects if `p` has not settled in `ms` (a DNS lookup has no timeout of its own). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Downloads a bundle: https only; on every hop the host is resolved, every address must be public
 * and the connection is pinned to one of them; at most three redirects, each re-checked (so a
 * redirect to http or to a local address fails); 8 MiB cap by header and streamed bytes; a
 * timeout; no cookies or credentials. Every network failure is the same message, so the link
 * cannot be used to probe what is on the owner's network.
 */
export async function fetchBundleText(url: string, opts: BundleFetchOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? pinnedFetch;
  const cap = Math.min(opts.maxBytes ?? MAX_BUNDLE_BYTES, MAX_BUNDLE_BYTES);
  const resolve = opts.resolveHost ?? defaultResolve;
  let current = checkBundleUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const host = current.hostname.replace(/\.+$/, "");
    let addresses: string[];
    try {
      addresses = await withTimeout(resolve(host), opts.fetchTimeoutMs ?? 30_000);
    } catch {
      throw new PsycheError("unavailable", GENERIC);
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw blockedLink();
    const pinned = addresses[0] as string;
    let res: Response;
    try {
      res = await doFetch(
        current.toString(),
        {
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.timeout(opts.fetchTimeoutMs ?? 30_000),
          headers: { accept: "application/json, application/octet-stream;q=0.9" },
        },
        pinned,
      );
    } catch {
      throw new PsycheError("unavailable", GENERIC);
    }
    if (REDIRECTS.has(res.status)) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (loc === null) throw new PsycheError("unavailable", GENERIC);
      try {
        current = checkBundleUrl(new URL(loc, current).toString());
      } catch {
        throw blockedLink();
      }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError("unavailable", GENERIC);
    }
    if (Number(res.headers.get("content-length") ?? "0") > cap) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError("invalid_params", `the file is larger than ${cap} bytes`);
    }
    if (res.body === null) throw new PsycheError("unavailable", GENERIC);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => undefined);
          throw new PsycheError("invalid_params", `the file is larger than ${cap} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof PsycheError) throw err;
      throw new PsycheError("unavailable", GENERIC);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new PsycheError("invalid_params", "the bundle is not UTF-8 text");
    }
  }
  throw new PsycheError("unavailable", GENERIC);
}
