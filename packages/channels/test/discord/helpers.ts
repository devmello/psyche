import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Channel } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { type WebSocket, WebSocketServer } from "ws";
import { DiscordAdapter, type DiscordAdapterOptions } from "../../src/adapters/discord/index.ts";
import type { ChannelInboundEvent } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";

export const TOKEN = "fake-discord-token.for-tests-only.s3cretHmacPartForTests_0123456789";
export const BOT_ID = "900000000000000001";
export const OWNER = "100000000000000001";
export const STRANGER = "300000000000000003";
export const OWNER_DM = "500000000000000001";
export const STRANGER_DM = "500000000000000003";
export const GUILD = "700000000000000001";
export const GUILD_CHANNEL = "710000000000000001";

export const tokenSource = (token = TOKEN) => ({
  use: <T>(fn: (t: string) => Promise<T>) => fn(token),
});

export interface RestCall {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  /** Parsed JSON, or the raw text of a multipart body. */
  body: unknown;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Responder = (call: RestCall) => RestReply | undefined;

export async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Stands in for discord.com: a gateway (ws) and a REST API (http), both on localhost:0. */
export class FakeDiscord {
  readonly rest: RestCall[] = [];
  /** Every payload a client sent the gateway, by connection index. */
  readonly received: { conn: number; op: number; d: unknown }[] = [];
  heartbeatIntervalMs = 40;
  ackHeartbeats = true;
  /** Close code sent instead of READY on IDENTIFY (e.g. 4004). */
  closeOnIdentify: number | undefined;
  responders: Responder[] = [];
  connections = 0;

  #http: Server;
  #wss: WebSocketServer;
  #sockets: WebSocket[] = [];
  #seq = 0;
  #nextMessage = 800000000000000000n;

  private constructor(http: Server, wss: WebSocketServer) {
    this.#http = http;
    this.#wss = wss;
  }

  static async create(): Promise<FakeDiscord> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    let self: FakeDiscord | undefined;
    const http = createServer((req, res) => {
      self?.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    self = new FakeDiscord(http, wss);
    wss.on("connection", (ws) => self?.handleConnection(ws));
    return self;
  }

  get gatewayUrl(): string {
    return `ws://127.0.0.1:${(this.#wss.address() as AddressInfo).port}/?v=10&encoding=json`;
  }

  get apiBase(): string {
    return `http://127.0.0.1:${(this.#http.address() as AddressInfo).port}/api/v10`;
  }

  ops(op: number): { conn: number; op: number; d: unknown }[] {
    return this.received.filter((p) => p.op === op);
  }

  calls(method: string, path: string | RegExp): RestCall[] {
    return this.rest.filter(
      (c) =>
        c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)),
    );
  }

  respond(responder: Responder): void {
    this.responders.unshift(responder);
  }

  dispatch(t: string, d: unknown): void {
    const ws = this.#sockets.at(-1);
    ws?.send(JSON.stringify({ op: 0, t, s: ++this.#seq, d }));
  }

  send(payload: unknown): void {
    this.#sockets.at(-1)?.send(JSON.stringify(payload));
  }

  /** Kills the current connection without a close frame (a network drop). */
  drop(): void {
    this.#sockets.at(-1)?.terminate();
  }

  async close(): Promise<void> {
    for (const ws of this.#sockets) ws.terminate();
    await new Promise<void>((r) => this.#wss.close(() => r()));
    this.#http.closeAllConnections();
    await new Promise<void>((r) => this.#http.close(() => r()));
  }

  handleConnection(ws: WebSocket): void {
    const conn = this.connections++;
    this.#sockets.push(ws);
    ws.on("message", (raw) => {
      const p = JSON.parse(String(raw)) as { op: number; d: unknown };
      this.received.push({ conn, ...p });
      if (p.op === 1 && this.ackHeartbeats) ws.send(JSON.stringify({ op: 11 }));
      if (p.op === 2) {
        if (this.closeOnIdentify !== undefined) {
          ws.close(this.closeOnIdentify, "nope");
          return;
        }
        ws.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: ++this.#seq,
            d: {
              session_id: "sess-1",
              resume_gateway_url: this.gatewayUrl.split("/?")[0],
              user: { id: BOT_ID, username: "psyche", bot: true },
            },
          }),
        );
      }
      if (p.op === 6) ws.send(JSON.stringify({ op: 0, t: "RESUMED", s: ++this.#seq, d: {} }));
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatIntervalMs } }));
  }

  handleRequest(req: IncomingMessage, res: import("node:http").ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      if (String(req.headers["content-type"] ?? "").includes("json")) body = JSON.parse(raw);
      const call: RestCall = {
        method: req.method ?? "",
        path: (req.url ?? "").replace(/^\/api\/v10/, ""),
        headers: req.headers,
        body,
      };
      this.rest.push(call);
      const reply =
        this.responders.map((r) => r(call)).find((r) => r !== undefined) ?? this.#default(call);
      res.writeHead(reply.status, {
        ...(reply.body === undefined ? {} : { "content-type": "application/json" }),
        ...reply.headers,
      });
      res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
    });
  }

  #default(call: RestCall): RestReply {
    if (call.method === "POST" && /^\/channels\/\d+\/messages$/.test(call.path)) {
      return { status: 200, body: { id: String(++this.#nextMessage) } };
    }
    if (call.method === "POST" && call.path === "/users/@me/channels") {
      const recipient = (call.body as { recipient_id: string }).recipient_id;
      return {
        status: 200,
        body: { id: recipient === OWNER ? OWNER_DM : `5${recipient.slice(1)}` },
      };
    }
    return { status: 204 };
  }
}

export function adapterOptions(fake: FakeDiscord): DiscordAdapterOptions {
  return {
    token: tokenSource(),
    account: "psyche",
    gatewayUrl: fake.gatewayUrl,
    apiBase: fake.apiBase,
    reconnectDelayMs: () => 10,
    random: () => 0.5,
  };
}

export interface Harness {
  fake: FakeDiscord;
  adapter: DiscordAdapter;
  service: ChannelService;
  broker: FakePermissionBroker;
  clock: FakeClock;
  delivered: ChannelInboundEvent[];
  channel: Channel;
  close(): Promise<void>;
}

let counter = 0;

/** A ChannelService with a Discord channel (owner OWNER, dmPolicy pairing) over a FakeDiscord. */
export async function harness(options: { channel?: Partial<Channel> } = {}): Promise<Harness> {
  const fake = await FakeDiscord.create();
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const delivered: ChannelInboundEvent[] = [];
  const service = new ChannelService({
    store: new MemoryChannelStore({ clock, newId: () => `id${++counter}` }),
    broker,
    clock,
    sink: {
      deliver: async (e) => {
        delivered.push(e);
      },
    },
    emit: () => undefined,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    random: () => 0.5,
    pairingRandom: (() => {
      let i = 0;
      return (max: number) => i++ % max;
    })(),
  });
  await service.init();
  const channel = await service.saveChannel({
    ...service.newChannel("discord", "psyche"),
    ownerIds: [OWNER],
    allowFrom: [OWNER],
    ...options.channel,
  });
  const adapter = new DiscordAdapter({ ...adapterOptions(fake), clock });
  service.attach(adapter);
  await service.start(channel.id);
  return {
    fake,
    adapter,
    service,
    broker,
    clock,
    delivered,
    channel,
    close: async () => {
      await service.stopAll();
      await fake.close();
    },
  };
}

export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "600000000000000001",
    channel_id: OWNER_DM,
    type: 0,
    author: { id: OWNER, username: "owner", global_name: "Owner" },
    content: "hello psyche",
    timestamp: "2026-10-20T10:00:00.000Z",
    edited_timestamp: null,
    mentions: [],
    attachments: [],
    ...overrides,
  };
}
