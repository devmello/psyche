import { PsycheError } from "@psyche/protocol";
import { MAX_BUNDLE_BYTES } from "./bundle.ts";

/** Options for downloading a bundle (tests inject `fetchImpl`). */
export interface BundleFetchOptions {
  fetchImpl?: typeof fetch;
  /** Milliseconds for a bundle download (default 30 s). */
  fetchTimeoutMs?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * An https URL a bundle may be fetched from: no credentials, and no host that names this
 * machine or its network (`localhost`, `.local`, `.internal`, a single-label name, any IP
 * literal). Names are not resolved here, so a hostile DNS answer is not caught; the fetched
 * text is only ever parsed and verified as a bundle, never executed, and nothing it says is
 * sent anywhere.
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
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.includes(":") ||
    /^\d+(?:\.\d+){0,3}$/.test(host) ||
    !host.includes(".")
  )
    throw new PsycheError("invalid_params", "the URL must name a public host, not an address");
  return u;
}

/**
 * Downloads a bundle: https only, no redirect to anything else (each hop is checked), at most
 * `MAX_BUNDLE_BYTES`, a timeout, no cookies or credentials sent.
 */
export async function fetchBundleText(url: string, opts: BundleFetchOptions = {}): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  let current = checkBundleUrl(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res: Response;
    try {
      res = await doFetch(current.toString(), {
        redirect: "manual",
        credentials: "omit",
        signal: AbortSignal.timeout(opts.fetchTimeoutMs ?? 30_000),
        headers: { accept: "application/json, application/octet-stream;q=0.9" },
      });
    } catch (err) {
      throw new PsycheError(
        "unavailable",
        `could not download the bundle: ${(err as Error).message}`,
      );
    }
    if (REDIRECTS.has(res.status)) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (loc === null) throw new PsycheError("unavailable", "redirect without a location");
      try {
        current = checkBundleUrl(new URL(loc, current).toString());
      } catch {
        throw new PsycheError(
          "invalid_params",
          "the bundle URL redirects somewhere that is not allowed (https only)",
        );
      }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError("unavailable", `the server answered ${res.status}`);
    }
    if (Number(res.headers.get("content-length") ?? "0") > MAX_BUNDLE_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw new PsycheError(
        "invalid_params",
        `the bundle is larger than ${MAX_BUNDLE_BYTES} bytes`,
      );
    }
    if (res.body === null) throw new PsycheError("unavailable", "empty response");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
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
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new PsycheError("invalid_params", "the bundle is not UTF-8 text");
    }
  }
  throw new PsycheError("unavailable", "too many redirects");
}
