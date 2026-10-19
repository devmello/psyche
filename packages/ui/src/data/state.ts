import type {
  ApprovalRequest,
  Artifact,
  Block,
  FeedPost,
  Goal,
  Idea,
  InputRequest,
  LibraryItem,
  Message,
  Notification,
  Receipt,
  Run,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
} from "@psyche/protocol";
import type { ConnectionState } from "./client.ts";

/** A text delta stream for an agent message that has not been committed yet. */
export interface StreamingMessage {
  threadId: string;
  messageId: string;
  runId: string | null;
  text: string;
}

/** A message the user wrote while the agent was mid-turn, held client-side (UI design §3.2). */
export interface QueuedFollowUp {
  id: string;
  threadId: string;
  content: string;
  mode: "followUp" | "steer" | "interrupt";
  replyToMessageId: string | null;
}

/** Result of a generic query (methods without a dedicated collection). */
export interface QueryEntry {
  data: unknown;
  error: string | null;
  loading: boolean;
  /** Client-observed stateVersion when the result was requested. */
  version: number;
}

export type Dict<T> = Readonly<Record<string, T>>;

/** Normalized client state. Every collection is keyed by id. */
export interface UiState {
  connection: ConnectionState;
  /** Highest stateVersion seen on an event or a versioned result. */
  stateVersion: number;
  lastSeq: number | null;
  /** True between a detected event gap (or a reconnect) and the end of the refresh. */
  refreshing: boolean;

  threads: Dict<ThreadListEntry>;
  threadsLoaded: boolean;
  /** Messages per thread, ordered by `seq`. */
  messages: Dict<readonly Message[]>;
  historyCursor: Dict<string | null>;
  streaming: Dict<StreamingMessage>;
  queue: readonly QueuedFollowUp[];
  runs: Dict<Run>;
  toolCalls: Dict<ToolCall>;
  tasks: Dict<Task>;
  taskActions: Dict<readonly TaskAction[]>;
  approvals: Dict<ApprovalRequest>;
  /** This surface's single-use answer tokens, by approval id. Never rendered. */
  answerTokens: Dict<string>;
  /** Approvals shown before a reconnect; stale until the Gateway re-issues them (UI design §3.0). */
  staleApprovals: Dict<true>;
  inputRequests: Dict<InputRequest>;
  receipts: Dict<Receipt>;
  artifacts: Dict<Artifact>;
  library: Dict<LibraryItem>;
  notifications: Dict<Notification>;
  feed: Dict<FeedPost>;
  nextBriefAt: string | null;
  ideas: Dict<Idea>;
  goals: Dict<Goal>;
  settings: Dict<unknown>;
  memoryEtags: Dict<string | null>;
  queries: Dict<QueryEntry>;
  /** stateVersion of the last event that touched an entity (`<collection>:<id>`). */
  touched: Dict<number>;
}

export const INITIAL_STATE: UiState = {
  connection: "connecting",
  stateVersion: 0,
  lastSeq: null,
  refreshing: false,
  threads: {},
  threadsLoaded: false,
  messages: {},
  historyCursor: {},
  streaming: {},
  queue: [],
  runs: {},
  toolCalls: {},
  tasks: {},
  taskActions: {},
  approvals: {},
  answerTokens: {},
  staleApprovals: {},
  inputRequests: {},
  receipts: {},
  artifacts: {},
  library: {},
  notifications: {},
  feed: {},
  nextBriefAt: null,
  ideas: {},
  goals: {},
  settings: {},
  memoryEtags: {},
  queries: {},
  touched: {},
};

/** Collections whose entities are keyed by `id` and can be bulk-loaded from a list result. */
export type EntityCollection =
  | "runs"
  | "toolCalls"
  | "tasks"
  | "approvals"
  | "inputRequests"
  | "receipts"
  | "artifacts"
  | "library"
  | "notifications"
  | "feed"
  | "ideas"
  | "goals";

type EntityOf<C extends EntityCollection> = UiState[C] extends Dict<infer T> ? T : never;

export function put<C extends EntityCollection>(
  state: UiState,
  collection: C,
  entity: EntityOf<C> & { id: string },
): UiState {
  return { ...state, [collection]: { ...state[collection], [entity.id]: entity } };
}

/**
 * Applies entities from a list result requested at `version`. An entity an event touched after
 * that version is newer than the list, so it is kept (stateVersion reconciliation).
 */
export function putMany<C extends EntityCollection>(
  state: UiState,
  collection: C,
  entities: readonly (EntityOf<C> & { id: string })[],
  version: number,
): UiState {
  const next: Record<string, unknown> = { ...state[collection] };
  for (const e of entities) {
    if ((state.touched[`${collection}:${e.id}`] ?? -1) > version) continue;
    next[e.id] = e;
  }
  return { ...state, [collection]: next };
}

export function touch(state: UiState, key: string, version: number): UiState {
  return { ...state, touched: { ...state.touched, [key]: version } };
}

/** Inserts or replaces a message, keeping the thread ordered by seq. */
export function upsertMessage(state: UiState, message: Message): UiState {
  const list = state.messages[message.threadId] ?? [];
  const without = list.filter((m) => m.id !== message.id);
  const next = [...without, message].sort((a, b) => a.seq - b.seq);
  const { [message.id]: _done, ...streaming } = state.streaming;
  return { ...state, messages: { ...state.messages, [message.threadId]: next }, streaming };
}

/** Appends a block to a message, creating a placeholder agent message when it is not loaded. */
export function appendBlock(
  state: UiState,
  threadId: string,
  messageId: string,
  block: Block,
  now: string,
): UiState {
  const list = state.messages[threadId] ?? [];
  const existing = list.find((m) => m.id === messageId);
  if (existing !== undefined) {
    return upsertMessage(state, { ...existing, blocks: [...existing.blocks, block] });
  }
  const seq = list.reduce((max, m) => Math.max(max, m.seq), -1) + 1;
  const streaming = state.streaming[messageId];
  const placeholder: Message = {
    id: messageId,
    threadId,
    seq,
    role: "agent",
    blocks: [block],
    providerNative: null,
    provenance: "agent",
    replyToMessageId: null,
    channelRef: null,
    runId: streaming?.runId ?? null,
    createdAt: now,
  };
  // Keep any streamed text visible: the placeholder is not the committed message yet.
  const next = upsertMessage(state, placeholder);
  return streaming === undefined
    ? next
    : { ...next, streaming: { ...next.streaming, [messageId]: streaming } };
}
