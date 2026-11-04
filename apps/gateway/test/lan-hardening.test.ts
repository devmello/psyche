import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import type { LanInterface } from "../src/lan/interfaces.ts";
import { isLanPeerAddress, type LanLimits, LanListener } from "../src/lan/listener.ts";

const homes: string[] = [];
const listeners: LanListener[] = [];
const sockets: TLSSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const l of listeners.splice(0)) await l.stop();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const quiet = { log: () => undefined };

/** A stand-in for an accepted socket: only what the limits look at. */
class Fake extends EventEmitter {
  destroyed = false;
  readonly remoteAddress: string;
  constructor(remoteAddress: string) {
    super();
    this.remoteAddress = remoteAddress;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

function listener(opts: {
  limits?: Partial<LanLimits>;
  cands?: () => LanInterface[];
  yes?: () => string[];
  allowPeer?: (a: string) => boolean;
}): LanListener {
  const home = mkdtempSync(join(tmpdir(), "psyche-lan-hard-"));
  homes.push(home);
  const l = new LanListener({
    home,
    log: quiet,
    now: () => new Date(),
    identityFingerprint: `sha256:${"ab".repeat(32)}`,
    onRequest: (_req, res) => void res.end("ok"),
    onUpgrade: (_req, socket) => void socket.destroy(),
    candidates: opts.cands ?? (() => []),
    hostLabel: () => "studio-mac",
    advertiser: null,
    limits: { watchMs: 0, ...opts.limits },
    ...(opts.yes ? { networks: { get: opts.yes, set: () => undefined } } : {}),
    ...(opts.allowPeer ? { allowPeer: opts.allowPeer } : {}),
  });
  listeners.push(l);
  return l;
}

/** Offers a stand-in connection to the limits; the socket is tracked if it was admitted. */
function arrive(l: LanListener, address: string): Fake {
  const s = new Fake(address);
  l.admit(s as unknown as Socket);
  if (!s.destroyed) l.track(s as unknown as TLSSocket);
  return s;
}

const A = "fd12:3456:789a:1::a";
const B = "fd12:3456:789a:1::b";

describe("who may connect, and how much", () => {
  it("admits IPv4 and unique-local IPv6 sources only", () => {
    for (const ok of ["192.168.1.7", "10.0.0.2", "fd12:3456:789a:1::a", "fc00::1"]) {
      expect(isLanPeerAddress(ok), ok).toBe(true);
    }
    for (const bad of [
      "fe80::1",
      "fe80::1%lo0", // what Node reports for a link-local peer: with its zone
      "fe80::1%en0",
      "2600:1700::5",
      "::1",
      "::",
      "ff02::1",
      "unknown",
      "",
    ]) {
      expect(isLanPeerAddress(bad), bad).toBe(false);
    }
    const l = listener({});
    for (const bad of ["fe80::1", "fe80::1%lo0", "2600:1700::5", "unknown"]) {
      expect(arrive(l, bad).destroyed, bad).toBe(true);
    }
    for (const ok of ["fd12:3456:789a:1::a", "10.0.0.9"])
      expect(arrive(l, ok).destroyed).toBe(false);
  });

  it("limits each address tightly, so one address cannot spend its /64 neighbours' budget", () => {
    const l = listener({
      limits: { connectionsPerMinutePerIp: 3, concurrentPerIp: 50, prefixFactor: 4 },
    });
    expect([1, 2, 3].map(() => arrive(l, A).destroyed)).toEqual([false, false, false]);
    expect(arrive(l, A).destroyed).toBe(true);
    // The neighbour on the same /64 is untouched by A's budget.
    expect(arrive(l, B).destroyed).toBe(false);
  });

  it("caps a whole /64 more loosely, so cycling addresses buys only a bounded budget", () => {
    const l = listener({
      limits: { connectionsPerMinutePerIp: 3, concurrentPerIp: 50, prefixFactor: 2 },
    });
    // Six connections in all from one /64 (3 x 2), however the addresses are chosen.
    const results = Array.from({ length: 8 }, (_, i) =>
      arrive(l, `fd12:3456:789a:1::${(0x100 + i).toString(16)}`),
    ).map((s) => s.destroyed);
    expect(results).toEqual([false, false, false, false, false, false, true, true]);
    // Another /64, and IPv4, have their own.
    expect(arrive(l, "fd12:3456:789a:2::1").destroyed).toBe(false);
    expect(arrive(l, "192.168.1.7").destroyed).toBe(false);
  });

  it("takes a silent neighbour's sockets before the owner's handshaking one, across a /64", () => {
    const l = listener({
      limits: {
        connectionsPerMinutePerIp: 1000,
        concurrentPerIp: 4,
        concurrentTotal: 40,
        prefixFactor: 2,
      },
    });
    const X1 = "fd12:3456:789a:1::1";
    const X2 = "fd12:3456:789a:1::2";
    const attacker = [...Array(4)]
      .map(() => arrive(l, X1))
      .concat([...Array(4)].map(() => arrive(l, X2)));
    expect(attacker.every((s) => !s.destroyed)).toBe(true);
    // The /64 is at its concurrent cap (8). The owner arrives: an attacker socket makes room.
    const owner = arrive(l, "fd12:3456:789a:1::beef");
    expect(owner.destroyed).toBe(false);
    expect(attacker.filter((s) => s.destroyed)).toHaveLength(1);
    // And again: the owner's socket is still not the one taken.
    const more = arrive(l, "fd12:3456:789a:1::cafe");
    expect(more.destroyed).toBe(false);
    expect(owner.destroyed).toBe(false);
    expect(attacker.filter((s) => s.destroyed)).toHaveLength(2);
  });

  it("at the global cap, the address holding the most silent sockets loses one", () => {
    const l = listener({
      limits: { connectionsPerMinutePerIp: 1000, concurrentPerIp: 8, concurrentTotal: 6 },
    });
    const owner = arrive(l, "10.0.0.5");
    const noisy = [...Array(5)].map(() => arrive(l, "10.0.0.9"));
    expect(arrive(l, "10.0.0.7").destroyed).toBe(false);
    expect(owner.destroyed).toBe(false);
    expect(noisy.filter((s) => s.destroyed)).toHaveLength(1);
  });
});

// --- listeners that really bind loopback, to see what a change does to the ones that stay ----

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const V4: LanInterface = {
  name: "lan0",
  address: "127.0.0.1",
  family: "IPv4",
  network: "127.0.0.0/8",
  isDefault: true,
};
const V6_NET = "fd12:3456:789a:1:0:0:0:0/64";
// `::1` and `::2` stand in for two addresses of one prefix (nothing else is bindable here).
const v6 = (address: string): LanInterface => ({
  name: "lan0",
  address,
  family: "IPv6",
  network: V6_NET,
  isDefault: false,
});

async function open(port: number, host: string): Promise<TLSSocket> {
  const s = tlsConnect({ host, port, rejectUnauthorized: false, minVersion: "TLSv1.3" });
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once("secureConnect", () => resolve());
    s.once("error", reject);
  });
  return s;
}

const addresses = (l: LanListener) =>
  l
    .status()
    .listening.map((x) => x.address)
    .sort();

describe("a change to one address leaves the other listeners alone", () => {
  it("a temporary IPv6 address coming and going does not touch IPv4 or the bound IPv6", async () => {
    let cands: LanInterface[] = [V4, v6("::1")];
    const l = listener({
      cands: () => cands,
      yes: () => ["127.0.0.0/8", V6_NET],
      allowPeer: () => true,
    });
    const port = await freePort();
    await l.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    expect(addresses(l)).toEqual(["127.0.0.1", "::1"]);
    const client = await open(port, "127.0.0.1");
    let dropped = false;
    client.once("close", () => {
      dropped = true;
    });

    // A new privacy address appears on the bound prefix: nothing is rebound.
    cands = [V4, v6("::1"), v6("::2")];
    await l.refresh();
    expect(addresses(l)).toEqual(["127.0.0.1", "::1"]);
    // The bound address stays chosen even if a "smaller" one appears and the other is listed first.
    cands = [V4, v6("::2"), v6("::1")];
    await l.refresh();
    expect(addresses(l)).toEqual(["127.0.0.1", "::1"]);
    // The unbound one going away is no event at all.
    cands = [V4, v6("::1")];
    await l.refresh();

    // The bound IPv6 address itself goes away (the next one cannot be bound here): only that
    // listener closes. The IPv4 one, and its connected client, stay.
    cands = [V4, v6("::2")];
    await l.refresh();
    expect(addresses(l)).toEqual(["127.0.0.1"]);
    expect(l.status().problems.some((p) => p.startsWith("bind_failed:::2:"))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(dropped).toBe(false);
    expect(client.destroyed).toBe(false);
  });

  it("an approved prefix that appears opens its listener and closes nothing", async () => {
    let cands: LanInterface[] = [V4];
    let yes = ["127.0.0.0/8"];
    const l = listener({ cands: () => cands, yes: () => yes, allowPeer: () => true });
    const port = await freePort();
    await l.apply({ enabled: true, interfaces: ["lan0"], port, ipv6: true }, true);
    const client = await open(port, "127.0.0.1");
    let dropped = false;
    client.once("close", () => {
      dropped = true;
    });

    // A prefix the owner never approved shows up (a router advertisement, anyone's): nothing opens.
    cands = [V4, v6("::1")];
    await l.refresh();
    expect(addresses(l)).toEqual(["127.0.0.1"]);
    expect(l.status().problems).toContain("network_paused");

    // Once approved, it is opened beside the existing one, which is not closed.
    yes = ["127.0.0.0/8", V6_NET];
    await l.refresh();
    expect(addresses(l)).toEqual(["127.0.0.1", "::1"]);
    await new Promise((r) => setTimeout(r, 50));
    expect(dropped).toBe(false);
    const six = await open(port, "::1");
    expect(six.destroyed).toBe(false);
  });

  it("an IPv6 address named in the setting is not bound while IPv6 is off, and says so", async () => {
    const l = listener({
      cands: () => [V4, v6("::1")],
      yes: () => ["127.0.0.0/8", V6_NET],
      allowPeer: () => true,
    });
    const port = await freePort();
    const off = await l.apply({ enabled: true, interfaces: ["::1"], port, ipv6: false }, true);
    expect(off.listening).toEqual([]);
    expect(off.problems).toContain("ipv6_off:::1");
    // With IPv6 on it still needs the IPv4 network of its interface to be bound with it.
    const alone = await l.apply({ enabled: true, interfaces: ["::1"], port, ipv6: true }, true);
    expect(alone.listening).toEqual([]);
    expect(alone.problems).toContain("ipv6_needs_ipv4:::1");
    const both = await l.apply(
      { enabled: true, interfaces: ["127.0.0.1", "::1"], port, ipv6: true },
      true,
    );
    expect(both.listening.map((x) => x.address).sort()).toEqual(["127.0.0.1", "::1"]);
  });
});
