import type { PsycheDb } from "@psyche/db";
import type {
  AgentLoop,
  Block,
  ChatContextRef,
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
import type { GatewayIdentity } from "./identity.ts";
import type { LanStatus } from "./lan/listener.ts";
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
  /** The model a thread without a pin runs on (the router's primary role), when known. */
  defaultModel?(): ModelRef | undefined;
  /** Absent when the provider is not the model router: the pin is then only recorded. */
  setThreadModel?(threadId: string, ref: ModelRef | undefined): Promise<void>;
}

/** Limits from security §10, overridable in tests. */
export interface GatewayLimits {
  /** New pairing requests per remote address per hour. */
  pairingsPerHour: number;
  /** Failed challenges per remote address per minute. */
  failedChallengesPerMinute: number;
  /** New pairing requests per LAN address per hour. */
  lanPairingsPerIpPerHour: number;
  /** New pairing requests from the LAN listener in all, per hour. */
  lanPairingsTotalPerHour: number;
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
  lanPairingsPerIpPerHour: 3,
  lanPairingsTotalPerHour: 10,
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
  /** Bytes queued on the socket and not yet sent (WebSockets only; 0 otherwise). */
  bufferedAmount(): number;
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

/** What a `chat.send.context` adds to the turn (Feed "Ask about this"). */
export interface ResolvedChatContext {
  /** Untrusted text the agent reads ahead of the message; not in the transcript as text. */
  preamble: string;
  /** The compact card the user message carries in the transcript. */
  block: Extract<Block, { type: "context" }>;
  taintSources: TaintSource[];
}

export type ChatContextResolver = (ref: ChatContextRef) => ResolvedChatContext;

/** What the rest of the Gateway may ask of the LAN listener. */
export interface LanControl {
  /** Applies a stored `gateway.lan` value (anything unreadable is off) and reports the result. */
  apply(value: unknown, owner?: boolean): Promise<LanStatus>;
  status(): LanStatus;
  /** The SPKI pin of the certificate being served (cheap; read per LAN challenge). */
  certSpki(): string | null;
  rotateCert(): Promise<LanStatus>;
  /** Re-reads the interfaces and rebinds or pauses if the chosen network changed. */
  refresh(): Promise<void>;
}

export interface GatewayContext {
  readonly config: GatewayConfig;
  readonly db: PsycheDb;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly now: () => Date;
  readonly agent: AgentLoop;
  readonly broker: PermissionBroker;
  readonly memory: MemoryStore | null;
  /** Reports `settings.set` to the audit trail. */
  readonly onSettingChanged:
    | ((change: { key: string; before: unknown; after: unknown; deviceId: string }) => void)
    | null;
  readonly limits: GatewayLimits;
  readonly failedChallenges: RateLimiter;
  /** Pairing requests from the LAN listener: smaller budgets than the global ones. */
  readonly lanPairings: { perIp: RateLimiter; total: RateLimiter };
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
  /**
   * Host terminal sessions (`compose/host-terminal.ts` sets `owns`): whether a device owns a
   * session, so the stream calls of an open terminal skip the per-minute request budget only
   * when they name a session the caller owns. Unset: nothing is exempt.
   */
  readonly terminalSessions: { owns: ((deviceId: string, sessionId: string) => boolean) | null };
  /**
   * Ask about this (Feed): resolves `chat.send.context` to what the turn gets. The proactive part
   * sets it; without one a send naming a context is refused.
   */
  readonly chatContext: { resolve: ChatContextResolver | null };
  serverOrigin(): string;
  /**
   * The origin a challenge to `peer` names and signs. A connection that came in through a proxy
   * (Tailscale Serve) is told the configured `gateway.publicOrigin`, which is the address its
   * client dialed; a direct loopback connection is told the loopback origin. The client refuses
   * a challenge whose origin is not the one it dialed (remote-gateway design §3.3).
   */
  challengeOrigin(peer: PeerInfo): string;
  /** The LAN listener (`lan/listener.ts`): off unless the owner turned `gateway.lan` on. */
  readonly lan: LanControl;
  /** This Gateway's identity key (`identity/gateway.key`); it signs every challenge. */
  readonly identity: GatewayIdentity;
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
