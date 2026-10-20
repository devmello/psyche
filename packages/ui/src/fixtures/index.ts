import type {
  ApprovalRequest,
  Artifact,
  Automation,
  Channel,
  Connector,
  CredentialMeta,
  CredentialUse,
  Device,
  FeedPost,
  Goal,
  Grant,
  Idea,
  InputRequest,
  LibraryItem,
  LinkPaymentMethod,
  MemoryClaim,
  MemoryFileInfo,
  Message,
  NodeInfo,
  Notification,
  PairingRequest,
  Receipt,
  Run,
  SearchHit,
  SkillDetails,
  SkillDraft,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
  VaultPayment,
} from "@psyche/protocol";
import { answerTokens, approvals, grants } from "./approvals.ts";
import { messages, runs, threads, toolCalls } from "./chat.ts";
import { fileTree, type MockFileNode } from "./files.ts";
import { memoryClaims, memoryFileInfos, memoryFiles, searchHits } from "./memory.ts";
import { automations, feed, goals, ideas, NEXT_BRIEF_AT, notifications } from "./proactive.ts";
import {
  channels,
  connectors,
  credentials,
  credentialUses,
  devices,
  linkMethods,
  nodes,
  pairingRequests,
  payments,
  settings,
  type UsageSummary,
  usage,
} from "./settings.ts";
import { type MockSkillSource, skillDrafts, skillSources, skills } from "./skills.ts";
import { artifacts, inputRequests, library, receipts, taskActions, tasks } from "./tasks.ts";

/**
 * The deterministic fixture world shared by Storybook stories, tests and the MockGateway.
 * Persona "Wren" (a pale moth); owner "you"; the clock is fixed at FIXTURE_NOW.
 */

import type {
  ContextLimits,
  ContextUsage,
  EndpointProbe,
  ModelProviderSummary,
  ModelRoles,
} from "@psyche/protocol";

export { ago, at, FIXTURE_NOW, fakeHex, fakeSha, IDS, inMinutes, PERSONA, today } from "./ids.ts";
export type { UsageSummary } from "./settings.ts";

export interface FixtureWorld {
  threads: ThreadListEntry[];
  messages: Message[];
  runs: Run[];
  toolCalls: ToolCall[];
  tasks: Task[];
  taskActions: TaskAction[];
  approvals: ApprovalRequest[];
  /** Single-use answer tokens this surface holds, by approval id (pending approvals only). */
  answerTokens: Record<string, string>;
  inputRequests: InputRequest[];
  receipts: Receipt[];
  artifacts: Artifact[];
  library: LibraryItem[];
  /** Granted-folder files by absolute path (FILE_ROOTS), for the Files pane. */
  files: Record<string, MockFileNode>;
  notifications: Notification[];
  feed: FeedPost[];
  nextBriefAt: string;
  ideas: Idea[];
  goals: Goal[];
  automations: Automation[];
  grants: Grant[];
  connectors: Connector[];
  channels: Channel[];
  pairingRequests: PairingRequest[];
  devices: Device[];
  nodes: NodeInfo[];
  credentials: CredentialMeta[];
  /** The fill audit behind `vault.uses`, newest first. */
  credentialUses: CredentialUse[];
  /** Stripe Link (`vault.payments.*`); absent methods → Link is not set up. */
  linkMethods?: LinkPaymentMethod[];
  payments?: VaultPayment[];
  settings: Record<string, unknown>;
  /** Workspace file contents by workspace-relative path. */
  memoryFiles: Record<string, string>;
  memoryFileInfos: MemoryFileInfo[];
  memoryClaims: MemoryClaim[];
  /** Unified search hits for the query "dentist", grouped by scope. */
  searchHits: SearchHit[];
  /** Settings → Skills (T2). */
  skills: SkillDetails[];
  /** What reviewing a folder finds: a proposal to stage, or policy violations. */
  skillSources: Record<string, MockSkillSource>;
  /** Agent-proposed skill drafts (T3). */
  skillDrafts: SkillDraft[];
  usage: UsageSummary;
  /** The last turn's context usage by thread id; absent → no turn has reported yet. */
  contextUsage?: Record<string, ContextUsage>;
  /** Each thread's own context limits. */
  contextLimits?: Record<string, ContextLimits>;
  /** `models.*` (B1, B4); stories and tests seed them from the settings sample data. */
  modelProviders?: ModelProviderSummary[];
  modelRoles?: ModelRoles;
  modelProbes?: Record<string, EndpointProbe>;
}

/** Builds a fresh world; every call returns a deep copy, so callers may mutate freely. */
export function createFixtureWorld(): FixtureWorld {
  return structuredClone<FixtureWorld>({
    threads: threads(),
    messages: messages(),
    runs: runs(),
    toolCalls: toolCalls(),
    tasks: tasks(),
    taskActions: taskActions(),
    approvals: approvals(),
    answerTokens: answerTokens(),
    inputRequests: inputRequests(),
    receipts: receipts(),
    artifacts: artifacts(),
    library: library(),
    files: fileTree(),
    notifications: notifications(),
    feed: feed(),
    nextBriefAt: NEXT_BRIEF_AT,
    ideas: ideas(),
    goals: goals(),
    automations: automations(),
    grants: grants(),
    connectors: connectors(),
    channels: channels(),
    pairingRequests: pairingRequests(),
    devices: devices(),
    nodes: nodes(),
    credentials: credentials(),
    credentialUses: credentialUses(),
    linkMethods: linkMethods(),
    payments: payments(),
    settings: settings(),
    memoryFiles: memoryFiles(),
    memoryFileInfos: memoryFileInfos(),
    memoryClaims: memoryClaims(),
    searchHits: searchHits(),
    skills: skills(),
    skillSources: skillSources(),
    skillDrafts: skillDrafts(),
    usage: usage(),
  });
}
export { FILE_ROOTS, fileRootGrants, fileTree, type MockFileNode } from "./files.ts";
export {
  GREEDY_SKILL_FOLDER,
  type MockSkillSource,
  SKILL_FOLDER,
  skillDrafts,
  skillSources,
  skills,
  stagedSkillProposal,
} from "./skills.ts";
