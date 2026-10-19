import type {
  Decision,
  GrantScope,
  ModelRef,
  PermissionMode,
  ProvenanceOut,
  SideEffect,
  Target,
  Usage,
} from "../common.ts";
import type { Block, ToolCallStatus } from "../schemas/blocks.ts";
import type { ApprovalKind, ApprovalRequest } from "../schemas/permissions.ts";
import type { InputRequest } from "../schemas/tasks.ts";
import type { RunStatus } from "../schemas/threads.ts";
import type { ToolSpec } from "../schemas/tools.ts";
import type { Unsubscribe } from "./Clock.ts";
import type { Requester } from "./PermissionBroker.ts";

/**
 * Agent loop contract (architecture §4.2–§4.3; owner S02). pi-agent-core semantics: one turn
 * at a time per thread, `steer` interrupts between tool calls, `followUp` queues after the turn
 * settles, every tool call passes the Permission Broker in `before_tool_call`.
 */

/** Hook names in execution order (architecture §4.3, §13). */
export const AGENT_HOOKS = [
  "before_model_resolve",
  "before_prompt_build",
  "before_tool_call",
  "after_tool_call",
  "tool_result_persist",
  "before_compaction",
  "agent_end",
] as const;
export type AgentHookName = (typeof AGENT_HOOKS)[number];

/** What a `before_tool_call` hook may return. Hooks can block or suspend, never allow. */
export type BeforeToolCallResult =
  | { action: "continue" }
  | { action: "block"; reason: string }
  | { action: "suspend"; approvalId: string };

/** `attended` runs can ask; `unattended` runs (automations, heartbeat) defer approvals. */
export type RunMode = "attended" | "unattended";

export type RunOutcome =
  | "final"
  | "no_reply"
  | "awaiting_approval"
  | "awaiting_input"
  | "cancelled"
  | "failed";

export interface TurnInput {
  text: string;
  attachments?: { libraryItemId: string }[];
}

export interface StartTurnInput {
  threadId: string;
  runId: string;
  taskId?: string;
  input: TurnInput;
  mode: RunMode;
  permissionMode: PermissionMode;
  signal?: AbortSignal;
  /**
   * Who sent `input` (S10 `RouteContext`; security §9). Absent means the owner. A non-owner's
   * text is untrusted: it taints the turn and never counts as the owner's words for target
   * matching; the broker decides every call of the turn as that person's.
   */
  requester?: Requester;
}

export type AgentEvent =
  | { type: "run.status"; runId: string; status: RunStatus }
  | { type: "chat.delta"; runId: string; messageId: string; delta: string }
  | { type: "block"; runId: string; messageId: string; block: Block }
  | {
      type: "tool_call";
      runId: string;
      toolCallId: string;
      tool: string;
      status: ToolCallStatus;
      level1?: string;
      update?: ToolUpdate;
      /** What the Gateway persists in `tool_calls`; send it with the first event of a call. */
      details?: ToolCallDetails;
    }
  | { type: "approval_requested"; runId: string; approval: ApprovalRequest }
  | { type: "question"; runId: string; inputRequest: InputRequest }
  | { type: "usage"; runId: string; usage: Usage }
  | { type: "end"; runId: string; outcome: RunOutcome; error?: string };

/**
 * Persisted facts about a tool call (data model §2 `tool_calls`). Params are redacted
 * (`{{cred:…}}` placeholders kept, never secrets). Later events may repeat or extend it
 * (decision, approval, receipt); absent fields keep their stored value.
 */
export interface ToolCallDetails {
  paramsRedacted?: unknown;
  paramsHash?: string;
  sideEffect?: SideEffect;
  target?: Target | null;
  decision?: Decision | null;
  decisionRule?: string | null;
  approvalId?: string | null;
  taintIn?: boolean;
  taintOut?: boolean;
  resultRef?: string | null;
  provenanceOut?: ProvenanceOut;
  receiptId?: string | null;
}

export interface AgentLoop {
  /** Runs one turn; the iterable ends after exactly one `end` event. */
  startTurn(input: StartTurnInput): AsyncIterable<AgentEvent>;
  /** Interrupt the current tool loop of `runId` with new guidance. */
  steer(runId: string, text: string): Promise<void>;
  /** Queue a message to run after the thread's current turn settles. */
  followUp(threadId: string, text: string): Promise<void>;
  /** Cancel a run; its tool and approval authority is revoked immediately (§4.5). */
  cancel(runId: string, reason?: string): Promise<void>;
  /**
   * The exact context assembled for the latest model call of `runId` (feature C11, "Show
   * prompt"); `undefined` for an unknown or evicted run.
   */
  explainContext?(runId: string): Promise<ContextExplanation | undefined>;
}

// --- Prompt viewer (C11) -----------------------------------------------------------------------

export type ContextSectionKind =
  | "base"
  | "persona"
  | "skills"
  | "tools"
  | "daily_note"
  | "summary"
  | "hook";

/** One section of the assembled system prompt, in prompt order (architecture §4.2 step 3). */
export interface ContextSection {
  /** Stable id, e.g. `base`, `persona:SOUL.md`, `daily:2026-10-18`, `summary`. */
  id: string;
  kind: ContextSectionKind;
  title: string;
  /** Exactly the text placed in the prompt, markers included. */
  text: string;
  /** Workspace path the text came from, when it came from a file. */
  source?: string;
  /** Character budget applied, when one was. */
  budget?: number;
  /** Characters before truncation. */
  originalChars?: number;
  truncated?: boolean;
  missing?: boolean;
  /** The section carries content with `untrusted` provenance. */
  untrusted?: boolean;
}

export interface ContextExplanation {
  runId: string;
  threadId: string;
  model: ModelRef;
  permissionMode: PermissionMode;
  /** The system prompt as sent (the sections joined). */
  system: string;
  sections: ContextSection[];
  /** Tool definitions as sent. */
  tools: ToolSpec[];
  /** Number of transcript messages sent after the system prompt. */
  messageCount: number;
  /** ISO-8601 time the context was assembled. */
  assembledAt: string;
}

// --- Tools -------------------------------------------------------------------------------------

export interface ToolUpdate {
  message?: string;
  progress?: number;
  data?: unknown;
}

export interface ToolResult {
  output: unknown;
  isError?: boolean;
  /** Executors tag network / third-party content `untrusted`; this taints the turn. */
  provenance: ProvenanceOut;
  receiptId?: string;
}

/** Signature every executor (browser, sandbox, node, MCP, built-ins) implements. */
export type ToolExecutor = (
  callId: string,
  params: unknown,
  signal: AbortSignal,
  onUpdate: (update: ToolUpdate) => void,
) => Promise<ToolResult>;

/**
 * Per-call facts only the executor's package can compute from the params (security §3.5).
 * Every field may only make a call stricter than the spec says, never looser: the agent loop
 * takes the more severe of `spec.sideEffect` and `sideEffect`.
 */
export interface ToolCallDescription {
  sideEffect?: SideEffect;
  /** Approval kind for this call; the broker infers one when absent. */
  kind?: ApprovalKind;
  /** Canonical target (origin, real path, recipient, argv…). */
  target?: Target;
  /** The `bindingHash` fields for `kind` (data model §4.2); the params hash is used when absent. */
  bindingFields?: unknown;
  /** Coarse key standing grants bind to (security §3.5). */
  grantKey?: string;
  /** One-line status for the transcript, e.g. `Opened united.com`. */
  summary?: string;
}

/**
 * The grant key a tool call offers the broker: `describeCall().grantKey` namespaced by the tool
 * so one tool's description can never borrow another tool's standing grants (security §3.5).
 * Executors recompute it from their own description to check a standing grant before dispatch.
 */
export function namespacedGrantKey(tool: string, grantKey: string): string {
  return grantKey.startsWith(`${tool}|`) ? grantKey : `${tool}|${grantKey}`;
}

/**
 * What authorized a dispatch (security §3.3, §3.7): the broker's decision as the agent loop
 * verified it right before running the tool. The loop is the single verifier and consumer of
 * `once` approvals; an executor that has its own enforcement (connectors, browser) confirms,
 * without consuming, that the approval or standing grant named here is live and covers the
 * exact arguments it is about to send (`bindingHash` for an approval, `grantKey` for a grant).
 */
export interface ToolCallAuthority {
  /** Deciding rule, e.g. `grant:<id>`, `mode:balanced/write`, `approval:<id>`. */
  rule: string;
  /** Binding hash of the exact arguments the loop decided or verified. */
  bindingHash: string;
  /** Namespaced grant key the call offered (see `namespacedGrantKey`), when it had one. */
  grantKey?: string;
  /** The approval the owner answered for this call, when the broker asked. */
  approvalId?: string;
  /** The standing grant that allowed the call, or the grant the approval created. */
  grantId?: string;
  /** `once` for a consumed approval; the grant's scope for a standing grant. */
  scope?: GrantScope;
}

export interface ToolRegistration {
  spec: ToolSpec;
  execute: ToolExecutor;
  /** Optional per-call description; must be pure and must not throw for valid params. */
  describeCall?: (params: unknown) => ToolCallDescription;
}

/** The single source of tool metadata for the broker and the tool-toggle settings. */
export interface ToolRegistry {
  list(): ToolSpec[];
  get(name: string): ToolRegistration | undefined;
  /** Packages register their executors here; returns an unregister function. */
  register(registration: ToolRegistration): Unsubscribe;
}
