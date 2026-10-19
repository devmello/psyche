import type { PsycheDb } from "@psyche/db";
import type {
  AgentLoop,
  DeviceScope,
  EventName,
  EventPayload,
  MemoryStore,
  PermissionBroker,
} from "@psyche/protocol";
import type { PairedIdentity, PeerInfo } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import type { EventBus, EventFilter } from "./event-bus.ts";
import type { Idempotency } from "./idempotency.ts";
import type { Logger } from "./log.ts";
import type { NodeRegistry } from "./nodes/registry.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { SessionController } from "./session/controller.ts";

/** Limits from security §10, overridable in tests. */
export interface GatewayLimits {
  /** New pairing requests per remote address per hour. */
  pairingsPerHour: number;
  /** Failed challenges per remote address per minute. */
  failedChallengesPerMinute: number;
  /** Outstanding pairing requests across all addresses. */
  maxPendingPairings: number;
  /** A `pending` connection is closed after this long. */
  pairingTtlMs: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  pairingsPerHour: 5,
  failedChallengesPerMinute: 10,
  maxPendingPairings: 20,
  pairingTtlMs: 5 * 60_000,
};

/** What a live connection exposes to the rest of the Gateway. */
export interface LiveConnection {
  readonly id: string;
  readonly peer: PeerInfo;
  readonly identity: PairedIdentity | null;
  readonly pendingDeviceId: string | null;
  close(reason: string): void;
  setEventFilter(filter: EventFilter | null): void;
  /** Gateway → peer request (node protocol); resolves with the `res` payload. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/** Shared services every handler sees. One per Gateway process. */
export interface GatewayContext {
  readonly config: GatewayConfig;
  readonly db: PsycheDb;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly now: () => Date;
  readonly agent: AgentLoop;
  readonly broker: PermissionBroker;
  readonly memory: MemoryStore | null;
  readonly limits: GatewayLimits;
  readonly failedChallenges: RateLimiter;
  readonly handshakeSecret: string;
  readonly idempotency: Idempotency;
  readonly sessions: SessionController;
  readonly nodes: NodeRegistry;
  /**
   * Handlers mounted by the composition root (package APIs such as `approvals.*` or `memory.*`).
   * Gateway-owned handlers win; `startGateway` refuses a name that both define.
   */
  readonly extraHandlers: Readonly<Record<string, HandlerDef>>;
  /**
   * Called after a device's revocation commits, so its standing grants end with it (design-28;
   * the composition root wires `PsychePermissionBroker.revokeGrantsByDevice`).
   */
  readonly onDeviceRevoked: ((deviceId: string) => Promise<unknown>) | null;
  serverOrigin(): string;
  connections(): Iterable<LiveConnection>;
}

/** One dispatched request, as a handler sees it. */
export interface Call {
  readonly ctx: GatewayContext;
  readonly conn: LiveConnection;
  readonly identity: PairedIdentity;
  readonly method: string;
  /**
   * Queues an event to publish after the request's transaction commits (architecture §4.2
   * step 6: committed before it is acknowledged). Outside a transaction it publishes at once.
   */
  emit<E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string): void;
  /** Runs after commit, before the response is sent (start a turn, close a connection, …). */
  afterCommit(fn: () => void): void;
}

export type Handler = (call: Call, params: never) => unknown;

export interface HandlerDef {
  readonly run: Handler;
  /**
   * The handler is synchronous and runs inside one SQLite transaction together with its
   * idempotency record; events and `afterCommit` work run only once it commits.
   */
  readonly transactional?: boolean;
}

export function hasScope(identity: PairedIdentity, scope: DeviceScope): boolean {
  return identity.scopes.includes(scope);
}
