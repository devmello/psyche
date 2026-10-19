import type {
  ApprovalRequest,
  Artifact,
  Automation,
  Channel,
  Connector,
  CredentialMeta,
  Device,
  FeedPost,
  Goal,
  Grant,
  Idea,
  InputRequest,
  LibraryItem,
  MemoryClaim,
  MemoryFileInfo,
  Message,
  NodeInfo,
  Notification,
  PairingRequest,
  Receipt,
  Run,
  SearchHit,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
} from "@psyche/protocol";
import { answerTokens, approvals, grants } from "./approvals.ts";
import { messages, runs, threads, toolCalls } from "./chat.ts";
import { memoryClaims, memoryFileInfos, memoryFiles, searchHits } from "./memory.ts";
import { automations, feed, goals, ideas, NEXT_BRIEF_AT, notifications } from "./proactive.ts";
import {
  channels,
  connectors,
  credentials,
  devices,
  nodes,
  pairingRequests,
  settings,
  type UsageSummary,
  usage,
} from "./settings.ts";
import { artifacts, inputRequests, library, receipts, taskActions, tasks } from "./tasks.ts";

/**
 * The deterministic fixture world shared by Storybook stories, tests and the MockGateway.
 * Persona "Wren" (a pale moth); owner "you"; the clock is fixed at FIXTURE_NOW.
 */

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
  settings: Record<string, unknown>;
  /** Workspace file contents by workspace-relative path. */
  memoryFiles: Record<string, string>;
  memoryFileInfos: MemoryFileInfo[];
  memoryClaims: MemoryClaim[];
  /** Unified search hits for the query "dentist", grouped by scope. */
  searchHits: SearchHit[];
  usage: UsageSummary;
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
    settings: settings(),
    memoryFiles: memoryFiles(),
    memoryFileInfos: memoryFileInfos(),
    memoryClaims: memoryClaims(),
    searchHits: searchHits(),
    usage: usage(),
  });
}
