import { createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import {
  BRIDGE_MAX_FRAME_BYTES,
  errRes,
  eventFrame,
  type Frame,
  okRes,
  PROTOCOL_VERSION,
  PsycheError,
  parseFrame,
  reqFrame,
  serializeFrame,
  validateParams,
} from "@psyche/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { connectSigningPayload } from "../src/client/signing.ts";

/**
 * Mock Gateway for S11's tests (packages/testing has no Gateway double yet). It speaks wire spec
 * v1 for real: it issues a challenge, verifies the Ed25519 signature over the connect signing
 * payload, then answers RPCs from a handler table and pushes events. Optionally it also listens
 * on a browser-bridge socket the way the Gateway will, accepts `bridge.hello` and can drive the
 * desktop's `bridge.*` methods.
 *
 * Test-only: never import it from app code.
 */

export type PairOutcome =
  | { phase: "paired"; scopes: string[] }
  | { phase: "pending"; code: string }
  | { phase: "denied"; reason: string };

export type Handler = (params: unknown, ctx: { connId: number }) => unknown | Promise<unknown>;

export interface MockGatewayOptions {
  /** Outcome of `connect.verify`. Defaults to paired with read/write/approvals. */
  pair?: PairOutcome;
  handlers?: Record<string, Handler>;
  /** Validate request params against the protocol registry (default true). */
  validate?: boolean;
  /** Listen on this path for the desktop's browser bridge. */
  bridgeSocketPath?: string;
  /** Secret the desktop must present in `bridge.hello`. */
  handshakeSecret?: string;
}

export interface RecordedCall {
  connId: number;
  method: string;
  params: unknown;
  idempotencyKey?: string;
}

interface Conn {
  id: number;
  ws: WebSocket;
  paired: boolean;
  seq: number;
  nonce?: string;
  publicKey?: string;
  platform?: string;
  deviceFamily?: string;
}

const DEFAULT_HANDLERS: Record<string, Handler> = {
  "threads.list": () => ({ threads: [], nextCursor: null }),
  "notifications.list": () => ({ notifications: [], nextCursor: null }),
  "approvals.list": () => ({ approvals: [] }),
  "tasks.list": () => ({ tasks: [], nextCursor: null }),
  "settings.get": () => ({ entries: [] }),
  "view.report": () => ({ ok: true }),
};

export class MockBridgePeer {
  readonly events: { event: string; payload: unknown; seq: number }[] = [];
  hello: Record<string, unknown> | undefined;
  private readonly pending = new Map<string, (f: Frame) => void>();
  private nextId = 1;
  private buf = "";
  private readonly listeners = new Set<() => void>();

  private readonly sock: Socket;
  private readonly secret: string | undefined;

  /** Called once the desktop's `bridge.hello` was accepted. */
  onHello: (() => void) | undefined;

  constructor(sock: Socket, secret: string | undefined) {
    this.sock = sock;
    this.secret = secret;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf("\n");
      while (nl >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line) this.onLine(line);
        nl = this.buf.indexOf("\n");
      }
    });
  }

  private write(frame: Frame): void {
    this.sock.write(`${serializeFrame(frame)}\n`);
  }

  private onLine(line: string): void {
    const frame = parseFrame(line, { maxBytes: BRIDGE_MAX_FRAME_BYTES });
    if (frame.type === "req" && frame.method === "bridge.hello") {
      const p = (frame.params ?? {}) as Record<string, unknown>;
      if (this.secret !== undefined && p.handshakeSecret !== this.secret) {
        this.write(errRes(frame.id, new PsycheError("unauthorized", "bad handshake secret")));
        this.sock.end();
        return;
      }
      const { handshakeSecret: _s, ...rest } = p;
      this.hello = rest;
      this.onHello?.();
      this.write(okRes(frame.id, { protocolVersion: PROTOCOL_VERSION, gatewayVersion: "mock" }));
      return;
    }
    if (frame.type === "res") {
      this.pending.get(frame.id)?.(frame);
      this.pending.delete(frame.id);
      return;
    }
    if (frame.type === "event") {
      this.events.push({ event: frame.event, payload: frame.payload, seq: frame.seq });
      for (const l of this.listeners) l();
    }
  }

  /** Calls a `bridge.*` method on the desktop. Rejects with the desktop's error. */
  call(method: string, params?: unknown): Promise<unknown> {
    const id = `g${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (f) => {
        if (f.type !== "res") return;
        if (f.ok) resolve(f.payload);
        else
          reject(
            new PsycheError(f.error.code, f.error.message, {
              details: f.error.details,
              retryable: f.error.retryable ?? false,
            }),
          );
      });
      this.write(reqFrame(id, method, params));
    });
  }

  /** Resolves when an event matching `pred` has arrived (including earlier ones). */
  waitForEvent(
    event: string,
    pred: (payload: unknown) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.events.find((e) => e.event === event && pred(e.payload));
        if (hit) {
          this.listeners.delete(check);
          clearTimeout(timer);
          resolve(hit.payload);
        }
      };
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      this.listeners.add(check);
      check();
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

export class MockGateway {
  readonly calls: RecordedCall[] = [];
  /** Params of every `connect`, oldest first (to assert what clients sent). */
  readonly connects: Record<string, unknown>[] = [];
  readonly handlers: Record<string, Handler>;
  pair: PairOutcome;
  origin = "";
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private bridgeServer: NetServer | undefined;
  private readonly conns = new Set<Conn>();
  private connSeq = 0;
  private stateVersion = 0;
  private readonly bridgeWaiters: ((p: MockBridgePeer) => void)[] = [];
  bridge: MockBridgePeer | undefined;
  private readonly opts: MockGatewayOptions;

  constructor(opts: MockGatewayOptions = {}) {
    this.opts = opts;
    this.pair = opts.pair ?? {
      phase: "paired",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    };
    this.handlers = { ...DEFAULT_HANDLERS, ...opts.handlers };
  }

  get wsUrl(): string {
    return `${this.origin.replace(/^http/, "ws")}/ws`;
  }

  get port(): number {
    return Number(new URL(this.origin).port);
  }

  async start(port = 0): Promise<this> {
    this.http = createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      if (req.url !== "/ws") return socket.destroy();
      this.wss?.handleUpgrade(req, socket, head, (ws) => this.onWs(ws));
    });
    await new Promise<void>((r) => this.http?.listen(port, "127.0.0.1", r));
    this.origin = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    if (this.opts.bridgeSocketPath) await this.startBridge(this.opts.bridgeSocketPath);
    return this;
  }

  private async startBridge(path: string): Promise<void> {
    rmSync(path, { force: true });
    this.bridgeServer = createNetServer((sock) => {
      const peer = new MockBridgePeer(sock, this.opts.handshakeSecret);
      // Only a peer that passed bridge.hello becomes `bridge`; rejected peers are ignored.
      peer.onHello = () => {
        this.bridge?.close();
        this.bridge = peer;
        for (const w of this.bridgeWaiters.splice(0)) w(peer);
      };
    });
    await new Promise<void>((r) => this.bridgeServer?.listen(path, r));
    chmodSync(path, 0o600);
  }

  /** Resolves with the desktop's bridge connection once it has said hello. */
  async waitForBridge(timeoutMs = 10_000): Promise<MockBridgePeer> {
    const deadline = Date.now() + timeoutMs;
    const peer =
      this.bridge ?? (await new Promise<MockBridgePeer>((r) => this.bridgeWaiters.push(r)));
    while (peer.hello === undefined) {
      if (Date.now() > deadline) throw new Error("bridge.hello not received");
      await new Promise((r) => setTimeout(r, 20));
    }
    return peer;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.bridge?.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.bridgeServer ? this.bridgeServer.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    if (this.opts.bridgeSocketPath) rmSync(this.opts.bridgeSocketPath, { force: true });
  }

  /** Drops every client socket (the client should reconnect with backoff). */
  dropClients(): void {
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
  }

  pairedCount(): number {
    return [...this.conns].filter((c) => c.paired).length;
  }

  /** Pushes an event to every paired connection. */
  emit(event: string, payload: unknown): void {
    this.stateVersion++;
    for (const c of this.conns) {
      if (!c.paired) continue;
      c.ws.send(serializeFrame(eventFrame(event, payload, c.seq++, this.stateVersion)));
    }
  }

  /** Waits until a call to `method` has been recorded. */
  async waitForCall(
    method: string,
    pred: (params: unknown) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<RecordedCall> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.calls.find((c) => c.method === method && pred(c.params));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private onWs(ws: WebSocket): void {
    const conn: Conn = { id: ++this.connSeq, ws, paired: false, seq: 0 };
    this.conns.add(conn);
    ws.on("close", () => this.conns.delete(conn));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return ws.close(1003);
      let frame: Frame;
      try {
        frame = parseFrame(data.toString());
      } catch {
        return ws.close(1002);
      }
      if (frame.type !== "req") return;
      void this.onReq(conn, frame.id, frame.method, frame.params, frame.idempotencyKey);
    });
  }

  private send(conn: Conn, frame: Frame): void {
    conn.ws.send(serializeFrame(frame));
  }

  private async onReq(
    conn: Conn,
    id: string,
    method: string,
    params: unknown,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "connect") {
      conn.nonce = randomBytes(32).toString("base64url");
      conn.publicKey = String(p.publicKey);
      conn.platform = String(p.platform);
      conn.deviceFamily = String(p.deviceFamily);
      this.connects.push(p);
      return this.send(
        conn,
        okRes(id, {
          phase: "challenge",
          nonce: conn.nonce,
          serverOrigin: this.origin,
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    }
    if (method === "connect.verify") {
      const ok =
        conn.nonce !== undefined &&
        p.nonce === conn.nonce &&
        typeof p.signature === "string" &&
        this.verifySignature(conn, p.signature);
      if (!ok) return this.send(conn, errRes(id, new PsycheError("unauthorized", "bad signature")));
      if (this.pair.phase === "paired") conn.paired = true;
      return this.send(conn, okRes(id, this.pair));
    }
    if (!conn.paired) {
      return this.send(conn, errRes(id, new PsycheError("not_paired", "pair first")));
    }
    this.calls.push({
      connId: conn.id,
      method,
      params,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    try {
      if (this.opts.validate !== false) validateParams(method, params);
      const handler = this.handlers[method];
      if (!handler) throw new PsycheError("not_implemented", `${method} is not mocked`);
      this.send(conn, okRes(id, await handler(params, { connId: conn.id })));
    } catch (err) {
      this.send(conn, errRes(id, PsycheError.from(err)));
    }
  }

  private verifySignature(conn: Conn, signature: string): boolean {
    try {
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: String(conn.publicKey) },
        format: "jwk",
      });
      const payload = connectSigningPayload({
        nonce: String(conn.nonce),
        platform: String(conn.platform),
        deviceFamily: String(conn.deviceFamily),
        protocolVersion: PROTOCOL_VERSION,
        serverOrigin: this.origin,
      });
      return verify(null, payload, key, Buffer.from(signature, "base64url"));
    } catch {
      return false;
    }
  }
}
