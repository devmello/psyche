import type { PsycheDb } from "@psyche/db";
import type {
  AgentLoop,
  ChatScreenRef,
  DeviceScope,
  EventName,
  EventPayload,
  MemoryStore,
  ModelRef,
  PermissionBroker,
  TaintSource,
} from "@psyche/protocol";
import type { PairedIdentity, PeerInfo } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";
import type { EventBus, EventFilter } from "./event-bus.ts";
import type { Idempotency } from "./idempotency.ts";
import type { Logger } from "./log.ts";
import type { NodeRegistry } from "./nodes/registry.ts";
import type { PresenceState } from "./presence-gate.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { RunTraceSink } from "./run-trace/sink.ts";
import type { SessionController } from "./session/controller.ts";

/**
 * Model policy for thread writes (architecture §4.4, security §7.2): which models may run a
 * thread in `auto`, and the model router's per-thread pin. The composition root supplies it.
 */
export interface ThreadModelPolicy {
  allowsAutoMode(ref: ModelRef): boolean;
  /** Absent when the provider is not the model router: the pin is then only recorded. */
  setThreadModel?(threadId: string, ref: ModelRef | undefined): Promise<void>;
}

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
  /** Requests per paired device per minute, across its connections (node protocol excluded). */
  deviceRequestsPerMinute: number;
  /** Side-effecting requests (`chat.send`, `nodes.invoke`, …) per paired device per minute. */
  deviceSideEffectsPerMinute: number;
}

export const DEFAULT_LIMITS: GatewayLimits = {
  pairingsPerHour: 5,
  failedChallengesPerMinute: 10,
  maxPendingPairings: 20,
  pairingTtlMs: 5 * 60_000,
  deviceRequestsPerMinute: 600,
  deviceSideEffectsPerMinute: 120,
};

/** What a live connection exposes to the rest of the Gateway. */
export interface LiveConnection {
  readonly id: string;
  readonly peer: PeerInfo;
  readonly identity: PairedIdentity | null;
  readonly pendingDeviceId: string | null;
  /** Paired and not closed. */
  readonly open: boolean;
  close(reason: string): void;
  setEventFilter(filter: EventFilter | null): void;
  /** Gateway → peer request (node protocol); resolves with the `res` payload. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/** Shared services every handler sees. One per Gateway process. */
/** A `chat.send` `redo` as the Gateway saw it (who sent it, for which message). */
export interface ChatRedo {
  threadId: string;
  messageId: string;
  instruction?: string;
  withoutLessons?: boolean;
  deviceId: string;
}

/** What a `chat.send.screen` adds to the turn (docs/design/screen-ask-2026.md §3.3). */
export interface ResolvedScreen {
  /** Untrusted text context the agent reads ahead of the message; never in the transcript. */
  preamble: string;
  /** The frame, when it goes with the message (pinned): shown in the transcript, seen by the model. */
  attachments: string[];
  images: { mime: string; data: string }[];
  taintSources: TaintSource[];
  /** Called once the send committed: the capture now belongs to the thread. */
  commit(threadId: string): void;
}

export type ChatScreenResolver = (
  ref: ChatScreenRef,
  caller: { deviceId: string; threadId: string },
) => ResolvedScreen;

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
  /** Per-device budgets (security §10), keyed by device id so extra connections do not help. */
  readonly deviceRequests: RateLimiter;
  readonly deviceSideEffects: RateLimiter;
  readonly handshakeSecret: string;
  readonly idempotency: Idempotency;
  readonly sessions: SessionController;
  readonly nodes: NodeRegistry;
  /** The run trace's one sink (run trace §4.2): steps for every run. */
  readonly runTrace: RunTraceSink;
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
  /** The broker emits `receipt.created` itself; handlers must not publish it again. */
  readonly brokerPublishesReceipts: boolean;
  /**
   * Fresh presence for security changes (`presence-gate.ts`): `ready` once a verifier can
   * verify, `unavailable` when one could before but none can now (fail closed), else `off`.
   */
  readonly presenceState: () => PresenceState;
  /** Null without a composition root: a thread can then never be created in `auto`. */
  readonly threadModels: ThreadModelPolicy | null;
  /** Called with a device id when its last paired connection closes (parts register here). */
  readonly deviceDisconnected: Set<(deviceId: string) => void>;
  /**
   * Called after a `chat.send` carrying `redo` commits (teaching loop §5.1, §7): parts register
   * here, e.g. the teaching loop records a redo with an instruction as `regenerated` feedback.
   */
  readonly chatRedo: Set<(redo: ChatRedo) => void>;
  /**
   * Ask about my screen (docs/design/screen-ask-2026.md §4): resolves `chat.send.screen` to what
   * the turn gets. The screen-ask part sets it; without one a send naming a capture is refused.
   */
  readonly chatScreen: { resolve: ChatScreenResolver | null };
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
