import { readFileSync } from "node:fs";
import type { PinnedRequest, TransportResponse } from "@psyche/connectors";
import { ResolvedSecret, type ToolRegistration } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  braveSearch,
  createWebTools,
  duckDuckGoSearch,
  type FetchFn,
  parseDuckDuckGoHtml,
  parsePreference,
  parseSearxngUrl,
  providerFor,
  RateLimiter,
  unwrapDuckDuckGoLink,
  webSearchStatus,
} from "../src/web/index.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/web/${name}`, import.meta.url), "utf8");
const KEY = "BSA-test-key-0000000000000000";
const secret = () =>
  new ResolvedSecret(KEY, {
    credentialId: "env:PSYCHE_SEARCH_BRAVE_KEY",
    target: { kind: "origin", value: "https://api.search.brave.com" },
  });

interface Seen {
  url: string;
  init: RequestInit | undefined;
}
function fakeFetch(respond: (url: URL) => Response): { fetch: FetchFn; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return respond(new URL(String(input)));
    },
  };
}
const run = (tool: ToolRegistration | undefined, params: unknown) =>
  (tool as ToolRegistration).execute("c1", params, new AbortController().signal, () => {});
const noWait = () => new RateLimiter({ sleep: async () => {} });

describe("DuckDuckGo HTML provider", () => {
  it("parses results, skips ads and duplicates, unwraps redirect links, decodes entities", () => {
    const results = parseDuckDuckGoHtml(fixture("ddg-node-lts.html"));
    expect(results.map((r) => r.url)).toEqual([
      "https://nodejs.org/en/about/previous-releases",
      "https://endoflife.date/nodejs",
    ]);
    expect(results[0]).toMatchObject({
      title: "Node.js — Node.js Releases",
      snippet: expect.stringContaining('Node.js 24 "Krypton" is the current Active LTS line.'),
    });
    expect(results[1]?.snippet).toContain("active LTS & 22");
    expect(unwrapDuckDuckGoLink("https://example.com/a")).toBe("https://example.com/a");
  });

  it("calls the HTML endpoint without cookies and honors count", async () => {
    const f = fakeFetch(() => new Response(fixture("ddg-node-lts.html")));
    const p = duckDuckGoSearch({ fetch: f.fetch, limiter: noWait() });
    const results = await p.search("  node js   lts ", { count: 1 });
    expect(results).toHaveLength(1);
    const url = new URL(f.seen[0]?.url ?? "");
    expect(url.origin).toBe("https://html.duckduckgo.com");
    expect(url.searchParams.get("q")).toBe("node js lts");
    expect(f.seen[0]?.init).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(JSON.stringify(f.seen[0]?.init?.headers)).not.toMatch(/cookie/i);
  });

  it("stops on DuckDuckGo's bot check (no CAPTCHA solving) and backs off", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ now: () => now, sleep: async () => {} });
    const f = fakeFetch(() => new Response(fixture("ddg-bot-check.html")));
    const p = duckDuckGoSearch({ fetch: f.fetch, limiter });
    await expect(p.search("node lts", { count: 5 })).rejects.toMatchObject({
      code: "rate_limited",
      details: { reason: "bot_check" },
    });
    now += 60_000;
    await expect(p.search("node lts", { count: 5 })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(f.seen).toHaveLength(1);
    now += 16 * 60_000;
    await expect(p.search("node lts", { count: 5 })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(f.seen).toHaveLength(2);
  });

  it("maps HTTP failures to typed errors", async () => {
    const p = (status: number) =>
      duckDuckGoSearch({
        fetch: fakeFetch(() => new Response("", { status })).fetch,
        limiter: noWait(),
      });
    await expect(p(429).search("x", { count: 1 })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(p(503).search("x", { count: 1 })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    const down = duckDuckGoSearch({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      limiter: noWait(),
    });
    await expect(down.search("x", { count: 1 })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("rate limiter", () => {
  it("spaces requests, caps them per window and refuses long waits", async () => {
    let now = 0;
    const waits: number[] = [];
    const l = new RateLimiter({
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
      minIntervalMs: 2_000,
      perWindow: 3,
      windowMs: 60_000,
      maxWaitMs: 3_000,
    });
    await l.take();
    await l.take();
    expect(waits).toEqual([2_000]);
    await expect(l.take()).rejects.toMatchObject({ code: "rate_limited" }); // would wait 4 s
    now = 10_000;
    await l.take();
    now = 20_000;
    await expect(l.take()).rejects.toMatchObject({ code: "rate_limited" }); // 3 in the window
    now = 70_000;
    await l.take();
  });
});

describe("Brave provider", () => {
  it("sends the key only in its header and keeps it out of results", async () => {
    const f = fakeFetch(() => Response.json(JSON.parse(fixture("brave-node-lts.json"))));
    const p = braveSearch({ fetch: f.fetch, key: async () => secret() });
    const results = await p.search("node lts", { count: 5 });
    expect(results).toEqual([
      {
        title: "Node.js Releases",
        url: "https://nodejs.org/en/about/previous-releases",
        snippet: "Node.js 24 is the current Active LTS release.",
        publishedAt: "2026-10-01T00:00:00",
      },
    ]);
    const url = new URL(f.seen[0]?.url ?? "");
    expect(url.origin).toBe("https://api.search.brave.com");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.toString()).not.toContain(KEY);
    expect((f.seen[0]?.init?.headers as Record<string, string>)["x-subscription-token"]).toBe(KEY);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });

  it("reports a refused key as unauthorized without echoing it", async () => {
    const p = braveSearch({
      fetch: fakeFetch(() => new Response("", { status: 401 })).fetch,
      key: async () => secret(),
    });
    const err = await p.search("x", { count: 1 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unauthorized" });
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});

describe("provider selection", () => {
  it("prefers Brave, then SearXNG, then DuckDuckGo, and explains a missing explicit choice", () => {
    expect(webSearchStatus({ preference: "auto" }).active).toBe("duckduckgo");
    expect(
      webSearchStatus({ preference: "auto", searxngUrl: "http://10.0.0.2:8888/" }).active,
    ).toBe("searxng");
    expect(
      webSearchStatus({ preference: "auto", braveKey: "env", searxngUrl: "http://x/" }).active,
    ).toBe("brave");
    expect(webSearchStatus({ preference: "brave" })).toMatchObject({
      active: "duckduckgo",
      note: expect.stringContaining("Brave"),
    });
    expect(webSearchStatus({ preference: "searxng", braveKey: "env" })).toMatchObject({
      active: "brave",
      note: expect.stringContaining("SearXNG"),
    });
    expect(webSearchStatus({ preference: "duckduckgo", braveKey: "env" }).active).toBe(
      "duckduckgo",
    );
    expect(webSearchStatus({ preference: "off", braveKey: "env" }).active).toBe("off");
    expect(parsePreference("nope")).toBe("auto");
    expect(parseSearxngUrl(" http://192.168.1.5:8888 ")).toBe("http://192.168.1.5:8888/");
    for (const bad of ["", "file:///etc", "javascript:x", "http://u:p@host/", 3]) {
      expect(parseSearxngUrl(bad)).toBeUndefined();
    }
  });

  it("queries the owner's SearXNG instance, even on the LAN", async () => {
    const f = fakeFetch(() =>
      Response.json({
        results: [{ title: "Node.js", url: "https://nodejs.org/", content: "LTS 24" }],
      }),
    );
    const status = webSearchStatus({ preference: "auto", searxngUrl: "http://192.168.1.5:8888/" });
    const p = providerFor(status, {
      fetch: f.fetch,
      braveKey: async () => secret(),
      limiter: noWait(),
    });
    expect(p?.id).toBe("searxng");
    expect(await p?.search("node lts", { count: 3 })).toEqual([
      { title: "Node.js", url: "https://nodejs.org/", snippet: "LTS 24" },
    ]);
    const url = new URL(f.seen[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("http://192.168.1.5:8888/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(
      providerFor(webSearchStatus({ preference: "off" }), {
        fetch: f.fetch,
        braveKey: async () => secret(),
        limiter: noWait(),
      }),
    ).toBeUndefined();
  });
});

describe("web.search tool", () => {
  it("is a read-only tool with untrusted output", async () => {
    const f = fakeFetch(() => new Response(fixture("ddg-node-lts.html")));
    const [search] = createWebTools({
      provider: () => duckDuckGoSearch({ fetch: f.fetch, limiter: noWait() }),
    });
    expect(search?.spec).toMatchObject({
      name: "web.search",
      sideEffect: "read",
      provenanceOut: "untrusted",
    });
    expect(search?.spec.targetKind).toBeUndefined();
    const r = await run(search, { query: "node lts", count: 2 });
    expect(r).toMatchObject({
      provenance: "untrusted",
      output: {
        provider: "duckduckgo",
        results: [{ url: "https://nodejs.org/en/about/previous-releases" }, {}],
      },
    });
    expect(r.isError).toBeUndefined();
  });

  it("explains when search is off and rejects bad params", async () => {
    const [search] = createWebTools({
      provider: () => undefined,
      offReason: () => "web search is turned off in Settings → Model & providers",
    });
    expect(await run(search, { query: "x" })).toMatchObject({
      isError: true,
      output: { code: "unavailable", error: expect.stringContaining("Settings") },
    });
    expect(await run(search, {})).toMatchObject({
      isError: true,
      output: { code: "invalid_params" },
    });
  });
});

// --- web.fetch through the real safeFetch with a fake network ------------------------------

const encoder = new TextEncoder();
function page(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: (async function* () {
      yield encoder.encode(body);
    })(),
    close() {},
  };
}

function network(
  routes: Record<string, () => TransportResponse>,
  addresses: Record<string, string> = {},
) {
  const requests: PinnedRequest[] = [];
  return {
    requests,
    fetchOptions: {
      lookup: async (host: string) => [{ address: addresses[host] ?? "93.184.215.14", family: 4 }],
      transport: async (req: PinnedRequest) => {
        requests.push(req);
        const route = routes[req.url.toString()];
        return route === undefined ? page(404, "not found") : route();
      },
    },
  };
}

const HTML = `<html><head><title>Previous Releases</title></head><body><main><h1>Node.js Releases</h1><p>Node.js 24 is Active LTS.</p></main></body></html>`;

describe("web.fetch tool", () => {
  it("returns a page's title and readable text, untrusted, targeting its origin", async () => {
    const net = network({ "https://nodejs.org/en/about/previous-releases": () => page(200, HTML) });
    const [, fetchTool] = createWebTools({
      provider: () => undefined,
      fetchOptions: net.fetchOptions,
    });
    expect(fetchTool?.spec).toMatchObject({
      name: "web.fetch",
      sideEffect: "read",
      targetKind: "origin",
      provenanceOut: "untrusted",
    });
    expect(fetchTool?.describeCall?.({ url: "https://NodeJS.org/en/x" })).toMatchObject({
      target: { kind: "origin", value: "https://nodejs.org" },
    });
    const r = await run(fetchTool, { url: "https://nodejs.org/en/about/previous-releases" });
    expect(r).toMatchObject({
      provenance: "untrusted",
      output: { status: 200, title: "Previous Releases", truncated: false },
    });
    expect((r.output as { text: string }).text).toContain("Node.js 24 is Active LTS.");
    expect(JSON.stringify(net.requests[0]?.headers ?? {})).not.toMatch(/cookie/i);
  });

  it("follows same-origin redirects only", async () => {
    const net = network({
      "https://nodejs.org/lts": () => page(301, "", { location: "/en/about/previous-releases" }),
      "https://nodejs.org/en/about/previous-releases": () => page(200, HTML),
      "https://nodejs.org/away": () => page(302, "", { location: "https://evil.example/collect" }),
    });
    const [, fetchTool] = createWebTools({
      provider: () => undefined,
      fetchOptions: net.fetchOptions,
    });
    expect(await run(fetchTool, { url: "https://nodejs.org/lts" })).toMatchObject({
      output: { finalUrl: "https://nodejs.org/en/about/previous-releases" },
    });
    const away = await run(fetchTool, { url: "https://nodejs.org/away" });
    expect(away.isError).toBe(true);
    expect(net.requests.map((r) => r.url.host)).not.toContain("evil.example");
  });

  it("refuses private addresses, non-http schemes and URL credentials", async () => {
    const net = network(
      { "http://router.example/": () => page(200, "admin") },
      { "router.example": "192.168.1.1" },
    );
    const [, fetchTool] = createWebTools({
      provider: () => undefined,
      fetchOptions: net.fetchOptions,
    });
    expect(await run(fetchTool, { url: "http://router.example/" })).toMatchObject({
      isError: true,
      output: { code: "policy_denied" },
    });
    expect(net.requests).toHaveLength(0);
    for (const url of ["file:///etc/passwd", "https://u:p@nodejs.org/", "not a url"]) {
      expect(await run(fetchTool, { url })).toMatchObject({
        isError: true,
        output: { code: "invalid_params" },
      });
    }
    expect(fetchTool?.describeCall?.({ url: "file:///etc/passwd" })).toEqual({});
  });

  it("caps the text it returns", async () => {
    const long = `<html><body><p>${"word ".repeat(10_000)}</p></body></html>`;
    const net = network({ "https://example.com/long": () => page(200, long) });
    const [, fetchTool] = createWebTools({
      provider: () => undefined,
      fetchOptions: net.fetchOptions,
    });
    const r = await run(fetchTool, { url: "https://example.com/long", maxChars: 1_000 });
    expect((r.output as { text: string; truncated: boolean }).truncated).toBe(true);
    expect((r.output as { text: string }).text.length).toBeLessThanOrEqual(1_100);
  });
});
