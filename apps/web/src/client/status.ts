/**
 * Gateway status shown in the renderer. Never carries the handshake secret, tokens or keys:
 * it crosses the preload bridge into the (untrusted) renderer.
 */

export type GatewayHealth = "unknown" | "ok" | "unreachable";

export type PairingPhase =
  | "idle"
  | "connecting"
  | "challenge"
  | "verifying"
  | "paired"
  | "pending"
  | "denied"
  | "disconnected"
  | "error";

export interface GatewayStatus {
  health: GatewayHealth;
  phase: PairingPhase;
  /** Negotiated protocol version once the challenge arrives. */
  protocolVersion?: number;
  /** Short pairing code to compare in the Gateway UI while `phase === "pending"`. */
  pairingCode?: string;
  /** Scopes granted when paired (names only). */
  scopes?: string[];
  /** Error code (from `ErrorCode`) or a short transport reason; never a message body. */
  lastError?: string;
  /**
   * `sha256:<hex>` of the Gateway identity key this connection checked (desktop client only): the
   * first pairing shows it next to the code so the owner can compare it with the Host's.
   */
  gatewayFingerprint?: string;
  /** The Gateway's protocol version, when it refused ours (`protocol_version_mismatch`). */
  serverProtocolVersion?: number;
  /** Consecutive failed connection attempts. */
  attempt: number;
}

/**
 * Errors that stop the reconnect loop: retrying cannot fix them and must not keep offering a
 * signature to a Gateway that failed the identity check (remote-gateway design §4.5, §4.6).
 */
export const FATAL_ERROR_CODES: readonly string[] = [
  "gateway_identity_changed",
  "gateway_identity_missing",
  "gateway_identity_invalid",
  "gateway_origin_mismatch",
  "gateway_pins_unreadable",
  // A LAN Gateway's self-signed certificate (remote-gateway design §3.1, "LAN").
  "gateway_cert_changed",
  "gateway_cert_missing",
  "gateway_cert_invalid",
];

export function isFatalStatus(status: GatewayStatus): boolean {
  return (
    status.phase === "denied" ||
    (status.phase === "error" &&
      status.lastError !== undefined &&
      FATAL_ERROR_CODES.includes(status.lastError))
  );
}

export const INITIAL_STATUS: GatewayStatus = { health: "unknown", phase: "idle", attempt: 0 };

export type StatusAction =
  | { type: "health"; ok: boolean }
  | { type: "connecting" }
  | { type: "challenge"; protocolVersion: number; gatewayFingerprint?: string }
  | { type: "verifying" }
  | { type: "paired"; scopes: string[] }
  | { type: "pending"; code: string }
  | { type: "denied"; reason: string }
  | { type: "error"; code: string; serverProtocolVersion?: number }
  | { type: "closed" };

export function reduceStatus(state: GatewayStatus, action: StatusAction): GatewayStatus {
  switch (action.type) {
    case "health":
      return { ...state, health: action.ok ? "ok" : "unreachable" };
    case "connecting":
      return { ...state, phase: "connecting" };
    case "challenge":
      return {
        ...state,
        phase: "challenge",
        protocolVersion: action.protocolVersion,
        ...(action.gatewayFingerprint ? { gatewayFingerprint: action.gatewayFingerprint } : {}),
      };
    case "verifying":
      return { ...state, phase: "verifying" };
    case "paired": {
      const { pairingCode: _code, lastError: _err, ...rest } = state;
      return { ...rest, health: "ok", phase: "paired", scopes: action.scopes, attempt: 0 };
    }
    case "pending": {
      const { lastError: _err, ...rest } = state;
      return { ...rest, health: "ok", phase: "pending", pairingCode: action.code, attempt: 0 };
    }
    case "denied":
      return { ...state, phase: "denied", lastError: action.reason };
    case "error":
      return {
        ...state,
        phase: "error",
        lastError: action.code,
        ...(action.serverProtocolVersion === undefined
          ? {}
          : { serverProtocolVersion: action.serverProtocolVersion }),
      };
    case "closed": {
      // Terminal phases survive the socket closing; everything else counts as a failed attempt.
      if (isFatalStatus(state)) return state;
      const { scopes: _s, ...rest } = state;
      return { ...rest, phase: "disconnected", attempt: state.attempt + 1 };
    }
  }
}
