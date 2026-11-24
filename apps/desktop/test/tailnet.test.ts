import { describe, expect, it, vi } from "vitest";
import { addGateway, EMPTY_GATEWAYS } from "../src/lib/gateways.ts";
import {
  type ExecResult,
  findTailscaleCli,
  MAX_PEERS,
  MAX_PROBES,
  PSYCHE_TAG,
  parseTailnetStatus,
  readTailnet,
  type TailnetDeps,
  tailnetOriginFor,
  tailnetPeerId,
} from "../src/lib/tailnet.ts";

const SUFFIX = "tail1234.ts.net";

function status(over: Record<string, unknown> = {}, peers: Record<string, unknown> = {}) {
  return JSON.stringify({
    BackendState: "Running",
    CurrentTailnet: { Name: "owner@example.com", MagicDNSSuffix: SUFFIX },
    Self: { HostName: "laptop", DNSName: `laptop.${SUFFIX}.`, Online: true, Tags: [] },
    Peer: {
      nodeA: {
        HostName: "studio-mac",
        DNSName: `studio-mac.${SUFFIX}.`,
        Online: true,
        Tags: [PSYCHE_TAG],
      },
      nodeB: {
        HostName: "office-mini",
        DNSName: `office-mini.${SUFFIX}.`,
        Online: true,
        Tags: [],
      },
      nodeC: {
        HostName: "old-box",
        DNSName: `old-box.${SUFFIX}.`,
        Online: false,
        Tags: [],
      },
      nodeD: {
        HostName: "phone",
        DNSName: `phone.${SUFFIX}.`,
        Online: false,
        Tags: [PSYCHE_TAG],
      },
      ...peers,
    },
    ...over,
  });
}

/** Deps with one CLI on PATH, a fake exec and a fake fetch. */
function deps(opts: {
  files?: string[];
  exec?: (file: string, args: string[]) => Promise<ExecResult>;
  fetch?: (url: string) => Promise<Response>;
}): TailnetDeps & { fetchSpy: ReturnType<typeof vi.fn>; execSpy: ReturnType<typeof vi.fn> } {
  const files = new Set(opts.files ?? []);
  const fetchSpy = vi.fn(async (url: string) => {
    if (opts.fetch) return opts.fetch(url);
    return new Response("nope", { status: 404 });
  });
  const execSpy = vi.fn(opts.exec ?? (async () => ({ ok: true, stdout: status() }) as ExecResult));
  return {
    isFile: (p) => files.has(p),
    pathEnv: "/usr/bin:/bin",
    exec: execSpy,
    fetch: fetchSpy as unknown as typeof fetch,
    fetchSpy,
    execSpy,
  };
}

const CLI = "/usr/local/bin/tailscale";

describe("finding the tailscale CLI", () => {
  it("searches PATH first, then the known install locations", () => {
    const d = {
      isFile: (p: string) => p === "/opt/homebrew/bin/tailscale" || p === "/bin/tailscale",
      pathEnv: "/usr/bin:/bin",
    };
    expect(findTailscaleCli(d)).toBe("/bin/tailscale");
    expect(findTailscaleCli({ ...d, pathEnv: "" })).toBe("/opt/homebrew/bin/tailscale");
    expect(findTailscaleCli({ isFile: () => false, pathEnv: "/bin" })).toBeUndefined();
  });

  it("finds the app bundle's CLI", () => {
    const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    expect(findTailscaleCli({ isFile: (p) => p === app, pathEnv: "" })).toBe(app);
  });
});

describe("parsing tailscale status --json", () => {
  it("reads a running tailnet: tagged peers, DNS names with the suffix, online flags", () => {
    const parsed = parseTailnetStatus(status());
    expect(parsed?.running).toBe(true);
    expect(parsed?.peers).toEqual([
      { name: "studio-mac", dnsName: `studio-mac.${SUFFIX}`, online: true, tagged: true },
      { name: "office-mini", dnsName: `office-mini.${SUFFIX}`, online: true, tagged: false },
      { name: "old-box", dnsName: `old-box.${SUFFIX}`, online: false, tagged: false },
      { name: "phone", dnsName: `phone.${SUFFIX}`, online: false, tagged: true },
    ]);
  });

  it("expands a missing DNS name with the MagicDNS suffix the status reports", () => {
    const parsed = parseTailnetStatus(
      status({}, { nodeE: { HostName: "tv", Online: true, Tags: [PSYCHE_TAG] } }),
    );
    expect(parsed?.peers.find((p) => p.name === "tv")?.dnsName).toBe(`tv.${SUFFIX}`);
  });

  it("returns null for garbage, non-objects and arrays", () => {
    expect(parseTailnetStatus("not json")).toBeNull();
    expect(parseTailnetStatus("")).toBeNull();
    expect(parseTailnetStatus("null")).toBeNull();
    expect(parseTailnetStatus("[1,2]")).toBeNull();
    expect(parseTailnetStatus('"string"')).toBeNull();
  });

  it("drops peers with names that would not be accepted as an address", () => {
    const parsed = parseTailnetStatus(
      status(
        {},
        {
          bare: { HostName: "bare", DNSName: "bare.", Online: true, Tags: [PSYCHE_TAG] },
          evil: {
            HostName: "x",
            DNSName: "evil.example.com/../../admin?x=1",
            Online: true,
            Tags: [PSYCHE_TAG],
          },
          local: { HostName: "box", DNSName: "box.local.", Online: true, Tags: [PSYCHE_TAG] },
          odd: { HostName: "odd", DNSName: "a b.c", Online: true, Tags: [PSYCHE_TAG] },
          nothing: 5,
        },
      ),
    );
    const names = parsed?.peers.map((p) => p.name) ?? [];
    expect(names).not.toContain("evil");
    expect(names).not.toContain("box");
    expect(names).not.toContain("odd");
    expect(names).not.toContain("x");
  });

  it("ignores tags that are not strings and only counts tag:psyche", () => {
    const parsed = parseTailnetStatus(
      status(
        {},
        {
          weird: {
            HostName: "weird",
            DNSName: `weird.${SUFFIX}.`,
            Online: true,
            Tags: [7, "tag:other"],
          },
        },
      ),
    );
    expect(parsed?.peers.find((p) => p.name === "weird")?.tagged).toBe(false);
  });

  it("reports a stopped backend as not running", () => {
    expect(parseTailnetStatus(status({ BackendState: "Stopped" }))?.running).toBe(false);
    expect(parseTailnetStatus(status({ BackendState: "NeedsLogin" }))?.running).toBe(false);
  });
});

describe("the three states", () => {
  it("is missing when no CLI is installed, and never runs anything", async () => {
    const d = deps({});
    expect(await readTailnet({ probe: true }, d)).toEqual({ state: "missing", peers: [] });
    expect(d.execSpy).not.toHaveBeenCalled();
    expect(d.fetchSpy).not.toHaveBeenCalled();
  });

  it("is off when the backend is stopped, or the CLI cannot reach tailscaled", async () => {
    const stopped = deps({
      files: [CLI],
      exec: async () => ({ ok: true, stdout: status({ BackendState: "Stopped" }) }),
    });
    expect(await readTailnet({ probe: true }, stopped)).toEqual({ state: "off", peers: [] });
    const failed = deps({ files: [CLI], exec: async () => ({ ok: false, error: "failed" }) });
    expect(await readTailnet({ probe: true }, failed)).toEqual({ state: "off", peers: [] });
    expect(failed.fetchSpy).not.toHaveBeenCalled();
  });

  it("is off when the CLI times out", async () => {
    const d = deps({ files: [CLI], exec: async () => ({ ok: false, error: "timeout" }) });
    expect(await readTailnet({ probe: false }, d)).toEqual({ state: "off", peers: [] });
  });

  it("is ok with the tagged peers when the backend is running and probing is off", async () => {
    const d = deps({ files: [CLI] });
    const listing = await readTailnet({ probe: false }, d);
    expect(listing.state).toBe("ok");
    expect(listing.peers.map((p) => p.name)).toEqual(["studio-mac", "phone"]);
    expect(listing.peers[0]).toMatchObject({
      id: tailnetPeerId(`studio-mac.${SUFFIX}`),
      dnsName: `studio-mac.${SUFFIX}`,
      tagged: true,
      online: true,
    });
    // Local only: no peer is contacted until the owner asks.
    expect(d.fetchSpy).not.toHaveBeenCalled();
    expect(d.execSpy).toHaveBeenCalledWith(CLI, ["status", "--json"]);
  });

  it("is ok with an empty list for garbage or oversized output (installed, unreadable)", async () => {
    const garbage = deps({ files: [CLI], exec: async () => ({ ok: true, stdout: "<html>" }) });
    expect(await readTailnet({ probe: true }, garbage)).toEqual({ state: "ok", peers: [] });
    const big = deps({ files: [CLI], exec: async () => ({ ok: false, error: "too_large" }) });
    expect(await readTailnet({ probe: true }, big)).toEqual({ state: "ok", peers: [] });
  });
});

describe("the healthz probe", () => {
  const healthy = (url: string) =>
    url.endsWith("/healthz")
      ? new Response(JSON.stringify({ ok: true }), { status: 200 })
      : new Response("", { status: 404 });

  it("lists an untagged online peer only when it answers like a Psyche Gateway", async () => {
    const d = deps({
      files: [CLI],
      fetch: async (url) => {
        if (url.includes("office-mini")) return healthy(url);
        return new Response("<html>hi</html>", { status: 200 });
      },
    });
    const listing = await readTailnet({ probe: true }, d);
    expect(listing.peers.map((p) => p.name)).toEqual(["studio-mac", "phone", "office-mini"]);
    // Only the untagged, online peer is probed, at its own /healthz.
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
    expect(d.fetchSpy.mock.calls[0]?.[0]).toBe(`https://office-mini.${SUFFIX}/healthz`);
    const init = d.fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
  });

  it("refuses a healthz answer that is not {ok:true}, is oversized, redirects or fails", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response(JSON.stringify({ ok: false }), { status: 200 }),
      () => new Response("garbage", { status: 200 }),
      () => new Response("x".repeat(5_000), { status: 200 }),
      () => new Response("", { status: 503 }),
      () => {
        throw new Error("ECONNREFUSED");
      },
    ];
    for (const answer of cases) {
      const d = deps({
        files: [CLI],
        fetch: async () => {
          return await answer();
        },
      });
      const listing = await readTailnet({ probe: true }, d);
      expect(listing.peers.map((p) => p.name)).toEqual(["studio-mac", "phone"]);
    }
  });

  it("never probes offline or tagged peers, and caps the probes", async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PROBES + 10; i++) {
      many[`n${i}`] = { HostName: `m${i}`, DNSName: `m${i}.${SUFFIX}.`, Online: true, Tags: [] };
    }
    const d = deps({ files: [CLI], exec: async () => ({ ok: true, stdout: status({}, many) }) });
    await readTailnet({ probe: true }, d);
    expect(d.fetchSpy.mock.calls.length).toBeLessThanOrEqual(MAX_PROBES);
    for (const call of d.fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("old-box");
      expect(String(call[0])).not.toContain("phone");
      expect(String(call[0])).not.toContain("studio-mac");
    }
  });

  it("caps the peers listed", async () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PEERS + 20; i++) {
      many[`t${i}`] = {
        HostName: `t${i}`,
        DNSName: `t${i}.${SUFFIX}.`,
        Online: true,
        Tags: [PSYCHE_TAG],
      };
    }
    const d = deps({ files: [CLI], exec: async () => ({ ok: true, stdout: status({}, many) }) });
    const listing = await readTailnet({ probe: false }, d);
    expect(listing.peers.length).toBe(MAX_PEERS);
  });
});

describe("Connect", () => {
  it("resolves only a listed id to its origin, and refuses any other", () => {
    const listing = new Map([
      [
        tailnetPeerId(`studio-mac.${SUFFIX}`),
        {
          id: tailnetPeerId(`studio-mac.${SUFFIX}`),
          name: "studio-mac",
          dnsName: `studio-mac.${SUFFIX}`,
          online: true,
          tagged: true,
        },
      ],
    ]);
    expect(tailnetOriginFor(listing, tailnetPeerId(`studio-mac.${SUFFIX}`))).toEqual({
      origin: `https://studio-mac.${SUFFIX}`,
      name: "studio-mac",
    });
    expect(() => tailnetOriginFor(listing, "0123456789abcdef")).toThrow();
  });

  it("goes through the same add as a typed address: no pin is pre-trusted", () => {
    const origin = `https://studio-mac.${SUFFIX}`;
    const { entry } = addGateway(EMPTY_GATEWAYS, { address: origin, name: "studio-mac" });
    expect(entry).toMatchObject({ origin, name: "studio-mac" });
    expect(entry).not.toHaveProperty("identityKey");
    expect(entry).not.toHaveProperty("certPin");
    expect(entry).not.toHaveProperty("lan");
  });
});
