import type { PermissionMode, SideEffect, TargetKind } from "@psyche/protocol";

/**
 * Injection corpus case, as defined by `tests/corpus/injection/schema.json` (see its README).
 * `validate.mjs` enforces the schema and cross-field rules; these types mirror it for the runner.
 */

export type Outcome = "blocked" | "asked" | "ignored";

export type Invariant =
  | "no_unapproved_side_effect"
  | "no_unapproved_egress"
  | "no_secret_in_model_context"
  | "no_placeholder_resolution"
  | "no_memory_promotion"
  | "no_grant_change"
  | "no_mode_change"
  | "no_skill_installed"
  | "no_chat_approval_accepted"
  | "card_shows_full_args"
  | "taint_recorded"
  | "audit_entry_written"
  | "flagged_instruction_like";

export type SourceKind =
  | "web_page"
  | "email"
  | "calendar_event"
  | "pdf"
  | "file"
  | "image"
  | "mcp_server"
  | "chat_message"
  | "memory_file"
  | "skill_package"
  | "subagent";

export interface AttackToolCall {
  tool: string;
  sideEffect: SideEffect;
  targetKind?: TargetKind;
  target?: string;
  approvalKind?: string;
  args: unknown;
}

/** A follow-up step of a multi-step attack, e.g. a forged approval answer on a channel. */
export interface FollowUp {
  type?: string;
  [key: string]: unknown;
}

export interface InjectionCase {
  id: string;
  title: string;
  vector: string;
  goal: string;
  techniques: string[];
  context: {
    ownerRequest: string;
    modes: PermissionMode[];
    unattended?: boolean;
    source: {
      kind: SourceKind;
      provenance: "untrusted" | "agent" | "owner" | "system";
      origin?: string;
      sender?: string;
      channel?: string;
      mcpServer?: Record<string, unknown>;
      path?: string;
    };
    grants?: { scope: string; kind: string; boundTo?: Record<string, unknown> }[];
    taskOrigins?: { readOnly?: string[]; readWritable?: string[] };
    owner?: Record<string, unknown>;
  };
  payload: { format: string; content: unknown; hiddenBy?: string; fixture?: string };
  attack: { toolCall: AttackToolCall | null; secretRefs?: string[]; followUps?: FollowUp[] };
  expected: {
    outcome: Outcome;
    byMode?: Partial<Record<PermissionMode, Outcome>>;
    rule?: string;
    approval?: {
      kind?: string;
      deviceOnly?: boolean;
      scopesOffered?: string[];
      mustShow?: string[];
      taintSources?: string[];
    };
    /** Per-mode overrides merged over `approval` (manual destructive is `once` only, §3.2). */
    approvalByMode?: Partial<
      Record<PermissionMode, NonNullable<InjectionCase["expected"]["approval"]>>
    >;
    invariants: Invariant[];
  };
  rationale: string;
  refs: string[];
}

export interface CorpusFile {
  family: string;
  version: 1;
  cases: InjectionCase[];
}
