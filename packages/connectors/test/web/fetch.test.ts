import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  nodeTransport,
  type PinnedRequest,
  safeFetch,
  type TransportResponse,
} from "../../src/web/fetch.ts";
import { expectPsyche, fakeLookup, fakeTransport, fixtureText, startServer } from "./helpers.ts";

const PUBLIC = "93.184.216.34";
const HTML = { "content-type": "text/html; charset=utf-8" };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("safeFetch: scheme and URL checks", () => {
  const transport = fakeTransport({});
  it.each([
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "not a url",
  ])("rejects %s", async (url) => {
    await expectPsyche(safeFetch(url, { transport, lookup: fakeLookup({}) }), "invalid_params");
  });

  it("rejects credentials in the URL", async () => {
    await expectPsyche(
      safeFetch("https://user:pass@example.com/", { transport, lookup: fakeLookup({}) }),
      "invalid_params",
      "credentials_in_url",
    );
    expect(transport.calls).toHaveLength(0);
  });
});

describe("safeFetch: SSRF / private-network block", () => {
  it.each([
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://10.0.0.5/", "private_address"],
    ["http://127.0.0.1:8080/", "private_address"],
    ["http://2130706433/", "private_address"],
    ["http://0x7f.0.0.1/", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://[::ffff:127.0.0.1]/", "private_address"],
    ["http://[::ffff:10.0.0.1]/", "private_address"],
    ["http://[fe80::1]/", "private_address"],
    ["http://0.0.0.0/", "private_address"],
    ["http://localhost/", "blocked_hostname"],
    ["http://localhost.:3000/", "blocked_hostname"],
    ["http://admin.localhost/", "blocked_hostname"],
    ["http://db.internal/", "blocked_hostname"],
    ["http://printer.local/", "blocked_hostname"],
  ])("blocks %s", async (url, reason) => {
    const transport = fakeTransport({});
    const lookup = fakeLookup({});
    await expectPsyche(safeFetch(url, { transport, lookup }), "policy_denied", reason);
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks a hostname resolving to a private address", async () => {
    const transport = fakeTransport({});
    const lookup = fakeLookup({ "evil.example": "10.1.2.3" });
    await expectPsyche(
      safeFetch("https://evil.example/", { transport, lookup }),
      "policy_denied",
      "private_address",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks a hostname resolving to a mix of public and private addresses", async () => {
    const transport = fakeTransport({});
    const lookup = fakeLookup({ "mixed.example": [PUBLIC, "127.0.0.1"] });
    await expectPsyche(
      safeFetch("https://mixed.example/", { transport, lookup }),
      "policy_denied",
      "private_address",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("blocks an IPv6 answer that maps a private IPv4", async () => {
    const transport = fakeTransport({});
    const lookup = fakeLookup({ "v6.example": ["2606:4700::1", "::ffff:192.168.0.1"] });
    await expectPsyche(
      safeFetch("https://v6.example/", { transport, lookup }),
      "policy_denied",
      "private_address",
    );
  });

  it("DNS rebinding: connects to the vetted address, never re-resolves", async () => {
    let n = 0;
    const lookup = Object.assign(async () => {
      n += 1;
      return [{ address: n === 1 ? PUBLIC : "127.0.0.1", family: 4 }];
    }, {});
    const transport = fakeTransport({
      "https://rebind.example/": { headers: HTML, body: "<p>public page</p>" },
    });
    const result = await safeFetch("https://rebind.example/", { transport, lookup });
    expect(result.markdown).toBe("public page");
    expect(n).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.address).toBe(PUBLIC);
    expect(transport.calls[0]?.url.hostname).toBe("rebind.example");
  });

  it("an unresolvable host is unavailable", async () => {
    await expectPsyche(
      safeFetch("https://nx.example/", { transport: fakeTransport({}), lookup: fakeLookup({}) }),
      "unavailable",
      "dns_failed",
    );
  });
});

describe("nodeTransport: the connection is pinned to the vetted address", () => {
  it("connects to the given address, not DNS, keeping Host as the name", async () => {
    const seen: { host?: string; path?: string } = {};
    const server = await startServer((req, res) => {
      seen.host = req.headers.host;
      seen.path = req.url;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned ok");
    });
    closers.push(server.close);
    // `rebind.invalid` cannot resolve (RFC 6761): success proves the lookup was not consulted.
    const url = new URL(`http://rebind.invalid:${server.port}/p?q=1`);
    const res = await nodeTransport({
      url,
      address: "127.0.0.1",
      family: 4,
      headers: {},
      signal: new AbortController().signal,
    });
    const chunks: Uint8Array[] = [];
    for await (const c of res.body) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe("pinned ok");
    expect(seen.host).toBe(`rebind.invalid:${server.port}`);
    expect(seen.path).toBe("/p?q=1");
  });

  it("end to end: owner allowlist admits one private host:port and nothing else", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/redirect-other-port") {
        res.writeHead(302, { location: "http://searx.example:1/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Local</title></head><body><h1>Hi</h1></body></html>");
    });
    closers.push(server.close);
    const lookup = fakeLookup({ "searx.example": "127.0.0.1" });
    const allow = [`searx.example:${server.port}`];
    const ok = await safeFetch(`http://searx.example:${server.port}/`, {
      lookup,
      privateAllowlist: allow,
    });
    expect(ok.title).toBe("Local");
    expect(ok.markdown).toBe("# Hi");
    await expectPsyche(
      safeFetch(`http://searx.example:${server.port}/`, { lookup }),
      "policy_denied",
      "private_address",
    );
    await expectPsyche(
      safeFetch(`http://searx.example:${server.port}/redirect-other-port`, {
        lookup,
        privateAllowlist: allow,
      }),
      "policy_denied",
      "private_address",
    );
  });

  it("decompresses gzip and caps the decompressed size", async () => {
    const big = "a".repeat(200_000);
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(gzipSync(big));
    });
    closers.push(server.close);
    const result = await safeFetch(`http://gz.example:${server.port}/`, {
      lookup: fakeLookup({ "gz.example": "127.0.0.1" }),
      privateAllowlist: [`gz.example:${server.port}`],
      maxBytes: 10_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(10_000);
    expect(result.markdown).toBe("a".repeat(10_000));
  });

  it("times out a server that never answers", async () => {
    const server = await startServer(() => {
      // never respond
    });
    closers.push(server.close);
    const started = Date.now();
    await expectPsyche(
      safeFetch(`http://slow.example:${server.port}/`, {
        lookup: fakeLookup({ "slow.example": "127.0.0.1" }),
        privateAllowlist: [`slow.example:${server.port}`],
        timeoutMs: 150,
      }),
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("safeFetch: redirects", () => {
  const lookup = fakeLookup({
    "a.example": PUBLIC,
    "b.example": "1.1.1.1",
    "intranet.example": "192.168.1.10",
  });

  it("follows a redirect and re-vets the new host", async () => {
    const transport = fakeTransport({
      "https://a.example/start": { status: 301, headers: { location: "https://b.example/end" } },
      "https://b.example/end": { headers: { "content-type": "text/plain" }, body: "done" },
    });
    const result = await safeFetch("https://a.example/start", { transport, lookup });
    expect(result.url).toBe("https://b.example/end");
    expect(result.markdown).toBe("done");
    expect(transport.calls.map((c) => c.address)).toEqual([PUBLIC, "1.1.1.1"]);
  });

  it.each([
    "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:6379/",
    "https://intranet.example/",
  ])("refuses a redirect to %s", async (location) => {
    const transport = fakeTransport({
      "https://a.example/": { status: 302, headers: { location } },
    });
    await expectPsyche(safeFetch("https://a.example/", { transport, lookup }), "policy_denied");
    expect(transport.calls).toHaveLength(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    const transport = fakeTransport({
      "https://a.example/": { status: 302, headers: { location: "file:///etc/passwd" } },
    });
    await expectPsyche(
      safeFetch("https://a.example/", { transport, lookup }),
      "policy_denied",
      "bad_redirect",
    );
  });

  it("refuses an https to http downgrade", async () => {
    const transport = fakeTransport({
      "https://a.example/": { status: 307, headers: { location: "http://a.example/" } },
    });
    await expectPsyche(
      safeFetch("https://a.example/", { transport, lookup }),
      "policy_denied",
      "redirect_downgrade",
    );
    expect(transport.calls).toHaveLength(1);
  });

  it("allows http to https", async () => {
    const transport = fakeTransport({
      "http://a.example/": { status: 301, headers: { location: "https://a.example/" } },
      "https://a.example/": { headers: { "content-type": "text/plain" }, body: "secure" },
    });
    expect((await safeFetch("http://a.example/", { transport, lookup })).markdown).toBe("secure");
  });

  function chain(hops: number) {
    const routes: Record<
      string,
      { status?: number; headers: Record<string, string>; body?: string }
    > = {};
    for (let i = 0; i < hops; i += 1) {
      routes[`https://a.example/${i}`] = {
        status: 302,
        headers: { location: `/${i + 1}` },
      };
    }
    routes[`https://a.example/${hops}`] = {
      headers: { "content-type": "text/plain" },
      body: "end",
    };
    return fakeTransport(routes);
  }

  it("follows up to 5 redirects", async () => {
    const result = await safeFetch("https://a.example/0", { transport: chain(5), lookup });
    expect(result.url).toBe("https://a.example/5");
  });

  it("refuses the 6th redirect", async () => {
    const transport = chain(6);
    await expectPsyche(
      safeFetch("https://a.example/0", { transport, lookup }),
      "unavailable",
      "too_many_redirects",
    );
    expect(transport.calls).toHaveLength(6);
  });
});

describe("safeFetch: caps, timeout, cancel", () => {
  const lookup = fakeLookup({ "a.example": PUBLIC });

  it("stops reading at maxBytes and marks the result truncated", async () => {
    let pulled = 0;
    const transport = async (_req: PinnedRequest): Promise<TransportResponse> => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: (async function* () {
        for (let i = 0; i < 1_000; i += 1) {
          pulled += 1;
          yield new TextEncoder().encode("x".repeat(1024));
        }
      })(),
      close: () => {},
    });
    const result = await safeFetch("https://a.example/", { transport, lookup, maxBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBe(4096);
    expect(pulled).toBeLessThanOrEqual(5);
  });

  it("caps the Markdown at maxChars", async () => {
    const transport = fakeTransport({
      "https://a.example/": { headers: { "content-type": "text/plain" }, body: "y".repeat(5000) },
    });
    const result = await safeFetch("https://a.example/", { transport, lookup, maxChars: 1000 });
    expect(result.markdown).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it("times out a hanging transport", async () => {
    const transport = fakeTransport({ "https://a.example/": { hang: true } });
    await expectPsyche(
      safeFetch("https://a.example/", { transport, lookup, timeoutMs: 50 }),
      "timeout",
    );
  });

  it("honours the caller's AbortSignal", async () => {
    const transport = fakeTransport({ "https://a.example/": { hang: true } });
    const ac = new AbortController();
    const p = safeFetch("https://a.example/", { transport, lookup, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expectPsyche(p, "cancelled");
    const pre = new AbortController();
    pre.abort();
    await expectPsyche(
      safeFetch("https://a.example/", { transport, lookup, signal: pre.signal }),
      "cancelled",
    );
  });
});

describe("safeFetch: content types", () => {
  const lookup = fakeLookup({ "a.example": PUBLIC });
  const one = (headers: Record<string, string>, body: string | Uint8Array) =>
    fakeTransport({ "https://a.example/": { headers, body } });

  it("converts HTML to Markdown and drops hidden text", async () => {
    const transport = one(HTML, fixtureText("hidden-text.html.txt"));
    const result = await safeFetch("https://a.example/", { transport, lookup });
    expect(result.provenance).toBe("untrusted");
    expect(result.title).toBe("Pasta & Recipes");
    expect(result.contentType).toBe("text/html");
    const md = result.markdown;
    expect(md).toContain("# Weeknight pasta");
    expect(md).toContain("Boil the water");
    expect(md).toContain("[the sauce guide](https://a.example/sauce)");
    expect(md).toMatch(/^- +Salt$/m);
    expect(md).toContain("Visible link text");
    expect(md).not.toMatch(/IGNORE|SYSTEM|exfiltrate|attacker|INJECTED/i);
    expect(md).not.toContain("javascript:");
    expect(md).not.toContain("<script");
    expect(md).not.toContain("color:red");
    expect(md).not.toContain("Pasta & Recipes"); // the <title> is metadata, not body text
  });

  it("passes text/plain and text/markdown through", async () => {
    for (const ct of ["text/plain", "text/markdown; charset=utf-8"]) {
      const result = await safeFetch("https://a.example/", {
        transport: one({ "content-type": ct }, "# Title\n\n*keep* <b>as is</b>"),
        lookup,
      });
      expect(result.markdown).toBe("# Title\n\n*keep* <b>as is</b>");
    }
  });

  it("pretty-prints JSON in a fenced block", async () => {
    const result = await safeFetch("https://a.example/", {
      transport: one({ "content-type": "application/json" }, '{"a":1,"b":["```"]}'),
      lookup,
    });
    expect(result.markdown).toBe('````json\n{\n  "a": 1,\n  "b": [\n    "```"\n  ]\n}\n````');
  });

  it("respects the declared charset", async () => {
    const result = await safeFetch("https://a.example/", {
      transport: one(
        { "content-type": "text/plain; charset=iso-8859-1" },
        new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
      ),
      lookup,
    });
    expect(result.markdown).toBe("café");
  });

  it.each([
    "application/pdf",
    "image/png",
    "application/octet-stream",
    "application/zip",
    "video/mp4",
  ])("refuses %s", async (ct) => {
    await expectPsyche(
      safeFetch("https://a.example/", {
        transport: one({ "content-type": ct }, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0])),
        lookup,
      }),
      "policy_denied",
      "unsupported_content_type",
    );
  });

  it("refuses binary bytes labelled as text", async () => {
    await expectPsyche(
      safeFetch("https://a.example/", {
        transport: one(
          { "content-type": "text/plain" },
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]),
        ),
        lookup,
      }),
      "policy_denied",
      "unsupported_content_type",
    );
  });

  it("sniffs HTML when the content type is missing", async () => {
    const result = await safeFetch("https://a.example/", {
      transport: one({}, "<!doctype html><p>sniffed</p>"),
      lookup,
    });
    expect(result.markdown).toBe("sniffed");
  });

  it("returns error pages with their status", async () => {
    const transport = fakeTransport({
      "https://a.example/": { status: 404, headers: HTML, body: "<p>Not found</p>" },
    });
    const result = await safeFetch("https://a.example/", { transport, lookup });
    expect(result.status).toBe(404);
    expect(result.markdown).toBe("Not found");
  });
});
