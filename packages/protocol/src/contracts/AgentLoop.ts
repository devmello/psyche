import type {
  Decision,
  PermissionMode,
  ProvenanceOut,
  SideEffect,
  Target,
  Usage,
} from "../common.ts";
import type { Block, ToolCallStatus } from "../schemas/blocks.ts";
import type { ApprovalRequest } from "../schemas/permissions.ts";
import type { InputRequest } from "../schemas/tasks.ts";
import type { RunStatus } from "../schemas/threads.ts";
import type { ToolSpec } from "../schemas/tools.ts";
import type { Unsubscribe } from "./Clock.ts";

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

export interface ToolRegistration {
  spec: ToolSpec;
  execute: ToolExecutor;
}

/** The single source of tool metadata for the broker and the tool-toggle settings. */
export interface ToolRegistry {
  list(): ToolSpec[];
  get(name: string): ToolRegistration | undefined;
  /** Packages register their executors here; returns an unregister function. */
  register(registration: ToolRegistration): Unsubscribe;
}
