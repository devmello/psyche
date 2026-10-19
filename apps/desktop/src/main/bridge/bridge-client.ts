import { lstatSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
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
  validateBridgeParams,
} from "@psyche/protocol";
import { backoffDelay } from "@psyche/web/client";
import {
  BRIDGE_EVENT_NAMES,
  type BridgeHostEvents,
  type BridgeTabHost,
  type Unsubscribe,
} from "./bridge-host.ts";

/**
 * Desktop end of the browser bridge (architecture §5, §8; security §6). The Gateway listens on
 * `$PSYCHE_HOME/run/browser-bridge.sock` (0600); the desktop connects, authenticates with
 * `bridge.hello` and the per-launch handshake secret, then serves the Gateway's `bridge.*`
 * requests against the tab host and pushes `bridge.*` events (`seq` per connection from 0,
 * `stateVersion` 0). NDJSON, at most `BRIDGE_MAX_FRAME_BYTES` per frame in both directions.
 *
 * Frame contents are never logged: they can carry credentials typed via `Input.insertText`.
 */

export interface BridgeClientOptions {
  socketPath: string;
  psycheHome: string;
  desktopVersion: string;
  host: BridgeTabHost;
  now?: () => number;
  random?: () => number;
  /** Defaults to `$PSYCHE_HOME/run/handshake.secret`; re-read before every attempt. */
  secretPath?: string;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
  /** Diagnostics without frame contents. */
  log?: (message: string) => void;
}

export interface BridgeClientStatus {
  connected: boolean;
  /** Failed attempts since the last successful hello. */
  attempt: number;
  lastError: string | null;
  connectedAt: number | null;
}

/**
 * The socket must be a socket owned by this uid with no group/other permission bits. Returns
 * null when it is acceptable, else why not (ENOENT included).
 */
export function checkBridgeSocket(path: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? "socket missing"
      : "socket unreadable";
  }
  if (!st.isSocket()) return "not a socket";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "socket owned by another user";
  if ((st.mode & 0o077) !== 0) return "socket is accessible to group or others";
  return null;
}

function readSecret(path: string): string | null {
  try {
    const s = readFileSync(path, "utf8").trim();
    return s.length > 0 && s.length <= 256 ? s : null;
  } catch {
    return null;
  }
}

function errorCode(err: unknown): string {
  if (err instanceof PsycheError) return err.code;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "error";
}

/** Splits NDJSON without rescanning or re-joining earlier chunks on every read. */
class LineReader {
  private parts: string[] = [];
  private pending = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Returns complete lines; throws when a partial line exceeds the cap. */
  push(chunk: string): string[] {
    const out: string[] = [];
    let rest = chunk;
    let nl = rest.indexOf("\n");
    while (nl >= 0) {
      const head = rest.slice(0, nl);
      const line = this.parts.length > 0 ? this.parts.join("") + head : head;
      this.parts = [];
      this.pending = 0;
      if (line.length > 0) out.push(line);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
    if (rest.length > 0) {
      this.parts.push(rest);
      this.pending += rest.length;
      // UTF-16 length ≤ UTF-8 byte length, so this never fires early.
      if (this.pending > this.max) throw new PsycheError("invalid_frame", "frame exceeds the cap");
    }
    return out;
  }
}

function fitsFrame(line: string): boolean {
  if (line.length * 3 <= BRIDGE_MAX_FRAME_BYTES) return true;
  return Buffer.byteLength(line, "utf8") <= BRIDGE_MAX_FRAME_BYTES;
}

export class BridgeClient {
  private readonly opts: BridgeClientOptions;
  private readonly now: () => number;
  private readonly secretPath: string;
  private readonly listeners = new Set<(connected: boolean) => void>();
  private readonly hostSubs: Unsubscribe[] = [];
  private sock: Socket | undefined;
  private isConnected = false;
  private started = false;
  private stopped = false;
  private attempt = 0;
  private lastError: string | null = null;
  private connectedAt: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private helloSeq = 0;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.secretPath = opts.secretPath ?? join(opts.psycheHome, "run", "handshake.secret");
  }

  get connected(): boolean {
    return this.isConnected;
  }

  status(): BridgeClientStatus {
    return {
      connected: this.isConnected,
      attempt: this.attempt,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  }

  onConnectedChange(cb: (connected: boolean) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    const keys = Object.keys(BRIDGE_EVENT_NAMES) as (keyof BridgeHostEvents)[];
    for (const key of keys) {
      this.hostSubs.push(
        this.opts.host.on(key, (payload) => {
          const wire =
            key === "download" ? (payload as BridgeHostEvents["download"]).payload : payload;
          this.sendEvent(BRIDGE_EVENT_NAMES[key], wire);
        }),
      );
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.helloTimer);
    for (const u of this.hostSubs.splice(0)) u();
    const sock = this.sock;
    if (sock === undefined || sock.destroyed) {
      this.setConnected(false);
      return;
    }
    await new Promise<void>((resolve) => {
      sock.once("close", () => resolve());
      sock.destroy();
    });
  }

  private log(message: string): void {
    this.opts.log?.(`[bridge] ${message}`);
  }

  private setConnected(on: boolean): void {
    if (this.isConnected === on) return;
    this.isConnected = on;
    this.connectedAt = on ? this.now() : null;
    for (const l of this.listeners) l(on);
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    this.lastError = reason;
    const delay = backoffDelay(this.attempt++, {
      ...(this.opts.backoffBaseMs === undefined ? {} : { baseMs: this.opts.backoffBaseMs }),
      ...(this.opts.backoffMaxMs === undefined ? {} : { maxMs: this.opts.backoffMaxMs }),
      ...(this.opts.random === undefined ? {} : { random: this.opts.random }),
    });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    if (this.stopped) return;
    const bad = checkBridgeSocket(this.opts.socketPath);
    if (bad !== null) {
      if (bad !== "socket missing") this.log(`refusing socket: ${bad}`);
      this.scheduleRetry(bad);
      return;
    }
    const secret = readSecret(this.secretPath);
    if (secret === null) {
      this.scheduleRetry("handshake secret unavailable");
      return;
    }
    const sock = createConnection({ path: this.opts.socketPath });
    this.sock = sock;
    sock.setEncoding("utf8");
    const reader = new LineReader(BRIDGE_MAX_FRAME_BYTES);
    const helloId = `hello-${++this.helloSeq}`;
    let authed = false;

    sock.on("connect", () => {
      this.write(
        sock,
        reqFrame(helloId, "bridge.hello", {
          protocolVersion: PROTOCOL_VERSION,
          handshakeSecret: secret,
          desktopVersion: this.opts.desktopVersion,
        }),
      );
      clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => {
        this.lastError = "bridge.hello timed out";
        sock.destroy();
      }, this.opts.helloTimeoutMs ?? 10_000);
    });

    sock.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = reader.push(chunk);
      } catch {
        this.log("oversized frame from Gateway; closing");
        sock.destroy();
        return;
      }
      for (const line of lines) {
        if (sock.destroyed) return;
        let frame: Frame;
        try {
          frame = parseFrame(line, { maxBytes: BRIDGE_MAX_FRAME_BYTES });
        } catch (err) {
          const details = err instanceof PsycheError ? err.details : undefined;
          const id =
            typeof details === "object" && details !== null && "id" in details
              ? (details as { id: unknown }).id
              : undefined;
          if (typeof id === "string") this.write(sock, errRes(id, PsycheError.from(err)));
          this.log("invalid frame from Gateway");
          continue;
        }
        if (frame.type === "res") {
          if (frame.id !== helloId || authed) continue;
          clearTimeout(this.helloTimer);
          if (!frame.ok) {
            this.lastError = `bridge.hello rejected: ${frame.error.code}`;
            this.log(this.lastError);
            sock.destroy();
            return;
          }
          authed = true;
          this.attempt = 0;
          this.lastError = null;
          this.seq = 0;
          this.setConnected(true);
          continue;
        }
        if (frame.type === "req") {
          if (!authed) {
            this.write(sock, errRes(frame.id, new PsycheError("unauthorized", "say hello first")));
            continue;
          }
          void this.handle(sock, frame.id, frame.method, frame.params);
        }
        // Gateway → desktop events are not part of the contract; ignore them.
      }
    });

    sock.on("error", (err) => {
      this.lastError = errorCode(err);
    });

    sock.on("close", () => {
      clearTimeout(this.helloTimer);
      if (this.sock === sock) this.sock = undefined;
      this.setConnected(false);
      this.scheduleRetry(this.lastError ?? "closed");
    });
  }

  private write(sock: Socket, frame: Frame): boolean {
    if (sock.destroyed || !sock.writable) return false;
    const line = serializeFrame(frame);
    if (!fitsFrame(line)) return false;
    sock.write(`${line}\n`);
    return true;
  }

  private sendEvent(event: string, payload: unknown): void {
    const sock = this.sock;
    if (!this.isConnected || sock === undefined) return;
    if (this.write(sock, eventFrame(event, payload, this.seq, 0))) this.seq++;
    else this.log(`dropped ${event}: over the frame cap`);
  }

  private async handle(sock: Socket, id: string, method: string, params: unknown): Promise<void> {
    let res: Frame;
    try {
      res = okRes(id, await this.dispatch(method, params));
    } catch (err) {
      res = errRes(id, PsycheError.from(err));
    }
    if (this.write(sock, res)) return;
    this.write(
      sock,
      errRes(id, new PsycheError("internal", `${method} result exceeds the bridge frame cap`)),
    );
  }

  private async dispatch(method: string, raw: unknown): Promise<unknown> {
    const host = this.opts.host;
    switch (method) {
      case "bridge.tabs.list":
        validateBridgeParams(method, raw);
        return { tabs: host.list() };
      case "bridge.tab.open":
        return { tab: await host.open(validateBridgeParams(method, raw)) };
      case "bridge.tab.close":
        await host.close(validateBridgeParams(method, raw).tabId);
        return { ok: true };
      case "bridge.attach":
        return { tab: await host.attach(validateBridgeParams(method, raw).tabId) };
      case "bridge.detach":
        await host.detach(validateBridgeParams(method, raw).tabId);
        return { ok: true };
      case "bridge.tab.status": {
        const p = validateBridgeParams(method, raw);
        await host.setStatus(p.tabId, p.text ?? null, p.highlight);
        return { ok: true };
      }
      case "bridge.cdp.send": {
        const p = validateBridgeParams(method, raw);
        return { result: await host.cdpSend(p.tabId, p.method, p.params, p.sessionId) };
      }
      case "bridge.hello":
        throw new PsycheError("unknown_method", "bridge.hello is sent by the desktop");
      default:
        // Throws unknown_method for anything outside the registry.
        validateBridgeParams(method, raw);
        throw new PsycheError("unknown_method", `unknown bridge method ${JSON.stringify(method)}`);
    }
  }
}
