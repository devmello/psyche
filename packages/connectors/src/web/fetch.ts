import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { PsycheError } from "@psyche/protocol";
import { bareHostname, checkAddress, isBlockedHostname } from "./address.ts";
import { extractTitle, htmlToMarkdown } from "./html.ts";

/**
 * Guarded HTTP GET for model-generated URLs (feature M8; security §7.2 item 3: a deterministic
 * check on every model-generated URL before `fetch`). The host is resolved once, every resolved
 * address must be public unicast, and the connection is pinned to the vetted address so a second
 * DNS answer (rebinding) can never redirect it. Redirects are followed by hand and re-checked.
 * The result is page text as Markdown, tagged `untrusted`: it is data, never instructions.
 */

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 200_000;
export const DEFAULT_MAX_REDIRECTS = 5;
const USER_AGENT = "Psyche-Fetch/0.1 (self-hosted personal agent)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** DNS seam: every address `hostname` resolves to (default `dns.lookup` with `all: true`). */
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultLookup: DnsLookup = (hostname) =>
  dnsLookup(hostname, { all: true, order: "verbatim" });

/** One request on a connection pinned to `address`; `url.hostname` stays the Host / SNI name. */
export interface PinnedRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string | string[] | undefined>;
  /** Decoded (decompressed) body bytes. */
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and release the connection. */
  close(): void;
}

export type Transport = (request: PinnedRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Body bytes read at most (after decompression); the rest is dropped and `truncated` set. */
  maxBytes?: number;
  /** Markdown characters returned at most. */
  maxChars?: number;
  maxRedirects?: number;
  /**
   * Exact `host:port` pairs the owner configured as reachable although private (a local
   * SearXNG). Never derived from model input; the model-facing `web_fetch` tool passes none.
   */
  privateAllowlist?: readonly string[];
  lookup?: DnsLookup;
  transport?: Transport;
}

export interface SafeFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  title?: string;
  markdown: string;
  bytes: number;
  truncated: boolean;
  provenance: "untrusted";
}

export interface VettedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  /** True when the owner's private allowlist admitted this host. */
  allowlisted: boolean;
}

function denied(reason: string, message: string, details: Record<string, unknown> = {}): never {
  throw new PsycheError("policy_denied", message, { details: { reason, ...details } });
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/** `host:port` with an explicit port, lower-cased, IPv6 in brackets (`[::1]:8080`). */
export function hostPortKey(url: URL): string {
  return `${url.hostname.toLowerCase()}:${url.port === "" ? defaultPort(url.protocol) : url.port}`;
}

function normalizeAllowlist(list: readonly string[] | undefined): Set<string> {
  return new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== ""));
}

/** True when the owner's private allowlist names this URL's exact `host:port`. */
export function isAllowlisted(url: URL, list: readonly string[] | undefined): boolean {
  return normalizeAllowlist(list).has(hostPortKey(url));
}

/** Parse and statically check a URL: http(s) only, no userinfo. */
export function parseFetchUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new PsycheError("invalid_params", "not a valid absolute URL", {
      details: { reason: "invalid_url" },
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PsycheError("invalid_params", `scheme ${url.protocol} is not allowed (http/https)`, {
      details: { reason: "scheme_not_allowed" },
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new PsycheError("invalid_params", "URLs with embedded credentials are not allowed", {
      details: { reason: "credentials_in_url" },
    });
  }
  url.hash = "";
  return url;
}

function abortError(signal: AbortSignal, timedOut: () => boolean): PsycheError {
  return timedOut()
    ? new PsycheError("timeout", "fetch timed out", { retryable: true })
    : new PsycheError("cancelled", "fetch was cancelled", { cause: signal.reason });
}

/**
 * Resolve and vet the host of `url` (scheme, credentials, blocked names, every resolved address).
 * Returns the single address the connection must use.
 */
export async function vetUrl(
  input: string | URL,
  options: Pick<SafeFetchOptions, "privateAllowlist" | "lookup" | "signal"> = {},
): Promise<VettedTarget> {
  const url = parseFetchUrl(input);
  const host = bareHostname(url.hostname);
  const allowlisted = isAllowlisted(url, options.privateAllowlist);
  if (!allowlisted && isBlockedHostname(host)) {
    denied("blocked_hostname", `host ${host} is a local or private name`, { host });
  }
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal !== 0) {
    addresses = [{ address: host, family: literal }];
  } else {
    const lookup = options.lookup ?? defaultLookup;
    try {
      addresses = await lookup(host);
    } catch (err) {
      if (options.signal?.aborted === true) throw err;
      throw new PsycheError("unavailable", `could not resolve ${host}`, {
        details: { reason: "dns_failed", host },
        retryable: true,
      });
    }
    if (addresses.length === 0) {
      throw new PsycheError("unavailable", `could not resolve ${host}`, {
        details: { reason: "dns_failed", host },
        retryable: true,
      });
    }
  }
  if (!allowlisted) {
    for (const a of addresses) {
      const verdict = checkAddress(a.address);
      // A host with any private answer is refused outright: a mixed answer is a rebinding lure.
      if (!verdict.ok) {
        denied("private_address", `host ${host} resolves to a private or reserved address`, {
          host,
          detail: verdict.reason,
        });
      }
    }
  }
  const first = addresses[0];
  if (first === undefined) denied("dns_failed", `could not resolve ${host}`, { host });
  const family = isIP(first.address);
  if (family !== 4 && family !== 6) denied("private_address", "resolver returned a non-IP answer");
  return { url, address: first.address, family, allowlisted };
}

/** Connect-time lookup that ignores DNS and returns the vetted address (rebinding guard). */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

function decodeStream(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  let decoder: Readable | undefined;
  if (encoding === "gzip" || encoding === "x-gzip") decoder = res.pipe(createGunzip());
  else if (encoding === "deflate") decoder = res.pipe(createInflate());
  else if (encoding === "br") decoder = res.pipe(createBrotliDecompress());
  if (decoder === undefined) return res;
  res.on("error", (err) => decoder.destroy(err));
  return decoder;
}

/** Default transport: node:http / node:https with the pinned lookup; Host and SNI stay the name. */
export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const host = bareHostname(req.url.hostname);
    const isHttps = req.url.protocol === "https:";
    const requestOptions: https.RequestOptions = {
      protocol: req.url.protocol,
      host,
      port: req.url.port === "" ? undefined : Number(req.url.port),
      path: `${req.url.pathname}${req.url.search}`,
      method: "GET",
      headers: { ...req.headers, host: req.url.host },
      agent: false,
      lookup: pinnedLookup(req.address, req.family),
      signal: req.signal,
    };
    if (isHttps && isIP(host) === 0) requestOptions.servername = host;
    const request = (isHttps ? https : http).request(requestOptions, (res) => {
      const body = decodeStream(res);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
        close: () => {
          body.destroy();
          res.destroy();
        },
      });
    });
    request.on("error", reject);
    request.end();
  });

function header(res: TransportResponse, name: string): string | undefined {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

type Kind = "html" | "text" | "json" | "unknown";

function classify(mime: string): Kind {
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime.startsWith("text/")) return "text";
  return "unknown";
}

function parseContentType(raw: string | undefined): { mime: string; charset?: string } {
  if (raw === undefined) return { mime: "" };
  const [type = "", ...params] = raw.split(";");
  const out: { mime: string; charset?: string } = { mime: type.trim().toLowerCase() };
  for (const p of params) {
    const [k = "", v = ""] = p.split("=");
    if (k.trim().toLowerCase() === "charset") out.charset = v.trim().replace(/^"|"$/g, "");
  }
  return out;
}

function decodeText(bytes: Uint8Array, charset: string | undefined, html: boolean): string {
  let label = charset;
  if (label === undefined && html) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i += 1) if (bytes[i] === 0) return true;
  return false;
}

function fence(lang: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

function capChars(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

async function readCapped(
  res: TransportResponse,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of res.body) {
      const room = maxBytes - total;
      if (chunk.byteLength > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    res.close();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out, truncated };
}

/** Fetch `input` with SSRF, redirect, size and content-type guards; returns Markdown. */
export async function safeFetch(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const transport = options.transport ?? nodeTransport;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  const signal = controller.signal;
  const isTimedOut = () => timedOut;
  const abortable = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError(signal, isTimedOut));
        return;
      }
      const stop = () => reject(abortError(signal, isTimedOut));
      signal.addEventListener("abort", stop, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });

  try {
    let current = parseFetchUrl(input);
    for (let hop = 0; ; hop += 1) {
      const target = await abortable(
        vetUrl(current, {
          signal,
          ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
          ...(options.privateAllowlist === undefined
            ? {}
            : { privateAllowlist: options.privateAllowlist }),
        }),
      );
      let res: TransportResponse;
      try {
        res = await abortable(
          transport({
            url: target.url,
            address: target.address,
            family: target.family,
            headers: {
              "user-agent": USER_AGENT,
              accept:
                "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
              "accept-encoding": "gzip, deflate, br",
            },
            signal,
          }),
        );
      } catch (err) {
        if (err instanceof PsycheError) throw err;
        if (signal.aborted) throw abortError(signal, isTimedOut);
        throw new PsycheError("unavailable", `could not connect to ${target.url.host}`, {
          details: { reason: "network_error" },
          retryable: true,
        });
      }

      const location = header(res, "location");
      if (REDIRECT_STATUSES.has(res.status) && location !== undefined) {
        res.close();
        if (hop >= maxRedirects) {
          throw new PsycheError("unavailable", `more than ${maxRedirects} redirects`, {
            details: { reason: "too_many_redirects" },
          });
        }
        let next: URL;
        try {
          next = parseFetchUrl(new URL(location, target.url));
        } catch (err) {
          if (err instanceof PsycheError) {
            denied("bad_redirect", `redirect refused: ${err.message}`);
          }
          throw err;
        }
        if (target.url.protocol === "https:" && next.protocol === "http:") {
          denied("redirect_downgrade", "redirect from https to http refused");
        }
        current = next;
        continue;
      }

      const contentTypeRaw = header(res, "content-type");
      const { mime, charset } = parseContentType(contentTypeRaw);
      const kind = classify(mime);
      if (kind === "unknown" && mime !== "") {
        res.close();
        denied("unsupported_content_type", `content type ${mime} is not text; refused`, {
          contentType: mime,
        });
      }
      let body: { bytes: Uint8Array; truncated: boolean };
      try {
        body = await abortable(readCapped(res, maxBytes));
      } catch (err) {
        if (err instanceof PsycheError) throw err;
        if (signal.aborted) throw abortError(signal, isTimedOut);
        throw new PsycheError("unavailable", "connection failed while reading the body", {
          details: { reason: "network_error" },
          retryable: true,
        });
      }
      if (charset === undefined && looksBinary(body.bytes)) {
        denied("unsupported_content_type", "response body is binary; refused", {
          contentType: mime || "unknown",
        });
      }

      let effective = kind;
      const text = decodeText(body.bytes, charset, kind === "html" || kind === "unknown");
      if (effective === "unknown") {
        effective = /^\s*(?:<!doctype html|<html[\s>])/i.test(text) ? "html" : "text";
      }
      let markdown: string;
      let title: string | undefined;
      if (effective === "html") {
        title = extractTitle(text);
        markdown = htmlToMarkdown(text, target.url);
      } else if (effective === "json") {
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Truncated or malformed JSON is shown as-is.
        }
        markdown = fence("json", pretty);
      } else {
        markdown = text;
      }
      const capped = capChars(markdown, maxChars);
      const result: SafeFetchResult = {
        url: target.url.toString(),
        status: res.status,
        contentType: mime || (effective === "html" ? "text/html" : "text/plain"),
        markdown: capped.text,
        bytes: body.bytes.byteLength,
        truncated: body.truncated || capped.cut,
        provenance: "untrusted",
      };
      if (title !== undefined) result.title = title;
      return result;
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
