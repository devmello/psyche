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
      ok: true;
      /** `sha256:<hex>` of the verified identity key, when there is one. */
      fingerprint?: string;
      /**
       * The verified Gateway key itself. When set, the device signs the v2 connect payload that
       * includes it and sends it, so the Gateway can refuse a connect that was made for another
       * Gateway's key. A client of a remote Gateway always has one.
       */
      gatewayKey?: string;
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
  /**
   * Where this socket is. A result is accepted only after this handshake sent `connect.verify`
   * for a challenge it received and (when a verifier is set) that the verifier passed. A server
   * that answers `connect` with a ready-made `connect.verify` result, sends one early, or
   * repeats one skips nothing: it is refused, and the connection stops.
   */
  private stage: "new" | "started" | "verifying" | "sent" | "done" = "new";

  constructor(params: ConnectParams, sign: Signer, verifyGateway?: GatewayVerifier) {
    this.params = params;
    this.sign = sign;
    this.verifyGateway = verifyGateway;
  }

  start(): ReqFrame {
    this.stage = "started";
    return reqFrame("connect", "connect", this.params);
  }

  async onFrame(frame: Frame): Promise<HandshakeStep> {
    if (frame.type !== "res") return {};
    if (!frame.ok) {
      this.stage = "done";
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
    const refuse = (): HandshakeStep => {
      this.stage = "done";
      return { status: { type: "error", code: "invalid_frame" }, done: true };
    };
    if (!isRecord(payload)) return refuse();

    if (frame.id === "connect" && payload.phase === "challenge") {
      // One challenge, answering the one `connect` this handshake sent.
      if (this.stage !== "started") return refuse();
      this.stage = "verifying";
      const { nonce, serverOrigin, protocolVersion } = payload;
      if (
        typeof nonce !== "string" ||
        typeof serverOrigin !== "string" ||
        typeof protocolVersion !== "number"
      ) {
        return { status: { type: "error", code: "invalid_frame" }, done: true };
      }
      let fingerprint: string | undefined;
      let verifiedKey: string | undefined;
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
        if (!verdict.ok) {
          this.stage = "done";
          return { status: { type: "error", code: verdict.code }, done: true };
        }
        fingerprint = verdict.fingerprint;
        verifiedKey = verdict.gatewayKey;
      }
      const bytes = connectSigningPayload({
        nonce,
        platform: this.params.platform,
        deviceFamily: this.params.deviceFamily,
        protocolVersion,
        serverOrigin,
        ...(verifiedKey === undefined ? {} : { gatewayKey: verifiedKey }),
      });
      const signature = await this.sign(bytes);
      this.stage = "sent";
      return {
        status: {
          type: "challenge",
          protocolVersion,
          ...(fingerprint ? { gatewayFingerprint: fingerprint } : {}),
        },
        send: reqFrame("connect.verify", "connect.verify", {
          nonce,
          signature,
          ...(verifiedKey === undefined ? {} : { gatewayKey: verifiedKey }),
        }),
      };
    }

    if (frame.id === "connect.verify") {
      if (this.stage !== "sent") return refuse();
      this.stage = "done";
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
    return refuse();
  }
}
