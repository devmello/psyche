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
import { PsycheError } from "@psyche/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { type GatewayConfig, resolveConfig } from "./config.ts";
import { Connection, type ConnectionDeps, IdempotencyCache } from "./connection.ts";
import { openGatewayStore } from "./db-store.ts";
import { EventBus } from "./event-bus.ts";
import {
  ensureHome,
  newHandshakeSecret,
  removeHandshakeSecret,
  writeHandshakeSecret,
} from "./home.ts";
import { handleHttp } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";
import type { GatewayStore } from "./store.ts";
import { NdjsonDecoder } from "./transports/ndjson.ts";

export const GATEWAY_VERSION = "0.0.0";
const WS_PATH = "/ws";

export interface GatewayOptions {
  config?: Partial<GatewayConfig>;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  now?: () => Date;
  /** Inject a store (tests); defaults to SQLite at config.dbPath. */
  store?: GatewayStore;
}

export interface Gateway {
  readonly config: GatewayConfig;
  /** `http://127.0.0.1:<port>` once listening. */
  readonly origin: string;
  readonly port: number;
  readonly handshakeSecret: string;
  readonly bus: EventBus;
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

/** Boots the bootstrap Gateway: DB, HTTP (`/healthz`, `/version`, static UI), WS clients, Unix-socket nodes. */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const config = resolveConfig(options.env ?? process.env, options.config ?? {});
  const log = options.logger ?? createLogger();
  const now = options.now ?? (() => new Date());

  ensureHome(config.home);
  const store = options.store ?? openGatewayStore(config.dbPath, now);
  const bus = new EventBus(store.readStateVersion(), (v) => store.writeStateVersion(v));
  // The secret is written to disk only after both listeners are up (see below).
  const handshakeSecret = newHandshakeSecret();
  const connections = new Set<Connection>();
  let connSeq = 0;
  let origin = "";

  const deps: ConnectionDeps = {
    store,
    bus,
    log,
    handshakeSecret,
    serverOrigin: () => origin,
    now,
    idempotency: new IdempotencyCache(),
  };

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
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const conn = new Connection(
        `ws-${++connSeq}`,
        {
          transport: "ws",
          remoteLoopback: isLoopbackAddress(req.socket.remoteAddress),
          origin: requestOrigin,
        },
        {
          send: (f) => ws.readyState === ws.OPEN && ws.send(f),
          close: (r) => ws.close(1000, r.slice(0, 120)),
        },
        deps,
      );
      connections.add(conn);
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          conn.close("binary frames are not supported");
          return;
        }
        conn.handleRaw(data.toString());
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
    store.close();
    throw err;
  }
  const port = (http.address() as AddressInfo).port;
  origin = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`;

  // Unix socket for local nodes (mac helper): NDJSON frames, mode 0600. A socket that still
  // accepts connections belongs to another running Gateway: refuse instead of stealing it.
  if (existsSync(config.nodeSocketPath)) {
    if (await socketIsLive(config.nodeSocketPath)) {
      await new Promise<void>((r) => http.close(() => r()));
      store.close();
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
      { transport: "unix", remoteLoopback: true, origin: null },
      { send: (f) => socket.writable && socket.write(`${f}\n`), close: () => socket.end() },
      deps,
    );
    connections.add(conn);
    socket.on("data", (chunk: string) => {
      try {
        for (const line of decoder.push(chunk)) conn.handleRaw(line);
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

  log.log("info", "gateway listening", { origin, nodeSocket: config.nodeSocketPath });

  let stopped = false;
  return {
    config,
    origin,
    port,
    handshakeSecret,
    bus,
    async stop(reason = "shutdown") {
      if (stopped) return;
      stopped = true;
      bus.publish("gateway.shutdown", { reason }, null);
      for (const conn of connections) conn.close(reason);
      connections.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => nodeServer.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      rmSync(config.nodeSocketPath, { force: true });
      removeHandshakeSecret(secretPath);
      store.close();
      log.log("info", "gateway stopped", { reason });
    },
  };
}
