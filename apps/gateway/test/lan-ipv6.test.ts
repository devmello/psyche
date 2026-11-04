import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { type NetworkInterfaceInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLanCert, lanTlsDir } from "../src/lan/cert.ts";
import type { AdvertiseSpec, MdnsAdvertiser } from "../src/lan/discovery.ts";
import {
  isLanBindAddress,
  isPrivateLanAddress,
  isUniqueLocalAddress,
  type LanInterface,
  listLanInterfaces,
  resolveLanBinds,
} from "../src/lan/interfaces.ts";
import { peerLimitKey } from "../src/lan/listener.ts";
import { parseLanSettings } from "../src/lan/settings.ts";
import { startTestGateway, TestClient, type TestGateway } from "./helpers.ts";

const homes: string[] = [];
const gateways: TestGateway[] = [];
afterEach(async () => {
  for (const g of gateways.splice(0)) await g.cleanup();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const ip6 = (
  address: string,
  over: Partial<NetworkInterfaceInfo> & { scopeid?: number } = {},
): NetworkInterfaceInfo =>
  ({
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
    ...over,
  }) as NetworkInterfaceInfo;

const ip4 = (address: string): NetworkInterfaceInfo =>
  ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  }) as NetworkInterfaceInfo;

describe("which IPv6 addresses the Gateway may ever listen on", () => {
  it("accepts unique-local (fc00::/7) and nothing else", () => {
    for (const a of [
      "fd12:3456:789a:1::20",
      "fc00::1",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]) {
      expect(isUniqueLocalAddress(a), a).toBe(true);
      expect(isLanBindAddress(a), a).toBe(true);
    }
    for (const a of [
      "2001:db8::1", // documentation, a stand-in for any global unicast address
      "2600:1700:abcd::5",
      "2a02:1234::1",
      "fe80::1", // link-local
      "fe80::1%en0",
      "febf::1",
      "::1",
      "::",
      "ff02::fb",
      "::ffff:10.0.0.1", // IPv4-mapped
      "[fd12::1]", // brackets belong to URLs, not to an address
      "fd12::1::2",
      "not-an-address",
    ]) {
      expect(isLanBindAddress(a), a).toBe(false);
    }
    expect(isPrivateLanAddress("fd12::1")).toBe(false);
    expect(isPrivateLanAddress("10.0.0.5")).toBe(true);
  });

  it("lists ULA addresses from the interface table and drops global, link-local and mapped ones", () => {
    const list = listLanInterfaces(() => ({
      lo0: [ip6("::1", { internal: true })],
      en0: [
        ip4("192.168.1.20"),
        ip6("fe80::1c2b:3d4e:5f60:7182", { scopeid: 15 }),
        ip6("fe80::1"), // link-local even when the scope id is missing
        ip6("2600:1700:abcd:1::20"), // global unicast: never
        ip6("2600:1700:abcd:1:aaaa:bbbb:cccc:dddd"),
        ip6("fd12:3456:789a:1::20"),
        ip6("fd12:3456:789a:1:ba:dc0f:fee1:1234"), // a rotating privacy address, same prefix
        ip6("::ffff:192.168.1.20"),
      ],
      // Tunnels and bridges never count, whatever they carry.
      utun3: [ip6("fd00:1::1")],
      bridge100: [ip6("fd00:2::1")],
      awdl0: [ip6("fd00:3::1")],
      // A ULA address that carries a scope id is not a plain ULA address.
      en7: [ip6("fd99::7", { scopeid: 3 })],
    }));
    expect(list.map((i) => i.address)).toEqual([
      "192.168.1.20",
      "fd12:3456:789a:1::20",
      "fd12:3456:789a:1:ba:dc0f:fee1:1234",
    ]);
    expect(list.every((i) => i.name === "en0")).toBe(true);
    expect(list.map((i) => i.family)).toEqual(["IPv4", "IPv6", "IPv6"]);
    // The IPv4 address is the default; the network of an IPv6 address is its /64 prefix, shared
    // by the stable and the privacy address (so a rotating one is not a "new network").
    expect(list.find((i) => i.isDefault)?.address).toBe("192.168.1.20");
    expect(list[1]?.network).toBe("fd12:3456:789a:1:0:0:0:0/64");
    expect(list[2]?.network).toBe(list[1]?.network);
  });

  it("never offers link-local addresses, with or without a zone, even when they are all there is", () => {
    const list = listLanInterfaces(() => ({
      en0: [ip6("fe80::1", { scopeid: 4 }), ip6("fe80::2"), ip6("fe80::3%en0")],
    }));
    expect(list).toEqual([]);
  });

  it("falls back to a ULA address as the primary one only when there is no private IPv4", () => {
    const list = listLanInterfaces(() => ({ en0: [ip6("fd12:3456:789a:1::20")] }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ family: "IPv6", isDefault: true });
  });
});

describe("what the owner's choice resolves to", () => {
  const all: LanInterface[] = listLanInterfaces(() => ({
    en0: [ip4("192.168.1.20"), ip6("fd12:3456:789a:1::20")],
    en5: [ip4("10.0.0.8")],
  }));

  it("is IPv4 only until IPv6 is turned on: an upgrade opens nothing new", () => {
    expect(resolveLanBinds([], all).binds.map((b) => b.address)).toEqual(["192.168.1.20"]);
    expect(resolveLanBinds(["en0"], all).binds.map((b) => b.address)).toEqual(["192.168.1.20"]);
  });

  it("adds the chosen interface's ULA addresses, and only those, when IPv6 is on", () => {
    expect(resolveLanBinds([], all, true).binds.map((b) => b.address)).toEqual([
      "192.168.1.20",
      "fd12:3456:789a:1::20",
    ]);
    expect(resolveLanBinds(["en5"], all, true).binds.map((b) => b.address)).toEqual(["10.0.0.8"]);
  });

  it("takes an IPv6 address typed in full as exactly that address, but only with IPv6 on", () => {
    const literal = resolveLanBinds(["fd12:3456:789a:1::20"], all, true);
    expect(literal.binds.map((b) => b.address)).toEqual(["fd12:3456:789a:1::20"]);
    expect(resolveLanBinds(["FD12:3456:789A:1::20"], all, true).binds).toHaveLength(1);
    // With IPv6 off the address is not bound, and it says so instead of calling it unknown.
    expect(resolveLanBinds(["fd12:3456:789a:1::20"], all)).toEqual({
      binds: [],
      unknown: [],
      ipv6Off: ["fd12:3456:789a:1::20"],
    });
    // A global or link-local address is not in the list, so it is unknown and binds nothing.
    for (const wanted of ["2600:1700:abcd:1::20", "fe80::1", "::1", "fd12::99"]) {
      expect(resolveLanBinds([wanted], all, true), wanted).toEqual({
        binds: [],
        unknown: [wanted],
        ipv6Off: [],
      });
    }
  });

  it("binds one IPv6 address per prefix, and keeps the bound one while it exists", () => {
    const many = listLanInterfaces(() => ({
      en0: [
        ip4("192.168.1.20"),
        ip6("fd12:3456:789a:1::20"),
        ip6("fd12:3456:789a:1:ba:dc0f:fee1:1234"), // a temporary address on the same prefix
        ip6("fd12:3456:789a:1:5555:6666:7777:8888"),
        ip6("fd99:0:0:7::5"), // a second prefix
      ],
    }));
    const pick = (prefer: string[] = []) =>
      resolveLanBinds([], many, true, new Set(prefer))
        .binds.filter((b) => b.family === "IPv6")
        .map((b) => b.address);
    // First time: the first address in sorted order, once per prefix.
    expect(pick()).toEqual(["fd12:3456:789a:1::20", "fd99:0:0:7::5"]);
    // Sticky: a bound address stays chosen while the interface still has it.
    expect(pick(["fd12:3456:789a:1:ba:dc0f:fee1:1234"])).toEqual([
      "fd12:3456:789a:1:ba:dc0f:fee1:1234",
      "fd99:0:0:7::5",
    ]);
    // When it is gone, the next one is taken.
    expect(pick(["fd12:3456:789a:1::dead"])).toEqual(["fd12:3456:789a:1::20", "fd99:0:0:7::5"]);
  });

  it("the setting refuses the wildcard and keeps ipv6 a plain boolean", () => {
    expect(() => parseLanSettings({ enabled: true, interfaces: ["::"] })).toThrow(
      /every interface/,
    );
    expect(() => parseLanSettings({ enabled: true, ipv6: "yes" })).toThrow(/ipv6/);
    expect(parseLanSettings({ enabled: true }).ipv6).toBe(false);
    expect(parseLanSettings({ enabled: true, ipv6: true }).ipv6).toBe(true);
    // A global address may be written down, but it can never resolve to a bind (above).
    expect(parseLanSettings({ enabled: true, interfaces: ["2600:1700::1"] }).interfaces).toEqual([
      "2600:1700::1",
    ]);
  });
});

describe("the certificate for an IPv6 address", () => {
  it("is valid for the address, is not reissued on every start, and keeps the pin", async () => {
    const home = mkdtempSync(join(tmpdir(), "psyche-lan6-"));
    homes.push(home);
    const names = ["studio-mac.local", "192.168.1.20", "fd12:3456:789a:1::20"];
    const first = await ensureLanCert(home, names, new Date("2026-11-04T12:00:00Z"));
    const cert = new X509Certificate(first.certPem);
    expect(cert.checkIP("fd12:3456:789a:1::20")).toBeTruthy();
    expect(cert.checkIP("fd12:3456:789a:1::21")).toBeUndefined();
    expect(cert.checkIP("192.168.1.20")).toBeTruthy();
    // Node writes the SAN uncompressed; the same names must still count as unchanged.
    const again = await ensureLanCert(home, names, new Date("2026-11-04T12:05:00Z"));
    expect(again.certPem).toBe(first.certPem);
    // A different address reissues the certificate for the same key: the pin stays.
    const moved = await ensureLanCert(
      home,
      ["studio-mac.local", "fd12:3456:789a:1::21"],
      new Date("2026-11-04T12:10:00Z"),
    );
    expect(moved.certPem).not.toBe(first.certPem);
    expect(moved.spki).toBe(first.spki);
  });
});

describe("a neighbour's limits are counted per /64", () => {
  it("collapses an IPv6 peer to its /64 and leaves IPv4 and others alone", () => {
    expect(peerLimitKey("fd12:3456:789a:1::20")).toBe("fd12:3456:789a:1::/64");
    expect(peerLimitKey("fd12:3456:789a:1:ba:dc0f:fee1:1234")).toBe("fd12:3456:789a:1::/64");
    expect(peerLimitKey("fd12:3456:789a:2::20")).not.toBe(peerLimitKey("fd12:3456:789a:1::20"));
    expect(peerLimitKey("192.168.1.20")).toBe("192.168.1.20");
    expect(peerLimitKey("unknown")).toBe("unknown");
  });
});

// A real IPv6 listener, with `::1` standing in for the interface (like 127.0.0.1 does for IPv4 in
// lan.test.ts): nothing here touches a real network interface. Skipped where the machine has no
// IPv6 loopback.
const hasIpv6 = await new Promise<boolean>((resolve) => {
  const s: Server = createServer();
  s.once("error", () => resolve(false));
  s.listen(0, "::1", () => s.close(() => resolve(true)));
});

/**
 * The chain is checked against the Gateway's own certificate. Node's host-name check does not
 * match an IPv6 address in a certificate (it is how a browser would do it); Psyche's own client
 * pins the SPKI instead (`lan-tls.ts`), so the name is not what these tests are about.
 */
const trust = (ca: string) => ({
  ca,
  // `ws` types this as returning a boolean; Node's TLS wants an error or nothing.
  checkServerIdentity: (() => undefined) as unknown as () => boolean,
});

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function advertiser(): { ad: MdnsAdvertiser; published: AdvertiseSpec[] } {
  const published: AdvertiseSpec[] = [];
  return {
    published,
    ad: {
      publish(spec) {
        published.push(spec);
        return { stop: async () => undefined };
      },
    },
  };
}

const V4: LanInterface = {
  name: "lan0",
  address: "127.0.0.1",
  family: "IPv4",
  network: "127.0.0.0/8",
  isDefault: true,
};
const V6: LanInterface = {
  name: "lan0",
  address: "::1",
  family: "IPv6",
  network: "0:0:0:0:0:0:0:1/128",
  isDefault: false,
};

describe.skipIf(!hasIpv6)("LAN over IPv6 (listener)", () => {
  async function start(cands: () => LanInterface[]) {
    const a = advertiser();
    const g = await startTestGateway({
      lan: {
        candidates: cands,
        hostLabel: () => "studio-mac",
        advertiser: a.ad,
        // `::1` stands in for the peer, and it is not unique-local: see lan-hardening.test.ts.
        allowPeer: () => true,
      },
    });
    gateways.push(g);
    return { g, a, port: await freePort() };
  }

  it("binds the IPv6 address only when IPv6 is on, and names it with brackets", async () => {
    const { g, a, port } = await start(() => [V4, V6]);
    const lan = g.gateway.context.lan;
    const off = await lan.apply({ enabled: true, interfaces: ["lan0"], port }, true);
    expect(off.listening).toEqual([{ address: "127.0.0.1", port }]);
    expect(off.ipv6).toBe(false);

    const on = await lan.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    expect(on.ipv6).toBe(true);
    expect(on.listening.map((l) => l.address).sort()).toEqual(["127.0.0.1", "::1"]);
    // The certificate is valid for the IPv6 address, and the SPKI pin is one value for both.
    const ca = readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8");
    expect(new X509Certificate(ca).checkIP("::1")).toBeTruthy();

    // A client that dials the IPv6 literal is told the bracketed origin it dialed.
    const c = await TestClient.open(`wss://[::1]:${port}/ws`, {}, trust(ca));
    const res = await c.request("connect", {
      protocolVersion: { min: 1, max: 1 },
      deviceId: "lan6-a",
      publicKey: "k".repeat(43),
      role: "client",
      platform: "macos",
      deviceFamily: "desktop",
      name: "ipv6 client",
    });
    expect((res.payload as { serverOrigin?: string }).serverOrigin).toBe(`https://[::1]:${port}`);
    expect((res.payload as { lanCertSpki?: string }).lanCertSpki).toBe(on.certSpki);
    c.close();

    // Bonjour is advertised through the IPv4 interface address only (the responder is IPv4);
    // the IPv6 bind adds no second advertisement.
    expect(a.published.every((p) => p.interfaceAddress === "127.0.0.1")).toBe(true);
  });

  it("never binds IPv6 without the interface's IPv4 network (an advertised prefix alone is no yes)", async () => {
    const { g, a, port } = await start(() => [{ ...V6, isDefault: true }]);
    const status = await g.gateway.context.lan.apply(
      { enabled: true, interfaces: [], port, ipv6: true },
      true,
    );
    expect(status.listening).toEqual([]);
    expect(status.problems).toContain("ipv6_needs_ipv4:::1");
    expect(a.published).toEqual([]);
  });

  it("matches a Host header however the IPv6 address is written, and nothing else", async () => {
    const { g, port } = await start(() => [V4, V6]);
    const lan = g.gateway.context.lan;
    await lan.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    const fallback = `https://studio-mac.local:${port}`;
    // Through a connection: each header form is answered with the canonical origin or the
    // `.local` one.
    const ca = readFileSync(join(lanTlsDir(g.home), "cert.pem"), "utf8");
    const origin = async (host: string) => {
      const c = await TestClient.open(`wss://[::1]:${port}/ws`, { host }, trust(ca));
      const res = await c.request("connect", {
        protocolVersion: { min: 1, max: 1 },
        deviceId: `lan6-${Math.random().toString(36).slice(2)}`,
        publicKey: "k".repeat(43),
        role: "client",
        platform: "macos",
        deviceFamily: "desktop",
        name: "ipv6 client",
      });
      c.close();
      return (res.payload as { serverOrigin?: string }).serverOrigin;
    };
    expect(await origin(`[::1]:${port}`)).toBe(`https://[::1]:${port}`);
    expect(await origin(`[0:0:0:0:0:0:0:1]:${port}`)).toBe(`https://[::1]:${port}`);
    expect(await origin(`[::2]:${port}`)).toBe(fallback);
    expect(await origin(`[::1]:${port + 1}`)).toBe(fallback);
    expect(await origin(`[::1]:${port}/x`)).toBe(fallback);
    expect(await origin(`evil.example:${port}`)).toBe(fallback);
  });

  it("pauses only the IPv6 bind when its prefix changes, and leaves IPv4 listening", async () => {
    let v6: LanInterface = { ...V6, network: "fd12:3456:789a:1:0:0:0:0/64" };
    const { g, port } = await start(() => [V4, v6]);
    const lan = g.gateway.context.lan;
    const first = await lan.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    expect(first.listening.map((l) => l.address).sort()).toEqual(["127.0.0.1", "::1"]);
    // The Mac joins another IPv6 prefix: only the IPv6 bind waits for a new yes.
    v6 = { ...V6, network: "fd99:0:0:7:0:0:0:0/64" };
    await lan.refresh();
    expect(lan.status().listening.map((l) => l.address)).toEqual(["127.0.0.1"]);
    expect(lan.status().problems).toContain("network_paused");
    const again = await lan.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    expect(again.listening).toHaveLength(2);
  });

  it("an address that is global or link-local never reaches a bind, even when named", async () => {
    const { g, port } = await start(() => [V4]);
    for (const wanted of ["2600:1700:abcd:1::20", "fe80::1", "::1"]) {
      const status = await g.gateway.context.lan.apply(
        { enabled: true, interfaces: [wanted], port, ipv6: true },
        true,
      );
      expect(status.listening, wanted).toEqual([]);
      expect(status.problems, wanted).toContain(`unknown_interface:${wanted}`);
    }
  });
});
