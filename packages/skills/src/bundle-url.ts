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
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** The one message for anything that goes wrong on the network: no oracle for the local network. */
const GENERIC = "could not download the bundle from that link";

function blockedLink(): PsycheError {
  return new PsycheError("invalid_params", "that link is not allowed; use a public https link");
}

/** Whether an address is loopback, private, link-local, shared, multicast or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1] !== undefined) return isPrivateAddress(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("64:ff9b:")) return true;
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
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

/** The default transport: HTTPS to the address that was checked, with the real host for SNI. */
function pinnedFetch(url: string, init: RequestInit, address: string): Promise<Response> {
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
        servername: u.hostname,
        agent: false,
        // The connection goes to the address that passed the check, never to a second lookup.
        lookup: (_host, _opts, cb) => {
          (cb as (e: null, a: string, f: number) => void)(null, address, isIP(address));
        },
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

/**
 * Downloads a bundle: https only; on every hop the host is resolved, every address must be public
 * and the connection is pinned to one of them; at most three redirects, each re-checked (so a
 * redirect to http or to a local address fails); 8 MiB cap by header and streamed bytes; a
 * timeout; no cookies or credentials. Every network failure is the same message, so the link
 * cannot be used to probe what is on the owner's network.
 */
export async function fetchBundleText(url: string, opts: BundleFetchOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? pinnedFetch;
  const resolve = opts.resolveHost ?? defaultResolve;
  let current = checkBundleUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const host = current.hostname.replace(/\.+$/, "");
    let addresses: string[];
    try {
      addresses = await resolve(host);
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
    if (Number(res.headers.get("content-length") ?? "0") > MAX_BUNDLE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError(
        "invalid_params",
        `the bundle is larger than ${MAX_BUNDLE_BYTES} bytes`,
      );
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
        if (total > MAX_BUNDLE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new PsycheError(
            "invalid_params",
            `the bundle is larger than ${MAX_BUNDLE_BYTES} bytes`,
          );
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
