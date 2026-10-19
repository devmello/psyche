import { PROTOCOL_VERSION } from "@psyche/protocol";
import { backoffDelay } from "./lib/backoff.ts";
import { createEphemeralDeviceKey, type WebDeviceKey } from "./lib/device-key.ts";
import { encodeFrame, parseWireFrame } from "./lib/frames.ts";
import { type ConnectParams, Handshake } from "./lib/handshake.ts";
import {
  type GatewayStatus,
  INITIAL_STATUS,
  reduceStatus,
  type StatusAction,
} from "./lib/status.ts";
import { gatewayWsUrl, healthzUrl } from "./lib/ws-url.ts";

/**
 * Browser Gateway client (wire spec v1). Connects only to `location.origin`; never sends a
 * handshake secret (browser connections are never auto-approved, so the expected result is
 * "pending pairing" until the owner approves the device).
 */
export class WebGatewayClient {
  private status: GatewayStatus = INITIAL_STATUS;
  private key: WebDeviceKey | undefined;
  private ws: WebSocket | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly onStatus: (s: GatewayStatus) => void;
  private readonly loc: Pick<Location, "origin">;

  constructor(
    onStatus: (s: GatewayStatus) => void,
    loc: Pick<Location, "origin"> = window.location,
  ) {
    this.onStatus = onStatus;
    this.loc = loc;
  }

  start(): void {
    this.stopped = false;
    void this.checkHealth();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, "shutdown");
    this.ws = undefined;
  }

  private dispatch(action: StatusAction): void {
    this.status = reduceStatus(this.status, action);
    this.onStatus(this.status);
  }

  private async checkHealth(): Promise<void> {
    try {
      const res = await fetch(healthzUrl(this.loc), { cache: "no-store", credentials: "omit" });
      const body: unknown = res.ok ? await res.json() : undefined;
      this.dispatch({ type: "health", ok: (body as { ok?: unknown } | undefined)?.ok === true });
    } catch {
      this.dispatch({ type: "health", ok: false });
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.key ??= await createEphemeralDeviceKey();
    const key = this.key;
    const params: ConnectParams = {
      protocolVersion: { min: 1, max: PROTOCOL_VERSION },
      deviceId: key.deviceId,
      publicKey: key.publicKey,
      role: "client",
      platform: "web",
      deviceFamily: "web",
      name: "Psyche Web",
    };
    const handshake = new Handshake(params, (payload) => key.sign(payload));
    this.dispatch({ type: "connecting" });
    const ws = new WebSocket(gatewayWsUrl(this.loc));
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
      if (settled) return;
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
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.dispatch({ type: "closed" });
      if (this.stopped || this.status.phase === "denied") return;
      this.timer = setTimeout(
        () => {
          void this.checkHealth();
          void this.connect();
        },
        backoffDelay(Math.max(0, this.status.attempt - 1)),
      );
    });
  }
}
