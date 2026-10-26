import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  allowedMapOrigins,
  DEFAULT_TILE_ORIGIN,
  handleMapProxy,
  MAP_PROXY_PREFIX,
  originOf,
  proxySegment,
} from "../src/map-proxy.ts";

function run(path: string, allowed: string[], up: (url: string) => Response) {
  const out = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) };
  const req = { url: path, once: () => req } as unknown as IncomingMessage;
  const res: Record<string, unknown> & { headersSent: boolean } = {
    headersSent: false,
    writeHead(s: number, h: Record<string, string>) {
      out.status = s;
      out.headers = h;
      this.headersSent = true;
    },
    end(b?: string | Buffer) {
      out.body = Buffer.from(b ?? "");
    },
    destroy() {},
  };
  const calls: string[] = [];
  const f = (async (u: string) => {
    calls.push(u);
    return up(u);
  }) as unknown as typeof fetch;
  return handleMapProxy(req, res as unknown as ServerResponse, () => allowed, f).then(() => ({
    out,
    calls,
  }));
}

const tile = () =>
  new Response(new Uint8Array([1, 2, 3]), {
    headers: { "content-type": "application/x-protobuf" },
  });
const path = (origin: string, rest: string) => `${MAP_PROXY_PREFIX}${proxySegment(origin)}${rest}`;

describe("map tile proxy", () => {
  it("allows the default host and the configured style origins only", () => {
    const get = (k: string) =>
      k === "ui.map.styleUrl" ? "https://tiles.example.org/s.json" : undefined;
    expect(allowedMapOrigins(get)).toEqual([DEFAULT_TILE_ORIGIN, "https://tiles.example.org"]);
    expect(originOf("ftp://x")).toBeNull();
    expect(originOf("http://169.254.169.254/latest")).toBeNull();
  });

  it("forwards a tile with the path and query, cacheable, with no credentials", async () => {
    const { out, calls } = await run(
      path(DEFAULT_TILE_ORIGIN, "/planet/1/2/3.pbf?v=1"),
      [DEFAULT_TILE_ORIGIN],
      tile,
    );
    expect(out.status).toBe(200);
    expect(calls).toEqual([`${DEFAULT_TILE_ORIGIN}/planet/1/2/3.pbf?v=1`]);
    expect(out.headers["cache-control"]).toMatch(/max-age/);
    expect([...out.body]).toEqual([1, 2, 3]);
  });

  it("refuses an origin that is not configured (no open proxy)", async () => {
    const { out, calls } = await run(
      path("https://evil.example", "/x"),
      [DEFAULT_TILE_ORIGIN],
      tile,
    );
    expect(out.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses redirects off the allowed origin, HTML and oversized bodies", async () => {
    const redirect = await run(
      path(DEFAULT_TILE_ORIGIN, "/a"),
      [DEFAULT_TILE_ORIGIN],
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    expect(redirect.out.status).toBe(502);
    const html = await run(
      path(DEFAULT_TILE_ORIGIN, "/a"),
      [DEFAULT_TILE_ORIGIN],
      () => new Response("<script>", { headers: { "content-type": "text/html" } }),
    );
    expect(html.out.status).toBe(502);
    const big = await run(
      path(DEFAULT_TILE_ORIGIN, "/a"),
      [DEFAULT_TILE_ORIGIN],
      () =>
        new Response(new Uint8Array(9 * 1024 * 1024), { headers: { "content-type": "image/png" } }),
    );
    expect(big.out.status).toBe(502);
  });
});
