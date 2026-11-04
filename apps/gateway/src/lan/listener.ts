import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { PsycheError } from "@psyche/protocol";
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

export interface LanContext {
  /** The origin a LAN challenge names by default: `https://<host>.local:<port>`. */
  origin: string;
}

export interface LanLimits {
  connectionsPerMinutePerIp: number;
  concurrentPerIp: number;
  concurrentTotal: number;
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
}

export interface LanStatus {
  enabled: boolean;
  port: number;
  interfaces: string[];
  listening: { address: string; port: number }[];
  candidates: LanInterface[];
  origin: string | null;
  certSpki: string | null;
  advertising: boolean;
  /** Reasons something the owner asked for is not happening (unknown interface, port in use). */
  problems: string[];
}

interface Live {
  ip: string;
  since: number;
  authed: () => boolean;
  timer: ReturnType<typeof setTimeout>;
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
  readonly #perIpOpen = new Map<string, number>();
  #open = 0;
  #admitted = 0;
  readonly #live = new Map<TLSSocket, Live>();
  readonly #raw = new Set<Socket>();
  #boundSig = "";
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
      await rotateLanCert(this.#deps.home, names, this.#deps.now());
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
    const live = this.#live.get(socket as TLSSocket);
    if (live) live.authed = authed;
  }

  /** Re-reads the interfaces; rebinds or pauses when the chosen network's address changed. */
  refresh(): Promise<void> {
    const run = this.#chain.then(async () => {
      if (!this.#settings.enabled || this.#signature() === this.#boundSig) return;
      await this.#apply(this.#settings, false);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #signature(): string {
    const { binds } = resolveLanBinds(this.#settings.interfaces, this.#deps.candidates());
    return JSON.stringify(binds.map((b) => [b.name, b.address, b.network]));
  }

  /** The origin a challenge to a LAN peer names: the Host header when it is one of ours. */
  originFor(hostHeader: string | null | undefined): string {
    const host = hostHeader?.toLowerCase();
    if (host !== undefined && this.#hosts.has(host)) return `https://${host}`;
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
    const available = this.#deps.candidates();
    const { binds } = resolveLanBinds(this.#settings.interfaces, available);
    return [lanHostName(this.#deps.hostLabel()), ...binds.map((b) => b.address)];
  }

  async #teardown(): Promise<void> {
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
    const bound = this.#bound;
    this.#bound = [];
    // Open sockets first: `server.close` waits for every connection, and an upgraded WebSocket
    // is not one `closeAllConnections` reaches. Whoever is connected is cut off now (LAN turned
    // off, certificate replaced), and the close below is time-boxed so it can never wedge.
    for (const [sock, live] of this.#live) {
      clearTimeout(live.timer);
      sock.destroy();
    }
    this.#live.clear();
    for (const sock of this.#raw) sock.destroy();
    this.#raw.clear();
    await Promise.all(
      bound.map(async (b) => {
        await timeBox(b.ad?.stop(), 2_000);
        b.server.closeAllConnections();
        await timeBox(new Promise<void>((resolve) => b.server.close(() => resolve())), 2_000);
      }),
    );
    this.#origin = null;
    this.#hosts = new Set();
    this.#boundSig = "";
  }

  async #apply(settings: LanSettings, owner: boolean): Promise<LanStatus> {
    await this.#teardown();
    this.#settings = settings;
    this.#problems = [];
    if (!settings.enabled) {
      if (owner) this.#deps.networks?.set([]);
      return this.status();
    }
    const blocked = this.#deps.blocked();
    if (blocked !== null) {
      this.#problems.push(blocked);
      return this.status();
    }
    if (this.#deps.containerMode) {
      this.#problems.push("container_bind");
      return this.status();
    }
    const available = this.#deps.candidates();
    const resolved = resolveLanBinds(settings.interfaces, available);
    for (const name of resolved.unknown) this.#problems.push(`unknown_interface:${name}`);
    this.#startWatch();
    this.#boundSig = this.#signature();
    let binds = resolved.binds;
    if (!owner && binds.length > 0) {
      // Only on a network the owner said yes on; any other network waits for a new yes.
      const yes = this.#deps.networks?.get() ?? [];
      const allowed = binds.filter((b) => yes.includes(b.network));
      if (allowed.length < binds.length) this.#problems.push("network_paused");
      binds = allowed;
    }
    if (binds.length === 0) {
      if (!this.#problems.includes("network_paused")) this.#problems.push("no_interface");
      return this.status();
    }
    const label = this.#deps.hostLabel();
    const names = [lanHostName(label), ...binds.map((b) => b.address)];
    try {
      this.#cert = await ensureLanCert(this.#deps.home, names, this.#deps.now());
    } catch (err) {
      this.#problems.push("cert_unavailable");
      this.#deps.log.log("warn", "lan certificate unavailable", {
        code: err instanceof PsycheError ? err.code : "error",
      });
      return this.status();
    }
    this.#origin = lanOriginFor(label, settings.port);
    this.#hosts = new Set([
      `${lanHostName(label)}:${settings.port}`.toLowerCase(),
      ...binds.map((b) => `${b.address}:${settings.port}`),
    ]);
    const lan: LanContext = { origin: this.#origin };
    for (const bind of binds) {
      try {
        const server = await this.#listen(bind, settings.port, this.#cert, lan);
        const ad = this.#advertise(bind, server, label);
        this.#bound.push({ address: bind.address, server, ad });
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
    if (this.#bound.length === 0) {
      this.#origin = null;
      this.#hosts = new Set();
    } else {
      if (owner) {
        this.#deps.networks?.set([...new Set(binds.map((b) => b.network))]);
      }
      this.#deps.log.log("info", "lan listening", {
        addresses: this.#bound.map((b) => b.address).join(","),
        port: settings.port,
      });
    }
    return this.status();
  }

  #startWatch(): void {
    const ms = this.#deps.limits.watchMs;
    if (ms <= 0 || this.#watch) return;
    this.#watch = setInterval(() => void this.refresh(), ms);
    this.#watch.unref();
  }

  #advertise(bind: LanInterface, server: HttpsServer, label: string): Advertisement | null {
    const advertiser = this.#deps.advertiser;
    if (advertiser === null) return null;
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
  ): Promise<HttpsServer> {
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
    server.on("connection", (socket: Socket) => this.#admit(socket));
    server.on("secureConnection", (tls: TLSSocket) => this.#track(tls));
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
    return server;
  }

  /** A socket that finished TLS: closed unless it completes `connect` in time. */
  #track(tls: TLSSocket): void {
    const entry: Live = {
      ip: normalizePeerAddress(tls.remoteAddress ?? "unknown"),
      since: this.#deps.now().getTime(),
      authed: () => false,
      timer: setTimeout(() => {
        if (!entry.authed()) tls.destroy();
      }, this.#deps.limits.unauthenticatedMs),
    };
    entry.timer.unref();
    this.#live.set(tls, entry);
    tls.once("close", () => {
      clearTimeout(entry.timer);
      this.#live.delete(tls);
    });
  }

  /** Closes the oldest socket (of `ip`, if given) that has not finished `connect`. */
  #evictUnauthenticated(ip?: string): boolean {
    let oldest: [TLSSocket, Live] | undefined;
    for (const e of this.#live) {
      if (
        (ip === undefined || e[1].ip === ip) &&
        !e[1].authed() &&
        (!oldest || e[1].since < oldest[1].since)
      )
        oldest = e;
    }
    if (!oldest) return false;
    oldest[0].destroy();
    this.#live.delete(oldest[0]);
    return true;
  }

  /**
   * Connection-level limits, before any TLS work for a neighbour that is over them. At a cap an
   * unauthenticated socket is evicted before a new one is refused, so a neighbour that opens
   * sockets and says nothing cannot lock out a paired device.
   */
  #admit(socket: Socket): void {
    const ip = normalizePeerAddress(socket.remoteAddress ?? "unknown");
    const { concurrentPerIp, concurrentTotal } = this.#deps.limits;
    if (!this.#perIpRate.allowed(ip)) return void socket.destroy();
    if ((this.#perIpOpen.get(ip) ?? 0) >= concurrentPerIp && !this.#evictUnauthenticated(ip)) {
      return void socket.destroy();
    }
    if (this.#open >= concurrentTotal && !this.#evictUnauthenticated()) {
      return void socket.destroy();
    }
    if (++this.#admitted % 256 === 0) this.#perIpRate.sweep();
    this.#perIpRate.record(ip);
    this.#perIpOpen.set(ip, (this.#perIpOpen.get(ip) ?? 0) + 1);
    this.#open += 1;
    this.#raw.add(socket);
    socket.once("close", () => {
      this.#raw.delete(socket);
      this.#open -= 1;
      const left = (this.#perIpOpen.get(ip) ?? 1) - 1;
      if (left <= 0) this.#perIpOpen.delete(ip);
      else this.#perIpOpen.set(ip, left);
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
