import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
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
}

export const DEFAULT_LAN_LIMITS: LanLimits = {
  connectionsPerMinutePerIp: 120,
  concurrentPerIp: 16,
  concurrentTotal: 128,
  handshakeTimeoutMs: 10_000,
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

  constructor(deps: LanListenerDeps) {
    this.#deps = {
      ...deps,
      candidates: deps.candidates ?? (() => listLanInterfaces(networkInterfaces)),
      hostLabel: deps.hostLabel ?? (() => defaultHostLabel()),
      advertiser: deps.advertiser ?? null,
      limits: { ...DEFAULT_LAN_LIMITS, ...deps.limits },
      containerMode: deps.containerMode ?? false,
    };
    this.#perIpRate = new RateLimiter(this.#deps.limits.connectionsPerMinutePerIp, 60_000, () =>
      deps.now().getTime(),
    );
  }

  /** Serialized: a second `apply` waits for the first, so binds never interleave. */
  apply(settings: LanSettings): Promise<LanStatus> {
    const run = this.#chain.then(() => this.#apply(settings));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  rotateCert(): Promise<LanStatus> {
    const run = this.#chain.then(async () => {
      const names = this.#names();
      if (names === null) throw new PsycheError("unavailable", "LAN listening is off");
      await rotateLanCert(this.#deps.home, names, this.#deps.now());
      await this.#teardown();
      return this.#apply(this.#settings);
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async stop(): Promise<void> {
    const run = this.#chain.then(() => this.#teardown());
    this.#chain = run.catch(() => undefined);
    await run;
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
    const bound = this.#bound;
    this.#bound = [];
    await Promise.all(
      bound.map(async (b) => {
        await b.ad?.stop().catch(() => undefined);
        b.server.closeAllConnections();
        await new Promise<void>((resolve) => b.server.close(() => resolve()));
      }),
    );
    this.#origin = null;
    this.#hosts = new Set();
  }

  async #apply(settings: LanSettings): Promise<LanStatus> {
    await this.#teardown();
    this.#settings = settings;
    this.#problems = [];
    if (!settings.enabled) return this.status();
    if (this.#deps.containerMode) {
      this.#problems.push("container_bind");
      return this.status();
    }
    const available = this.#deps.candidates();
    const { binds, unknown } = resolveLanBinds(settings.interfaces, available);
    for (const name of unknown) this.#problems.push(`unknown_interface:${name}`);
    if (binds.length === 0) {
      this.#problems.push("no_interface");
      return this.status();
    }
    const label = this.#deps.hostLabel();
    const names = [lanHostName(label), ...binds.map((b) => b.address)];
    this.#cert = await ensureLanCert(this.#deps.home, names, this.#deps.now());
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
      this.#deps.log.log("info", "lan listening", {
        addresses: this.#bound.map((b) => b.address).join(","),
        port: settings.port,
      });
    }
    return this.status();
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

  /** Connection-level limits, before any TLS work for a neighbour that is over them. */
  #admit(socket: Socket): void {
    const ip = normalizePeerAddress(socket.remoteAddress ?? "unknown");
    const { concurrentPerIp, concurrentTotal } = this.#deps.limits;
    const open = this.#perIpOpen.get(ip) ?? 0;
    if (!this.#perIpRate.allowed(ip) || open >= concurrentPerIp || this.#open >= concurrentTotal) {
      socket.destroy();
      return;
    }
    if (++this.#admitted % 256 === 0) this.#perIpRate.sweep();
    this.#perIpRate.record(ip);
    this.#perIpOpen.set(ip, open + 1);
    this.#open += 1;
    socket.once("close", () => {
      this.#open -= 1;
      const left = (this.#perIpOpen.get(ip) ?? 1) - 1;
      if (left <= 0) this.#perIpOpen.delete(ip);
      else this.#perIpOpen.set(ip, left);
    });
  }
}

type LanDepsResolved = Omit<
  LanListenerDeps,
  "candidates" | "hostLabel" | "advertiser" | "limits" | "containerMode"
> & {
  candidates: () => LanInterface[];
  hostLabel: () => string;
  advertiser: MdnsAdvertiser | null;
  limits: LanLimits;
  containerMode: boolean;
};
