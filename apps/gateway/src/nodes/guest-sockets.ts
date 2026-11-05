import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDeviceFamily, listDevices, revokeDevice } from "@psyche/db";
import type { NodeClient } from "@psyche/protocol";
import { Connection } from "../connection.ts";
import type { GatewayContext } from "../context.ts";
import { ensureSocketDir, socketPathFits } from "../socket-path.ts";
import { NdjsonDecoder } from "../transports/ndjson.ts";

/**
 * The per-container node socket of a separate desktop (docs/design/linux-desktop-2026.md §8.3,
 * security §10 guest socket rules). One Unix socket per container, `$PSYCHE_HOME/run/guest-<id>.sock`,
 * mode 0600, bind-mounted read-only into that container as `/run/psyche/node.sock` and nowhere
 * else. It exists only while the desktop runs.
 *
 * What makes it a guest socket and not the node socket:
 * - Its connections are `transport: "container-guest"`: never loopback-trusted, never auto-paired,
 *   never a Host-helper candidate, whatever family the helper inside declares (it is the same
 *   binary as the Host's and says `linux-helper`). The listener sets `PeerInfo.guest`; nothing the
 *   peer sends can.
 * - The only way to pair on it is this container's single-use token (`GuestSockets.open` mints it
 *   at start; the entrypoint hands it to the helper). Spent once, it expires in two minutes, only
 *   ever works on this container's socket, and five wrong tries close the socket.
 * - A paired guest is a node bound to its container. `clientFor(container)` returns it only while
 *   its connection is live on that container's socket. Closing the container (removal, stop)
 *   closes the socket, drops its connections and revokes its device.
 */

/** How long a minted token is good for (a container starts in about two seconds). */
export const GUEST_TOKEN_TTL_MS = 120_000;
/** Wrong tokens tolerated on one socket before it is closed. */
export const GUEST_MAX_BAD_TOKENS = 5;
/** A connection that has not paired by then is dropped. */
export const GUEST_PAIR_TIMEOUT_MS = 30_000;
/** Simultaneous connections on one container's socket. */
export const GUEST_MAX_CONNECTIONS = 4;

const ID_RE = /^[a-z0-9]{1,16}$/;

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

interface Entry {
  server: Server;
  socketPath: string;
  tokenHash: Buffer;
  expiresAtMs: number;
  spent: boolean;
  bad: number;
  deviceId: string | null;
  sockets: Set<Socket>;
  conns: Set<Connection>;
  closed: boolean;
}

export interface GuestSocketsDeps {
  ctx: GatewayContext;
  /** `$PSYCHE_HOME`. */
  home: string;
  now?: () => number;
  pairTimeoutMs?: number;
  tokenTtlMs?: number;
}

export interface OpenedGuestSocket {
  socketPath: string;
  /** Single use. Goes to the container's environment and nowhere else; never logged. */
  token: string;
  expiresAt: number;
}

export class GuestSockets {
  readonly #deps: GuestSocketsDeps;
  readonly #entries = new Map<string, Entry>();
  #seq = 0;

  constructor(deps: GuestSocketsDeps) {
    this.#deps = deps;
  }

  /** Where this container's socket lives: the run folder, or a private folder when that is too deep. */
  socketPathFor(container: string): string {
    if (!ID_RE.test(container)) throw new Error(`bad separate desktop id ${JSON.stringify(container)}`);
    const preferred = join(this.#deps.home, "run", `guest-${container}.sock`);
    if (socketPathFits(preferred)) return preferred;
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const hash = createHash("sha256").update(this.#deps.home).digest("hex").slice(0, 12);
    const fallback = join(tmpdir(), `psyche-${uid}`, `g-${hash}-${container}.sock`);
    if (!socketPathFits(fallback)) {
      throw new Error("$PSYCHE_HOME is too deep for the separate desktop's socket");
    }
    return fallback;
  }

  /**
   * Starts listening for a container and mints its token. Any socket this container had before is
   * closed first, so a new start can never inherit an old token or an old connection.
   */
  async open(container: string): Promise<OpenedGuestSocket> {
    const socketPath = this.socketPathFor(container);
    this.close(container);
    // The previous start's revoked identity is of no use to anyone: forget it (its node row goes too).
    this.#deps.ctx.db.sqlite
      .prepare("DELETE FROM devices WHERE name = ? AND revoked_at IS NOT NULL")
      .run(`Separate desktop (${container})`);
    ensureSocketDir(socketPath, this.#deps.home);
    rmSync(socketPath, { force: true });
    const now = this.#deps.now ?? Date.now;
    const token = randomBytes(32).toString("base64url");
    const entry: Entry = {
      server: createServer(),
      socketPath,
      tokenHash: sha256(token),
      expiresAtMs: now() + (this.#deps.tokenTtlMs ?? GUEST_TOKEN_TTL_MS),
      spent: false,
      bad: 0,
      deviceId: null,
      sockets: new Set(),
      conns: new Set(),
      closed: false,
    };
    entry.server.on("connection", (socket) => this.#accept(container, entry, socket));
    // Mode 0600 from the first instant: nobody else's connect can slip in before a chmod.
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        entry.server.once("error", reject);
        entry.server.listen(socketPath, () => {
          entry.server.off("error", reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousUmask);
    }
    chmodSync(socketPath, 0o600);
    this.#entries.set(container, entry);
    return { socketPath, token, expiresAt: entry.expiresAtMs };
  }

  /** Spends this container's token. False for anything but the first valid presentation. */
  #redeem(container: string, entry: Entry, presented: string | undefined, deviceId: string): boolean {
    const now = (this.#deps.now ?? Date.now)();
    // A closed socket or another container's entry never redeems.
    if (entry.closed || this.#entries.get(container) !== entry) return false;
    const fresh = !entry.spent && now <= entry.expiresAtMs;
    // Always compare, so a wrong token costs the same as a right one.
    const same =
      typeof presented === "string" &&
      presented.length > 0 &&
      presented.length <= 512 &&
      timingSafeEqual(sha256(presented), entry.tokenHash);
    if (!same || !fresh) {
      if (!same && ++entry.bad >= GUEST_MAX_BAD_TOKENS) {
        this.#deps.ctx.log.log("warn", "separate desktop socket closed after bad tokens", { container });
        setTimeout(() => this.close(container), 50).unref();
      }
      return false;
    }
    entry.spent = true;
    entry.deviceId = deviceId;
    return true;
  }

  #accept(container: string, entry: Entry, socket: Socket): void {
    if (entry.closed || entry.sockets.size >= GUEST_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    entry.sockets.add(socket);
    socket.setEncoding("utf8");
    const decoder = new NdjsonDecoder();
    const conn = new Connection(
      `guest-${container}-${++this.#seq}`,
      {
        transport: "container-guest",
        remoteLoopback: false,
        remoteAddress: `container-guest:${container}`,
        origin: null,
        guest: {
          container,
          redeem: (presented, deviceId) => this.#redeem(container, entry, presented, deviceId),
        },
      },
      { send: (f) => socket.writable && socket.write(`${f}\n`), close: () => socket.end() },
      this.#deps.ctx,
    );
    entry.conns.add(conn);
    const timer = setTimeout(() => {
      if (!conn.open) socket.destroy();
    }, this.#deps.pairTimeoutMs ?? GUEST_PAIR_TIMEOUT_MS);
    timer.unref();
    socket.on("data", (chunk: string) => {
      try {
        for (const line of decoder.push(chunk)) void conn.handleRaw(line);
      } catch {
        conn.close("frame too large");
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      conn.close("socket closed");
      entry.conns.delete(conn);
      entry.sockets.delete(socket);
    });
    socket.on("error", () => conn.close("socket error"));
  }

  /** Whether this container has an open socket. */
  isOpen(container: string): boolean {
    return this.#entries.has(container);
  }

  /** The device this container's helper paired as (the token was spent by it), if it has. */
  deviceOf(container: string): string | undefined {
    return this.#entries.get(container)?.deviceId ?? undefined;
  }

  /**
   * The container's helper as a node client, only while it is paired on this container's socket
   * and connected on it. Never a node found by kind, family or capability: a node on any other
   * transport, or bound to another container, is never returned.
   */
  clientFor(container: string): NodeClient | undefined {
    const entry = this.#entries.get(container);
    const deviceId = entry?.deviceId;
    if (entry === undefined || entry.closed || deviceId === null || deviceId === undefined) return undefined;
    const { nodes } = this.#deps.ctx;
    const info = nodes.list().find((n) => n.deviceId === deviceId);
    if (info === undefined || !nodes.isLive(info.id)) return undefined;
    if (nodes.transportOf(info.id) !== "container-guest") return undefined;
    if (![...entry.conns].some((c) => c.open && c.identity?.deviceId === deviceId)) return undefined;
    return nodes.client(info.id);
  }

  /** Whether `nodeId` is a live node that paired on a separate desktop's socket. */
  isGuestNode(nodeId: string): boolean {
    return this.#deps.ctx.nodes.transportOf(nodeId) === "container-guest";
  }

  /**
   * Closes the container's socket for good: no more connections, the live ones dropped, the token
   * void, the paired device revoked and the socket file gone. Idempotent.
   */
  close(container: string): void {
    const entry = this.#entries.get(container);
    if (entry === undefined) return;
    this.#entries.delete(container);
    entry.closed = true;
    entry.tokenHash = Buffer.alloc(32);
    entry.server.close();
    for (const conn of entry.conns) conn.close("separate desktop closed");
    for (const socket of entry.sockets) socket.destroy();
    entry.conns.clear();
    entry.sockets.clear();
    rmSync(entry.socketPath, { force: true });
    if (entry.deviceId !== null) {
      try {
        revokeDevice(this.#deps.ctx.db, entry.deviceId);
      } catch (err) {
        this.#deps.ctx.log.log("warn", "could not revoke a separate desktop's device", {
          container,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  /**
   * Revokes every separate-desktop device still valid from an earlier run of the Gateway (it
   * crashed with a container up). Their containers are removed by the lifecycle's `reconcile`.
   */
  revokeStale(): number {
    const { db } = this.#deps.ctx;
    const live = new Set([...this.#entries.values()].flatMap((e) => (e.deviceId === null ? [] : [e.deviceId])));
    let n = 0;
    for (const d of listDevices(db)) {
      if (getDeviceFamily(db, d.id) !== "separate-desktop" || live.has(d.id)) continue;
      revokeDevice(db, d.id);
      n++;
    }
    return n;
  }

  /** Every container's socket (Gateway stop). */
  closeAll(): void {
    for (const container of [...this.#entries.keys()]) this.close(container);
  }
}
