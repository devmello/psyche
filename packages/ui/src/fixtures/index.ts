import type {
  ActionProposal,
  ApprovalRequest,
  Artifact,
  AuditChange,
  Automation,
  AutomationRun,
  BotAuthStatus,
  Channel,
  Connector,
  CredentialMeta,
  CredentialUse,
  Device,
  FeedbackEvent,
  FeedPost,
  Goal,
  Grant,
  Idea,
  InputRequest,
  Lesson,
  LibraryItem,
  LinkPaymentMethod,
  LinkSetupStatus,
  MemoryClaim,
  MemoryFileInfo,
  Message,
  Milestone,
  NodeInfo,
  Notification,
  OnePasswordSetupStatus,
  PairingRequest,
  PluginSummarySchema,
  Receipt,
  Run,
  RunFrame,
  RunStep,
  SearchHit,
  SecurityStateStatus,
  SkillDetails,
  SkillDraft,
  SpecialistJob,
  SpecialistRole,
  Task,
  TaskAction,
  ThreadListEntry,
  ToolCall,
  VaultPayment,
  VaultStatus,
  Widget,
} from "@psyche/protocol";
import type { ReviewWorld } from "../data/mock-review.ts";
import type { SpacesWorld } from "../data/mock-spaces.ts";
import type { NightShiftWorld } from "../night-shift/mock-night-shift.ts";
import { answerTokens, approvals, grants } from "./approvals.ts";
import { messages, runs, threads, toolCalls } from "./chat.ts";
import { fileTree, type MockFileNode } from "./files.ts";
import { feedbackEvents, lessons, milestones } from "./learning.ts";
import { memoryClaims, memoryFileInfos, memoryFiles, searchHits } from "./memory.ts";
import { type GraphWorld, graphWorld } from "./people.ts";
import { plugins } from "./plugins.ts";
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
import { specialistJobs, specialistRoles } from "./specialists.ts";
import { artifacts, inputRequests, library, receipts, taskActions, tasks } from "./tasks.ts";
import { usageSummary } from "./usage.ts";

/**
 * The deterministic fixture world shared by Storybook stories, tests and the MockGateway.
 * Persona "Wren" (a pale moth); owner "you"; the clock is fixed at FIXTURE_NOW.
 */

import type {
  ContextLimits,
  ContextUsage,
  EndpointProbe,
  MethodResult,
  ModelProviderSummary,
  ModelRoles,
} from "@psyche/protocol";

export { ago, at, FIXTURE_NOW, fakeHex, fakeSha, IDS, inMinutes, PERSONA, today } from "./ids.ts";
export {
  emptyInsights,
  type InsightsFixtureState,
  insightsFixtures,
} from "./insights.ts";
export { growthFeedPost, LEARNING_IDS } from "./learning.ts";
export {
  appleConnectors,
  appleShortcuts,
  connectorCatalogue,
  shortcutsAndObsidian,
  type UsageSummary,
  WINDOWS_IDS,
  windowsDevices,
  windowsNodes,
  windowsPresenceKeys,
} from "./settings.ts";
export { subscriptionUsageSummary, usageSummary } from "./usage.ts";

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
  /** Audit change records (`audit.changes`), newest first, with their stored diffs. */
  auditChanges: { change: AuditChange; diff?: string }[];
  /** Whether the audit hash chain verifies. */
  auditVerified: boolean;
  /** What `audit.friction` answers; absent means an empty window. */
  auditFriction?: MethodResult<"audit.friction">;
  artifacts: Artifact[];
  /** Generative-UI widget snapshots (empty unless a story or test adds some). */
  widgets: Widget[];
  /** What `widgets.preview` answers per tool (default `ask`). */
  widgetDecisions: Record<string, "allow" | "ask" | "deny" | "device-only" | "unavailable">;
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
  /** `security.*` (absent: sealed, no alerts, no recoveries), and a Gateway that asks for an approval card. */
  security?: SecurityStateStatus;
  securityNeedsApproval?: boolean;
  /** Web Bot Auth (I14): no key until the owner creates one. */
  botAuth: BotAuthStatus;
  nodes: NodeInfo[];
  credentials: CredentialMeta[];
  /** The fill audit behind `vault.uses`, newest first. */
  credentialUses: CredentialUse[];
  /** Stripe Link (`vault.payments.*`); absent methods → Link is not set up. */
  linkMethods?: LinkPaymentMethod[];
  /** The vault (`vault.status|setup|confirmRecovery|unlock`); absent → not implemented. */
  vault?: { status: VaultStatus; recoveryKey?: string };
  /** The guided Link setup (`payments.link.*`); absent → derived from `linkMethods`. */
  linkSetup?: LinkSetupStatus;
  /** The guided 1Password setup (`vault.onePassword.*`); absent → `op` is not installed. */
  onePassword?: { status: OnePasswordSetupStatus; vaultCount?: number };
  payments?: VaultPayment[];
  settings: Record<string, unknown>;
  /** Workspace file contents by workspace-relative path. */
  memoryFiles: Record<string, string>;
  memoryFileInfos: MemoryFileInfo[];
  memoryClaims: MemoryClaim[];
  /** Unified search hits for the query "dentist", grouped by scope. */
  searchHits: SearchHit[];
  /** The local search sources the mock Gateway reports (`search.sources`); absent = all off. */
  searchSources?: {
    sources: Partial<
      Record<
        string,
        { enabled: boolean; processing: "cloud" | "local" | "none"; agent: boolean; ocr?: boolean }
      >
    >;
    exclude: { contacts: string[]; chats: string[]; accounts: string[]; folders: string[] };
  };
  /** People and projects (docs/memory/people-and-projects-2026.md §8). */
  graph: GraphWorld;
  /** Everything memory's review queue, quarantine and runs (absent = empty). */
  review?: ReviewWorld;
  /** Spaces (absent = none); `withSpaces` fills it. */
  spaces?: SpacesWorld;
  /** Settings → Skills (T2). */
  skills: SkillDetails[];
  /** What reviewing a folder finds: a proposal to stage, or policy violations. */
  skillSources: Record<string, MockSkillSource>;
  /** Agent-proposed skill drafts (T3). */
  skillDrafts: SkillDraft[];
  /** Settings → Skills → Plugins: `plugins.list`. */
  plugins: PluginSummarySchema[];
  /** The admin switch `plugins.enabled`. */
  pluginsEnabled: boolean;
  usage: UsageSummary;
  /** `connectors.connect` behaviour in the mock: "unavailable" answers not_implemented. */
  connectorConnect?: "unavailable" | "not_configured";
  /** `connectors.googleClient`: absent = set in config.json; `null` = not set up yet. */
  googleClient?: { clientId: string; hasSecret: boolean; source: "app" | "config" } | null;
  /** macOS grant for the Apple connectors (#549); default granted. */
  appleGrant?: "granted" | "denied" | "notDetermined";
  /** The last turn's context usage by thread id; absent → no turn has reported yet. */
  contextUsage?: Record<string, ContextUsage>;
  /** Each thread's own context limits. */
  contextLimits?: Record<string, ContextLimits>;
  /** `models.*` (B1, B4); stories and tests seed them from the settings sample data. */
  modelProviders?: ModelProviderSummary[];
  modelRoles?: ModelRoles;
  modelProbes?: Record<string, EndpointProbe>;
  /** `usage.summary` (#599). */
  usageSummary?: MethodResult<"usage.summary">;
  /** The teaching loop (T0 #678): the owner's feedback, the lessons from it, milestones. */
  feedbackEvents: FeedbackEvent[];
  lessons: Lesson[];
  milestones: Milestone[];
  /** Run-trace steps, frames, payloads and automation runs (`runTraceWorld()` in fixtures/runs). */
  runSteps?: RunStep[];
  runFrames?: Record<string, RunFrame[]>;
  runPayloads?: Record<string, { input?: unknown; output?: unknown; truncated?: boolean }>;
  automationRuns?: AutomationRun[];
  /** Batch proposals (`proposals.*`) and which calls fail when one runs (`fixtures/workflows.ts`). */
  proposals?: ActionProposal[];
  proposalFailures?: Record<string, Record<number, string>>;
  /** Night shift (`night-shift/mock.ts`: `nightShiftFixture()`); absent → off. */
  nightShift?: NightShiftWorld;
  /** Background specialists (`fixtures/specialists.ts`). */
  specialistRoles?: SpecialistRole[];
  specialistJobs?: SpecialistJob[];
}

/** Builds a fresh world; every call returns a deep copy, so callers may mutate freely. */
export function createFixtureWorld(): FixtureWorld {
  return structuredClone<FixtureWorld>({
    threads: threads(),
    usageSummary: usageSummary(),
    feedbackEvents: feedbackEvents(),
    lessons: lessons(),
    milestones: milestones(),
    messages: messages(),
    runs: runs(),
    toolCalls: toolCalls(),
    tasks: tasks(),
    taskActions: taskActions(),
    approvals: approvals(),
    answerTokens: answerTokens(),
    inputRequests: inputRequests(),
    receipts: receipts(),
    auditChanges: [],
    auditVerified: true,
    artifacts: artifacts(),
    widgets: [],
    widgetDecisions: {},
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
    botAuth: {
      enabled: false,
      keyId: null,
      publicJwk: null,
      createdAt: null,
      signatureAgent: null,
      directoryPath: "/.well-known/http-message-signatures-directory",
      origins: [],
      advertised: [],
    },
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
    graph: graphWorld(),
    skills: skills(),
    skillSources: skillSources(),
    skillDrafts: skillDrafts(),
    plugins: plugins(),
    pluginsEnabled: true,
    usage: usage(),
    specialistRoles: specialistRoles(),
    specialistJobs: specialistJobs(),
  });
}
export { FILE_ROOTS, fileRootGrants, fileTree, type MockFileNode } from "./files.ts";
export {
  runTraceWorld,
  TRACE_IDS,
  traceAutomationRuns,
  traceFrames,
  traceLongRun,
  tracePayloads,
  traceRuns,
  traceSteps,
} from "./runs.ts";
export {
  GREEDY_SKILL_FOLDER,
  type MockSkillSource,
  SKILL_FOLDER,
  skillDrafts,
  skillSources,
  skills,
  stagedSkillProposal,
} from "./skills.ts";
export {
  DONE_RESULT,
  SPECIALIST_IDS,
  specialistJobs,
  specialistNotifications,
  specialistRoles,
  specialistTasks,
  withSpecialists,
} from "./specialists.ts";
export {
  draftView,
  inboxDigest,
  markReadProposal,
  meetingNotes,
  meetingPrep,
  quietDigest,
  remindersProposal,
  schedulingView,
  WORKFLOW_IDS,
  withWorkflows,
  workflowLoops,
  workflowPosts,
  workflowProposals,
} from "./workflows.ts";
