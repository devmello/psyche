import {
  type ErrorPayload,
  type EventFrame,
  type Frame,
  isEventName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PsycheError,
  parseFrame,
  reqFrame,
  requiresIdempotencyKey,
  serializeFrame,
  validateEventPayload,
} from "@psyche/protocol";
import { backoffDelay } from "./backoff.ts";
import { type ConnectParams, Handshake, type Signer } from "./handshake.ts";
import { type GatewayStatus, INITIAL_STATUS, reduceStatus, type StatusAction } from "./status.ts";

/**
 * Transport-agnostic Gateway connection (wire spec v1) shared by the desktop main process and
 * the web client: `connect` → challenge → `connect.verify`, then RPC and server events, with
 * exponential reconnect. Both hosts pass the platform's global `WebSocket`.
 *
 * It never logs frames: params and payloads can carry user content.
 */

/** The subset of the WHATWG WebSocket both Node 24 and browsers provide. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    cb: (ev: { data?: unknown }) => void,
  ): void;
}

/** A server event as the shell sees it. Payloads of known events are validated. */
export interface GatewayEvent {
  event: string;
  payload: unknown;
  seq: number;
  stateVersion: number;
}

export interface CallOptions {
  timeoutMs?: number;
  /** Overrides the generated key for side-effecting methods (retries reuse it). */
  idempotencyKey?: string;
}

export interface GatewayConnectionOptions {
  wsUrl: string;
  /** `GET /healthz`; omitted → health follows the socket. */
  healthUrl?: string;
  /** Built per attempt (the desktop re-reads the per-launch handshake secret). */
  connectParams: () => ConnectParams | Promise<ConnectParams>;
  sign: Signer;
  onStatus: (status: GatewayStatus) => void;
  onEvent?: (event: GatewayEvent) => void;
  /** Called after a reconnect or a `seq` gap: the shell refetches its collections. */
  onResync?: () => void;
  createWebSocket?: (url: string) => WebSocketLike;
  fetch?: typeof fetch;
  healthIntervalMs?: number;
  requestTimeoutMs?: number;
  random?: () => number;
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: PsycheError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

function toError(payload: ErrorPayload): PsycheError {
  return new PsycheError(payload.code, payload.message, {
    details: payload.details,
    retryable: payload.retryable ?? false,
  });
}

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export class GatewayConnection {
  private status: GatewayStatus = INITIAL_STATUS;
  private ws: WebSocketLike | undefined;
  private paired = false;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private connectSeq = 0;
  private lastSeq: number | undefined;
  private everPaired = false;
  private readonly opts: GatewayConnectionOptions;

  constructor(opts: GatewayConnectionOptions) {
    this.opts = opts;
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  isPaired(): boolean {
    return this.paired;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.opts.healthUrl) {
      void this.checkHealth();
      this.healthTimer = setInterval(
        () => void this.checkHealth(),
        this.opts.healthIntervalMs ?? 10_000,
      );
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.connectSeq++;
    clearInterval(this.healthTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "shutdown");
    this.ws = undefined;
    this.paired = false;
    this.failPending("shutdown");
  }

  /** Calls a Gateway method. Rejects with `unavailable` (retryable) while not paired. */
  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: CallOptions,
  ): Promise<MethodResult<M>>;
  call(method: string, params: unknown, options?: CallOptions): Promise<unknown>;
  call(method: string, params: unknown, options: CallOptions = {}): Promise<unknown> {
    const ws = this.ws;
    if (!this.paired || ws === undefined || ws.readyState !== OPEN) {
      return Promise.reject(
        new PsycheError("unavailable", "Psyche can't reach the Gateway", { retryable: true }),
      );
    }
    const id = `r${this.nextId++}`;
    const key = requiresIdempotencyKey(method) ? (options.idempotencyKey ?? newKey()) : undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new PsycheError("timeout", `${method} timed out`, { retryable: true }));
        },
        options.timeoutMs ?? this.opts.requestTimeoutMs ?? 30_000,
      );
      this.pending.set(id, { resolve, reject, timer });
      ws.send(serializeFrame(reqFrame(id, method, params, key)));
    });
  }

  private dispatch(action: StatusAction): void {
    this.status = reduceStatus(this.status, action);
    this.opts.onStatus(this.status);
  }

  private async checkHealth(): Promise<void> {
    const url = this.opts.healthUrl;
    if (!url) return;
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    try {
      const res = await doFetch(url, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const body: unknown = res.ok ? await res.json() : undefined;
      this.dispatch({ type: "health", ok: (body as { ok?: unknown } | undefined)?.ok === true });
    } catch {
      this.dispatch({ type: "health", ok: false });
    }
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        new PsycheError("unavailable", `connection closed (${reason})`, { retryable: true }),
      );
      this.pending.delete(id);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // A stop()/start() while connectParams() is pending must not leave two sockets.
    const attempt = ++this.connectSeq;
    let params: ConnectParams;
    try {
      params = await this.opts.connectParams();
    } catch {
      if (attempt !== this.connectSeq) return;
      this.dispatch({ type: "closed" }); // counts as a failed attempt, so backoff grows
      this.scheduleReconnect();
      return;
    }
    if (this.stopped || attempt !== this.connectSeq) return;
    const handshake = new Handshake(params, this.opts.sign);
    this.dispatch({ type: "connecting" });
    const create = this.opts.createWebSocket ?? ((url: string) => new WebSocket(url));
    const ws = create(this.opts.wsUrl);
    this.ws = ws;
    this.lastSeq = undefined;
    let settled = false;

    ws.addEventListener("open", () => ws.send(serializeFrame(handshake.start())));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return ws.close(1003, "text frames only");
      let frame: Frame;
      try {
        frame = parseFrame(ev.data);
      } catch {
        return ws.close(1002, "invalid frame");
      }
      if (settled) return this.onFrame(frame);
      void handshake
        .onFrame(frame)
        .then((step) => {
          // Callable before anyone hears "paired": a status listener may call at once (the web
          // client reads the persona on pairing; it used to be refused as "can't reach").
          const paired = step.status?.type === "paired";
          if (paired) this.paired = true;
          if (step.status) this.dispatch(step.status);
          if (step.send) {
            ws.send(serializeFrame(step.send));
            this.dispatch({ type: "verifying" });
          }
          if (step.done) settled = true;
          if (paired) {
            if (this.everPaired) this.opts.onResync?.();
            this.everPaired = true;
          }
          if (step.status?.type === "error") ws.close(1000, "handshake failed");
        })
        .catch(() => {
          // signing failed: drop this socket; "close" schedules the retry
          this.dispatch({ type: "error", code: "internal" });
          ws.close(1000, "handshake failed");
        });
    });
    ws.addEventListener("error", () => {
      // "close" follows; nothing is logged.
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.paired = false;
      this.failPending("closed");
      this.dispatch({ type: "closed" });
      this.scheduleReconnect();
    });
  }

  private onFrame(frame: Frame): void {
    if (frame.type === "res") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(toError(frame.error));
      return;
    }
    if (frame.type === "event") this.onEventFrame(frame);
    // The Gateway sends no requests to clients.
  }

  private onEventFrame(frame: EventFrame): void {
    if (this.lastSeq !== undefined && frame.seq !== this.lastSeq + 1) this.opts.onResync?.();
    this.lastSeq = frame.seq;
    if (isEventName(frame.event)) {
      try {
        validateEventPayload(frame.event, frame.payload);
      } catch {
        return; // a malformed payload of a known event is dropped, never half-rendered
      }
    }
    this.opts.onEvent?.({
      event: frame.event,
      payload: frame.payload,
      seq: frame.seq,
      stateVersion: frame.stateVersion,
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.status.phase === "denied") return;
    clearTimeout(this.reconnectTimer);
    const delay = backoffDelay(Math.max(0, this.status.attempt - 1), {
      ...(this.opts.random ? { random: this.opts.random } : {}),
    });
    this.reconnectTimer = setTimeout(() => {
      void this.checkHealth();
      void this.connect();
    }, delay);
  }
}
