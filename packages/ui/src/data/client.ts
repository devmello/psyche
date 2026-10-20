import type {
  ApprovalRequest,
  EventName,
  EventPayload,
  MethodName,
  MethodParams,
  MethodResult,
} from "@psyche/protocol";

/**
 * The only thing the kit needs from a shell: a Gateway connection that sends typed requests and
 * delivers typed events (wire spec v1; data model §11). psyche-desktop and psyche-web adapt their
 * WS clients to it; stories and tests use `MockGateway` from `@psyche/ui/testing`.
 *
 * The client never decides (UI design §1.2): it relays requests and renders what comes back.
 */

export type ConnectionState = "connecting" | "open" | "offline";

/** One server-pushed event with its envelope counters. */
export type GatewayEvent = {
  [E in EventName]: { event: E; payload: EventPayload<E>; seq: number; stateVersion: number };
}[EventName];

export interface RequestOptions {
  /** Required by side-effecting methods; the store adds one automatically. */
  idempotencyKey?: string;
}

export interface GatewayClient {
  request<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
    options?: RequestOptions,
  ): Promise<MethodResult<M>>;
  /** Subscribes to every event this connection receives; returns an unsubscribe function. */
  subscribe(listener: (event: GatewayEvent) => void): () => void;
  connectionState(): ConnectionState;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
  /**
   * Fresh user presence for approving a card that requires authentication (security §3.7): the
   * web client's passkey assertion over the approval's presence challenge. Hosts without one omit
   * it, and the Gateway refuses such an approval from them with `presence_required`.
   */
  presence?(approval: ApprovalRequest, answerToken: string): Promise<PresenceAssertion>;
}

/** `ApprovalAnswer.presence` (a WebAuthn or helper assertion). */
export type PresenceAssertion = NonNullable<MethodParams<"approvals.answer">["presence"]>;

/** Error surfaced by hooks; `code` is the wire error code when the Gateway sent one. */
export class GatewayRequestError extends Error {
  readonly code: string;
  readonly method: string;
  /** The error's structured details from the Gateway (e.g. `{ approvalId }`), when any. */
  readonly details: unknown;
  constructor(method: string, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "GatewayRequestError";
    this.code = code;
    this.method = method;
    this.details = details;
  }
}

/** A fresh idempotency key. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
