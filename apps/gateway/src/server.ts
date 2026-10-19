import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";
import { openDb, type PsycheDb } from "@psyche/db";
import {
  type AgentLoop,
  isMethodName,
  type MemoryStore,
  type PermissionBroker,
  PsycheError,
} from "@psyche/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { type GatewayConfig, resolveConfig } from "./config.ts";
import { Connection } from "./connection.ts";
import {
  DEFAULT_LIMITS,
  type GatewayContext,
  type GatewayLimits,
  type HandlerDef,
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
import { handleHttp } from "./http.ts";
import { Idempotency } from "./idempotency.ts";
import { createLogger, type Logger } from "./log.ts";
import { NodeRegistry } from "./nodes/registry.ts";
import { RateLimiter } from "./rate-limit.ts";
import { type RecoveryReport, recoverAfterRestart } from "./recovery.ts";
import { RETENTION_INTERVAL_MS, runRetention } from "./retention.ts";
import { SessionController } from "./session/controller.ts";
import { readStateVersion, writeStateVersion } from "./state-version.ts";
import { NdjsonDecoder } from "./transports/ndjson.ts";

export const GATEWAY_VERSION = "0.1.0";
const WS_PATH = "/ws";

export interface GatewayOptions {
  config?: Partial<GatewayConfig>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: () => Date;
  /** Inject an open database (tests); defaults to SQLite at config.dbPath. */
  db?: PsycheDb;
  /** Agent runtime (S02); defaults to a loop that fails every turn cleanly. */
  agent?: AgentLoop;
  /** Permission Broker (S05); defaults to a fail-closed broker. */
  broker?: PermissionBroker;
  memory?: MemoryStore;
  limits?: Partial<GatewayLimits>;
  /** Package handlers to mount (composition root); a name the Gateway already handles is refused. */
  handlers?: Readonly<Record<string, HandlerDef>>;
  /** Run the retention sweep on this interval (0 disables the timer; tests call it directly). */
  retentionIntervalMs?: number;
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

function isLoopbackAddress(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
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
  const log = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());
  const limits: GatewayLimits = { ...DEFAULT_LIMITS, ...options.limits };

  ensureHome(config.home);
  const db = options.db ?? openDb(config.dbPath, { now: () => now().toISOString() });
  const recovery = recoverAfterRestart(db, log);
  const bus = new EventBus(readStateVersion(db), (v) => writeStateVersion(db, v));
  // The secret is written to disk only after both listeners are up (see below).
  const handshakeSecret = newHandshakeSecret();
  const connections = new Set<Connection>();
  let connSeq = 0;
  let origin = "";

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
    limits,
    failedChallenges: new RateLimiter(limits.failedChallengesPerMinute, 60_000, () =>
      now().getTime(),
    ),
    handshakeSecret,
    idempotency: new Idempotency(db),
    serverOrigin: () => origin,
    connections: () => connections,
  } as Omit<GatewayContext, "sessions" | "nodes"> as GatewayContext;
  Object.assign(ctx, { sessions: new SessionController(ctx), nodes: new NodeRegistry(ctx) });

  // Security §3.7: a restart invalidates pending approvals; the broker re-issues them.
  try {
    await broker.reissue();
  } catch (err) {
    log.log("warn", "approval reissue failed", { code: PsycheError.from(err).code });
  }

  const http: Server = createServer((req, res) =>
    handleHttp(req, res, { webRoot: config.webRoot, version: GATEWAY_VERSION }),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 });

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const requestOrigin = req.headers.origin ?? null;
    const allowed = new Set([origin, ...config.allowedOrigins]);
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
    // Identity headers from a proxy (Tailscale-User-Login, Cf-Access-*) are deliberately not read:
    // they never authorize the API; every device pairs (security §10).
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const remoteAddress = req.socket.remoteAddress ?? "unknown";
      const conn = new Connection(
        `ws-${++connSeq}`,
        {
          transport: "ws",
          remoteLoopback: isLoopbackAddress(remoteAddress),
          remoteAddress,
          origin: requestOrigin,
        },
        {
          send: (f) => ws.readyState === ws.OPEN && ws.send(f),
          close: (r) => ws.close(1000, r.slice(0, 120)),
        },
        ctx,
      );
      connections.add(conn);
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
  });

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

  // Unix socket for local nodes (mac helper): NDJSON frames, mode 0600. A socket that still
  // accepts connections belongs to another running Gateway: refuse instead of stealing it.
  if (existsSync(config.nodeSocketPath)) {
    if (await socketIsLive(config.nodeSocketPath)) {
      await new Promise<void>((r) => http.close(() => r()));
      if (!options.db) db.close();
      throw new PsycheError(
        "conflict",
        `Another Gateway is already listening on ${config.nodeSocketPath}`,
      );
    }
    rmSync(config.nodeSocketPath, { force: true });
  }
  const nodeServer: NetServer = createNetServer((socket: Socket) => {
    socket.setEncoding("utf8");
    const decoder = new NdjsonDecoder();
    const conn = new Connection(
      `node-${++connSeq}`,
      { transport: "unix", remoteLoopback: true, remoteAddress: "unix", origin: null },
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
  await new Promise<void>((resolveListen, reject) => {
    nodeServer.once("error", reject);
    nodeServer.listen(config.nodeSocketPath, () => {
      nodeServer.off("error", reject);
      resolveListen();
    });
  });
  chmodSync(config.nodeSocketPath, 0o600);
  const { path: secretPath } = writeHandshakeSecret(config.home, handshakeSecret);

  // Follow-ups queued before the restart run now; then the hourly retention sweep.
  ctx.sessions.drainAll();
  runRetention(ctx);
  const intervalMs = options.retentionIntervalMs ?? RETENTION_INTERVAL_MS;
  const retentionTimer = intervalMs > 0 ? setInterval(() => runRetention(ctx), intervalMs) : null;
  retentionTimer?.unref();

  log.log("info", "gateway listening", { origin, nodeSocket: config.nodeSocketPath });

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
      bus.publish("gateway.shutdown", { reason });
      await ctx.sessions.stop();
      for (const conn of connections) conn.close(reason);
      connections.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => nodeServer.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      rmSync(config.nodeSocketPath, { force: true });
      removeHandshakeSecret(secretPath);
      if (!options.db) db.close();
      log.log("info", "gateway stopped", { reason });
    },
  };
}
