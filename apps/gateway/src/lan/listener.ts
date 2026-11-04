import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { type AddressInfo, isIP, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { isUniqueLocalIpv6, PsycheError, parseIpv6 } from "@psyche/protocol";
import type { Logger } from "../log.ts";
import { normalizePeerAddress } from "../proxy.ts";
import { RateLimiter } from "../rate-limit.ts";
import { ensureLanCert, type LanCert, rotateLanCert } from "./cert.ts";
import { type Advertisement, buildLanTxt, type MdnsAdvertiser } from "./discovery.ts";
import { type LanInterface, listLanInterfaces, resolveLanBinds } from "./interfaces.ts";
import { defaultHostLabel, lanHostName, lanOriginFor } from "./names.ts";
import { type LanSettings, lanOff } from "./settings.ts";

/**
 * The LAN listener (remote-gateway design §3.1, "LAN"): an HTTPS server per chosen interface
 * address, in the same process as the loopback listener and off unless the owner turned it on.
 *
 * - It binds exactly the addresses of the interfaces the owner chose (the primary one by default),
 *   never a wildcard and never loopback, so turning it off, or changing the choice, closes the
 *   socket and nothing else gets bound.
 * - Its certificate is self-signed (`cert.ts`); clients pin it and the Gateway identity key.
 * - It serves `/healthz` and the `/ws` upgrade only. The web UI, webhooks and public routes stay
 *   on loopback and behind the owner's proxy.
 * - It limits what an unauthenticated neighbour can cost: connections per address per minute,
 *   concurrent connections per address and in all, and a short TLS handshake window.
 */

/**
 * The key a neighbour's pre-authentication limits are counted under, besides its own address: an
 * IPv6 peer's /64 (whoever holds a /64 can pick any address in it, and a phone rotates privacy
 * addresses by design), an IPv4 peer's address. The limit on the /64 is looser than the one on a
 * single address (`LanLimits.prefixFactor`), so one address cannot lock the rest of its /64 out,
 * yet cycling addresses buys only a bounded budget. Anything that is not a plain IPv6 address
 * (`unknown`) is kept as it is.
 */
export function peerLimitKey(address: string): string {
  if (isIP(address) !== 6) return address;
  const groups = parseIpv6(address);
  if (groups === null) return address;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * Whether a source address may talk to the LAN listener at all. IPv4 as before. IPv6 only from
 * unique-local: a neighbour that reaches a unique-local address is on the same network with a
 * unique-local (or global) source, while a link-local or zone-qualified source (`fe80::1%en0`,
 * which Node reports with its zone and `parseIpv6` rejects) has no stable identity to limit, so
 * it is refused rather than pooled.
 */
export function isLanPeerAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return true;
  if (family !== 6) return false;
  const groups = parseIpv6(address);
  return groups !== null && isUniqueLocalIpv6(groups);
}

/** `host:port` as a URL writes it, lower case, an IPv6 literal in brackets; null if not a host. */
function canonicalHost(hostPort: string): string | null {
  if (hostPort === "" || /[/\\?#@\s]/.test(hostPort)) return null;
  try {
    const url = new URL(`https://${hostPort}`);
    return url.host === "" ? null : url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** `[fd12::1]:7979` or `192.168.1.20:7979`. */
function addressHostPort(address: string, port: number): string {
  return isIP(address) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

export interface LanContext {
  /** The origin a LAN challenge names by default: `https://<host>.local:<port>`. */
  origin: string;
}

export interface LanLimits {
  connectionsPerMinutePerIp: number;
  concurrentPerIp: number;
  concurrentTotal: number;
  /** The limit on an IPv6 peer's whole /64, as a multiple of the per-address one. */
  prefixFactor: number;
  handshakeTimeoutMs: number;
  /** A socket that has not finished `connect` (paired or pending) by then is closed. */
  unauthenticatedMs: number;
  /** Re-reading the interface list for an address or network change; 0 turns the timer off. */
  watchMs: number;
}

export const DEFAULT_LAN_LIMITS: LanLimits = {
  connectionsPerMinutePerIp: 120,
  concurrentPerIp: 16,
  concurrentTotal: 128,
  prefixFactor: 8,
  handshakeTimeoutMs: 10_000,
  unauthenticatedMs: 10_000,
  watchMs: 15_000,
};

export interface LanListenerDeps {
  home: string;
  log: Logger;
  now: () => Date;
  /** `sha256:<hex>` of the Gateway identity key, advertised in the TXT record. */
  identityFingerprint: string;
  onRequest(req: IncomingMessage, res: ServerResponse): void;
  onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, lan: LanContext): void;
  /** Where the interface list comes from; tests give a fixed one. */
  candidates?: () => LanInterface[];
  hostLabel?: () => string;
  /** `null`: do not advertise (the default for tests and for hosts without a backend). */
  advertiser?: MdnsAdvertiser | null;
  limits?: Partial<LanLimits>;
  /** The Gateway runs in a container: the LAN listener is not offered there. */
  containerMode?: boolean;
  /**
   * A reason LAN listening must not start (`cloudflare_access`): the Gateway is set up to be
   * reached only through Cloudflare Access, which the LAN listener would go around.
   */
  blocked?: () => string | null;
  /**
   * The networks (`192.168.1.0/24`) the owner enabled LAN listening on, kept by the Gateway. A
   * restart or an address change binds only on those; on any other network it pauses until the
   * owner turns it on again.
   */
  networks?: { get(): string[] | undefined; set(networks: string[]): void };
  /**
   * Called as soon as the new certificate key has been written (even if replacing it, or the
   * listeners' restart, then fails): whatever was made for the old certificate is void.
   */
  onCertRotated?: () => void;
  /** Tests: which source addresses are admitted (default `isLanPeerAddress`). */
  allowPeer?: (address: string) => boolean;
}

export interface LanStatus {
  enabled: boolean;
  port: number;
  interfaces: string[];
  /** Also listening on the chosen interfaces' IPv6 unique-local addresses. */
  ipv6: boolean;
  listening: { address: string; port: number }[];
  candidates: LanInterface[];
  origin: string | null;
  certSpki: string | null;
  advertising: boolean;
  /** Reasons something the owner asked for is not happening (unknown interface, port in use). */
  problems: string[];
}

/** One admitted connection, from `admit` on: before TLS, during it and after. */
interface Live {
  /** The peer's own address. */
  ip: string;
  /** The peer's /64 (IPv6) or its address. */
  prefix: string;
  since: number;
  /** Whether it finished `connect` (paired or pending): such a connection is never evicted. */
  authed: () => boolean;
  /** The "must finish `connect`" timer; set once TLS is done. */
  timer: ReturnType<typeof setTimeout> | null;
  /** TLS finished (`track` saw it). A connection that has not is evicted first. */
  secured: boolean;
  /** Evicted: gone from every count already, whatever the socket still takes to close. */
  evicted: boolean;
  destroy: () => void;
  /** Gives the connection's slots back (idempotent). */
  release: () => void;
}

/** Identifies one TCP connection as `connection` and `secureConnection` both report it. */
function connKey(s: {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  localAddress?: string | undefined;
  localPort?: number | undefined;
}): string {
  return `${s.remoteAddress}|${s.remotePort}|${s.localAddress}|${s.localPort}`;
}

/** Resolves when `p` does or after `ms`, whichever is first: a close must never wedge the chain. */
function timeBox(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
    Promise.resolve(p).then(
      () => {
        clearTimeout(t);
        resolve();
      },
      () => {
        clearTimeout(t);
        resolve();
      },
    );
  });
}

interface Bound {
  address: string;
  server: HttpsServer;
  /** Every socket accepted by this server, so closing one bind cuts off only its own peers. */
  sockets: Set<Socket>;
  ad: Advertisement | null;
}

export class LanListener {
  readonly #deps: LanDepsResolved;
  #settings: LanSettings = lanOff();
  #bound: Bound[] = [];
  #cert: LanCert | null = null;
  #origin: string | null = null;
  #hosts = new Set<string>();
  #problems: string[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  readonly #perIpRate: RateLimiter;
  readonly #perPrefixRate: RateLimiter;
  readonly #perIpOpen = new Map<string, number>();
  readonly #perPrefixOpen = new Map<string, number>();
  #open = 0;
  #admitted = 0;
  /** Every admitted connection that is still open. */
  readonly #conns = new Set<Live>();
  readonly #byKey = new Map<string, Live>();
  readonly #byTls = new Map<TLSSocket, Live>();
  /** The listener cannot run now (Cloudflare Access, a container): refresh does nothing. */
  #halted = false;
  #watch: ReturnType<typeof setInterval> | null = null;

  constructor(deps: LanListenerDeps) {
    this.#deps = {
      ...deps,
      candidates: deps.candidates ?? (() => listLanInterfaces(networkInterfaces)),
      hostLabel: deps.hostLabel ?? (() => defaultHostLabel()),
      advertiser: deps.advertiser ?? null,
      limits: { ...DEFAULT_LAN_LIMITS, ...deps.limits },
      containerMode: deps.containerMode ?? false,
      blocked: deps.blocked ?? (() => null),
    };
    this.#perIpRate = new RateLimiter(this.#deps.limits.connectionsPerMinutePerIp, 60_000, () =>
      deps.now().getTime(),
    );
    this.#perPrefixRate = new RateLimiter(
      this.#deps.limits.connectionsPerMinutePerIp * this.#deps.limits.prefixFactor,
      60_000,
      () => deps.now().getTime(),
    );
  }

  /** Serialized: a second `apply` waits for the first, so binds never interleave. */
  apply(settings: LanSettings, owner = false): Promise<LanStatus> {
    const run = this.#chain.then(() => this.#apply(settings, owner));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  rotateCert(): Promise<LanStatus> {
    const run = this.#chain.then(async () => {
      const names = this.#names();
      if (names === null) throw new PsycheError("unavailable", "LAN listening is off");
      try {
        await rotateLanCert(this.#deps.home, names, this.#deps.now());
      } finally {
        // Revoked before anything else can fail, and also when writing the new key did.
        try {
          this.#deps.onCertRotated?.();
        } catch (err) {
          this.#deps.log.log("warn", "lan certificate rotation hook failed", {
            code: err instanceof PsycheError ? err.code : "error",
          });
        }
      }
      // Every open LAN socket is closed (teardown), so each client reconnects to the new
      // certificate and fails its pin if it still holds the old one.
      return this.#apply(this.#settings, false);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    const run = this.#chain.then(() => this.#teardown());
    this.#chain = run.catch(() => undefined);
    await run;
  }

  /** Tells the listener when a LAN socket has finished `connect`; until then it can be evicted. */
  bindAuth(socket: Duplex, authed: () => boolean): void {
    const live = this.#byTls.get(socket as TLSSocket);
    if (live) live.authed = authed;
  }

  /**
   * Re-reads the interfaces and changes only what changed: a bind whose address is gone (or no
   * longer approved) is closed, a newly approved one is opened, and every other listener, with
   * its connected peers, is left alone. An address that appears or vanishes on a network the
   * owner did not approve, or an extra IPv6 address on a prefix already bound, changes nothing.
   */
  refresh(): Promise<void> {
    const run = this.#chain.then(async () => {
      if (!this.#settings.enabled || this.#halted) return;
      await this.#sync(false);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /**
   * What should be bound now: the owner's choice, on approved networks only, with IPv6 only
   * beside an approved IPv4 network of the same interface. The IPv4 network is the anchor: an
   * IPv6 prefix can be announced by anything on the link (a router advertisement), so approving
   * a prefix alone would let a rogue advertiser stand in for the owner's "yes".
   */
  #desired(owner: boolean): { binds: LanInterface[]; problems: string[] } {
    const settings = this.#settings;
    const prefer = new Set(this.#bound.map((b) => b.address));
    const resolved = resolveLanBinds(
      settings.interfaces,
      this.#deps.candidates(),
      settings.ipv6,
      prefer,
    );
    const problems = [
      ...resolved.unknown.map((n) => `unknown_interface:${n}`),
      ...resolved.ipv6Off.map((a) => `ipv6_off:${a}`),
    ];
    let binds = resolved.binds;
    if (!owner && binds.length > 0) {
      // Only on a network the owner said yes on; any other network waits for a new yes.
      const yes = this.#deps.networks?.get() ?? [];
      const allowed = binds.filter((b) => yes.includes(b.network));
      if (allowed.length < binds.length) problems.push("network_paused");
      binds = allowed;
    }
    const anchored = new Set(binds.filter((b) => b.family === "IPv4").map((b) => b.name));
    const kept = binds.filter((b) => b.family === "IPv4" || anchored.has(b.name));
    for (const b of binds) {
      if (!kept.includes(b)) problems.push(`ipv6_needs_ipv4:${b.address}`);
    }
    return { binds: kept, problems };
  }

  /** The origin a challenge to a LAN peer names: the Host header when it is one of ours. */
  originFor(hostHeader: string | null | undefined): string {
    const host = hostHeader === undefined || hostHeader === null ? null : canonicalHost(hostHeader);
    if (host !== null && this.#hosts.has(host)) return `https://${host}`;
    return this.#origin ?? lanOriginFor(this.#deps.hostLabel(), this.#settings.port);
  }

  /** SPKI pin of the certificate being served; `null` when not listening. */
  certSpki(): string | null {
    return this.#bound.length > 0 ? (this.#cert?.spki ?? null) : null;
  }

  status(): LanStatus {
    return {
      enabled: this.#settings.enabled,
      port: this.#settings.port,
      interfaces: [...this.#settings.interfaces],
      ipv6: this.#settings.ipv6,
      listening: this.#bound.map((b) => ({
        address: b.address,
        port: (b.server.address() as AddressInfo | null)?.port ?? this.#settings.port,
      })),
      candidates: this.#deps.candidates(),
      origin: this.#bound.length > 0 ? this.#origin : null,
      certSpki: this.certSpki(),
      advertising: this.#bound.some((b) => b.ad !== null),
      problems: [...this.#problems],
    };
  }

  #names(): string[] | null {
    if (!this.#settings.enabled) return null;
    const addresses =
      this.#bound.length > 0
        ? this.#bound.map((b) => b.address)
        : this.#desired(false).binds.map((b) => b.address);
    return [lanHostName(this.#deps.hostLabel()), ...addresses];
  }

  async #teardown(): Promise<void> {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    const bound = this.#bound;
    this.#bound = [];
    // Open sockets first: `server.close` waits for every connection, and an upgraded WebSocket
    // is not one `closeAllConnections` reaches. Whoever is connected is cut off now (LAN turned
    // off, certificate replaced), and the close below is time-boxed so it can never wedge.
    for (const live of this.#conns) {
      if (live.timer !== null) clearTimeout(live.timer);
      live.destroy();
    }
    this.#conns.clear();
    this.#byKey.clear();
    this.#byTls.clear();
    await Promise.all(
      bound.map(async (b) => {
        await timeBox(b.ad?.stop(), 2_000);
        b.server.closeAllConnections();
        await timeBox(new Promise<void>((resolve) => b.server.close(() => resolve())), 2_000);
      }),
    );
    this.#origin = null;
    this.#hosts = new Set();
  }

  async #apply(settings: LanSettings, owner: boolean): Promise<LanStatus> {
    await this.#teardown();
    this.#settings = settings;
    this.#problems = [];
    this.#halted = false;
    if (!settings.enabled) {
      if (owner) this.#deps.networks?.set([]);
      return this.status();
    }
    const blocked = this.#deps.blocked();
    if (blocked !== null) {
      this.#halted = true;
      this.#problems.push(blocked);
      return this.status();
    }
    if (this.#deps.containerMode) {
      this.#halted = true;
      this.#problems.push("container_bind");
      return this.status();
    }
    this.#startWatch();
    await this.#sync(owner);
    return this.status();
  }

  /** Brings the open listeners to `#desired`: closes what is gone, opens what is new. */
  async #sync(owner: boolean): Promise<void> {
    const desired = this.#desired(owner);
    this.#problems = [...desired.problems];
    const binds = desired.binds;
    const want = new Set(binds.map((b) => b.address));
    const removed = this.#bound.filter((b) => !want.has(b.address));
    if (removed.length > 0) {
      this.#bound = this.#bound.filter((b) => want.has(b.address));
      await this.#closeBound(removed);
      this.#deps.log.log("info", "lan listener closed", {
        addresses: removed.map((b) => b.address).join(","),
      });
    }
    if (binds.length === 0) {
      if (!this.#problems.includes("network_paused")) this.#problems.push("no_interface");
      this.#origin = null;
      this.#hosts = new Set();
      return;
    }
    const added = binds.filter((b) => !this.#bound.some((x) => x.address === b.address));
    const settings = this.#settings;
    const label = this.#deps.hostLabel();
    if (added.length > 0 || this.#cert === null) {
      try {
        this.#cert = await ensureLanCert(
          this.#deps.home,
          [lanHostName(label), ...binds.map((b) => b.address)],
          this.#deps.now(),
        );
      } catch (err) {
        this.#problems.push("cert_unavailable");
        this.#deps.log.log("warn", "lan certificate unavailable", {
          code: err instanceof PsycheError ? err.code : "error",
        });
        return;
      }
    }
    const cert = this.#cert;
    if (cert === null) return;
    this.#origin = lanOriginFor(label, settings.port);
    const lan: LanContext = { origin: this.#origin };
    for (const bind of added) {
      try {
        const { server, sockets } = await this.#listen(bind, settings.port, cert, lan);
        const ad = this.#advertise(bind, server, label);
        this.#bound.push({ address: bind.address, server, sockets, ad });
      } catch (err) {
        this.#problems.push(
          `bind_failed:${bind.address}:${(err as NodeJS.ErrnoException).code ?? "error"}`,
        );
        this.#deps.log.log("warn", "lan listener could not bind", {
          address: bind.address,
          code: (err as NodeJS.ErrnoException).code ?? "error",
        });
      }
    }
    this.#hosts = new Set(
      [
        `${lanHostName(label)}:${settings.port}`,
        ...this.#bound.map((b) => addressHostPort(b.address, settings.port)),
      ].flatMap((h) => canonicalHost(h) ?? []),
    );
    if (this.#bound.length === 0) {
      this.#origin = null;
      this.#hosts = new Set();
      return;
    }
    if (owner) this.#deps.networks?.set([...new Set(binds.map((b) => b.network))]);
    if (added.length > 0) {
      this.#deps.log.log("info", "lan listening", {
        addresses: this.#bound.map((b) => b.address).join(","),
        port: settings.port,
      });
    }
  }

  /** Closes some of the binds (not all): their peers are cut off, every other listener stays. */
  async #closeBound(bound: Bound[]): Promise<void> {
    for (const b of bound) for (const sock of b.sockets) sock.destroy();
    await Promise.all(
      bound.map(async (b) => {
        await timeBox(b.ad?.stop(), 2_000);
        b.server.closeAllConnections();
        await timeBox(new Promise<void>((resolve) => b.server.close(() => resolve())), 2_000);
      }),
    );
  }

  #startWatch(): void {
    const ms = this.#deps.limits.watchMs;
    if (ms <= 0 || this.#watch) return;
    this.#watch = setInterval(() => void this.refresh(), ms);
    this.#watch.unref();
  }

  #advertise(bind: LanInterface, server: HttpsServer, label: string): Advertisement | null {
    const advertiser = this.#deps.advertiser;
    // The mDNS responder is bound to an IPv4 interface address. A dual-stack interface is found
    // through its IPv4 advertisement (the PTR, SRV and TXT records are family-neutral, and the
    // system answers `<host>.local` with its AAAA records); an IPv6-only bind is not advertised.
    if (advertiser === null || bind.family !== "IPv4") return null;
    try {
      return advertiser.publish({
        name: label,
        host: lanHostName(label),
        port: (server.address() as AddressInfo).port,
        txt: buildLanTxt({ hostName: label, fingerprint: this.#deps.identityFingerprint }),
        interfaceAddress: bind.address,
      });
    } catch (err) {
      this.#problems.push("advertise_failed");
      this.#deps.log.log("warn", "bonjour advertising failed", {
        code: err instanceof Error ? err.name : "error",
      });
      return null;
    }
  }

  async #listen(
    bind: LanInterface,
    port: number,
    cert: LanCert,
    lan: LanContext,
  ): Promise<{ server: HttpsServer; sockets: Set<Socket> }> {
    const server = createHttpsServer(
      {
        key: cert.keyPem,
        cert: cert.certPem,
        minVersion: "TLSv1.3",
        // Nobody on this network is asked for a client certificate; devices pair at `connect`.
        requestCert: false,
        handshakeTimeout: this.#deps.limits.handshakeTimeoutMs,
      },
      (req, res) => this.#deps.onRequest(req, res),
    );
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      this.admit(socket);
    });
    server.on("secureConnection", (tls: TLSSocket) => this.track(tls));
    server.on("tlsClientError", () => {
      // The handshake failed (a scanner, a client that does not speak TLS 1.3): nothing to say.
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      this.#deps.onUpgrade(req, socket, head, lan),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // The one place the LAN listener binds: an address the owner chose from this machine's
      // interfaces (resolveLanBinds), never a wildcard.
      server.listen(port, bind.address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => {
      this.#deps.log.log("warn", "lan listener error", {
        code: (err as NodeJS.ErrnoException).code ?? "error",
      });
    });
    return { server, sockets };
  }

  /**
   * A socket that finished TLS: closed unless it completes `connect` in time. Public for the
   * server events above and for tests that drive the limits with stand-in sockets. It is the
   * connection `admit` already counted (the same remote address and port); one `admit` never saw
   * gets an entry of its own.
   */
  track(tls: TLSSocket): void {
    let entry = this.#byKey.get(connKey(tls));
    if (entry === undefined) {
      const ip = normalizePeerAddress(tls.remoteAddress ?? "unknown");
      entry = {
        ip,
        prefix: peerLimitKey(ip),
        since: this.#deps.now().getTime(),
        authed: () => false,
        timer: null,
        secured: false,
        evicted: false,
        destroy: () => tls.destroy(),
        release: () => undefined,
      };
      this.#conns.add(entry);
    }
    const live = entry;
    live.secured = true;
    live.destroy = () => tls.destroy();
    live.timer = setTimeout(() => {
      if (!live.authed()) tls.destroy();
    }, this.#deps.limits.unauthenticatedMs);
    live.timer.unref();
    this.#byTls.set(tls, live);
    tls.once("close", () => {
      if (live.timer !== null) clearTimeout(live.timer);
      this.#byTls.delete(tls);
      this.#conns.delete(live);
    });
  }

  /**
   * Closes one connection that has not finished `connect`, among those in `scope` (a /64, an
   * address, or all). A connection still in its TLS handshake goes before one that finished it:
   * it is the one that holds a slot and proves nothing. Then the victim comes from the address
   * holding the most such connections (its oldest), not simply the oldest in scope, so a
   * neighbour that fills a cap with silent sockets is the one that loses them. When every address
   * holds just one, the newest goes: an owner mid-handshake is older than the flood that arrives
   * after it. Slots are given back at once, so one admission frees only what it evicts.
   */
  #evictUnauthenticated(scope?: { prefix?: string; ip?: string }): boolean {
    const pool = [...this.#conns].filter(
      (c) =>
        !c.evicted &&
        !c.authed() &&
        (scope?.prefix === undefined || c.prefix === scope.prefix) &&
        (scope?.ip === undefined || c.ip === scope.ip),
    );
    const early = pool.filter((c) => !c.secured);
    const candidates = early.length > 0 ? early : pool;
    if (candidates.length === 0) return false;
    const byIp = new Map<string, Live[]>();
    for (const c of candidates) byIp.set(c.ip, [...(byIp.get(c.ip) ?? []), c]);
    const most = Math.max(...[...byIp.values()].map((l) => l.length));
    const heaviest = [...byIp.values()].filter((l) => l.length === most).flat();
    const victim = heaviest.reduce((a, b) =>
      most === 1 ? (b.since >= a.since ? b : a) : b.since < a.since ? b : a,
    );
    victim.evicted = true;
    victim.release();
    victim.destroy();
    return true;
  }

  /**
   * Connection-level limits, before any TLS work for a neighbour that is over them. Two levels:
   * a tight one per source address and a looser one (`prefixFactor` times) per IPv6 /64, so one
   * address cannot spend its neighbours' budget and cycling addresses in a /64 buys only a
   * bounded one. At a cap an unauthenticated socket is evicted before a new one is refused (see
   * `#evictUnauthenticated`). A source that is not allowed (link-local or zone-qualified IPv6)
   * is refused outright.
   */
  admit(socket: Socket): void {
    const ip = normalizePeerAddress(socket.remoteAddress ?? "unknown");
    if (!(this.#deps.allowPeer ?? isLanPeerAddress)(ip)) return void socket.destroy();
    const prefix = peerLimitKey(ip);
    const wide = prefix !== ip;
    const { concurrentPerIp, concurrentTotal, prefixFactor } = this.#deps.limits;
    const concurrentPerPrefix = Math.min(concurrentPerIp * prefixFactor, concurrentTotal / 2);
    if (!this.#perIpRate.allowed(ip) || (wide && !this.#perPrefixRate.allowed(prefix))) {
      return void socket.destroy();
    }
    if ((this.#perIpOpen.get(ip) ?? 0) >= concurrentPerIp && !this.#evictUnauthenticated({ ip })) {
      return void socket.destroy();
    }
    if (
      wide &&
      (this.#perPrefixOpen.get(prefix) ?? 0) >= concurrentPerPrefix &&
      !this.#evictUnauthenticated({ prefix })
    ) {
      return void socket.destroy();
    }
    if (this.#open >= concurrentTotal && !this.#evictUnauthenticated()) {
      return void socket.destroy();
    }
    if (++this.#admitted % 256 === 0) {
      this.#perIpRate.sweep();
      this.#perPrefixRate.sweep();
    }
    this.#perIpRate.record(ip);
    if (wide) this.#perPrefixRate.record(prefix);
    this.#perIpOpen.set(ip, (this.#perIpOpen.get(ip) ?? 0) + 1);
    if (wide) this.#perPrefixOpen.set(prefix, (this.#perPrefixOpen.get(prefix) ?? 0) + 1);
    this.#open += 1;
    let released = false;
    const entry: Live = {
      ip,
      prefix,
      since: this.#deps.now().getTime(),
      authed: () => false,
      timer: null,
      secured: false,
      evicted: false,
      destroy: () => socket.destroy(),
      release: () => {
        if (released) return;
        released = true;
        this.#open -= 1;
        const left = (this.#perIpOpen.get(ip) ?? 1) - 1;
        if (left <= 0) this.#perIpOpen.delete(ip);
        else this.#perIpOpen.set(ip, left);
        if (wide) {
          const rest = (this.#perPrefixOpen.get(prefix) ?? 1) - 1;
          if (rest <= 0) this.#perPrefixOpen.delete(prefix);
          else this.#perPrefixOpen.set(prefix, rest);
        }
      },
    };
    const key = connKey(socket);
    this.#conns.add(entry);
    this.#byKey.set(key, entry);
    socket.once("close", () => {
      entry.release();
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.#conns.delete(entry);
      if (this.#byKey.get(key) === entry) this.#byKey.delete(key);
    });
  }
}

type LanDepsResolved = Omit<
  LanListenerDeps,
  "candidates" | "hostLabel" | "advertiser" | "limits" | "containerMode" | "blocked"
> & {
  candidates: () => LanInterface[];
  hostLabel: () => string;
  advertiser: MdnsAdvertiser | null;
  limits: LanLimits;
  containerMode: boolean;
  blocked: () => string | null;
};
