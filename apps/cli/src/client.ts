import { randomUUID } from "node:crypto";
import {
  connectSigningPayload,
  type Frame,
  isMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  PROTOCOL_VERSION,
  PsycheError,
  parseFrame,
  reqFrame,
  requiresIdempotencyKey,
  serializeFrame,
  validateParams,
} from "@psyche/protocol";
import { CliError } from "./errors.ts";
import type { Identity } from "./identity.ts";

/** The subset of the WHATWG WebSocket that Node 24's global provides. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ConnectOptions {
  wsUrl: string;
  identity: Identity;
  platform: "macos" | "linux";
  timeoutMs?: number;
  createWebSocket?: WebSocketFactory;
}

export interface CallOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
}

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

/**
 * One-shot Gateway connection for a CLI command (wire spec v1): `connect` → challenge →
 * `connect.verify` with the CLI's own key, then request/response calls. No reconnects; it never
 * logs frames (params can carry user content and, for `vault.add`, a secret).
 */
export class GatewayClient {
  readonly scopes: readonly string[];
  readonly deviceId: string;
  private readonly ws: WebSocketLike;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private closed = false;

  private constructor(ws: WebSocketLike, scopes: string[], deviceId: string, timeoutMs: number) {
    this.ws = ws;
    this.scopes = scopes;
    this.deviceId = deviceId;
    this.timeoutMs = timeoutMs;
    ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    ws.addEventListener("close", () =>
      this.failAll(new CliError("unreachable", "Gateway closed the connection")),
    );
  }

  static async connect(opts: ConnectOptions): Promise<GatewayClient> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const create =
      opts.createWebSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const ws = create(opts.wsUrl);
    const frames: Frame[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let handshakeDone = false;
    ws.addEventListener("message", (ev) => {
      if (handshakeDone) return;
      try {
        frames.push(parseFrame(String(ev.data)));
      } catch (err) {
        failure = PsycheError.from(err);
      }
      wake?.();
    });
    ws.addEventListener("error", () => {
      failure ??= new CliError("unreachable", `Cannot reach the Gateway at ${opts.wsUrl}`);
      wake?.();
    });
    ws.addEventListener("close", (ev) => {
      if (handshakeDone) return;
      failure ??= new CliError(
        ev.code === 1008 ? "pairing" : "unreachable",
        `Gateway closed the connection during the handshake (code ${ev.code ?? "?"})`,
      );
      wake?.();
    });

    let opened = ws.readyState === OPEN;
    ws.addEventListener("open", () => {
      opened = true;
      wake?.();
    });
    const deadline = Date.now() + timeoutMs;
    /** Waits for `ready()` to return a value, failing on a socket error, close or the deadline. */
    const waitFor = async <T>(ready: () => T | undefined): Promise<T> => {
      for (;;) {
        const value = ready();
        if (value !== undefined) return value;
        if (failure) throw failure;
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new CliError("unreachable", `Gateway handshake timed out after ${timeoutMs} ms`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = undefined;
      }
    };
    const expectRes = async (id: string): Promise<Record<string, unknown>> => {
      const frame = await waitFor(() => {
        for (;;) {
          const f = frames.shift();
          if (!f) return undefined;
          if (f.type === "res" && f.id === id) return f;
        }
      });
      if (!frame.ok) {
        throw new PsycheError(frame.error.code, frame.error.message, {
          details: frame.error.details,
        });
      }
      return (frame.payload ?? {}) as Record<string, unknown>;
    };

    try {
      await waitFor(() => (opened ? true : undefined));
      ws.send(
        serializeFrame(
          reqFrame("connect", "connect", {
            protocolVersion: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
            deviceId: opts.identity.deviceId,
            publicKey: opts.identity.publicKey,
            role: "client",
            platform: opts.platform,
            deviceFamily: "cli",
            name: opts.identity.name,
          }),
        ),
      );
      const challenge = await expectRes("connect");
      const { nonce, serverOrigin, protocolVersion } = challenge;
      if (
        challenge.phase !== "challenge" ||
        typeof nonce !== "string" ||
        typeof serverOrigin !== "string" ||
        typeof protocolVersion !== "number"
      ) {
        throw new CliError("failure", "Gateway sent an invalid challenge");
      }
      const signature = opts.identity.sign(
        connectSigningPayload({
          nonce,
          platform: opts.platform,
          deviceFamily: "cli",
          protocolVersion,
          serverOrigin,
        }),
      );
      ws.send(serializeFrame(reqFrame("connect.verify", "connect.verify", { nonce, signature })));
      const result = await expectRes("connect.verify");
      if (result.phase === "pending") {
        const code = String(result.code ?? "");
        throw new CliError(
          "pairing",
          `This CLI is not paired yet (code ${code}). On the Gateway host run \`psyched devices approve ${code}\`, or approve it from an admin device (\`psyche pairing approve ${code}\`), then run the command again.`,
          { code, pairingRequestId: result.pairingRequestId },
        );
      }
      if (result.phase === "denied") {
        throw new CliError(
          "pairing",
          `The Gateway denied this CLI: ${String(result.reason ?? "denied")}`,
          {
            reason: result.reason,
          },
        );
      }
      if (result.phase !== "paired" || !Array.isArray(result.scopes)) {
        throw new CliError("failure", "Gateway sent an invalid connect.verify result");
      }
      handshakeDone = true;
      return new GatewayClient(ws, result.scopes.map(String), opts.identity.deviceId, timeoutMs);
    } catch (err) {
      ws.close();
      throw err;
    }
  }

  /** Typed call for a registered method; params are validated before they are sent. */
  call<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    opts?: CallOptions,
  ): Promise<MethodResult<M>>;
  /** Untyped call for a method the protocol does not define yet (e.g. `skills.*`). */
  call(method: string, params: unknown, opts?: CallOptions): Promise<unknown>;
  call(method: string, params: unknown, opts: CallOptions = {}): Promise<unknown> {
    if (this.closed || this.ws.readyState !== OPEN) {
      return Promise.reject(new CliError("unreachable", "Gateway connection is closed"));
    }
    try {
      if (isMethodName(method)) validateParams(method, params);
    } catch (err) {
      return Promise.reject(err);
    }
    const id = randomUUID();
    const idempotencyKey =
      opts.idempotencyKey ?? (requiresIdempotencyKey(method) ? randomUUID() : undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PsycheError("timeout", `${method} timed out`));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(serializeFrame(reqFrame(id, method, params ?? {}, idempotencyKey)));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close(1000, "done");
    this.failAll(new CliError("unreachable", "Gateway connection is closed"));
  }

  private onMessage(data: unknown): void {
    let frame: Frame;
    try {
      frame = parseFrame(String(data));
    } catch {
      return;
    }
    if (frame.type !== "res") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.payload);
    else
      p.reject(
        new PsycheError(frame.error.code, frame.error.message, {
          details: frame.error.details,
          retryable: frame.error.retryable ?? false,
        }),
      );
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

export interface HttpProbe {
  reachable: boolean;
  healthy: boolean;
  version: { name?: string; version?: string; protocolVersion?: number } | null;
  error?: string;
}

/** `GET /healthz` and `GET /version`: no pairing needed (security §10 "bare ok"). */
export async function probeGateway(
  base: URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<HttpProbe> {
  const get = async (path: string) =>
    fetchImpl(new URL(path, base), { signal: AbortSignal.timeout(timeoutMs) });
  let healthy = false;
  try {
    const res = await get("/healthz");
    const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
    healthy = res.ok && body?.ok === true;
  } catch (err) {
    return {
      reachable: false,
      healthy: false,
      version: null,
      error:
        err instanceof Error
          ? err.cause instanceof Error
            ? err.cause.message
            : err.message
          : String(err),
    };
  }
  let version: HttpProbe["version"] = null;
  try {
    const res = await get("/version");
    if (res.ok) version = (await res.json()) as HttpProbe["version"];
  } catch {
    // Older Gateways have no /version.
  }
  return { reachable: true, healthy, version };
}
