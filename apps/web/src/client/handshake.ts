import { type Frame, type ReqFrame, reqFrame } from "@psyche/protocol";
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

/** What a challenge says about the Gateway that sent it. */
export interface GatewayChallengeView {
  nonce: string;
  serverOrigin: string;
  gatewayKey?: string;
  gatewaySignature?: string;
}

export type GatewayVerdict =
  | {
      ok: true /** `sha256:<hex>` of the verified identity key, when there is one. */;
      fingerprint?: string;
    }
  | { ok: false; code: string };

/**
 * Decides whether this client may sign for the Gateway behind a challenge. Runs before anything
 * is signed or sent; `devicePublicKey` is the key this connection announced.
 */
export type GatewayVerifier = (
  challenge: GatewayChallengeView,
  devicePublicKey: string,
) => GatewayVerdict | Promise<GatewayVerdict>;

export interface HandshakeStep {
  send?: ReqFrame;
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
  private readonly verifyGateway: GatewayVerifier | undefined;

  constructor(params: ConnectParams, sign: Signer, verifyGateway?: GatewayVerifier) {
    this.params = params;
    this.sign = sign;
    this.verifyGateway = verifyGateway;
  }

  start(): ReqFrame {
    return reqFrame("connect", "connect", this.params);
  }

  async onFrame(frame: Frame): Promise<HandshakeStep> {
    if (frame.type !== "res") return {};
    if (!frame.ok) {
      const server = (frame.error.details as { server?: unknown } | undefined)?.server;
      return {
        status: {
          type: "error",
          code: frame.error.code,
          ...(typeof server === "number" ? { serverProtocolVersion: server } : {}),
        },
        done: true,
      };
    }
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
      let fingerprint: string | undefined;
      if (this.verifyGateway) {
        const { gatewayKey, gatewaySignature } = payload;
        const verdict = await this.verifyGateway(
          {
            nonce,
            serverOrigin,
            ...(typeof gatewayKey === "string" ? { gatewayKey } : {}),
            ...(typeof gatewaySignature === "string" ? { gatewaySignature } : {}),
          },
          this.params.publicKey,
        );
        // Nothing is signed for a Gateway that failed the check.
        if (!verdict.ok) return { status: { type: "error", code: verdict.code }, done: true };
        fingerprint = verdict.fingerprint;
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
        status: {
          type: "challenge",
          protocolVersion,
          ...(fingerprint ? { gatewayFingerprint: fingerprint } : {}),
        },
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
