import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import {
  type BridgeMethodName,
  type BridgeMethodParams,
  type BridgeMethodResult,
  PROTOCOL_VERSION,
  PsycheError,
  type Unsubscribe,
  validateBridgeEventPayload,
  validateBridgeParams,
} from "@psyche/protocol";
import type { CdpTarget } from "../cdp/page.ts";
import { checkCdpCommand } from "./allowlist.ts";
import { FrameConnection } from "./framing.ts";

/**
 * Gateway side of the desktop browser bridge (architecture §5, §8; `packages/protocol`
 * `bridge.ts`). The Gateway listens on `$PSYCHE_HOME/run/browser-bridge.sock` (0600); the
 * desktop connects and must send `bridge.hello` with the per-launch handshake secret first.
 * After that the Gateway calls `bridge.*` methods and receives `bridge.*` events.
 */

export type BridgeEvent =
  | { event: "bridge.cdp.event"; payload: { tabId: string; method: string; params: unknown } }
  | { event: string; payload: Record<string, unknown> };

export class BridgeClient {
  readonly #conn: FrameConnection;
  #listeners = new Set<(event: string, payload: Record<string, unknown>) => void>();
  #cdpListeners = new Map<string, Set<(method: string, params: unknown) => void>>();
  #closeListeners = new Set<(reason: string) => void>();

  constructor(conn: FrameConnection) {
    this.#conn = conn;
    conn.setHandlers({
      onEvent: (event, payload) => this.#onEvent(event, payload),
      onClose: (reason) => {
        for (const l of this.#closeListeners) l(reason);
      },
      onRequest: async (method) => {
        throw new PsycheError("unknown_method", `unexpected request ${method} from desktop`);
      },
    });
  }

  get connected(): boolean {
    return !this.#conn.closed;
  }

  #onEvent(event: string, payload: unknown): void {
    let p: Record<string, unknown>;
    try {
      p = validateBridgeEventPayload(event, payload) as Record<string, unknown>;
    } catch {
      return; // unknown or malformed events are dropped, never half-applied
    }
    if (event === "bridge.cdp.event") {
      const tabId = String(p.tabId);
      for (const l of this.#cdpListeners.get(tabId) ?? []) l(String(p.method), p.params);
      return;
    }
    for (const l of this.#listeners) l(event, p);
  }

  async call<M extends BridgeMethodName>(
    method: M,
    params: BridgeMethodParams<M>,
    options: { timeoutMs?: number } = {},
  ): Promise<BridgeMethodResult<M>> {
    validateBridgeParams(method, params);
    return (await this.#conn.request(method, params, options)) as BridgeMethodResult<M>;
  }

  /** Events other than `bridge.cdp.event` (tab lifecycle, control, downloads). */
  onEvent(listener: (event: string, payload: Record<string, unknown>) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): Unsubscribe {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  /** A `CdpTarget` for one attached tab. Commands off the allowlist fail before sending. */
  target(tabId: string): CdpTarget {
    return {
      send: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        const check = checkCdpCommand(method, params);
        if (!check.ok) throw new PsycheError("forbidden", check.reason);
        const body: BridgeMethodParams<"bridge.cdp.send"> = { tabId, method };
        if (params !== undefined) body.params = params;
        try {
          const r = await this.call("bridge.cdp.send", body);
          return r.result as T;
        } catch (err) {
          // The BrowserDriver contract reports Take control as `conflict`; the desktop uses
          // the bridge code `user_in_control` (spike 01, amendment 3).
          if (err instanceof PsycheError && err.code === "user_in_control") {
            throw new PsycheError("conflict", err.message, {
              details: { reason: "user_in_control" },
              retryable: true,
            });
          }
          throw err;
        }
      },
      on: (listener) => {
        let set = this.#cdpListeners.get(tabId);
        if (set === undefined) {
          set = new Set();
          this.#cdpListeners.set(tabId, set);
        }
        set.add(listener);
        return () => set.delete(listener);
      },
    };
  }

  close(): void {
    this.#conn.destroy("closed by gateway");
  }
}

function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface BridgeServerOptions {
  socketPath: string;
  /** Per-launch handshake secret (`run/handshake.secret`); compared in constant time. */
  handshakeSecret: string;
  gatewayVersion: string;
  /** A newly authenticated desktop connection (replaces any previous one). */
  onClient: (client: BridgeClient) => void;
  helloTimeoutMs?: number;
}

/**
 * Authenticate one desktop stream: the first frame must be `req bridge.hello` with the secret.
 * Exported so tests (and an in-process desktop) can run it over any duplex.
 */
export function acceptBridgeStream(
  stream: Duplex,
  options: Omit<BridgeServerOptions, "socketPath" | "onClient">,
): Promise<BridgeClient> {
  return new Promise((resolve, reject) => {
    let done = false;
    const conn = new FrameConnection(stream, {});
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy("hello timeout");
      reject(new PsycheError("unauthorized", "no bridge.hello within the timeout"));
    }, options.helloTimeoutMs ?? 5000);
    conn.setHandlers({
      onRequest: async (method, params) => {
        if (done || method !== "bridge.hello") {
          throw new PsycheError("unauthorized", "the first frame must be bridge.hello");
        }
        const p = validateBridgeParams("bridge.hello", params);
        if (!secretEquals(p.handshakeSecret, options.handshakeSecret)) {
          done = true;
          clearTimeout(timer);
          setImmediate(() => conn.destroy("bad handshake secret"));
          reject(new PsycheError("unauthorized", "bad handshake secret"));
          throw new PsycheError("unauthorized", "bad handshake secret");
        }
        if (p.protocolVersion !== PROTOCOL_VERSION) {
          done = true;
          clearTimeout(timer);
          setImmediate(() => conn.destroy("protocol mismatch"));
          reject(new PsycheError("protocol_version_mismatch", "bridge protocol mismatch"));
          throw new PsycheError(
            "protocol_version_mismatch",
            `gateway speaks bridge protocol ${PROTOCOL_VERSION}`,
          );
        }
        done = true;
        clearTimeout(timer);
        setImmediate(() => resolve(new BridgeClient(conn)));
        return { protocolVersion: PROTOCOL_VERSION, gatewayVersion: options.gatewayVersion };
      },
      onClose: (reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new PsycheError("unavailable", `bridge closed before hello: ${reason}`));
      },
    });
  });
}

/** Unix-socket listener, mode 0600 in a 0700 directory. One desktop client at a time. */
export class BridgeServer {
  #o: BridgeServerOptions;
  #server: Server | undefined;
  #current: BridgeClient | undefined;

  constructor(options: BridgeServerOptions) {
    if (Buffer.byteLength(options.socketPath) > 103) {
      throw new PsycheError(
        "invalid_params",
        "socket path exceeds the 104-byte macOS limit; set a shorter PSYCHE_HOME or socket path",
      );
    }
    this.#o = options;
  }

  get client(): BridgeClient | undefined {
    return this.#current?.connected === true ? this.#current : undefined;
  }

  async listen(): Promise<void> {
    await mkdir(dirname(this.#o.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.#o.socketPath, { force: true });
    const server = createServer((socket: Socket) => {
      acceptBridgeStream(socket, this.#o).then(
        (client) => {
          this.#current?.close();
          this.#current = client;
          this.#o.onClient(client);
        },
        () => socket.destroy(),
      );
    });
    this.#server = server;
    const oldMask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#o.socketPath, () => resolve());
      });
    } finally {
      process.umask(oldMask);
    }
    await chmod(this.#o.socketPath, 0o600);
  }

  async close(): Promise<void> {
    this.#current?.close();
    await new Promise<void>((resolve) => {
      if (this.#server === undefined) resolve();
      else this.#server.close(() => resolve());
    });
    await rm(this.#o.socketPath, { force: true });
  }
}
