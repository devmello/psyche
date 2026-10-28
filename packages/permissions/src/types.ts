import type {
  ApprovalAnswerInput,
  ApprovalKind,
  ApprovalRequest,
  ApprovalRequestInput,
  DecisionContext,
  DecisionResult,
  GrantScope,
  JsonObject,
  SideEffect,
  Surface,
  ToolCallIntent,
} from "@psyche/protocol";

/**
 * Extensions of the `PermissionBroker` contract types. Every field is optional, so a caller that
 * only knows the contract still gets the strict defaults; the additions are listed for a
 * `protocol:` PR in `docs/archive/status/s05.md`.
 */

/** Where taint came from (security §3.6): `{sourceKind, origin or sender, toolCallId}`. */
export interface TaintSource {
  sourceKind: string;
  origin?: string;
  sender?: string;
  toolCallId?: string;
}

/** Who caused this call. `content` is a hard prohibition (instructions found in content). */
export type Initiator = "owner" | "agent" | "subagent" | "automation" | "content" | "mcp_app";

/** Who asked for the call (S10 `RouteContext`; security §9). Absent means the owner. */
export interface Requester {
  role: "owner" | "designated" | "allowed";
  /** `identities.id` for designated persons. */
  identityId?: string;
  display?: string;
  channel?: string;
  senderId?: string;
  chatId?: string;
  /** `identities.links` (`<channel>:<senderId>`). */
  links?: string[];
  /** `identities.tool_allow` globs; absent = no extra limit beyond the persona limits. */
  toolAllow?: string[];
}

export interface PolicyContext extends DecisionContext {
  requester?: Requester;
  taintSources?: TaintSource[];
  initiator?: Initiator;
  /** The Task's origin sets (security §6). */
  originSet?: { readOnly?: string[]; readWritable?: string[] };
  /** Owner-provenance request messages, newest last; the classifier sees the last 10. */
  ownerMessages?: string[];
  task?: {
    title?: string;
    goal?: string;
    /** Agent-written goals reach the classifier only as metadata (design-08). */
    goalAuthoredBy?: "owner" | "agent";
    goalTainted?: boolean;
  };
}

/** Facts about the call the executor knows and the broker cannot infer from params. */
export interface CallMeta {
  /** Connector matrix key, e.g. `{ id: "google", action: "gmail.send" }`. */
  connector?: { id: string; action: string };
  /** Bundle id for computer-use actions. */
  app?: string;
  /** Computer-use or browser action name (`click`, `type`, …). */
  action?: string;
  /** The element being typed into or filled. */
  field?: {
    type?: string;
    tag?: string;
    name?: string;
    role?: string;
    autocomplete?: string;
    secure?: boolean;
  };
  /** Irreversible deletion (needs the owner's typed confirmation word). */
  permanentDelete?: boolean;
  /** A CAPTCHA or bot challenge is involved. */
  captcha?: boolean;
  /** Creates an account with a third party. */
  accountCreation?: boolean;
  /** Runs page JavaScript (`javascript_tool`). */
  javascript?: boolean;
  /** Values come from the localhost test-credential exception. */
  testCredential?: boolean;
  /** Sandbox network mode for `exec`. */
  network?: "none" | "proxy";
  /** `exec` writes outside `/workspace`. */
  writesOutsideWorkspace?: boolean;
  /** MCP server trust tier. */
  mcpTier?: "bundled" | "verified" | "unknown";
  /** MCP server and the `tools/list` hash the call was described with (grant subject, #279). */
  mcpServerId?: string;
  mcpToolsListHash?: string;
}

export interface PolicyCall extends ToolCallIntent {
  toolCallId?: string;
  /** Kind-specific binding arguments (see `binding.ts`); else `{tool, paramsHash, target}`. */
  binding?: unknown;
  meta?: CallMeta;
}

export interface PolicyDecision extends DecisionResult {
  /** Evaluation steps that ran, in order, for the audit log and tests. */
  trace: string[];
  /** Effective side-effect class after the broker's floors (never lower than declared). */
  sideEffect: ToolCallIntent["sideEffect"];
  /** The call after hook rewrites; its binding is what an approval binds. */
  call: PolicyCall;
  /** Owner must type this word on the card (permanent deletion). */
  typedConfirmation?: string;
  /** `ask` in an unattended run: queued, the run continues without the action. */
  deferred?: boolean;
  /** Classifier label when the classifier ran. */
  classifier?: { label: ClassifierLabel; reason: string };
  /**
   * What let a send / destructive / financial call through without a card (§3.12): a standing
   * grant the owner made, or the owner's confirmed matrix override.
   */
  via?: "grant" | "matrix-override";
}

export type ClassifierLabel = "routine" | "sensitive" | "prohibited";

export interface PolicyApprovalInput extends ApprovalRequestInput {
  /** The decided call and context, persisted so `reissue()` re-evaluates the same inputs. */
  call?: PolicyCall;
  context?: PolicyContext;
  typedConfirmation?: string;
  /** Taint sources shown on the card. */
  taintSources?: TaintSource[];
  /** `kind: "batch"`: the decided calls the one approval covers, in order (§8.1, #670). */
  batch?: { children: BatchChild[] };
}

/**
 * One call inside a batch approval, as the broker decided it when the batch was requested. On
 * approval the broker mints one approved, once-only child approval per call, bound to the
 * call's own binding hash, so every existing check (the loop's `verifyBinding`, connectors
 * confirming their authority) works unchanged.
 */
export interface BatchChild {
  call: PolicyCall;
  kind: ApprovalKind;
  bindingHash: string;
  grantKey: string;
  sideEffect: SideEffect;
  summary: string;
}

/** `requestBatch` input (docs/workflows/mail-and-meetings-2026.md §8.1). */
export interface PolicyBatchInput {
  title: string;
  children: { call: PolicyCall; summary: string }[];
  context: PolicyContext;
  requestedBy: ApprovalRequest["requestedBy"];
  surfaces: Surface[];
  details?: JsonObject;
  taintSources?: TaintSource[];
  ttlMs?: number;
}

/** WebAuthn assertion or helper-signed Touch ID signature over the challenge (design-04). */
export interface PresenceAssertion {
  kind: "webauthn" | "helper";
  deviceId: string;
  signature: string;
  /** Opaque payload the verifier needs (authenticator data, client data JSON, …). */
  payload?: Record<string, string>;
}

export interface PolicyAnswerInput extends ApprovalAnswerInput {
  presence?: PresenceAssertion;
  /** The word the owner typed for a permanent deletion. */
  typedConfirmation?: string;
}

export interface ScopeTtlConfig {
  task: number;
  destructiveTask: number;
  site: number;
  sessionIdle: number;
  sessionMax: number;
  always: number;
  execHostAlways: number;
}

export type { ApprovalKind, GrantScope };
