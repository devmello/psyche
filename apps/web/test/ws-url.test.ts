import { describe, expect, it } from "vitest";
import { gatewayWsUrl, healthzUrl } from "../src/lib/ws-url.ts";

/** A Location-shaped object as a hostile link might produce it. */
function loc(href: string): Location {
  const u = new URL(href);
  return {
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    search: u.search,
    hash: u.hash,
  } as Location;
}

describe("gatewayWsUrl", () => {
  it("uses ws: for http origins and wss: for https origins", () => {
    expect(gatewayWsUrl(loc("http://127.0.0.1:7979/"))).toBe("ws://127.0.0.1:7979/ws");
    expect(gatewayWsUrl(loc("https://psyche.example.ts.net/threads/1"))).toBe(
      "wss://psyche.example.ts.net/ws",
    );
  });

  it("ignores gateway URLs and tokens in location.search and location.hash (CVE-2026-25253)", () => {
    const hostile = loc(
      "http://127.0.0.1:7979/?gatewayUrl=wss://evil.example/ws&token=abc#gatewayUrl=wss://evil.example/ws",
    );
    expect(hostile.search).toContain("evil.example");
    expect(hostile.hash).toContain("evil.example");
    const url = gatewayWsUrl(hostile);
    expect(url).toBe("ws://127.0.0.1:7979/ws");
    expect(url).not.toContain("evil");
    expect(url).not.toContain("token");
    expect(healthzUrl(hostile)).toBe("http://127.0.0.1:7979/healthz");
  });

  it("cannot be redirected by a path-looking origin", () => {
    expect(gatewayWsUrl({ origin: "http://localhost:5173" })).toBe("ws://localhost:5173/ws");
  });
});
