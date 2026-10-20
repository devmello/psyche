import { createServer, type Server, type Socket } from "node:net";
import type { SandboxScope } from "@psyche/protocol";
import type { CliStream } from "./cli.ts";

/**
 * Dev servers started in a sandbox (feature I12; security §3.10). A sandbox has network
 * `none`, so a server listening on port 5173 inside it is NOT the host's `localhost:5173`:
 * reporting the container port would let the dev preview open whatever host process holds
 * that number. Instead the runner binds its own `127.0.0.1:<ephemeral>` listener and relays each
 * connection into the container over `exec -i` (`PORT_RELAY`), and reports THAT port. The
 * container keeps network `none`: the forward is inbound from host loopback only.
 */
export interface SandboxDevServer {
  sandboxId: string;
  scope: SandboxScope;
  /** Host loopback port the runner forwards from; what the browser previews. */
  port: number;
  /** Port the server listens on inside the container. */
  containerPort: number;
  /** Root pid inside the container: the exec's session leader (the command's process group). */
  pid: number;
  /** The process that owns the listening socket, inside the container. */
  listenerPid: number;
  /** The exec's working directory (a container path). */
  cwd: string;
  /** The exec's argv, for the approval card. */
  argv: string[];
}

export type DevServerEvent =
  | { type: "started"; server: SandboxDevServer }
  | { type: "stopped"; server: SandboxDevServer; reason: DevServerStopReason };

/** `exited`: the listener went away; `sandbox`: the container was stopped, removed or disposed. */
export type DevServerStopReason = "exited" | "sandbox";

export interface DevServerOptions {
  /**
   * Re-probe delays (ms after the exec returned) while the command left processes running but
   * nothing listens yet: servers started in the background bind a moment later.
   */
  probeDelaysMs?: readonly number[];
  /** How often a running forward checks that its listener still exists. */
  pollMs?: number;
  /** Concurrent forwarded connections per server. */
  maxConnections?: number;
}

export const DEFAULT_DEV_SERVER_PROBE_DELAYS_MS: readonly number[] = [
  500, 1_000, 2_000, 4_000, 8_000,
];
export const DEFAULT_DEV_SERVER_POLL_MS = 5_000;
export const DEFAULT_DEV_SERVER_MAX_CONNECTIONS = 32;

export interface ProbeListener {
  port: number;
  /** Address the socket is bound to inside the container. */
  addr: string;
  pid: number;
}

export interface ProbeResult {
  sid: number | null;
  alive: boolean;
  listeners: ProbeListener[];
}

const isPort = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n > 0 && n < 65_536;
const isPid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 1;

/** Probe output is data from inside the sandbox: validate every field, drop the rest. */
export function parseProbe(text: string): ProbeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { sid: null, alive: false, listeners: [] };
  }
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const listeners: ProbeListener[] = [];
  for (const l of Array.isArray(r.listeners) ? r.listeners.slice(0, 64) : []) {
    const o = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
    if (isPort(o.port) && isPid(o.pid) && typeof o.addr === "string") {
      const addr = relayTarget(o.addr);
      if (addr !== null) listeners.push({ port: o.port, addr, pid: o.pid });
    }
  }
  return { sid: isPid(r.sid) ? r.sid : null, alive: r.alive === true, listeners };
}

/**
 * Where the relay connects inside the container. Wildcard binds are reached on loopback; any
 * other non-loopback address is skipped (with network `none` there is none to reach).
 */
export function relayTarget(addr: string): string | null {
  if (addr === "0.0.0.0" || addr.startsWith("127.")) return "127.0.0.1";
  if (addr === "::" || addr === "::1") return "::1";
  if (addr.startsWith("::ffff:127.") || addr === "::ffff:0.0.0.0") return "127.0.0.1";
  return null;
}

/**
 * A host `127.0.0.1:<ephemeral>` listener whose connections are relayed into the container.
 * `open` starts one relay stream per connection; closing the forward ends them all.
 */
export class PortForward {
  readonly #server: Server;
  readonly #open: () => CliStream;
  readonly #max: number;
  readonly #live = new Set<{ socket: Socket; stream: CliStream }>();
  #port = 0;
  #closed = false;

  private constructor(open: () => CliStream, max: number) {
    this.#open = open;
    this.#max = max;
    this.#server = createServer((socket) => this.#connect(socket));
  }

  /** Binds `127.0.0.1` only: never a LAN address. */
  static async listen(open: () => CliStream, maxConnections: number): Promise<PortForward> {
    const f = new PortForward(open, maxConnections);
    await new Promise<void>((resolve, reject) => {
      f.#server.once("error", reject);
      f.#server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        f.#server.off("error", reject);
        resolve();
      });
    });
    const address = f.#server.address();
    f.#port = typeof address === "object" && address !== null ? address.port : 0;
    return f;
  }

  get port(): number {
    return this.#port;
  }

  get connections(): number {
    return this.#live.size;
  }

  #connect(socket: Socket): void {
    if (this.#closed || this.#live.size >= this.#max) {
      socket.destroy();
      return;
    }
    let stream: CliStream;
    try {
      stream = this.#open();
    } catch {
      socket.destroy();
      return;
    }
    const conn = { socket, stream };
    this.#live.add(conn);
    const end = () => {
      if (!this.#live.delete(conn)) return;
      socket.destroy();
      stream.stdin.destroy();
      stream.kill("SIGTERM");
    };
    socket.on("error", end);
    socket.on("close", end);
    stream.stdin.on("error", end);
    stream.stdout.on("error", end);
    stream.stdout.on("end", () => socket.end());
    stream.exited.then(end, end);
    socket.pipe(stream.stdin);
    stream.stdout.pipe(socket);
    // Relay errors (connection refused inside the container) are not shown to the browser.
    stream.stderr.resume();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const conn of [...this.#live]) {
      this.#live.delete(conn);
      conn.socket.destroy();
      conn.stream.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
