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
  /** Consecutive failed connection attempts. */
  attempt: number;
}

export const INITIAL_STATUS: GatewayStatus = { health: "unknown", phase: "idle", attempt: 0 };

export type StatusAction =
  | { type: "health"; ok: boolean }
  | { type: "connecting" }
  | { type: "challenge"; protocolVersion: number }
  | { type: "verifying" }
  | { type: "paired"; scopes: string[] }
  | { type: "pending"; code: string }
  | { type: "denied"; reason: string }
  | { type: "error"; code: string }
  | { type: "closed" };

export function reduceStatus(state: GatewayStatus, action: StatusAction): GatewayStatus {
  switch (action.type) {
    case "health":
      return { ...state, health: action.ok ? "ok" : "unreachable" };
    case "connecting":
      return { ...state, phase: "connecting" };
    case "challenge":
      return { ...state, phase: "challenge", protocolVersion: action.protocolVersion };
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
      return { ...state, phase: "error", lastError: action.code };
    case "closed": {
      // Terminal phases survive the socket closing; everything else counts as a failed attempt.
      if (state.phase === "denied") return state;
      const { scopes: _s, ...rest } = state;
      return { ...rest, phase: "disconnected", attempt: state.attempt + 1 };
    }
  }
}
