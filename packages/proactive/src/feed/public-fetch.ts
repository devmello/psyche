import { isIP } from "node:net";
import type { FetchLike } from "./sources.ts";

/**
 * A guarded fetch for public feeds until S09 exports its SSRF-policed one (status note): http(s)
 * only, public hosts only (no loopback, private, link-local, `.local` / `.internal`), no
 * credentials in the url, a size cap and a timeout. Redirects are followed by `fetch` itself,
 * so a public feed that redirects to a private address is the remaining gap S09's fetch closes.
 */

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal")
  ) {
    return true;
  }
  const v = isIP(h);
  if (v === 4) {
    const [a = 0, b = 0] = h.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (v === 6) {
    return (
      h === "::1" ||
      h === "::" ||
      /^f[cd]/.test(h) ||
      /^fe[89ab]/.test(h) ||
      h.startsWith("::ffff:")
    );
  }
  return false;
}

export function publicFetch(options: { maxBytes?: number; timeoutMs?: number } = {}): FetchLike {
  const maxBytes = options.maxBytes ?? 2_000_000;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (url, { signal }) => {
    const u = URL.canParse(url) ? new URL(url) : undefined;
    if (u === undefined || (u.protocol !== "https:" && u.protocol !== "http:")) {
      throw new Error("only http(s) urls");
    }
    if (u.username !== "" || u.password !== "") throw new Error("credentials in url");
    if (isPrivateHost(u.hostname)) throw new Error("private host");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(u, {
        signal: controller.signal,
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/json, text/xml, */*",
        },
      });
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (reader !== undefined) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
      return { status: res.status, text: new TextDecoder().decode(Buffer.concat(chunks)) };
    } finally {
      clearTimeout(timer);
    }
  };
}
