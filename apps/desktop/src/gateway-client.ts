import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATEWAY_PORT, PROTOCOL_VERSION } from "@psyche/protocol";
import { backoffDelay } from "./lib/backoff.ts";
import { type DeviceKey, platformFromNode, signWithDeviceKey } from "./lib/device-key.ts";
import { encodeFrame, parseWireFrame } from "./lib/frames.ts";
import { type ConnectParams, Handshake } from "./lib/handshake.ts";
import {
  type GatewayStatus,
  INITIAL_STATUS,
  reduceStatus,
  type StatusAction,
} from "./lib/status.ts";

/**
 * Main-process Gateway client (wire spec v1, docs/plans/s00.md). The renderer never sees the
 * handshake secret, the device key or any token; it only receives `GatewayStatus`.
 *
 * The desktop connects only to its configured Gateway (security §10): loopback by default.
 */

const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

export interface GatewayClientOptions {
  deviceKey: DeviceKey;
  /** Defaults to http://127.0.0.1:7979. */
  httpOrigin?: string;
  /** Defaults to $PSYCHE_HOME (or ~/.psyche). */
  psycheHome?: string;
  onStatus: (status: GatewayStatus) => void;
}

export function defaultPsycheHome(): string {
  return process.env.PSYCHE_HOME ?? join(homedir(), ".psyche");
}

async function readHandshakeSecret(home: string): Promise<string | undefined> {
  try {
    const secret = (await readFile(join(home, "run", "handshake.secret"), "utf8")).trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

export class GatewayClient {
  private status: GatewayStatus = INITIAL_STATUS;
  private readonly httpOrigin: string;
  private readonly wsUrl: string;
  private readonly home: string;
  private ws: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly opts: GatewayClientOptions;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
    this.httpOrigin = opts.httpOrigin ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
    const ws = new URL("/ws", this.httpOrigin);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = ws.toString();
    this.home = opts.psycheHome ?? defaultPsycheHome();
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    void this.checkHealth();
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "shutdown");
    this.ws = undefined;
  }

  private dispatch(action: StatusAction): void {
    this.status = reduceStatus(this.status, action);
    this.opts.onStatus(this.status);
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await fetch(new URL("/healthz", this.httpOrigin), {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      const body: unknown = res.ok ? await res.json() : undefined;
      this.dispatch({ type: "health", ok: (body as { ok?: unknown } | undefined)?.ok === true });
    } catch {
      this.dispatch({ type: "health", ok: false });
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const key = this.opts.deviceKey;
    const handshakeSecret = await readHandshakeSecret(this.home);
    const params: ConnectParams = {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      role: "client",
      platform: platformFromNode(process.platform),
      deviceFamily: "desktop",
      name: `Psyche Desktop (${hostname()})`.slice(0, 64),
      ...(handshakeSecret ? { handshakeSecret } : {}),
    };
    const handshake = new Handshake(params, (payload) => signWithDeviceKey(key, payload));

    this.dispatch({ type: "connecting" });
    // Node's WebSocket sends no Origin header, which the Gateway requires for loopback auto-pairing.
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    let settled = false;

    ws.addEventListener("open", () => ws.send(encodeFrame(handshake.start())));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return ws.close(1003, "text frames only");
      let frame: ReturnType<typeof parseWireFrame>;
      try {
        frame = parseWireFrame(ev.data);
      } catch {
        return ws.close(1002, "invalid frame");
      }
      if (settled) return; // events after pairing: S11 wires the event bus.
      void handshake.onFrame(frame).then((step) => {
        if (step.status) this.dispatch(step.status);
        if (step.send) {
          ws.send(encodeFrame(step.send));
          this.dispatch({ type: "verifying" });
        }
        if (step.done) settled = true;
        if (step.status?.type === "error") ws.close(1000, "handshake failed");
      });
    });
    ws.addEventListener("error", () => {
      // "close" follows; nothing secret is logged.
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.dispatch({ type: "closed" });
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.status.phase === "denied") return;
    clearTimeout(this.reconnectTimer);
    const delay = backoffDelay(Math.max(0, this.status.attempt - 1));
    this.reconnectTimer = setTimeout(() => {
      void this.checkHealth();
      void this.connect();
    }, delay);
  }
}
