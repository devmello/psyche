import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Channel } from "@psyche/protocol";
import { FakeClock, FakePermissionBroker } from "@psyche/testing";
import { SignalAdapter, type SignalAdapterOptions } from "../../src/adapters/signal/index.ts";
import type { SignalEnvelope } from "../../src/adapters/signal/mapping.ts";
import type { ChannelInboundEvent } from "../../src/ports.ts";
import { ChannelService } from "../../src/service.ts";
import { MemoryChannelStore } from "../../src/store/memory.ts";

export const ACCOUNT = "+15550009999";
export const ACCOUNT_UUID = "0a0a0a0a-1111-4222-8333-444444444444";
export const OWNER = "+15550001111";
export const FRIEND = "+15550002222";
export const STRANGER = "+15550003333";
export const GROUP_ID = "Z3JvdXAtaWQtZm9yLXRlc3RzLTAxMjM0NTY3ODk=";

export interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * A stand-in for `signal-cli daemon --socket`: a `node:net` server on a temp UNIX socket (in a
 * mkdtemp directory, mode 0700) speaking newline-delimited JSON-RPC 2.0. It records every request,
 * answers `send` with a timestamp, and pushes `receive` notifications on demand.
 */
export class FixtureDaemon {
  readonly dir: string;
  readonly path: string;
  readonly requests: RpcRequest[] = [];
  /** Raw lines received, including any the client should never have written. */
  readonly lines: string[] = [];
  readonly handlers = new Map<string, Handler | "hang">();
  #server: Server | undefined;
  #sockets = new Set<Socket>();
  #nextTs = 1_760_000_000_000;
  #waiters: (() => void)[] = [];
  connections = 0;

  private constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, "s.sock");
    this.handlers.set("send", () => ({ timestamp: this.#nextTs++, results: [] }));
    this.handlers.set("sendTyping", () => ({}));
  }

  static async start(): Promise<FixtureDaemon> {
    const dir = mkdtempSync(join(tmpdir(), "psy-sig-"));
    chmodSync(dir, 0o700);
    const d = new FixtureDaemon(dir);
    await d.listen();
    return d;
  }

  async listen(): Promise<void> {
    const server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => resolve());
    });
    chmodSync(this.path, 0o700);
    this.#server = server;
  }

  /** Last timestamp handed out by `send`. */
  get lastSentTimestamp(): number {
    return this.#nextTs - 1;
  }

  sent(): RpcRequest[] {
    return this.requests.filter((r) => r.method === "send");
  }

  sentTexts(): string[] {
    return this.sent().map((r) => String(r.params.message));
  }

  /** Resolves once `n` connections have been accepted in total. */
  async waitForConnections(n: number): Promise<void> {
    while (this.connections < n) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** Pushes one `receive` notification to every connected client. */
  push(envelope: SignalEnvelope, account = ACCOUNT): void {
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "receive",
      params: { envelope, account },
    });
    for (const s of this.#sockets) s.write(`${line}\n`);
  }

  /** Drops every client connection (the daemon restarting), keeping the listener. */
  dropClients(): void {
    for (const s of this.#sockets) s.destroy();
    this.#sockets.clear();
  }

  /** Stops listening (the socket file goes away) and drops clients. */
  async stopListening(): Promise<void> {
    this.dropClients();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async close(): Promise<void> {
    await this.stopListening();
    rmSync(this.dir, { recursive: true, force: true });
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    this.connections++;
    for (const w of this.#waiters.splice(0)) w();
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.#onLine(socket, line);
        nl = buf.indexOf("\n");
      }
    });
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => undefined);
  }

  #onLine(socket: Socket, line: string): void {
    this.lines.push(line);
    const req = JSON.parse(line) as RpcRequest;
    this.requests.push(req);
    const handler = this.handlers.get(req.method);
    if (handler === "hang") return;
    if (handler === undefined) {
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not implemented" } })}\n`,
      );
      return;
    }
    const result = handler(req.params);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n`);
  }
}

let ts = 1_760_100_000_000;

/** A `dataMessage` envelope from `from` (a DM unless `groupId` is given). */
export function textEnvelope(
  from: string,
  text: string,
  extra: {
    groupId?: string;
    name?: string;
    uuid?: string;
    data?: Record<string, unknown>;
  } = {},
): SignalEnvelope {
  const t = ts++;
  return {
    source: from,
    sourceNumber: from,
    sourceUuid: extra.uuid ?? null,
    sourceName: extra.name ?? "Someone",
    sourceDevice: 1,
    timestamp: t,
    dataMessage: {
      timestamp: t,
      message: text,
      ...(extra.groupId === undefined
        ? {}
        : { groupInfo: { groupId: extra.groupId, type: "DELIVER" } }),
      ...extra.data,
    },
  };
}

export function reactionEnvelope(
  from: string,
  targetSentTimestamp: number,
  emoji = "👍",
  extra: { isRemove?: boolean; targetAuthor?: string; groupId?: string } = {},
): SignalEnvelope {
  const t = ts++;
  const author = extra.targetAuthor ?? ACCOUNT;
  return {
    source: from,
    sourceNumber: from,
    sourceUuid: null,
    sourceName: "Someone",
    timestamp: t,
    dataMessage: {
      timestamp: t,
      message: null,
      reaction: {
        emoji,
        targetAuthor: author,
        targetAuthorNumber: author,
        targetAuthorUuid: null,
        targetSentTimestamp,
        isRemove: extra.isRemove === true,
      },
      ...(extra.groupId === undefined
        ? {}
        : { groupInfo: { groupId: extra.groupId, type: "DELIVER" } }),
    },
  };
}

export interface Harness {
  daemon: FixtureDaemon;
  clock: FakeClock;
  adapter: SignalAdapter;
  service: ChannelService;
  broker: FakePermissionBroker;
  delivered: ChannelInboundEvent[];
  channel: Channel;
  /** Reconnect waits the adapter asked for. */
  reconnectSleeps: number[];
  /** Waits until the adapter has handled every event the daemon pushed so far. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

let counter = 0;

/** Lets socket I/O run (a pushed line reaches the adapter, a request reaches the daemon). */
export async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2));
}

export async function harness(
  options: {
    channel?: Partial<Channel>;
    adapter?: Partial<SignalAdapterOptions>;
    daemon?: FixtureDaemon;
    start?: boolean;
  } = {},
): Promise<Harness> {
  const daemon = options.daemon ?? (await FixtureDaemon.start());
  const clock = new FakeClock();
  const broker = new FakePermissionBroker({ clock });
  const delivered: ChannelInboundEvent[] = [];
  const reconnectSleeps: number[] = [];
  const store = new MemoryChannelStore({ clock, newId: () => `sig${++counter}` });
  const service = new ChannelService({
    store,
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
    ...service.newChannel("signal", ACCOUNT),
    ownerIds: [OWNER],
    allowFrom: [OWNER],
    ...options.channel,
  });
  const adapter = new SignalAdapter({
    socketPath: daemon.path,
    account: ACCOUNT,
    clock,
    sleep: async (ms, signal) => {
      reconnectSleeps.push(ms);
      if (signal.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 3));
    },
    ...options.adapter,
  });
  service.attach(adapter);
  if (options.start !== false) {
    await service.start(channel.id);
    await daemon.waitForConnections(1);
  }
  const settle = async () => {
    await ticks();
    await adapter.idle();
    await ticks(2);
  };
  return {
    daemon,
    clock,
    adapter,
    service,
    broker,
    delivered,
    channel,
    reconnectSleeps,
    settle,
    close: async () => {
      await service.stop(channel.id).catch(() => undefined);
      await adapter.stop();
      await daemon.close();
    },
  };
}
