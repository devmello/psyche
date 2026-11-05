import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  getSetting,
  getThread,
  type PsycheDb,
  revokeSetupTokensWithCertPin,
  setSetting,
} from "@psyche/db";
import {
  type AgentLoop,
  type DeviceScope,
  isMethodName,
  type MemoryStore,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import { isNamedPipePath } from "@psyche/protocol/platform";
import { type WebSocket, WebSocketServer } from "ws";
import pkg from "../package.json" with { type: "json" };
import type { PeerInfo } from "./auth.ts";
import { CloudflareAccessVerifier } from "./cf-access.ts";
import { type GatewayConfig, resolveConfig } from "./config.ts";
import { Connection } from "./connection.ts";
import {
  DEFAULT_LIMITS,
  type GatewayContext,
  type GatewayLimits,
  type HandlerDef,
  type ThreadModelPolicy,
} from "./context.ts";
import { LockedPermissionBroker, UnavailableAgentLoop } from "./defaults.ts";
import { EventBus } from "./event-bus.ts";
import { HANDLERS } from "./handlers/index.ts";
import {
  ensureHome,
  newHandshakeSecret,
  removeHandshakeSecret,
  writeHandshakeSecret,
} from "./home.ts";
import {
  handleHttp,
  type PublicRoute,
  servePublic,
  serveWebhook,
  type WebhookRoute,
  webhookMethods,
} from "./http.ts";
import { Idempotency } from "./idempotency.ts";
import { loadOrCreateGatewayIdentity } from "./identity.ts";
import { bonjourAdvertiser, type MdnsAdvertiser } from "./lan/discovery.ts";
import type { LanInterface } from "./lan/interfaces.ts";
import { type LanContext, type LanLimits, LanListener, peerLimitKey } from "./lan/listener.ts";
import { LAN_SETTING, readLanSettings } from "./lan/settings.ts";
import { createLogger, type Logger } from "./log.ts";
import { allowedMapOrigins } from "./map-proxy.ts";
import { NodeRegistry } from "./nodes/registry.ts";
import { openGatewayDb, releaseGatewayLock } from "./pre-update.ts";
import { presenceStateFor } from "./presence-gate.ts";
import { normalizePeerAddress, resolvePeer, trustedProxyList } from "./proxy.ts";
import { RateLimiter } from "./rate-limit.ts";
import { type RecoveryReport, recoverAfterRestart } from "./recovery.ts";
import {
  RETENTION_INTERVAL_MS,
  reasoningRetentionDays,
  replayRetentionDays,
  runRecordingsDir,
  runRetention,
} from "./retention.ts";
import { RunTraceSink } from "./run-trace/sink.ts";
import { SessionController } from "./session/controller.ts";
import { ensureSocketDir, writeGuestPointer, writeSocketPointer } from "./socket-path.ts";
import { INTERNAL_SETTING_PREFIX, readStateVersion, writeStateVersion } from "./state-version.ts";
import { TransportGate } from "./transport-gate.ts";
import { NdjsonDecoder } from "./transports/ndjson.ts";
import { UpdateGate } from "./update-gate.ts";

/**
 * From package.json, like the CLI's: changesets versions every workspace package together, so
 * `psyche security audit`'s CLI-vs-Gateway check (version.mismatch) compares like with like.
 */
export const GATEWAY_VERSION: string = pkg.version;
const WS_PATH = "/ws";
/** The networks the owner enabled LAN listening on (internal: never readable by clients). */
const LAN_NETWORKS_SETTING = `${INTERNAL_SETTING_PREFIX}lan.networks`;

export interface GatewayOptions {
  config?: Partial<GatewayConfig>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: () => Date;
  /** The owner changed a setting (audit trail: key and value hashes, never the value). */
  onSettingChanged?: (change: {
    key: string;
    before: unknown;
    after: unknown;
    deviceId: string;
  }) => void;
  /** Inject an open database (tests); defaults to SQLite at config.dbPath. */
  db?: PsycheDb;
  /** The door `gateway.prepareUpdate` closes; the composition root shares it with the task pools. */
  updateGate?: UpdateGate;
  /** Agent runtime (S02); defaults to a loop that fails every turn cleanly. */
  agent?: AgentLoop;
  /** Permission Broker (S05); defaults to a fail-closed broker. */
  broker?: PermissionBroker;
  memory?: MemoryStore;
  limits?: Partial<GatewayLimits>;
  /** Tests: where the Cloudflare Access JWKS comes from. */
  cloudflareAccessFetch?: ConstructorParameters<typeof CloudflareAccessVerifier>[1];
  /**
   * Whether a presence verifier can verify now (helper Touch ID key, passkeys). Security changes
   * then need a presence-approved `policy_change` card (security §10, `presence-gate.ts`); once
   * it was true, it being false later fails them closed (`presence_required`).
   */
  settingsPresence?: () => boolean;
  /** After a device is revoked (composition root: end the grants it approved). */
  onDeviceRevoked?: (deviceId: string) => Promise<unknown>;
  /** A device removed itself with devices.revokeSelf (composition root: audit it). */
  onDeviceSelfRevoked?: (revoked: { deviceId: string; name: string }) => void;
  /** A computer paired itself with a setup token (composition root: audit it). */
  onSetupTokenUsed?: (used: { tokenId: string; deviceId: string; scopes: DeviceScope[] }) => void;
  /**
   * The broker publishes its own `receipt.created` events (the composition root forwards them),
   * so `nodes.invoke` must not publish the same receipt again (issue #50).
   */
  brokerPublishesReceipts?: boolean;
  /** Which models may run `auto` threads, and the router's per-thread pin (composition root). */
  threadModels?: ThreadModelPolicy;
  /** Package handlers to mount (composition root); a name the Gateway already handles is refused. */
  handlers?: Readonly<Record<string, HandlerDef>>;
  /**
   * `POST <path>` routes of composed parts (channel webhooks; also `GET` where a route declares
   * it). They authenticate themselves (a
   * transport signature), so the container transport gate does not apply to them.
   */
  webhooks?: Readonly<Record<string, WebhookRoute>>;
  /** Public `GET` routes of composed parts (the Web Bot Auth key directory). */
  publicRoutes?: Readonly<Record<string, PublicRoute>>;
  /** Run the retention sweep on this interval (0 disables the timer; tests call it directly). */
  retentionIntervalMs?: number;
  /**
   * The run trace's redactor (composition root: the vault's `SecretRedactor` and credential-like
   * URL parameters). Every stored or streamed step text goes through it (run trace §4.6).
   */
  traceRedact?: (text: string) => string;
  /**
   * LAN listening backends (tests): the interface list, the host label, the mDNS advertiser
   * (`null` = none) and connection limits. Production uses the machine's interfaces and Bonjour.
   */
  lan?: {
    candidates?: () => LanInterface[];
    hostLabel?: () => string;
    advertiser?: MdnsAdvertiser | null;
    limits?: Partial<LanLimits>;
    /** Tests: which source addresses the LAN listener admits (see `isLanPeerAddress`). */
    allowPeer?: (address: string) => boolean;
  };
}

export interface Gateway {
  readonly config: GatewayConfig;
  /** `http://127.0.0.1:<port>` once listening. */
  readonly origin: string;
  readonly port: number;
  readonly handshakeSecret: string;
  readonly bus: EventBus;
  readonly context: GatewayContext;
  readonly recovery: RecoveryReport;
  stop(reason?: string): Promise<void>;
}

function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolveLive) => {
    const probe = createConnection(path);
    probe.once("connect", () => {
      probe.destroy();
      resolveLive(true);
    });
    probe.once("error", () => resolveLive(false));
  });
}

function checkExtraHandlers(
  handlers: Readonly<Record<string, HandlerDef>>,
): Readonly<Record<string, HandlerDef>> {
  for (const name of Object.keys(handlers)) {
    if (!isMethodName(name)) throw new PsycheError("invalid_params", `Unknown method ${name}`);
    if (Object.hasOwn(HANDLERS, name)) {
      throw new PsycheError("conflict", `${name} is already handled by the Gateway`);
    }
  }
  return handlers;
}

/** Boots the Gateway: DB + recovery, HTTP (`/healthz`, `/version`, static UI), WS clients, Unix-socket nodes. */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const config = resolveConfig(options.env ?? process.env, options.config ?? {});
  const proxies = trustedProxyList(config.trustedProxy.trustedProxies);
  const cfAccess =
    config.cloudflareAccess === null
      ? null
      : new CloudflareAccessVerifier(config.cloudflareAccess, options.cloudflareAccessFetch ?? {});
  const transportGate = new TransportGate({
    mode: config.bind,
    token: config.gatewayToken,
    trustedProxies: proxies,
    // Tailscale Serve on the loopback bind connects from loopback, so that is its default peer.
    tailscaleProxies: trustedProxyList(
      (config.trustedProxy.tailscaleProxies ?? []).length > 0 || config.bind !== "loopback"
        ? (config.trustedProxy.tailscaleProxies ?? [])
        : ["127.0.0.1/32", "::1"],
    ),
    cfAccess,
    allowedLogins: config.trustedProxy.allowedLogins ?? [],
  });
  const log = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };

  ensureHome(config.home);
  const db = options.db ?? (await openGatewayDb(config, () => now().toISOString(), log));
  const recovery = recoverAfterRestart(db, log);
  const bus = new EventBus(readStateVersion(db), (v) => writeStateVersion(db, v));
  // The secret is written to disk only after both listeners are up (see below).
  const handshakeSecret = newHandshakeSecret();
  // Created at first start, never silently replaced (identity.ts): clients pin its public half.
  const identity = loadOrCreateGatewayIdentity(config.home);
  const connections = new Set<Connection>();
  let connSeq = 0;
  let origin = "";
  // The LAN listener exists always and listens only when the owner turned `gateway.lan` on.
  const lan = new LanListener({
    home: config.home,
    log,
    now,
    identityFingerprint: identity.fingerprint,
    onRequest: (req, res) => serveLan(req, res),
    onUpgrade: (req, socket, head, lanContext) => handleUpgrade(req, socket, head, lanContext),
    containerMode: config.bind === "container",
    // Cloudflare Access in front means "reach this only through Access"; a second door that
    // skips it is refused, not warned about.
    blocked: () => (config.cloudflareAccess === null ? null : "cloudflare_access"),
    networks: {
      get: () => {
        const v = getSetting(db, LAN_NETWORKS_SETTING)?.value;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
      },
      set: (networks) => void setSetting(db, LAN_NETWORKS_SETTING, networks),
    },
    advertiser:
      options.lan?.advertiser === undefined
        ? bonjourAdvertiser((err) =>
            log.log("warn", "bonjour error", { name: err instanceof Error ? err.name : "error" }),
          )
        : options.lan.advertiser,
    ...(options.lan?.candidates ? { candidates: options.lan.candidates } : {}),
    ...(options.lan?.hostLabel ? { hostLabel: options.lan.hostLabel } : {}),
    ...(options.lan?.limits ? { limits: options.lan.limits } : {}),
    ...(options.lan?.allowPeer ? { allowPeer: options.lan.allowPeer } : {}),
    // Links made for the old certificate (v2) are void: their tokens stop working at once.
    onCertRotated: () => {
      const revoked = revokeSetupTokensWithCertPin(db);
      if (revoked > 0) log.log("info", "lan links revoked with the certificate", { revoked });
    },
  });

  const broker = options.broker ?? new LockedPermissionBroker();
  const ctx = {
    config,
    db,
    bus,
    log,
    now,
    agent: options.agent ?? new UnavailableAgentLoop(),
    broker,
    memory: options.memory ?? null,
    extraHandlers: checkExtraHandlers(options.handlers ?? {}),
    onDeviceRevoked: options.onDeviceRevoked ?? null,
    onDeviceSelfRevoked: options.onDeviceSelfRevoked ?? null,
    onSetupTokenUsed: options.onSetupTokenUsed ?? null,
    onSettingChanged: options.onSettingChanged ?? null,
    brokerPublishesReceipts: options.brokerPublishesReceipts ?? false,
    presenceState: presenceStateFor(db, options.settingsPresence ?? (() => false)),
    threadModels: options.threadModels ?? null,
    deviceDisconnected: new Set<(deviceId: string) => void>(),
    chatRedo: new Set(),
    chatScreen: { resolve: null },
    terminalSessions: { owns: null },
    chatContext: { resolve: null },
    messageScrub: { scrub: null, heal: null },
    limits,
    failedChallenges: new RateLimiter(limits.failedChallengesPerMinute, 60_000, () =>
      now().getTime(),
    ),
    failedChallengesPrefix: new RateLimiter(limits.failedChallengesPrefixPerMinute, 60_000, () =>
      now().getTime(),
    ),
    lanPairings: {
      perPrefix: new RateLimiter(limits.lanPairingsPerPrefixPerHour, 3_600_000, () =>
        now().getTime(),
      ),
      perIp: new RateLimiter(limits.lanPairingsPerIpPerHour, 3_600_000, () => now().getTime()),
      total: new RateLimiter(limits.lanPairingsTotalPerHour, 3_600_000, () => now().getTime()),
    },
    deviceRequests: new RateLimiter(limits.deviceRequestsPerMinute, 60_000, () => now().getTime()),
    deviceSideEffects: new RateLimiter(limits.deviceSideEffectsPerMinute, 60_000, () =>
      now().getTime(),
    ),
    handshakeSecret,
    updateGate: options.updateGate ?? new UpdateGate(),
    idempotency: new Idempotency(db),
    serverOrigin: () => origin,
    identity,
    challengeOrigin: (peer: PeerInfo) =>
      // A LAN peer is told the address it dialed on the LAN (`https://<host>.local:<port>`, or
      // one of this Host's own LAN addresses), never the loopback or the public origin.
      peer.lan === true
        ? lan.originFor(peer.host)
        : config.publicOrigin !== null && peer.transport === "ws" && !peer.remoteLoopback
          ? config.publicOrigin
          : origin,
    lan: {
      apply: (value: unknown, owner = false) => lan.apply(readLanSettings(value), owner),
      status: () => lan.status(),
      certSpki: () => lan.certSpki(),
      rotateCert: () => lan.rotateCert(),
      refresh: () => lan.refresh(),
    },
    connections: () => connections,
  } as Omit<GatewayContext, "sessions" | "nodes" | "runTrace"> as GatewayContext;
  Object.assign(ctx, {
    sessions: new SessionController(ctx),
    nodes: new NodeRegistry(ctx),
    runTrace: new RunTraceSink({
      db,
      bus,
      now,
      ...(options.traceRedact === undefined ? {} : { redact: options.traceRedact }),
      reasoningRetentionDays: () => reasoningRetentionDays(db),
      replayRetentionDays: () => replayRetentionDays(db),
      recordingsDir: (runId) => runRecordingsDir(config.home, runId),
      // Incognito threads are never written (run trace §4.3).
      isIncognito: (threadId) => getThread(db, threadId)?.kind === "incognito",
    }),
  });

  // Security §3.7: a restart invalidates pending approvals; the broker re-issues them.
  try {
    await broker.reissue();
  } catch (err) {
    log.log("warn", "approval reissue failed", { code: PsycheError.from(err).code });
  }

  const webhooks: Readonly<Record<string, WebhookRoute>> = { ...options.webhooks };
  const publicRoutes: Readonly<Record<string, PublicRoute>> = { ...options.publicRoutes };
  const http: Server = createServer((req, res) => {
    const serve = () =>
      handleHttp(req, res, {
        webRoot: config.webRoot,
        webAsar: config.webAsar,
        version: GATEWAY_VERSION,
        mapOrigins: () => allowedMapOrigins((key) => getSetting(db, key)?.value),
      });
    // The container bind gates every route but the bare health check (Compose healthcheck).
    const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
    // POST by default; GET only on a route that declares it (WhatsApp's subscription handshake).
    const route = Object.hasOwn(webhooks, path) ? webhooks[path] : undefined;
    const webhook =
      route !== undefined && webhookMethods(route).some((m) => m === req.method)
        ? route
        : undefined;
    if (webhook !== undefined) return void serveWebhook(req, res, webhook);
    const pub = req.method === "GET" || req.method === "HEAD" ? publicRoutes[path] : undefined;
    // Public data meant for anyone (a key directory), so the container gate does not apply.
    if (pub !== undefined) return void servePublic(req, res, pub);
    if (transportGate.mode !== "container" || path === "/healthz") return serve();
    const resolved = resolvePeer(
      req.socket.remoteAddress,
      req.headers,
      config.trustedProxy,
      proxies,
    );
    void transportGate.admit(req, resolved).then((admission) => {
      if ("refused" in admission) {
        res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      serve();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    lanContext: LanContext | null,
  ) => {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const requestOrigin = req.headers.origin ?? null;
    // A browser on the LAN names the origin it loaded the page from: only the LAN's own.
    const allowed =
      lanContext === null
        ? new Set([origin, ...config.allowedOrigins])
        : new Set([lanContext.origin, lan.originFor(req.headers.host)]);
    if (url.pathname !== WS_PATH || (requestOrigin !== null && !allowed.has(requestOrigin))) {
      // Security §10: reject any Origin outside the allowlist with 403, before the upgrade.
      log.log("warn", "websocket upgrade rejected", {
        path: url.pathname,
        hasOrigin: requestOrigin !== null,
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (lanContext !== null) {
      // The LAN listener's own connections: never loopback (whatever the address is), forwarding
      // headers are not believed (no proxy is in front of it) and the container and Cloudflare
      // gates do not apply to it. Pairing, the key binding and every rate limit still do.
      acceptUpgrade(req, socket, head, requestOrigin, {
        remoteAddress: normalizePeerAddress(req.socket.remoteAddress ?? "unknown"),
        limitKey: peerLimitKey(normalizePeerAddress(req.socket.remoteAddress ?? "unknown")),
        remoteLoopback: false,
        forwarded: false,
        claimedIdentity: null,
        lan: true,
        host: req.headers.host ?? null,
      });
      return;
    }
    // Proxy headers never authorize the API; every device pairs (security §10). They only make a
    // forwarded connection non-loopback and, in trusted-proxy mode, name the client address.
    const resolved = resolvePeer(
      req.socket.remoteAddress,
      req.headers,
      config.trustedProxy,
      proxies,
    );
    // Transport gate (§10): Cloudflare Access and, with PSYCHE_BIND=container, the token or a
    // verified proxy identity. Pairing still applies after it.
    void transportGate.admit(req, resolved).then((admission) => {
      if ("refused" in admission) {
        log.log("warn", "websocket upgrade rejected", { reason: admission.refused });
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      acceptUpgrade(req, socket, head, requestOrigin, admission.peer);
    });
  };
  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    handleUpgrade(req, socket, head, null),
  );

  /** The LAN listener serves the health check and the WebSocket, nothing else. */
  const serveLan = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
    const ok = path === "/healthz" && (req.method === "GET" || req.method === "HEAD");
    res.writeHead(ok ? 200 : 404, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: "not found" }));
  };

  const acceptUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    requestOrigin: string | null,
    peer: ReturnType<typeof resolvePeer> & {
      lan?: true;
      host?: string | null;
      limitKey?: string;
    },
  ) => {
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const conn = new Connection(
        `ws-${++connSeq}`,
        {
          transport: "ws",
          remoteLoopback: peer.remoteLoopback,
          remoteAddress: peer.remoteAddress,
          origin: requestOrigin,
          claimedIdentity: peer.claimedIdentity,
          ...(peer.lan === true
            ? {
                lan: true as const,
                host: peer.host ?? null,
                ...(peer.limitKey === undefined ? {} : { limitKey: peer.limitKey }),
              }
            : {}),
        },
        {
          send: (f) => ws.readyState === ws.OPEN && ws.send(f),
          close: (r) => ws.close(1000, r.slice(0, 120)),
          bufferedAmount: () => ws.bufferedAmount,
        },
        ctx,
      );
      connections.add(conn);
      // A LAN socket that has not finished `connect` can be closed or evicted (lan/listener.ts).
      if (peer.lan === true) {
        lan.bindAuth(
          socket,
          () => conn.phase === "paired",
          () => conn.phase === "pending",
        );
      }
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          conn.close("binary frames are not supported");
          return;
        }
        void conn.handleRaw(data.toString());
      });
      ws.on("close", () => {
        conn.close("socket closed");
        connections.delete(conn);
      });
      ws.on("error", () => conn.close("socket error"));
    });
  };

  try {
    await new Promise<void>((resolveListen, reject) => {
      http.once("error", reject);
      http.listen(config.port, config.host, () => {
        http.off("error", reject);
        resolveListen();
      });
    });
  } catch (err) {
    if (!options.db) db.close();
    throw err;
  }
  const port = (http.address() as AddressInfo).port;
  origin = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`;

  // Local node transport (mac / win helper, psyche-node): NDJSON frames. A Unix socket, mode
  // 0600; on Windows a named pipe (no file, no mode: the handshake secret and the pipe's default
  // DACL guard it, `@psyche/protocol/platform`). An endpoint that still accepts connections
  // belongs to another running Gateway: refuse instead of stealing it.
  const nodePipe = isNamedPipePath(config.nodeSocketPath);
  const refuseTaken = async (): Promise<never> => {
    await new Promise<void>((r) => http.close(() => r()));
    if (!options.db) db.close();
    throw new PsycheError(
      "conflict",
      `Another Gateway is already listening on ${config.nodeSocketPath}`,
    );
  };
  ensureSocketDir(config.nodeSocketPath, config.home);
  if (nodePipe) {
    // A pipe vanishes with its server, so there is nothing stale to remove; only a live one.
    if (await socketIsLive(config.nodeSocketPath)) await refuseTaken();
  } else if (existsSync(config.nodeSocketPath)) {
    if (await socketIsLive(config.nodeSocketPath)) await refuseTaken();
    rmSync(config.nodeSocketPath, { force: true });
  }
  // One server per node socket. The transport is fixed by the socket a stream arrived on, never
  // by anything the peer says: `unix` is the node socket (the Host's own helper and psyche-node),
  // `vm-relay` the guest socket the Host helper copies sandbox guests into.
  const serveNodes = (transport: "unix" | "vm-relay"): NetServer =>
    createNetServer((socket: Socket) => {
      socket.setEncoding("utf8");
      const decoder = new NdjsonDecoder();
      const conn = new Connection(
        `node-${++connSeq}`,
        {
          transport,
          // A relayed guest is not "this machine's own process": never loopback-trusted.
          remoteLoopback: transport === "unix",
          remoteAddress: transport,
          origin: null,
        },
        { send: (f) => socket.writable && socket.write(`${f}\n`), close: () => socket.end() },
        ctx,
      );
      connections.add(conn);
      socket.on("data", (chunk: string) => {
        try {
          for (const line of decoder.push(chunk)) void conn.handleRaw(line);
        } catch {
          conn.close("frame too large");
        }
      });
      socket.on("close", () => {
        conn.close("socket closed");
        connections.delete(conn);
      });
      socket.on("error", () => conn.close("socket error"));
    });
  const listenOn = (server: NetServer, path: string) =>
    new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  // The secret first: a helper that reconnects the moment a socket opens (a Gateway restart)
  // must find this launch's secret, never the previous one or none.
  const { path: secretPath } = writeHandshakeSecret(config.home, handshakeSecret);
  const nodeServer = serveNodes("unix");
  try {
    await listenOn(nodeServer, config.nodeSocketPath);
  } catch (err) {
    // A pipe created between the check and now (a racing Gateway, or a squatter holding the
    // name: libuv opens the first instance exclusively) is refused the same way.
    if (nodePipe && (err as NodeJS.ErrnoException).code === "EADDRINUSE") await refuseTaken();
    throw err;
  }
  if (!nodePipe) chmodSync(config.nodeSocketPath, 0o600);
  writeSocketPointer(config.home, config.nodeSocketPath);
  let guestServer: NetServer | null = null;
  const guestPipe = config.guestSocketPath !== null && isNamedPipePath(config.guestSocketPath);
  if (config.guestSocketPath !== null) {
    // The node socket check above proved no other Gateway owns this home; a stale guest socket
    // is ours to replace.
    ensureSocketDir(config.guestSocketPath, config.home);
    if (!guestPipe) rmSync(config.guestSocketPath, { force: true });
    guestServer = serveNodes("vm-relay");
    try {
      await listenOn(guestServer, config.guestSocketPath);
      if (!guestPipe) chmodSync(config.guestSocketPath, 0o600);
      // Windows: the sandbox PC's service finds the pipe it relays guests into here.
      if (guestPipe) writeGuestPointer(config.home, config.guestSocketPath);
    } catch (err) {
      // A squatter on the guest pipe (libuv opens the first instance exclusively) costs VM mode,
      // never the Gateway.
      if (!guestPipe || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      guestServer = null;
      log.log("warn", "guest pipe is taken; sandbox guests cannot connect", {});
    }
  }

  // LAN listening only when the owner turned it on (`gateway.lan`); a failure here (no usable
  // interface, no certificate) leaves the Gateway on loopback, which is where it was.
  try {
    await lan.apply(readLanSettings(getSetting(db, LAN_SETTING)?.value));
  } catch (err) {
    log.log("warn", "lan listener failed to start", { code: PsycheError.from(err).code });
  }

  // Follow-ups queued before the restart run now; then the hourly retention sweep.
  ctx.sessions.drainAll();
  // An update that never came (cancelled, or timed out): queued follow-ups start again.
  const stopWatchingGate = ctx.updateGate.onReopen(() => ctx.sessions.drainAll());
  runRetention(ctx);
  const intervalMs = options.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
  const retentionTimer =
    intervalMs > 0
      ? setInterval(() => {
          // Not while an app update is being prepared: the files are about to be handed over.
          if (ctx.updateGate.accepting()) runRetention(ctx);
        }, intervalMs)
      : null;
  retentionTimer?.unref();

  log.log("info", "gateway listening", {
    origin,
    nodeSocket: config.nodeSocketPath,
    guestSocket: config.guestSocketPath ?? "none",
  });

  let stopped = false;
  return {
    config,
    origin,
    port,
    handshakeSecret,
    bus,
    context: ctx,
    recovery,
    async stop(reason = "shutdown") {
      if (stopped) return;
      stopped = true;
      if (retentionTimer) clearInterval(retentionTimer);
      stopWatchingGate();
      bus.publish("gateway.shutdown", { reason });
      await ctx.sessions.stop();
      for (const conn of connections) conn.close(reason);
      connections.clear();
      await lan.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => nodeServer.close(() => r()));
      if (guestServer !== null) await new Promise<void>((r) => guestServer?.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      if (!nodePipe) rmSync(config.nodeSocketPath, { force: true });
      if (config.guestSocketPath !== null && !guestPipe) {
        rmSync(config.guestSocketPath, { force: true });
      }
      if (guestPipe) rmSync(join(config.home, "run", "guest-socket"), { force: true });
      rmSync(join(config.home, "run", "node-socket"), { force: true });
      removeHandshakeSecret(secretPath);
      if (!options.db) {
        db.close();
        // Windows will not delete a data folder while the lock file in it is open.
        releaseGatewayLock(config.home);
      }
      log.log("info", "gateway stopped", { reason });
    },
  };
}
