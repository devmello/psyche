// Duplicated from apps/desktop/src/lib/handshake.ts for the bootstrap; S11 merges the two shells' client code.
import { reqFrame, type WireFrame, type WireReq } from "./frames.ts";
import { connectSigningPayload } from "./signing.ts";
import type { StatusAction } from "./status.ts";

/** `ConnectParams` from the wire spec (subset the desktop sends). */
export interface ConnectParams {
  protocolVersion: { min: number; max: number };
  deviceId: string;
  publicKey: string;
  role: "client" | "node";
  platform: string;
  deviceFamily: string;
  name: string;
  capabilities?: unknown[];
  handshakeSecret?: string;
}

export type Signer = (payload: Uint8Array<ArrayBuffer>) => string | Promise<string>;

export interface HandshakeStep {
  send?: WireReq;
  status?: StatusAction;
  /** The handshake reached a terminal phase (paired / pending / denied) or failed. */
  done?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pure connect → challenge → connect.verify state machine (wire spec v1). The transport feeds it
 * parsed frames and sends whatever it returns. Request ids are "connect" and "connect.verify".
 */
export class Handshake {
  private readonly params: ConnectParams;
  private readonly sign: Signer;

  constructor(params: ConnectParams, sign: Signer) {
    this.params = params;
    this.sign = sign;
  }

  start(): WireReq {
    return reqFrame("connect", "connect", this.params);
  }

  async onFrame(frame: WireFrame): Promise<HandshakeStep> {
    if (frame.type !== "res") return {};
    if (!frame.ok) return { status: { type: "error", code: frame.error.code }, done: true };
    const payload = frame.payload;
    if (!isRecord(payload)) return { status: { type: "error", code: "invalid_frame" }, done: true };

    if (frame.id === "connect" && payload.phase === "challenge") {
      const { nonce, serverOrigin, protocolVersion } = payload;
      if (
        typeof nonce !== "string" ||
        typeof serverOrigin !== "string" ||
        typeof protocolVersion !== "number"
      ) {
        return { status: { type: "error", code: "invalid_frame" }, done: true };
      }
      const bytes = connectSigningPayload({
        nonce,
        platform: this.params.platform,
        deviceFamily: this.params.deviceFamily,
        protocolVersion,
        serverOrigin,
      });
      const signature = await this.sign(bytes);
      return {
        status: { type: "challenge", protocolVersion },
        send: reqFrame("connect.verify", "connect.verify", { nonce, signature }),
      };
    }

    if (frame.id === "connect.verify") {
      switch (payload.phase) {
        case "paired":
          return {
            status: {
              type: "paired",
              scopes: Array.isArray(payload.scopes) ? payload.scopes.map(String) : [],
            },
            done: true,
          };
        case "pending":
          return { status: { type: "pending", code: String(payload.code ?? "") }, done: true };
        case "denied":
          return {
            status: { type: "denied", reason: String(payload.reason ?? "denied") },
            done: true,
          };
      }
    }
    return { status: { type: "error", code: "invalid_frame" }, done: true };
  }
}
