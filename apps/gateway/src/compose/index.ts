import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentToolRegistry,
  automationIntentProvider,
  type CompactionPolicy,
  createAgentLoop,
  defangFence,
  type ForkReportHost,
  type PsycheAgentLoop,
} from "@psyche/agent-core";
import {
  createAuditLog,
  FileAuditStore,
  type HashChainAuditLog,
  SoftwareAnchorKey,
} from "@psyche/audit";
import { redactUrl } from "@psyche/browser";
import type { ConnectorRegistry } from "@psyche/connectors";
import {
  countActivePasskeys,
  getDevice,
  getSetting,
  getThread,
  listDevices,
  listLibraryGateRows,
  type PsycheDb,
  setSetting,
} from "@psyche/db";
import { fileTools } from "@psyche/files";
import {
  brokerApprovalCheck,
  consolidateLessons,
  createAgentNoteHandlers,
  createMemoryHandlers,
  createMemoryStore,
  ownerTimeZone,
  parseLearned,
  readHeader,
  retireUnanswered,
  type SqliteMemoryStore,
} from "@psyche/memory";
import {
  type AppleHelper,
  CliAdapter,
  type CliAdapterDeps,
  createModelRouter,
  isLocalKind,
  isSubscriptionKind,
  type KeySource,
  KeyValueProbeStore,
  type ModelRouter,
  type ModelRouterConfig,
} from "@psyche/model-router";
import {
  createDeviceSurface,
  createNotificationHandlers,
  PsycheNotifier,
  SqliteNotificationStore,
  toGatewayEvent,
} from "@psyche/notifications";
import {
  appleConnectorKey,
  compilePolicy,
  createPermissionHandlers,
  DENY_ALL_LOOPBACK,
  type FolderGrantEntry,
  type LocalProjectVerifier,
  ModelExecReviewer,
  type PolicyApprovalInput,
  type PolicyConfig,
  type PresenceVerifier,
  PsychePermissionBroker,
  RESTORE_MARKER,
  RevocationLedger,
  replayRevocations,
  SENSITIVE_CATEGORY_SETTING_PREFIX,
  SqlitePermissionStore,
} from "@psyche/permissions";
import {
  DAILY_SETTING_KEYS,
  proactiveTools,
  publicFetch,
  withProactiveJobs,
} from "@psyche/proactive";
import {
  type ApprovalRequestInput,
  type Clock,
  EVERYTHING_MEMORY_SETTING_KEY,
  type EventName,
  type EventPayload,
  type GraphLoop,
  type IssuedApproval,
  isUnattendedTask,
  MEMORY_RECALL_MODE_SETTING,
  MEMORY_WORK_SETTING_KEY,
  type Message,
  type ModelProvider,
  type ModelRef,
  type Notification,
  type PermissionBroker,
  type PromiseView,
  PsycheError,
  type SecurityAlert,
  type StagedAction,
  type Task,
  TERMINAL_TASK_STATUSES,
} from "@psyche/protocol";
import {
  createAutomationHandlers,
  createDbSessionResolver,
  createDeliverer,
  createTaskLauncher,
  groupAutomationRunThreads,
  KEEP_AWAKE_SETTING,
  KeepAwake,
  type RunLauncher,
  SqliteScheduler,
} from "@psyche/scheduler";
import { WEB_SEARCH_PROVIDER_SETTING, WEB_SEARCH_SEARXNG_SETTING } from "@psyche/search";
import {
  createTaskHandlers,
  createWakeDetector,
  SqliteTaskEngine,
  TaskWorkerPool,
} from "@psyche/tasks";
import { DerivedKeyStore, type PaymentBroker, SecretRedactor, type Vault } from "@psyche/vault";
import { type DocumentsHandle, documentBridge } from "../artifacts/bridge.ts";
import { resolveConfig } from "../config.ts";
import type { HandlerDef } from "../context.ts";
import type { PublicRoute, WebhookRoute } from "../http.ts";
import { createLogger } from "../log.ts";
import { personalizeMessageEvent } from "../message-scrub.ts";
import { openGatewayDb, purgePreUpdateSnapshots, releaseGatewayLock } from "../pre-update.ts";
import {
  personalizeLoopEvent,
  personalizeNotificationEvent,
  personalizePromiseEvent,
  withNotificationScrub,
} from "../promise-scrub.ts";
import { TraceScrubWorker } from "../run-trace/forget-scrub.ts";
import { taskRunTrace } from "../run-trace/tasks.ts";
import { alertNotice, alertNotifyDecision } from "../security/alerts.ts";
import { sealedPermissionStore } from "../security/sealed-stores.ts";
import { StateSeal } from "../security/state-seal.ts";
import { type Gateway, type GatewayOptions, startGateway } from "../server.ts";
import { psycheServerKind } from "../server-install.ts";
import { reencodeToolImage } from "../session/image-resize.ts";
import { composeSpaceFolders, spaceFolderSource } from "../spaces/folders.ts";
import { BusySources, UpdateGate } from "../update-gate.ts";
import {
  API_KEY_IDS,
  API_KEY_LABEL,
  apiKeyHandlers,
  describeKeyActor,
  envKey,
  keyActorParts,
} from "./api-keys.ts";
import { ApprovalTokens } from "./approval-tokens.ts";
import { artifactContextProvider, composeArtifacts } from "./artifacts.ts";
import { attentionHandlers, OwnerAttention, parkWhenUnwatched } from "./attention.ts";
import { createAutoTitler } from "./auto-title.ts";
import { withAutomationSpecialists } from "./automation-specialists.ts";
import { BOOTSTRAP_ADMIN_AUDIT_KIND, bootstrapAdminHandlers } from "./bootstrap-admin.ts";
import type { ComposedBrowser } from "./browser.ts";
import { CallContexts } from "./call-context.ts";
import { capabilityCatalogue, capabilityTools, deferToolFor } from "./capabilities.ts";
import {
  changeHandlers,
  createChangeRecorder,
  fileChange,
  memoryChange,
  settingChange,
  toolEffectChange,
} from "./changes.ts";
import { ChannelConversations } from "./channel-conversations.ts";
import { type ComposedComputer, composeComputer } from "./computer.ts";
import { CONNECTOR_MATRIX_PREFIX } from "./connector-matrix.ts";
import { macHelper } from "./connectors.ts";
import { createContext } from "./context.ts";
import { composeConversion } from "./convert.ts";
import { cookieImportHandlers } from "./cookie-import.ts";
import { DeferredDigest } from "./deferred-digest.ts";
import { DeferredResume } from "./deferred-resume.ts";
import { composeDeviceNotifications, DeviceNotifications } from "./device-notify.ts";
import { composeDictation } from "./dictation.ts";
import { composeEverything, type Everything, everythingSettings } from "./everything.ts";
import { readSystemState } from "./everything-probe.ts";
import { type ExecHostDeps, execHostTool } from "./exec-host.ts";
import { feedContextResolver } from "./feed-context.ts";
import { filesHandlers } from "./files.ts";
import { migrateFilesConnector } from "./files-migration.ts";
import { repointFolders, withFolder, withRecordedReal, withRecordedRef } from "./folder-access.ts";
import { composeForgetCascade, composeGraphReset } from "./forget-cascade.ts";
import { composeForks, FORK_POOL_CLAIM } from "./forks.ts";
import { usesSandboxPc } from "./guest-sandbox.ts";
import {
  mountParamsOnly,
  mountPermissions,
  questionHandlers,
  receiptHandlers,
  surfaceOf,
} from "./handlers.ts";
import { composeHarnesses } from "./harnesses.ts";
import { headlessLinuxHost, hostGraphicalSession } from "./headless-host.ts";
import { HELPER_AVAILABILITY_SETTING, HelperAvailability } from "./helper-availability.ts";
import { type HostTerminalOptions, hostTerminalPart } from "./host-terminal.ts";
import { insightsHandlers } from "./insights.ts";
import { libraryHandlers } from "./library.ts";
import { composeGuidedPayments, type LinkSetupOptions } from "./link-setup.ts";
import { machineExec } from "./machine-exec.ts";
import {
  MachineFolderGrants,
  machineDirectory,
  machineFilesTool,
  machineLibrary,
} from "./machine-files.ts";
import { machineChangeHook } from "./machine-notices.ts";
import { composeMailFollowups } from "./mail-followups.ts";
import type { ComposedMcp } from "./mcp.ts";
import { mountMemoryHandlers } from "./memory-chunks.ts";
import { memoryStoreStatus, resolveMemoryStore, setMemoryEncrypted } from "./memory-db.ts";
import { withMemoryEntityContext } from "./memory-item-context.ts";
import {
  asMemoryEmbedder,
  createMemoryRecall,
  defaultLocalLoader,
  type LocalEmbedderLoader,
} from "./memory-recall.ts";
import {
  clearModelKey,
  type HostedModelKind,
  hasModelKey,
  isHostedModelKind,
  storeModelKey,
  untilPrimaryPicked,
  vaultModelKeys,
} from "./model-keys.ts";
import {
  type ModelSettingsSetup,
  modelSettingsHandlers,
  restoreModelSettings,
  settingsKeyValue,
} from "./model-settings.ts";
import { composeNightShift, personalizeNightShiftItem } from "./night-shift.ts";
import { NotificationActions } from "./notification-actions.ts";
import { composeNudges } from "./nudges.ts";
import { composeOnePasswordSetup, type OnePasswordSetupOptions } from "./onepassword-setup.ts";
import { createOtherChats, type OtherChats } from "./other-chats.ts";
import { PageReadHub } from "./page-reads.ts";
import { composePasskeys } from "./passkeys.ts";
import { passkeyPresenceForced, withPaymentPresence } from "./payment-presence.ts";
import { type ComposedPayments, type PaymentsSetup, paymentsSetupFromEnv } from "./payments.ts";
import { composePeople, type People } from "./people.ts";
import { graphSourceAdapters } from "./people-sources.ts";
import { phoneLocationTool } from "./phone-location.ts";
import { composePlugins } from "./plugins.ts";
import { composePoints, type PointsOptions } from "./points.ts";
import { type ComposedProactive, composeProactive, connectorToolLookup } from "./proactive.ts";
import {
  folderAccessEnv,
  launchConfigLinks,
  ownWorkdirs,
  protectedRoots,
  runCarveOuts,
  writeProtection,
} from "./protected-paths.ts";
import {
  checkoutNeedsDesktop,
  createPurchaseTool,
  LINK_PAYMENT_SOURCE,
  PURCHASE_TOOL,
} from "./purchase-tool.ts";
import { notifierRouting } from "./quiet-hours.ts";
import { createRateLimits } from "./rate-limits.ts";
import {
  attachRecordedRunGuard,
  createRecordingScheduleHandlers,
  RECORDED_RUN_RULES,
  RecordedRuns,
  withoutAgentRecordingSchedules,
  withRecordedSkillRuns,
} from "./recording-schedule.ts";
import { requestPermissionTool } from "./request-permission.ts";
import { researchTools } from "./research.ts";
import { withRunSnapshot } from "./run-snapshot.ts";
import type { ComposedSandbox } from "./sandbox.ts";
import { scrubSavedRecall } from "./saved-recall.ts";
import {
  createScheduledHandlers,
  pausedRoutines,
  routineOf,
  withPausedRoutines,
} from "./scheduled.ts";
import { composeScreenAsk, type ScreenAskOptions } from "./screen-ask.ts";
import { scriptTools } from "./scripts.ts";
import { type ComposedSearch, composeSearch, graphNames } from "./search.ts";
import { appleSearchSeams } from "./search-apple.ts";
import { resolveSearchKey } from "./search-db.ts";
import { searchEngine, searchModelProvider } from "./search-engine.ts";
import { filesSourceDeps, powerReader } from "./search-files.ts";
import { chatContextResolver } from "./search-hit-context.ts";
import { memorySettings, memorySourceDeps } from "./search-memory.ts";
import { helperRecognizer } from "./search-ocr.ts";
import { agentBlockedHit, canOpenGistSource, scrubCitations } from "./search-open.ts";
import { routerEmbedder, type SemanticEngines } from "./search-semantic.ts";
import { agentLocalSearch, searchEverythingTool } from "./search-tool.ts";
import { applySensitiveCategories, sensitiveCategoriesFrom } from "./sensitive-categories.ts";
import { composeSeparateDesktop, separateDesktopFolderEnv } from "./separate-desktop.ts";
import {
  type ApprovalRelay,
  type BrowserAvailability,
  type ComposedPart,
  type ComposeServices,
  createOwnPorts,
} from "./services.ts";
import { setupTokenHandlers, setupTokenUsedHook } from "./setup-tokens.ts";
import { composeSkills } from "./skills.ts";
import { composeSpaceContext } from "./space-context.ts";
import { composeSpaceOffers } from "./space-propose-tool.ts";
import { composeSpaces, type SpaceTrackersRef } from "./spaces.ts";
import { withSpecialistContext } from "./specialist-approvals.ts";
import {
  createSpecialistHost,
  raiseSpecialistBudget,
  specialistHandlers,
  withSpecialistProgress,
} from "./specialists.ts";
import {
  composeSpeech,
  type MeetingIngest,
  type SpeechSetup,
  speechSetupFromEnv,
} from "./speech.ts";
import { createSrtResolver, type SrtResolver } from "./srt.ts";
import { taskUpdateHandlers } from "./task-controls.ts";
import { composeTeachApp } from "./teach-app.ts";
import {
  type ComposedTeaching,
  composeTeaching,
  TEACHING_ASK_RULES_KEY,
  teachingAskRules,
  teachingSettings,
} from "./teaching.ts";
import { createThreadClear } from "./thread-clear.ts";
import { endSessionQuietly } from "./thread-end.ts";
import { SqliteThreadStateStore } from "./thread-state.ts";
import { CROSS_THREAD_SETTING, crossThreadToggle, threadTools } from "./thread-tools.ts";
import { modelPinsFor, restoreModelPins, threadSettingsHandlers } from "./threads.ts";
import { SystemZone } from "./time-zone.ts";
import { uninstallHandlers } from "./uninstall.ts";
import { updateHandlers } from "./update.ts";
import { usageSummaryHandlers } from "./usage-summary.ts";
import { cheapLearnerModel, createUserProfile } from "./user-profile.ts";
import { composeVault, maskingLogger, type VaultSetup, vaultSetupFromEnv } from "./vault.ts";
import { viewHandlers } from "./view.ts";
import { type ComposedVirtualScreen, composeVirtualScreen } from "./virtual-screen.ts";
import type { ComposedVm } from "./vm.ts";
import { type ComposedWebTools, composeWebTools, type WebToolsSetup } from "./web-tools.ts";
import { ensureWeeklyCardAutomation, withWeeklyCard } from "./weekly-card.ts";
import { composeWidgets } from "./widgets.ts";
import { composeWork, workSettings } from "./work.ts";
import { WORKFLOW_SETTING_KEYS } from "./workflow-settings.ts";

/**
 * Composition root for `psyched` (INT-1): the real agent loop, model router, Permission Broker,
 * audit log, memory, tasks, scheduler and notifier, wired into one Gateway. Package handlers are
 * mounted through `startGateway({ handlers })`; package events are forwarded to the event bus.
 */

/** How the agent reaches a model. */
export type ModelSetup =
  /** A ready provider: the scripted `FakeModelProvider` in CI, or anything implementing it. */
  | { provider: ModelProvider; model: ModelRef; utilityModel?: ModelRef }
  /** The model router over provider configs (hosted or local). */
  | {
      router: ModelRouterConfig;
      keys?: KeySource;
      model?: ModelRef;
      utilityModel?: ModelRef;
      /** Provider transport (tests replay recorded fixtures through this). */
      fetch?: typeof fetch;
      /** Subscription CLIs: their environment and bridge (tests run a fake CLI). */
      cli?: CliAdapterDeps;
      /**
       * Hosted keys are the vault's Gateway-owned `model-<provider>` items (`models.setKey`), the
       * packaged first run with no environment. Until a primary model is picked, turns answer
       * "No model is configured yet" instead of failing.
       */
      vaultKeys?: boolean;
    };

export interface ComposeOptions
  extends Omit<GatewayOptions, "agent" | "broker" | "memory" | "handlers"> {
  model: ModelSetup;
  /** Permission policy; defaults to the `permissions.policy` setting, then the package default. */
  policy?: PolicyConfig;
  clock?: Clock;
  timeZone?: string;
  /** Start the task worker pool and the scheduler (tests may drive them by hand). */
  background?: boolean;
  /** Worker pool poll interval (default 1 s). */
  taskPollMs?: number;
  /** Compaction policy for the loop (tests lower the threshold to exercise the memory flush). */
  compaction?: Partial<CompactionPolicy>;
  /**
   * Subsystems mounted on the composed services (INT-2: browser, connectors, channels). Each
   * returns handlers, tools (registered through `services.tools`) and start / stop hooks; a
   * part with a `relay` delivers approvals beyond the in-app surfaces (chat, the Mac helper).
   */
  parts?: ReadonlyArray<(services: ComposeServices) => Promise<ComposedPart> | ComposedPart>;
  /**
   * Stripe Link payments. Default: the guided setup (Settings → Credentials → Payments), with
   * `PSYCHE_LINK_CLI` as a dev override. A `wallet` replaces it (tests, the scenario runner);
   * `link` tunes the guided setup (tests). Mount payments here, not as a part: the guided setup
   * is always mounted and its `vault.payments.*` handlers would collide.
   */
  payments?: PaymentsSetup & { link?: LinkSetupOptions };
  /** Tunes the guided 1Password setup (tests inject a fake `op` runner). */
  onePasswordSetup?: OnePasswordSetupOptions;
  /**
   * Speech (S17: dictation, voice memos, read-aloud, voices) is always mounted; this sets its
   * process runner prefix (default: `speechSetupFromEnv`).
   */
  speech?: SpeechSetup;
  /** `exec_host` (security §5.4): where srt is, and the process driver (tests mock both). */
  execHost?: Partial<Pick<ExecHostDeps, "srt" | "driver" | "userHome">>;
  /** Terminal on the Host is always mounted; tests inject a fake PTY and limits. */
  hostTerminal?: HostTerminalOptions;
  /** Ask about my screen is always mounted; this swaps what takes the capture (default: the Mac helper). */
  screenAsk?: ScreenAskOptions;
  /** Psyche points: tests shorten the idle end and fake the Memory lines (the model is the primary). */
  points?: Pick<PointsOptions, "idleMs" | "memoryLines">;
  /**
   * Passkey assertions for approvals that require authentication (purchase, credential fill,
   * host exec; security §3.7). Helper (Touch ID) assertions go to the helper part's verifier.
   * Defaults to refusing every assertion.
   */
  presence?: PresenceVerifier;
  /**
   * The vault's key slot (S06). Default from the environment: `PSYCHE_VAULT_KEY_FILE` in server
   * mode, else the keychain through a connected Mac helper.
   */
  vault?: VaultSetup;
  /** Semantic search engines (S3; tests pass fakes so no model downloads or runs). */
  semanticEngines?: SemanticEngines;
  /** Memory recall's on-device model when it is already on disk (tests pass a fake). */
  memoryRecallLocal?: LocalEmbedderLoader;
  /** Built-in `web.search` / `web.fetch` network seams (#557; tests replay fixtures). */
  web?: WebToolsSetup;
}

/**
 * The broker only checks presence when it has a verifier. Fail closed: an assertion kind no
 * verifier handles (passkeys until S01 #79) is refused, so approvals that require
 * authentication cannot be answered with it.
 */
/** A quiet log still gets an anchor this often (on its next entry). */
const ANCHOR_INTERVAL_MS = 60 * 60_000;

const NO_PRESENCE: PresenceVerifier = { verify: async () => false };

export interface ComposedGateway {
  readonly gateway: Gateway;
  readonly db: PsycheDb;
  readonly loop: PsycheAgentLoop;
  /** E12 "From your other chats": the digests and the turn context provider. */
  readonly otherChats: OtherChats;
  /** The people and projects graph (#651). */
  readonly people: People;
  /** Everything memory: review, quarantine and the nightly pass (#1010). */
  readonly everything: Everything;
  /** Unified search (S1): the main index, its indexer and `search.query`. */
  readonly search: ComposedSearch;
  readonly broker: PsychePermissionBroker;
  readonly audit: HashChainAuditLog;
  readonly memory: SqliteMemoryStore;
  readonly tasks: SqliteTaskEngine;
  readonly pool: TaskWorkerPool;
  /** Background specialists' own pool (docs/agent/specialists-2026.md §4.5). */
  readonly specialistPool: TaskWorkerPool;
  /**
   * `tasks.update` for a specialist job (specialists §4.7): raise its budget or move its
   * deadline within the role's caps; a job paused on its budget re-queues.
   */
  readonly raiseSpecialistBudget: (
    taskId: string,
    patch: { tokens?: number; costUsd?: number; minutes?: number; deadline?: string },
  ) => Promise<Task>;
  readonly scheduler: SqliteScheduler;
  readonly notifier: PsycheNotifier;
  readonly proactive: ComposedProactive;
  /** The teaching loop (#679): feedback, lessons and their writers. */
  readonly teaching: ComposedTeaching;
  readonly provider: ModelProvider;
  readonly vault: Vault;
  /** Shared by the vault, its payment broker and every output path that masks. */
  readonly redactor: SecretRedactor;
  /** The built-in web search and page tools (provider state, in-process search). */
  readonly web: ComposedWebTools;
  readonly parts: readonly ComposedPart[];
  stop(reason?: string): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now() };

function providerFor(
  setup: ModelSetup,
  clock: Clock,
  db: PsycheDb,
  home: string,
  appleNode: AppleHelper,
): { provider: ModelProvider; model: ModelRef; utility?: ModelRef; router?: ModelRouter } {
  if ("provider" in setup) {
    return {
      provider: setup.provider,
      model: setup.model,
      ...(setup.utilityModel === undefined ? {} : { utility: setup.utilityModel }),
    };
  }
  // Subscription CLIs keep their sessions per working directory: one each under the home.
  const providers = setup.router.providers.map((p) =>
    isSubscriptionKind(p.kind) && p.workdir === undefined
      ? { ...p, workdir: join(home, "cli", p.id) }
      : p,
  );
  // Apple's on-device model (macOS 26, Apple Intelligence) is always routable as `apple/on-device`:
  // it costs nothing, holds no key, and answers "unavailable" until a Mac helper offers it.
  if (!providers.some((p) => p.kind === "apple")) providers.push({ id: "apple", kind: "apple" });
  const router = createModelRouter(
    { ...setup.router, providers },
    {
      clock,
      apple: { node: appleNode },
      ...(setup.cli === undefined ? {} : { cli: setup.cli }),
      // Tool-check verdicts (B4) survive restarts as `models.probe.<ref>` settings rows.
      probes: new KeyValueProbeStore(settingsKeyValue(db)),
      ...(setup.keys === undefined ? {} : { keys: setup.keys }),
      ...(setup.fetch === undefined ? {} : { fetch: setup.fetch }),
    },
  );
  return {
    router,
    provider: router,
    model: setup.model ?? "router/primary",
    utility: setup.utilityModel ?? "router/utility",
  };
}

/** A stored policy that fails validation must not stop the next boot; the defaults apply instead. */
function validPolicy(value: unknown, log: ComposeOptions["logger"]): PolicyConfig | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    compilePolicy(value as PolicyConfig);
    return value as PolicyConfig;
  } catch (err) {
    log?.log("warn", "stored permissions.policy is invalid; using the default policy", {
      code: PsycheError.from(err).code,
    });
    return undefined;
  }
}

/** The owner's IANA zone from their USER.md, if it says one. Never throws. */
function ownerTimeZoneAt(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8");
    return ownerTimeZone(content, parseLearned(content));
  } catch {
    return undefined;
  }
}

/** Methods that erase the owner's data and so must erase the pre-update snapshots too. */
export const PURGES_SNAPSHOTS = ["memory.reset", "memory.lessons.forgetAll"] as const;

export async function composeGateway(options: ComposeOptions): Promise<ComposedGateway> {
  const {
    model,
    policy,
    clock: clockOpt,
    timeZone: timeZoneOption,
    background = true,
    taskPollMs,
    compaction,
    parts: extraParts = [],
    speech: speechSetup,
    execHost: execHostSetup = {},
    presence = NO_PRESENCE,
    vault: vaultSetup,
    web: webSetup,
    ...gwOptions
  } = options;
  const clock =
    clockOpt ??
    (options.now ? { now: () => options.now?.().getTime() ?? Date.now() } : systemClock);
  const config = resolveConfig(gwOptions.env ?? process.env, gwOptions.config ?? {});
  // "Today", daily notes and automations follow the owner's timezone (USER.md's `Timezone`,
  // also filled from what they told Psyche); no zone there leaves the defaults as they were.
  // `let`: it is read again on wake and every hour, so a trip changes it without a restart.
  let timeZone = timeZoneOption ?? ownerTimeZoneAt(join(config.home, "workspace", "USER.md"));
  // One redactor for the vault, payments and logs: a value the vault handed out is masked
  // wherever it would be written.
  const redactor = new SecretRedactor();
  gwOptions.logger = maskingLogger(gwOptions.logger ?? createLogger(), redactor);
  // A database the caller passes in stays theirs to close; one compose opens, `stop()` closes.
  const ownsDb = gwOptions.db === undefined;
  const db =
    gwOptions.db ??
    (await openGatewayDb(config, () => new Date(clock.now()).toISOString(), gwOptions.logger));

  // Events from packages are published once the Gateway's bus exists.
  let bus: Gateway["bus"] | null = null;
  const publish = <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => {
    if (bus === null) return;
    bus.bumpStateVersion();
    bus.publish(event, payload, threadId);
  };

  // Signed anchors (security §15.1): the server's software key until the helper's Secure Enclave
  // key can sign; every 1,000 entries and at least hourly, with the head kept in security/.
  const auditStore = new FileAuditStore(join(config.home, "audit"));
  const anchorKey = SoftwareAnchorKey.open(
    config.home,
    (auditStore.tail()?.seq ?? -1) + 1,
    () => new Date(clock.now()),
  );
  const audit = createAuditLog({
    store: auditStore,
    clock,
    signer: anchorKey,
    verifier: anchorKey,
    anchorIntervalMs: ANCHOR_INTERVAL_MS,
    // Live vault values are masked in every entry, change diffs included.
    redact: (text) => redactor.redact(text),
  });
  // Every write to the owner's data reports here (audit.change.recorded drives the chat chip).
  const changes = createChangeRecorder({
    audit,
    redact: (text) => redactor.redact(text),
    publish,
  });
  // Parts that act on a setting the moment it changes (the separate desktop's reset).
  const settingListeners: ((c: { key: string; after: unknown }) => void)[] = [];
  // A security change that only narrowed (no card) leaves one low-key notice per device and hour,
  // so a compromised admin device cannot strip protections unseen.
  const tightenedAt = new Map<string, number>();
  const noticeTightened = (deviceId: string) => {
    const now = clock.now();
    const last = tightenedAt.get(deviceId);
    if (last !== undefined && now - last < 60 * 60 * 1000) return;
    tightenedAt.set(deviceId, now);
    // The display name is the device's own choice, so add the start of its id: a compromised
    // device cannot pass itself off as the owner's own by name alone.
    const named = keyActorParts(getDevice(db, deviceId))?.device;
    const device = named === undefined ? "none" : `${named} (${deviceId.slice(0, 8)})`;
    void notifier
      .notify({
        kind: "system",
        title: `Security settings were tightened from ${device === "none" ? "a device" : device}`,
        body: "This only reduced what Psyche is allowed to do, so no approval was needed. If that was not you, revoke the device in Settings → Devices.",
        message: {
          titleKey: "notice.security.tightened.title",
          bodyKey: "notice.security.tightened.body",
          params: { device },
        },
        route: "/settings/devices",
        dedupeKey: `security-tightened:${deviceId}:${Math.floor(now / (60 * 60 * 1000))}`,
      })
      .catch(() => undefined);
  };
  gwOptions.onThreadsImported = (e) => {
    void audit
      .append({
        kind: "threads.import",
        actor: { type: "device", deviceId: e.deviceId },
        data: { source: e.source, imported: e.imported, duplicates: e.duplicates },
      })
      .catch(() => undefined);
  };
  gwOptions.onSettingChanged = (c) => {
    void changes.record(settingChange(c));
    if (c.narrowing === true) noticeTightened(c.deviceId);
    for (const listener of settingListeners) listener(c);
  };
  // A restored backup's log is shorter than what this key anchored; the restore is audited with
  // the head it had (replayRevocations below consumes the marker).
  const restored = existsSync(join(config.home, RESTORE_MARKER));
  if (restored) {
    const previous = anchorKey.forgetHead();
    if (previous !== undefined) {
      void audit
        .append({
          kind: "audit.anchor_head.reset",
          actor: { type: "system" },
          data: {
            reason: "restore",
            previousHeadSeq: previous.seq,
            previousHeadHash: previous.hash,
          },
        })
        .catch(() => undefined);
    }
  }
  if (anchorKey.created) {
    void audit
      .append({
        kind: "audit.anchor_key.created",
        actor: { type: "system" },
        data: { keyId: anchorKey.keyId, sinceSeq: anchorKey.signingSinceSeq(), kind: "software" },
      })
      .catch(() => undefined);
  }
  // The security-state seal, before revocations are replayed or policy is read: what changed
  // outside the Gateway is undone now (docs/design/security-state-integrity-2026.md §7.1).
  const seal =
    gwOptions.securityState ??
    (await StateSeal.open(db, {
      home: config.home,
      now: () => new Date(clock.now()),
      log: gwOptions.logger,
      audit,
      restored,
    }));
  gwOptions.securityState = seal;
  // Revocations live outside the backup scope; a restored database cannot bring a revoked device
  // or grant back (S23 design-26). Replay before anything authenticates.
  const nowIso = () => new Date(clock.now()).toISOString();
  // Lines are signed with the seal key, so the running seal replays only the Gateway's own.
  const revocations = new RevocationLedger(config.home, nowIso, (line) =>
    seal.signRevocation(line),
  );
  const replay = replayRevocations(db.sqlite, config.home, nowIso);
  if (replay.unknownEpoch || replay.devicesRevoked + replay.grantsRevoked > 0) {
    void audit
      .append({
        kind: "revocations.replayed",
        actor: { type: "system" },
        data: { revocationReplay: { ...replay } },
      })
      .catch(() => undefined);
  }
  // Remote desktop clients' own OS notifications (`device:<deviceId>`, remote Gateway R2).
  const deviceNotes = new DeviceNotifications();
  const ownerRouting = notifierRouting(db);
  // A notice's own buttons ("Keep it" on held launch config): parts register their actions.
  const notificationActions = new NotificationActions();
  const notifier = new PsycheNotifier({
    onAction: (n, actionId) => notificationActions.run(n, actionId),
    // Tables come from @psyche/db's migration ledger (202610190200_notifications_init).
    store: new SqliteNotificationStore(db.sqlite),
    clock,
    // Quiet hours (#953): a getter, so a change in Settings applies to the next notification.
    // The connected clients that opted in are read per notification, so a reconnect applies.
    routing: () => ({ ...ownerRouting(), deviceTargets: deviceNotes.targets() }),
    adapters: [createDeviceSurface({ send: (id, toast) => deviceNotes.send(id, toast) })],
  });
  // Every security alert reaches the owner's inbox: the desktop, the Mac's notification and the
  // phone (the in-app banner reads `security.state.get`). An open alert raised again (one
  // "changed outside" alert counts repeats) updates its notification at most every 10 minutes,
  // and only its first delivery may break through quiet hours.
  // Based on the alert's sealed `notified_at`, so a restart neither resets the limit nor lets a
  // repeat break through quiet hours again.
  const notifyAlert = (alert: SecurityAlert) => {
    const decision = alertNotifyDecision(alert, seal.alerts.notifiedAt(alert.id), clock.now());
    if (!decision.send) return;
    const { title, body, message } = alertNotice(alert);
    void notifier
      .notify({
        kind: "system",
        title,
        body,
        message,
        route: "/settings/devices",
        dedupeKey: `security-alert:${alert.id}`,
        breakQuietHours: decision.breakQuietHours,
      })
      .then(
        () => seal.alerts.markNotified(alert.id),
        () => undefined,
      );
  };
  seal.alerts.onAlert(notifyAlert);
  for (const alert of seal.alerts.unnotified()) notifyAlert(alert);
  // The old "Files on this Mac" connector is File access now: move its folder into the grants.
  await migrateFilesConnector(db, config.home, folderAccessEnv(config.home));
  // One chat per automation: runs that each opened a chat of their own are filed under it.
  groupAutomationRunThreads(db);
  const storedPolicy = validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger);
  const tokens = new ApprovalTokens();
  const relays: ApprovalRelay[] = [];
  const parts: ComposedPart[] = [];
  const presenceByKind = new Map<string, PresenceVerifier>();
  const presenceReady: (() => boolean)[] = [];
  const presenceCanVerify: (() => boolean)[] = [];
  // The localhost rule (security §3.10) needs OS probes a part supplies (the browser's dev
  // preview); until one does, no loopback origin is the owner's project.
  let localProject: LocalProjectVerifier = DENY_ALL_LOOPBACK;
  // Inbound channel decisions (filled by the channels part) back the broker's reply authority.
  const channelConversations = new ChannelConversations();
  const attention = new OwnerAttention(() => clock.now());
  // `Always allow` on a folder request lands in Settings → File access (permissions.policy.folders).
  const persistFolder = async (entry: FolderGrantEntry) => {
    // A pick is already its real path: that is where the grant was made (`grantedRootRefused`).
    const next = withFolder(
      validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger) ?? {},
      { ...entry, real: entry.path },
    );
    const saved = setSetting(db, "permissions.policy", next);
    rawBroker.setPolicy(hostPolicy(next, db));
    publish("settings.changed", { entries: [saved] });
  };
  // Revoking an `always` folder (Settings' access list) drops it from the same policy list.
  const forgetFolder = async (path: string): Promise<boolean> => {
    const current =
      validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger) ?? {};
    const folders = current.folders ?? [];
    const kept = folders.filter((f) => f.path !== path);
    if (kept.length === folders.length) return false;
    const saved = setSetting(db, "permissions.policy", { ...current, folders: kept });
    rawBroker.setPolicy(hostPolicy({ ...current, folders: kept }, db));
    publish("settings.changed", { entries: [saved] });
    return true;
  };
  // A Settings folder granted before real paths were recorded: the first real path the broker
  // saw for it (while it still counted) is stored with it, so a later move survives a restart.
  // With `by`, the owner confirmed a moved folder in Settings: reported like the security setting
  // change a policy write is (change record, setting listeners).
  const recordFolderReal = (path: string, real: string, by?: { deviceId: string }) => {
    const current = validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger);
    const next = current === undefined ? undefined : withRecordedReal(current, path, real);
    if (next === undefined) return;
    const before = getSetting(db, "permissions.policy")?.value;
    const saved = setSetting(db, "permissions.policy", next);
    rawBroker.setPolicy(hostPolicy(next, db));
    publish("settings.changed", { entries: [saved] });
    if (by !== undefined) {
      try {
        gwOptions.onSettingChanged?.({
          key: "permissions.policy",
          before,
          after: next,
          deviceId: by.deviceId,
        });
      } catch {
        // Reporting never fails the change.
      }
    }
  };
  // The identity (volume and inode) of a Settings folder, stored once so a rename can be offered
  // back to the owner as "Reconnect <name>?" (never re-pointed silently).
  const recordFolderRef = (path: string, ref: { dev: string; ino: string; birth: string }) => {
    const current = validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger);
    const next = current === undefined ? undefined : withRecordedRef(current, path, ref);
    if (next === undefined) return;
    const saved = setSetting(db, "permissions.policy", next);
    rawBroker.setPolicy(hostPolicy(next, db));
    publish("settings.changed", { entries: [saved] });
  };
  // The owner's tap on "Reconnect <name>?": the broker has already run every grant check.
  const repointFolder = (
    moves: readonly { from: string; to: string }[],
    by: { deviceId: string },
  ) =>
    repointFolders(
      {
        read: () => ({
          value: getSetting(db, "permissions.policy")?.value,
          policy: validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger),
        }),
        write: (next) => setSetting(db, "permissions.policy", next),
        applied: (next, saved) => {
          rawBroker.setPolicy(hostPolicy(next, db));
          publish("settings.changed", { entries: [saved as never] });
        },
        report: (change) =>
          gwOptions.onSettingChanged?.({
            key: change.key,
            before: change.before as never,
            after: change.after,
            deviceId: change.deviceId,
          }),
      },
      moves,
      by,
    );
  let deferredResumeRef: DeferredResume | undefined;
  // The model router is composed after the broker; the exec reviewer reads it when it runs.
  const execReviewRouter: { current?: ModelRouter } = {};
  const rawBroker = new PsychePermissionBroker({
    folderAccess: {
      env: () => folderAccessEnv(config.home),
      // A folder shown to the separate desktop is judged by the container's own, wider list.
      separateDesktopEnv: () => separateDesktopFolderEnv(config.home),
      persist: persistFolder,
      remove: forgetFolder,
      recordReal: recordFolderReal,
      recordRef: recordFolderRef,
      repoint: repointFolder,
    },
    channelConversations: (ref) => channelConversations.get(ref),
    // Spaces S2: "Allow in this Space" and the Space folders a run in a Space may use.
    spaces: spaceFolderSource(db, (spaceId) =>
      publish("space.updated", { spaceId, changed: ["folders"] }),
    ),
    approvers: {
      async device(deviceId) {
        seal.ensure();
        const d = getDevice(db, deviceId);
        if (d === undefined) return undefined;
        // Untrusted security records: only what the seal still trusts this device with.
        const authz = seal.authorizeDevice(d);
        const scopes = authz.ok ? authz.scopes : [];
        // The mac helper answers only through its part's relay, on the `notification` surface.
        const viaPart = parts.some((p) => p.approver?.(deviceId) === true);
        return {
          scopes: viaPart && authz.ok ? [...scopes, "operator.approvals" as const] : scopes,
          ...(d.revokedAt || !authz.ok ? { revoked: true } : {}),
        };
      },
      // Channel owners (S10) come from the channels part, when one is mounted.
      async isOwnerSender(channel, senderId) {
        for (const r of relays) {
          if ((await r.isOwnerSender(channel, senderId)) === true) return true;
        }
        return false;
      },
    },
    // A phone or tablet taps a device-only card on its own `device:<deviceId>` surface (a plain tap,
    // owner's decision 2026-11-09). Only paired, unrevoked operator devices the seal still trusts
    // with `operator.approvals`; the desktop and web have their own surfaces, nodes never answer.
    deviceSurfaces: () => {
      seal.ensure();
      return listDevices(db)
        .filter((d) => d.pairedAt !== null && !d.revokedAt && d.role !== "node")
        .filter((d) => surfaceOf(db, d.id).startsWith("device:"))
        .filter((d) => {
          const authz = seal.authorizeDevice(d);
          return authz.ok && authz.scopes.includes("operator.approvals");
        })
        .map((d) => surfaceOf(db, d.id));
    },
    store: sealedPermissionStore(new SqlitePermissionStore(db.sqlite), seal),
    audit,
    notifier,
    clock,
    revocations,
    // An unattended run's card is announced by the automation digest, not by its own notice.
    deferredApproval: async (a) => {
      const taskId = a.requestedBy.taskId;
      return isUnattendedTask(taskId == null ? undefined : await tasks.get(taskId));
    },
    // A set-aside card is approvable only when its automation can run again (deferred-resume.ts).
    // The scheduler is composed later; until then nothing can resume, so nothing is approved.
    canResume: async (a) => (await deferredResumeRef?.canResume(a)) === true,
    // A restart revoked an approved set-aside card: say the resume will not happen.
    onSetAsideRevoked: (a, how) => deferredResumeRef?.revokedAtRestart(a, how),
    sameAutomation: (a, taskId) => deferredResumeRef?.sameAutomation(a, taskId) === true,
    psycheHome: config.home,
    presence: {
      // Presence fails closed while the security records are untrusted; the registered keys
      // and passkeys it checks against are verified first.
      verify: async (assertion, challenge, deviceId) => {
        seal.ensure();
        if (seal.untrusted() !== null) return false;
        return (presenceByKind.get(assertion.kind) ?? presence).verify(
          assertion,
          challenge,
          deviceId,
        );
      },
    },
    localProject: { check: (url) => localProject.check(url) },
    // The agent never acts on Psyche's own UI (prohibitions `gateway_origin`): every origin it is served on.
    gatewayOrigins: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      ...config.allowedOrigins.filter((o) => /^https?:\/\//.test(o)),
    ],
    policy: hostPolicy((policy ?? storedPolicy) as PolicyConfig | undefined, db),
    // Auto mode's exec reviewer (owner's decision 2026-11-23: Haiku on the owner's own key, via
    // the `utility` role). Only the router's own cheap or picked utility model, and only one the
    // Auto-mode allowlist accepts: never a paid fallback to the primary, never a local model.
    // Without a router (tests, a fixed provider) there is no reviewer, so every command asks.
    execReviewer: new ModelExecReviewer({
      provider: () => execReviewRouter.current,
      model: () => {
        const r = execReviewRouter.current;
        const ref = r?.utilityRef();
        return ref !== undefined && r?.allowsAutoMode(ref) === true ? ref : undefined;
      },
      redact: (text) => redactor.redact(text),
      neutralise: (text) => defangFence(text),
    }),
  });
  // B3: on a headless Linux Host a payment needs a passkey; without one it fails before a card
  // nobody could answer is raised (compose/payment-presence.ts). Other approvals are untouched.
  // The service env's switch, read once now (the agent cannot set it), else B0's logind answer.
  const passkeyForced = passkeyPresenceForced(gwOptions.env ?? process.env);
  const graphical = hostGraphicalSession();
  const broker = withPaymentPresence(withRelay(tokens.wrap(rawBroker), relays, gwOptions.logger), {
    passkeyOnly: async () =>
      passkeyForced || (await headlessLinuxHost(process.platform, graphical)),
    hasPasskey: () => presence !== NO_PRESENCE || countActivePasskeys(db) > 0,
  });
  // The teaching loop (#679) reads approval answers as implicit feedback; set once composed.
  let teachingRef: ComposedTeaching | undefined;
  // Executors (vault fills, the browser's mid-run gate, sandbox secrets) request approvals
  // outside the loop, which announces only its own: they announce theirs here.
  const executorBroker = announcing(broker, publish);
  // Background Task runs have no session controller to announce their cards: the loop's handle
  // announces those (requestedBy.taskId set); chat turns keep the controller's announcement.
  // A specialist's approvals also carry its parent run and role (specialists §4.4).
  const loopBroker = announcing(
    withSpecialistContext(broker, (id) => tasks.get(id)),
    publish,
    (a) => a.requestedBy.taskId != null,
  );
  broker.subscribe((e) => {
    if (
      e.type === "approval.decided" ||
      e.type === "approval.expired" ||
      e.type === "approval.invalidated"
    ) {
      tokens.forget(e.approval.id);
    }
    if (
      e.type === "approval.decided" ||
      e.type === "approval.expired" ||
      e.type === "approval.invalidated"
    ) {
      publish(
        "approval.updated",
        { approval: e.approval },
        e.approval.requestedBy.threadId ?? undefined,
      );
      if (e.type === "approval.decided") teachingRef?.observeApproval(e.approval);
    } else if (e.type === "receipt.created") {
      publish("receipt.created", { receipt: e.receipt });
    }
  });
  // One digest for every automation card waiting on the owner (see deferred-digest.ts).
  const deferredDigest = new DeferredDigest({
    broker,
    notifier,
    clock,
    isDeferred: async (a) => {
      const taskId = a.requestedBy.taskId;
      return isUnattendedTask(taskId == null ? undefined : await tasks.get(taskId));
    },
  });
  broker.subscribe((e) => {
    if (
      e.type === "approval.created" ||
      e.type === "approval.decided" ||
      e.type === "approval.expired" ||
      e.type === "approval.invalidated"
    ) {
      void deferredDigest.refresh().catch(() => undefined);
    }
  });

  const vault = composeVault(
    {
      home: config.home,
      db,
      permissions: executorBroker,
      audit,
      clock,
      publish,
      redactor,
      // Removed items stay removed across a restore (design-26), like devices and grants.
      removals: {
        record: (id) => revocations.recordVaultItem(id),
        ids: () => revocations.vaultItemIds(),
      },
    },
    {
      ...(vaultSetup ?? vaultSetupFromEnv(gwOptions.env ?? process.env)),
      // credentials.onePassword (G10); a test's own source wins.
      ...(vaultSetup?.onePassword === undefined && config.onePassword
        ? { onePassword: config.onePassword }
        : {}),
      // credentials.bitwarden (G11), the same way.
      ...(vaultSetup?.bitwarden === undefined && config.bitwarden
        ? { bitwarden: config.bitwarden }
        : {}),
    },
  );

  // Environment keys win over the vault and are masked wherever the Gateway logs.
  const keyEnv = gwOptions.env ?? process.env;
  for (const id of API_KEY_IDS) {
    const k = envKey(keyEnv, id);
    if (k !== undefined) redactor.add(k, { sticky: true });
  }
  const vaultKeys = "router" in model && model.vaultKeys === true;
  const modelSetup: ModelSetup = vaultKeys
    ? { ...model, keys: vaultModelKeys(() => vault.vault, keyEnv) }
    : model;
  // Bound below, once the Gateway's node registry exists.
  const appleHelper: { current: AppleHelper } = { current: () => undefined };
  const routed = providerFor(modelSetup, clock, db, config.home, () => appleHelper.current());
  const { model: modelRef, utility, router } = routed;
  if (router !== undefined) execReviewRouter.current = router;
  const provider = vaultKeys && router !== undefined ? untilPrimaryPicked(router) : routed.provider;
  // Tells the owner's devices a key was swapped or removed. It names the provider and the device
  // (as quoted data, see describeKeyActor), never the key.
  const noticeKeyChange = ({
    id,
    action,
    deviceId,
  }: {
    id: keyof typeof API_KEY_LABEL;
    action: "changed" | "removed";
    deviceId: string;
  }) => {
    const what = `${API_KEY_LABEL[id]} ${id === "brave" ? "key" : "API key"}`;
    const actor = keyActorParts(getDevice(db, deviceId));
    void notifier
      .notify({
        kind: "system",
        message: {
          titleKey: "notice.apiKey.changed.title",
          bodyKey: "notice.apiKey.changed.body",
          params: {
            provider: API_KEY_LABEL[id],
            kind: id === "brave" ? "brave" : "api",
            action,
            device: actor?.device ?? "none",
            platform: actor?.platform ?? "",
            paired: actor?.paired ?? "none",
          },
        },
        title: `The ${what} was ${action}`,
        body: `${action === "changed" ? "Changed" : "Removed"} from ${describeKeyActor(getDevice(db, deviceId))}. If that was not you, revoke the device in Settings → Devices.`,
        route: "/settings/devices",
      })
      .catch(() => undefined);
  };
  const modelSettings: ModelSettingsSetup = {
    db,
    clock,
    providers: "router" in modelSetup ? modelSetup.router.providers : [],
    ...(router === undefined ? {} : { router }),
    ...("router" in modelSetup && modelSetup.keys !== undefined ? { keys: modelSetup.keys } : {}),
    ...("router" in modelSetup && modelSetup.fetch !== undefined
      ? { fetch: modelSetup.fetch }
      : {}),
    ...("router" in modelSetup && modelSetup.cli?.env !== undefined
      ? { cliEnv: modelSetup.cli.env }
      : {}),
    ...("provider" in modelSetup ? { fixedModel: modelSetup.model } : {}),
    ...(vaultKeys
      ? {
          vaultKeys: {
            has: (id: string) =>
              hasModelKey(vault.vault, id) ||
              (isHostedModelKind(id) && envKey(keyEnv, id) !== undefined),
            // The same notice as keys.set / keys.clear: a replace or removal tells the owner, a
            // first set or a no-op clear does not, whichever method wrote the item.
            store: async (id: HostedModelKind, key: string, deviceId?: string) => {
              const replaced = hasModelKey(vault.vault, id);
              await storeModelKey(vault.vault, id, key);
              if (replaced && deviceId !== undefined) {
                noticeKeyChange({ id, action: "changed", deviceId });
              }
            },
            clear: async (id: HostedModelKind, deviceId?: string) => {
              const removed = await clearModelKey(vault.vault, id);
              if (removed && deviceId !== undefined) {
                noticeKeyChange({ id, action: "removed", deviceId });
              }
              return removed;
            },
          },
        }
      : {}),
  };
  await restoreModelSettings(modelSettings);
  const modelPins = modelPinsFor(provider);
  // Where the graph and memory tables live: `psyche.sqlite` itself unless `memory.encrypt` is on,
  // then the encrypted `state/memory.sqlite`, opened once its key arrives (EM9b).
  const memoryDb = resolveMemoryStore({
    db,
    home: config.home,
    wrapper: vault.wrapper,
    slot: vault.slot,
    derived: new DerivedKeyStore(vault.helper),
    escrow: vault.vault,
    ...(gwOptions.logger === undefined
      ? {}
      : { log: (msg: string) => gwOptions.logger?.log("warn", msg) }),
  });
  const memoryLate = memoryDb.late;
  // The people graph is composed once the tool registry exists; card edits reach it from here.
  let people: People | undefined;
  // Forget's trace scrub: a queued, resumable pass. A run in progress (the loop's view) keeps the
  // final pass waiting until it has ended.
  const traceScrub = new TraceScrubWorker({
    db,
    activeRuns: () =>
      (
        db.sqlite
          .prepare(
            "SELECT id, thread_id FROM runs WHERE status IN ('running', 'awaiting_approval', 'awaiting_input')",
          )
          .all() as { id: string; thread_id: string }[]
      )
        .filter((r) => loop.isActive(r.thread_id))
        .map((r) => r.id),
    log: (level, message) => gwOptions.logger?.log(level, message),
  });
  const memory = await createMemoryStore({
    db,
    ...(memoryLate === undefined ? {} : { sqlite: memoryDb.sqlite, deferInit: true }),
    workspaceDir: join(config.home, "workspace"),
    clock,
    ...(timeZone === undefined ? {} : { timeZone }),
    approvals: brokerApprovalCheck(broker),
    audit,
    onChange: (c) => void changes.record(memoryChange(c)),
    // Every forget (the RPC and the agent's tool both come here) cuts the forgotten words out of
    // the saved chats and the run traces. The trace pass is queued first and runs in the
    // background; the transcript pass is short and synchronous. A failure in either is logged and
    // never fails the forget, which has already committed.
    onForget: ({ subject }) => {
      try {
        traceScrub.enqueue(subject);
      } catch {
        gwOptions.logger?.log("warn", "forget could not queue the run-trace scrub");
      }
      try {
        gatewayRef?.context.messageScrub.heal?.();
      } catch {
        gwOptions.logger?.log("warn", "forget could not cut the words from saved chats");
      }
    },
    flush: { provider, model: utility ?? modelRef },
    onEvent: (e) => {
      if (e.event === "memory.file.changed") {
        // Run trace §4.2: the writing call becomes the trace step; the call id stays internal.
        const { toolCallId, ...payload } = e.payload;
        const sink = gatewayRef?.context.runTrace;
        const stepId =
          payload.runId === undefined || toolCallId === undefined
            ? undefined
            : sink?.memoryChanged(payload.runId, toolCallId, payload.path);
        publish(e.event, { ...payload, ...(stepId === undefined ? {} : { stepId }) });
      } else {
        publish(e.event, e.payload as never);
      }
      people?.onMemoryEvent(e);
    },
  });
  if (memoryLate !== undefined) {
    // First-run setup and the initial index wait for the encrypted file; until then memory reads
    // are empty and writes fail with `unavailable` (never written to the plain file).
    memoryLate.whenReady(() => {
      memory.init().catch((err: unknown) => {
        gwOptions.logger?.log("warn", "memory store setup failed", { error: String(err) });
      });
    });
    parts.push({ start: () => memoryDb.start(), stop: () => memoryDb.stop() });
  }

  const tasks = new SqliteTaskEngine({ db, clock });
  tasks.subscribe((e) => {
    const threadId =
      e.event === "task.updated" ? (e.payload.task.threadId ?? undefined) : undefined;
    publish(e.event, e.payload as never, threadId);
  });
  notifier.subscribe((e) => {
    const { event, payload } = toGatewayEvent(e);
    publish(event, payload as never);
  });

  const registry = new AgentToolRegistry();
  // P9 file tools (#49); the executors re-check the live granted folders behind the broker.
  const documents: DocumentsHandle = {};
  for (const tool of fileTools({
    documents: documentBridge(documents),
    // No folder list means nothing is granted (#287), never "only the broker checks".
    // This conversation's "Allow once" folders count beside the owner's (request_folder_access).
    folders: (scope) => [
      ...rawBroker.grantedFolders(),
      ...(scope === undefined ? [] : rawBroker.liveSessionFolders(scope.threadId, scope.runId)),
    ],
    protectedRoots: () => protectedRoots(config.home),
    ownDirs: () => ownWorkdirs(config.home),
    carveOuts: () => runCarveOuts(),
    writeProtectedRoots: () => writeProtection(),
    launchConfigLinks: launchConfigLinks(() => rawBroker.grantedFolders()),
    onChange: (c) => void changes.record(fileChange(c)),
  }))
    registry.register(tool);
  // Security §3.13: one way to ask for whatever a denial or error named as missing (a folder,
  // exec_host, a connector group set to deny, a connector, macOS access, the sandbox).
  const savePolicy = (next: PolicyConfig) => {
    const entry = setSetting(db, "permissions.policy", next);
    rawBroker.setPolicy(hostPolicy(next, db));
    publish("settings.changed", { entries: [entry] });
  };
  // The Gateway's one srt lookup (`PSYCHE_SRT_PATH`, `exec.srtPath`, then found on this Mac):
  // host commands and every part that runs under srt share it (`services.srt`).
  const srt: SrtResolver = createSrtResolver({ db }, gwOptions.env ?? process.env);
  const execHostSrt = execHostSetup.srt ?? srt;
  // VM mode's part, once composed: on Windows srt's features run in its guest (the sandbox PC).
  const vmPart = () => parts.find((p): p is ComposedVm => "runner" in p && "workspaceFor" in p);
  registry.register(
    requestPermissionTool({
      broker: executorBroker,
      surfaces: ["desktop", "web"],
      folderEnv: () => folderAccessEnv(config.home),
      grantedFolders: (threadId, runId) => [
        ...rawBroker.grantedFolders(),
        ...rawBroker.liveSessionFolders(threadId, runId),
      ],
      execHostEnabled: () => rawBroker.policy.exec?.execHostEnabled === true,
      enableExecHost: async () => {
        const current =
          validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger) ?? {};
        savePolicy({ ...current, exec: { ...(current.exec ?? {}), execHostEnabled: true } });
      },
      allowConnectorAsk: async (connector, group) => {
        // `apple.<app>` (direct helper calls) names every record of that app (#747).
        const records = (await connectorsPart?.registry.list().catch(() => [])) ?? [];
        const ids = records
          .filter((r) => r.id === connector || appleConnectorKey(r.type) === connector)
          .map((r) => r.id);
        for (const id of ids) {
          const key = `${CONNECTOR_MATRIX_PREFIX}${id}`;
          const current = getSetting(db, key)?.value;
          const matrix =
            typeof current === "object" && current !== null && !Array.isArray(current)
              ? (current as Record<string, unknown>)
              : {};
          // Deny becomes ask, never allow: every call of the group still asks.
          const entry = setSetting(db, key, { ...matrix, [group]: "ask" });
          publish("settings.changed", { entries: [entry] });
        }
        return ids.length > 0;
      },
      connectorConnected: async (connector) => {
        const record = await connectorsPart?.registry.get(connector).catch(() => undefined);
        return record?.status === "connected";
      },
      // On Windows the sandbox is the sandbox PC: ready when its guest can run srt's features.
      sandboxReady: async () =>
        usesSandboxPc()
          ? vmPart()?.runner.canIsolate() === true
          : "path" in (await execHostSrt.resolve()),
    }),
  );
  // Shell and files on a paired machine (linux-helper-only §5, H5): grants per machine and
  // conversation, reached through H3's registry (`nodes.machine`), never `nodes.invoke`.
  const machines = machineDirectory(
    db,
    (deviceId) => gatewayRef?.context.nodes.machine(deviceId)?.client,
  );
  const machineFolders = new MachineFolderGrants();
  registry.register(
    machineFilesTool({
      directory: machines,
      grants: machineFolders,
      broker: executorBroker,
      surfaces: ["desktop", "web"],
      library: machineLibrary(db, config.home),
      audit,
    }),
  );
  // "Run commands on this Mac" (security §5.4): registered always, so a call while it is off is
  // denied with a request the owner can answer; the broker keeps it off until they turn it on.
  registry.register(
    execHostTool({
      machine: machineExec({
        directory: machines,
        grants: machineFolders,
        broker: executorBroker,
        vault: vault.vault,
        audit,
        notifier,
      }),
      broker: executorBroker,
      vault: vault.vault,
      folders: (threadId, runId) => [
        ...rawBroker.grantedFolders(),
        ...rawBroker.liveSessionFolders(threadId, runId),
      ],
      // One live look per root at a time, bounded: a hung mount does not fill the libuv pool.
      lookRoot: (path) => rawBroker.lookRootNow(path),
      srt: execHostSrt,
      home: config.home,
      audit,
      ...(execHostSetup.driver === undefined ? {} : { driver: execHostSetup.driver }),
      ...(execHostSetup.userHome === undefined ? {} : { userHome: execHostSetup.userHome }),
    }),
  );
  // E12 cross-thread awareness: registered only while the owner has turned it on.
  let gatewayRef: Gateway | null = null;
  const crossThread = crossThreadToggle(
    (tool) => registry.register(tool),
    threadTools({ db, gateway: () => gatewayRef }),
  );
  crossThread.sync(getSetting(db, CROSS_THREAD_SETTING)?.value);
  // The owner's phone, while it offers `location.current` (it is off by default on the phone).
  registry.register(phoneLocationTool({ nodes: () => gatewayRef?.context.nodes }));
  // People and projects (#651): handlers, owner-only agent tools, search docs, the nightly pass.
  people = composePeople({
    db,
    ...(memoryLate === undefined ? {} : { memorySqlite: memoryDb.sqlite }),
    clock,
    memory,
    provider,
    model: utility ?? modelRef,
    publish: (event, payload) => publish(event, payload as never),
    register: (tool) => registry.register(tool),
    ownerName: async () => readHeader((await memory.readFile("USER.md"))?.content ?? "").name,
    // Tests drive `people.poll()` by hand.
    ...(background ? {} : { pollIntervalMs: 0, afterRunDelayMs: 0 }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  // A remote desktop's OS notifications about a promise follow the same scrub.
  deviceNotes.bindPromiseVisibility(people.loopVisibility);
  // Everything memory (#1010): review and quarantine handlers, and the nightly pass.
  const everything = composeEverything({
    db,
    ...(memoryLate === undefined
      ? {}
      : { memorySqlite: memoryDb.sqlite, memoryReady: () => memoryLate.ready }),
    clock,
    graph: people.graph,
    home: config.home,
    provider,
    utility: utility ?? modelRef,
    timeZone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    card: async (path) => (await memory.readFile(path))?.content,
    isCloudRef: (ref) => isCloudRef(ref),
    // Raw passages for an answer: the index and the same per-source rules the agent's search has.
    passageIndex: () => {
      const sources = searchRef?.sources;
      return searchRef === undefined || sources === undefined
        ? undefined
        : {
            index: searchRef.index,
            document: (id) => sources.document(id, "agent"),
            cloudBlocked: () => sources.cloudBlocked(),
          };
    },
    embedder: () => {
      const e = searchRef?.embedder();
      return e === undefined ? undefined : asMemoryEmbedder(e);
    },
    // One nightly budget: the people graph's model pass runs inside this pass's window, on the
    // tokens it leaves, for the people it did not read about (the graph's own nightly step then
    // skips its model pass).
    graphModelPass: (left, covered) => people.modelPass(left, covered),
    announce: (card) => void proactive.feed.postNotice({ ...card, reason: "memory learned" }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  people.useModelWindow(() => everything.ownsGraphPass());
  // Relationship nudges: off until the owner consents; cards are silent Feed posts.
  const nudges = composeNudges({
    db,
    clock,
    graph: people.graph,
    em: everything.store,
    model: () => everything.answerModel(),
    timeZone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    post: (card) =>
      void proactive.feed.postNotice({
        title: card.title,
        bodyMd: card.bodyMd,
        reason: "relationship nudge",
        refs: { nudgeId: card.nudgeId },
      }),
    ...(background ? {} : { refreshMs: 0 }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  // Quiet email threads: read through the connected mail tools; nothing is sent.
  const mailFollowups = composeMailFollowups({
    db,
    clock,
    tools: () => connectorToolLookup(registry),
    timeZone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  const calls = new CallContexts();
  const ownPorts = createOwnPorts();
  // `gateway.prepareUpdate` closes this door to new chat turns and tasks; the task pools and the
  // session controller check it. Recordings are counted by the parts that own them.
  const updateGate = gwOptions.updateGate ?? new UpdateGate();
  const busySources = new BusySources();
  const browserAvailability: BrowserAvailability = {};
  ownPorts.add(config.port, "gateway (configured)");
  const pageReads = new PageReadHub();
  const services: ComposeServices = {
    memoryStore: memoryDb,
    memory,
    documents,
    pageReads,
    busy: busySources,
    db,
    srt,
    clock,
    home: config.home,
    approvalTokens: tokens,
    broker: executorBroker,
    rawBroker,
    notificationActions,
    channelConversations,
    attention,
    audit,
    notifier,
    // A Task's browser / computer-use call waits for the owner instead of failing (#272).
    tools: parkWhenUnwatched(calls.adopt(registry), {
      attention,
      taskOf: (callId) => calls.get(callId)?.taskId,
      notify: (taskId, tool) => {
        notifier
          .notify({
            kind: "input_needed",
            title: "A task is waiting for you",
            body: `Paused before ${tool} on a sensitive app or site until you are back in Psyche.`,
            message: {
              titleKey: "notice.attention.paused.title",
              bodyKey: "notice.attention.paused.body",
              params: { tool },
            },
            taskId,
            dedupeKey: `attention:${taskId}`,
            route: `/tasks/${taskId}`,
          })
          .catch(() => undefined);
      },
    }),
    calls,
    publish,
    vault: vault.vault,
    redactor,
    ownPorts,
    browserAvailability,
    rateLimits: createRateLimits(config.rateLimits, {
      audit,
      clock,
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  };
  const skills = composeSkills();
  const partFactories = [
    composeComputer,
    // Linux virtual screen (watch pane methods); inert without a Linux helper.
    composeVirtualScreen,
    // The separate desktop (Linux only; nothing runs until a Task asks for it).
    composeSeparateDesktop({
      onSettingChanged: (listener) => void settingListeners.push(listener),
      egress: () =>
        parts.find((p): p is ComposedSandbox => "runner" in p && "egress" in p && "track" in p)
          ?.egress,
    }),
    skills.part,
    composeSpeech(speechSetup ?? speechSetupFromEnv(gwOptions.env)),
    composeDictation(),
    // Teach by showing in a Mac app (J8 phase 2): the desktop shell only (compose/teach-app.ts).
    composeTeachApp(),
    composeDeviceNotifications(deviceNotes),
    // A terminal on the Host (remote-gateway design §4.2, R4): admin + presence, per device.
    hostTerminalPart(gwOptions.hostTerminal),
    composeScreenAsk(gwOptions.screenAsk),
    // Psyche points, you click (psyche-points-2026 W7): the desktop shell only, off until the owner turns it on.
    composePoints({ provider, model: modelRef, ...gwOptions.points }),
    // Canvas artifacts (chat-experience-2026 §4.3): the version store and `artifact.*` tools.
    composeArtifacts,
    // Generative-UI widgets (generative-ui-2026): snapshots by id; tools arrive in P3.
    composeWidgets,
    // Guided 1Password setup (Settings → Credentials): the CLI integration of the 1Password app.
    composeOnePasswordSetup({
      ...gwOptions.onePasswordSetup,
      externalConfigured:
        (vaultSetup?.onePassword ?? config.onePassword ?? undefined) !== undefined,
    }),
    composeGuidedPayments(
      gwOptions.payments ?? paymentsSetupFromEnv(gwOptions.env ?? process.env),
      gwOptions.payments?.link,
    ),
    // Web passkeys (issue #79): unavailable until gateway.publicOrigin is an https origin. A
    // caller-supplied `presence` verifier takes the passkey role instead.
    ...(presence === NO_PRESENCE ? [composePasskeys({ publicOrigin: config.publicOrigin })] : []),
    ...extraParts,
  ];
  let localProjectSupplied = false;
  for (const factory of partFactories) {
    const part = await factory(services);
    parts.push(part);
    // Two parts deciding the same security question would leave one silently ignored: refuse
    // at compose time instead.
    const duplicate =
      part.presence !== undefined && presenceByKind.has(part.presence.kind)
        ? `presence verifier for "${part.presence.kind}"`
        : part.localProject !== undefined && localProjectSupplied
          ? "localhost verifier (localProject)"
          : undefined;
    if (duplicate !== undefined) {
      for (const p of parts) await Promise.resolve(p.stop?.()).catch(() => undefined);
      throw new PsycheError("invalid_params", `two composed parts supply a ${duplicate}`);
    }
    if (part.relay !== undefined) relays.push(part.relay);
    if (part.presence !== undefined) {
      presenceByKind.set(part.presence.kind, part.presence.verifier);
      presenceReady.push(part.presence.ready ?? (() => true));
      presenceCanVerify.push(part.presence.canVerify ?? part.presence.ready ?? (() => true));
    }
    if (part.localProject !== undefined) {
      localProject = part.localProject;
      localProjectSupplied = true;
    }
  }
  // The agent's purchase tool exists only with a wallet configured and a browser to pay in. With
  // the guided setup the wallet is always there, so the tool follows whether a Link CLI is
  // connected: it appears on connect and goes on disconnect, and no Pay card is ever raised for a
  // payment that cannot happen.
  const paymentsPart = parts.find((p): p is ComposedPayments & { payments: PaymentBroker } => {
    return "payments" in p && p.payments !== undefined;
  });
  const browserPart = parts.find((p): p is ComposedBrowser => "ownsTab" in p && "devServers" in p);
  // B3: headless computer use on the Host helper's private screen keeps the screen's take-over,
  // parked card and Task-end rules (the agent browser runs headless Chromium, off that screen).
  const screenPart = parts.find(
    (p): p is ComposedVirtualScreen => "screen" in p && "handlers" in p,
  );
  parts.find((p): p is ComposedComputer => "useScreen" in p)?.useScreen(screenPart?.screen);
  if (paymentsPart !== undefined && browserPart !== undefined) {
    const availability = paymentsPart.availability;
    const purchaseTool = createPurchaseTool({
      payments: paymentsPart.payments,
      driver: () => browserPart.driver,
      // A headless Host has no checkout driver yet (B3 r1): refused before any card.
      unavailable: () => (browserPart.serverOnly ? checkoutNeedsDesktop() : undefined),
      ownsTab: (callId, tabId) => browserPart.ownsTab(callId, tabId),
      calls,
      approvals: broker,
      redactor,
      // Checked on every call too: a tool list built before a disconnect raises no Pay card.
      ...(availability === undefined ? {} : { ready: () => availability.ready() }),
      ...(gwOptions.env?.PSYCHE_LINK_TEST === "1" ? { test: true } : {}),
    });
    if (availability === undefined) services.tools.register(purchaseTool);
    else {
      let unregister: (() => void) | undefined;
      const follow = () => {
        // Connected and signed in: a saved CLI path alone is not enough (before sign-in, Link
        // cannot pay).
        const on = availability.ready();
        if (on && unregister === undefined) unregister = services.tools.register(purchaseTool);
        else if (!on && unregister !== undefined) {
          unregister();
          unregister = undefined;
          // A Stripe Link Pay card still open when Link goes away is withdrawn, never left to be
          // approved. Other purchase cards (a vault card at a shop, a connector) stay.
          void broker
            .invalidatePendingOfKind(
              "purchase",
              "payments_disconnected",
              // The fallback card (a tab with no origin) has no paymentSource: the loop always
              // names the tool, so match that too.
              (a) =>
                a.details?.paymentSource === LINK_PAYMENT_SOURCE ||
                a.details?.tool === PURCHASE_TOOL,
            )
            .catch(() => undefined);
        }
      };
      follow();
      availability.onChange(follow);
    }
  }
  // The people graph's deterministic pass reads the connected apps through their tools (#732).
  const connectorsPart = parts.find(
    (p): p is ComposedPart & { registry: ConnectorRegistry } => "registry" in p && "mail" in p,
  );
  // The three below are the Host's own Mac helper (`NodeRegistry.hostHelper`): the Host's
  // Messages, the Host's files for OCR and the Host's on-device model. A second Mac that paired as
  // a node never offers them, whatever capabilities it declares.
  //
  // The Host helper that offers the people graph's Messages metadata reads (#763), when live.
  const graphMessagesHelper = () =>
    gatewayRef?.context.nodes.hostHelper("messages.graph_read")?.client;
  // The Host helper that offers Vision OCR for search ingest (`ocr.recognize`), when one is live.
  const ocrHelper = () => gatewayRef?.context.nodes.hostHelper("ocr.recognize")?.client;
  // The Host helper that runs Apple's on-device model (`llm.apple.generate`), when one is live.
  appleHelper.current = () => gatewayRef?.context.nodes.hostHelper("llm.apple.generate")?.client;
  people.useSources(() =>
    graphSourceAdapters({
      connectors: async () => (connectorsPart === undefined ? [] : connectorsPart.registry.list()),
      tools: services.tools,
      clock,
      db,
      messages: graphMessagesHelper,
    }),
  );

  // scheduler → launcher → worker pool → loop → scheduler: the launcher is bound once the pool exists.
  let launcher: RunLauncher | null = null;
  const lateLauncher: RunLauncher = {
    launch: (request) => {
      if (launcher === null) throw new PsycheError("unavailable", "task launcher not ready");
      return launcher.launch(request);
    },
    reattach: (run) => launcher?.reattach?.(run),
    rerunOnInterrupt: (a) => launcher?.rerunOnInterrupt?.(a) === true,
    cancel: async (run, reason) => launcher?.cancel?.(run, reason),
  };
  const scheduler = new SqliteScheduler({
    db,
    clock,
    notifier,
    launcher: lateLauncher,
    sessions: createDbSessionResolver(db),
    deliverer: withRunSnapshot(createDeliverer({ notifier, broker }), {
      // `proactive` is composed after the scheduler; a run finishes long after both exist.
      postNotice: (input) => proactive.feed.postNotice(input),
    }),
    // Watches (O3) read public pages through the guarded fetch until S09 exports its own.
    watchFetch: publicFetch(),
    defaultTimezone: () => timeZone,
  });
  // Keeps the Mac awake while a scheduled run (or its retry) is active, when the owner turned it on.
  // Re-checked on every scheduler event and settings change; caffeinate exits with this process.
  const keepAwake = new KeepAwake({
    enabled: () => getSetting(db, KEEP_AWAKE_SETTING)?.value === true,
    activeRuns: () => scheduler.activeRunCount(),
    onError: (error) =>
      gwOptions.logger?.log("warn", "keep-awake hold failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
  });
  scheduler.subscribe(() => keepAwake.sync());
  settingListeners.push((c) => {
    if (c.key === KEEP_AWAKE_SETTING) keepAwake.sync();
  });
  // Approve on a set-aside automation card starts a resume run that may do it once (deferred-resume.ts).
  const deferredResume = new DeferredResume({
    scheduler,
    notifier,
    clock,
    settle: (id) => broker.settleSetAside(id),
    // A built-in routine paused in Scheduled keeps `enabled`; it must not be resumed either.
    // `scheduledKv` is composed later; this runs only once the owner answers a card.
    isPaused: (a) => pausedRoutines(scheduledKv).has(routineOf(a).id),
    onError: (err) =>
      gwOptions.logger?.log("warn", "deferred resume failed", {
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  deferredResumeRef = deferredResume;
  broker.subscribe((e) => deferredResume.onBrokerEvent(e));
  scheduler.subscribe((e) => {
    if (e.event === "automation.run.finished") deferredResume.onRunFinished(e.payload.run);
  });
  // E12 "From your other chats": digests of the owner's chats, shared only with threads.otherChats on.
  const otherChats = createOtherChats({ db, audit, now: () => clock.now() });
  // Context usage, owner-set limits and compaction (B7, C2): the meter and the compaction blocks.
  const context = createContext({
    db,
    audit,
    broker,
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
    isRunning: (threadId) => loop.isBusy(threadId),
  });
  // Learning about the owner (#509): facts from the owner's own words into USER.md's Learned
  // section. It runs on the utility model, so only when one is configured (the router always has one).
  // Memory recall (`memory.recall.mode`): embeddings over the Markdown memory, sharing Search's
  // embedder; Search is composed later, hence the late binding.
  let searchRef: ComposedSearch | undefined;
  const memoryRecall = createMemoryRecall({
    db,
    memory,
    searchEmbedder: () => searchRef?.embedder(),
    router: (allowCloud) => routerEmbedder(router, allowCloud),
    local: gwOptions.memoryRecallLocal ?? defaultLocalLoader(config.home),
  });
  const userProfile = createUserProfile({
    db,
    home: config.home,
    memory,
    provider,
    model: utility ?? modelRef,
    active: utility !== undefined,
    // Chat learning runs on a cheap model only (the owner's utility pick or the provider's cheap
    // default), never on the primary; with none it does not learn from chats at all.
    cheapModel: () => (router === undefined ? utility : cheapLearnerModel(router)),
    now: () => clock.now(),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    // One learner call per thread per half minute; quicker turns are sent together.
    // (Tests run with background off and learn on every turn.)
    minIntervalMs: background ? 30_000 : 0,
    redactor,
    audit,
    broker: executorBroker,
    surfaces: ["desktop", "web"],
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
    onForgotten: (factId, threadId) => teachingRef?.onLearnedUndo(factId, threadId),
    // The owner's own chat updates their work (MW7); off while the People graph is off.
    work: {
      // Only with People on and the owner's work-tracking consent (`memory.work`).
      graph: () =>
        people?.settings().enabled === true &&
        workSettings(getSetting(db, MEMORY_WORK_SETTING_KEY)?.value).enabled
          ? people.graph
          : undefined,
      em: () => people?.em,
      autoAccept: () =>
        everythingSettings(getSetting(db, EVERYTHING_MEMORY_SETTING_KEY)?.value).review
          .autoAcceptOwnerAuthored,
      now: () => clock.now(),
      timeZone: () =>
        timeZone ?? ownerTimeZoneAt(join(config.home, "workspace", "USER.md")) ?? "UTC",
    },
  });
  // Background specialists (docs/agent/specialists-2026.md, #683): roles from the role skills,
  // jobs as a subagent thread + Task, one sanitized result.
  // The specialist pool is created after the loop; spawning pokes it through this late binding.
  let pokeSpecialists = (): void => {};
  const specialistSlots = (): number => {
    const v = getSetting(db, "specialists.maxConcurrent")?.value;
    return typeof v === "number" && Number.isInteger(v) ? Math.min(6, Math.max(1, v)) : 3;
  };
  const specialists = createSpecialistHost({
    db,
    tasks,
    broker: loopBroker,
    roles: skills.roles,
    models: { primary: modelRef, ...(utility === undefined ? {} : { utility }) },
    now: () => clock.now(),
    slots: specialistSlots,
    poke: () => pokeSpecialists(),
    notifier,
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
  });
  // The teaching loop (#679): the owner's feedback → lessons written where they belong.
  const teaching = composeTeaching({
    db,
    memory,
    provider,
    model: utility ?? modelRef,
    active: utility !== undefined,
    broker: executorBroker,
    clock,
    audit,
    scheduler,
    // Entity and person-scoped lessons write through the people graph (S07, #651).
    ...(people === undefined ? {} : { graph: people.graph }),
    tasks,
    // "Used n lessons": the lessons each run's assembled prompt carried (teaching loop §5.1).
    explain: (runId) => loop.explainContext(runId),
    ...(gwOptions.retentionIntervalMs === undefined
      ? {}
      : { retentionIntervalMs: gwOptions.retentionIntervalMs }),
    surfaces: ["desktop", "web"],
    askRules: teachingAskRules({
      db,
      read: () => ({
        ...(validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger) ?? {}),
      }),
      write: (next) => {
        const entry = setSetting(db, "permissions.policy", next);
        rawBroker.setPolicy(hostPolicy(next as PolicyConfig, db));
        publish("settings.changed", { entries: [entry] });
      },
      owned: () => (getSetting(db, TEACHING_ASK_RULES_KEY)?.value as string[] | undefined) ?? [],
      setOwned: (rules) => void setSetting(db, TEACHING_ASK_RULES_KEY, rules),
    }),
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
  });
  teachingRef = teaching;
  parts.push(teaching.part);
  const spaceRun = composeSpaceContext(services, {
    // Note links name a file in the memory workspace; a path outside it throws, so it is no note.
    noteExists: (path) => {
      try {
        return memory.entryKind(path) === "file";
      } catch {
        return false;
      }
    },
  });
  parts.push(spaceRun.part);
  // `fork_report` files to the plan-fork service, which is composed after the loop (late binding).
  const forkReportHost: { current: ForkReportHost | undefined } = { current: undefined };
  const loop = createAgentLoop({
    forkReports: {
      file: async (input) => {
        const host = forkReportHost.current;
        if (host === undefined) throw new PsycheError("unavailable", "plan forks are not ready");
        await host.file(input);
      },
    },
    // Screenshots and MCP images are decoded and re-encoded (cut to 1568 px) before the model sees
    // or the thread keeps them; one that cannot be decoded becomes a note.
    toolImageShaper: (bytes, mime, signal) =>
      reencodeToolImage(bytes, mime, undefined, undefined, signal),
    // Model-side history survives a restart (issue #52); secrets the vault knows are masked.
    state: new SqliteThreadStateStore(db, redactor, config.home, (threadId, state) =>
      // A life-answer preamble built for a local model is rebuilt before a cloud model reads it.
      everything.lifeChat.refreshState(threadId, state),
    ),
    provider,
    model: modelRef,
    ...(utility === undefined ? {} : { utilityModel: utility }),
    broker: loopBroker,
    memory,
    tasks,
    notifier,
    // The agent cannot schedule a recorded skill: that is the owner's action (teach by showing §8).
    scheduler: withoutAgentRecordingSchedules(scheduler, skills.recorded),
    registry,
    clock,
    ...(timeZone === undefined ? {} : { timeZone }),
    approvalSurfaces: ["desktop", "web"],
    resumeApproval: (q) => deferredResume.claim(q),
    skills: skills.loader,
    ...(compaction === undefined ? {} : { compaction }),
    spaceFor: spaceRun.spaceFor,
    spaceById: spaceRun.spaceById,
    contextProviders: [
      spaceRun.provider,
      otherChats.provider,
      ...(people === undefined ? [] : [people.recall]),
      memoryRecall.recall,
      artifactContextProvider(db),
      automationIntentProvider(),
    ],
    contextLimits: context.contextLimits,
    onContextUsage: context.onContextUsage,
    onCompaction: context.onCompaction,
    onOwnerTurn: userProfile.onOwnerTurn,
    onToolEffect: (e) => {
      const change = toolEffectChange(e);
      if (change !== undefined) void changes.record(change);
    },
    // Incognito threads are memory-only (E9, security §8): the loop never flushes them.
    isIncognito: (threadId) => getThread(db, threadId)?.kind === "incognito",
    // Progressive disclosure: only the core tools' schemas ride in every request (capabilities.ts).
    deferTool: deferToolFor(db),
    specialists,
    // Reasoning steps for the step log (setting agent.showReasoning, default on), masked.
    showReasoning: () => getSetting(db, "agent.showReasoning")?.value !== false,
    redact: (text) => redactor.redact(text),
    // Helper runs become child runs in the run trace (run trace §4.2).
    onSubagentEvent: (info, event) => {
      try {
        gatewayRef?.context.runTrace.subagent(info, event);
      } catch {
        // A trace write never fails the helper.
      }
    },
  });
  // Tool inputs and outputs become the trace's payloads and previews (run trace §4.2).
  loop.hooks.on("tool_result_persist", ({ record, result }) => {
    try {
      gatewayRef?.context.runTrace.toolResult(record, result);
    } catch {
      // A trace write never fails the call.
    }
  });
  // A model call's prompt and reply become the Timeline step's input and output.
  loop.hooks.on("model_call_persist", (ctx) => {
    try {
      gatewayRef?.context.runTrace.modelCall(ctx);
    } catch {
      // A trace write never fails the turn.
    }
  });
  // Awaited by the loop before its `end` event, so a chat run's lessons are known before the
  // controller commits the transcript and publishes `run.updated`.
  loop.hooks.on("agent_end", (ctx) =>
    teaching.onRunEnd({
      runId: ctx.runId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      subagent: ctx.subagent,
    }),
  );
  // Night shift (docs/design/night-shift-2026.md): composed after Proactive; the pool reaches it
  // through this ref for a staging task's sink, its toolset and its usage meter.
  let nightShiftRef: ReturnType<typeof composeNightShift> | undefined;
  // Plan forks (docs/design/fork-a-plan-2026.md): composed right after Night shift, whose adapters
  // they share; the fork pool reaches them through this ref.
  let forksRef: ReturnType<typeof composeForks> | undefined;
  const taskTrace = taskRunTrace({
    db,
    sink: () => gatewayRef?.context.runTrace,
    publish,
    modelRef,
    onError: (err) =>
      gwOptions.logger?.log("warn", "task run trace failed", {
        code: PsycheError.from(err).code,
      }),
  });
  const pool = new TaskWorkerPool({
    engine: tasks,
    loop,
    clock,
    broker,
    notifier,
    tools: registry,
    stagingSinkFor: (staging) => nightShiftRef?.sinkFor(staging),
    stagingToolsFor: (staging) => nightShiftRef?.toolsFor(staging),
    ...(taskPollMs === undefined ? {} : { pollMs: taskPollMs }),
    canClaim: () => updateGate.accepting(),
    // Run trace §4.2: each task turn is its own run (ULID), recorded like a chat turn.
    newRunId: () => db.newId(),
    trace: {
      start: (turn) => taskTrace.start(turn),
      event: (turn, ev) => {
        // Night shift meters its own jobs' spend from their usage events.
        if (ev.type === "usage") nightShiftRef?.meter(turn.taskId, ev.usage, turn.runId);
        taskTrace.event(turn, ev);
      },
      end: (turn, outcome, error) => taskTrace.end(turn, outcome, error),
    },
    // Specialist jobs run in their own pool, so they never take the chat tasks' slots.
    // Plan-fork branches run in their own pool (F2); until it exists none runs here.
    claim: { excludeOrigins: ["subagent", "fork"] },
  });
  // Plan-fork branches (fork-a-plan-2026 §2.3): their own pool, so a branch never takes a chat
  // task's slot. Two slots, or one when the thread's model is a local one (`canClaim`).
  const forkPool: TaskWorkerPool = new TaskWorkerPool({
    engine: tasks,
    loop,
    clock,
    broker,
    notifier,
    tools: registry,
    owner: "fork",
    concurrency: 2,
    stagingSinkFor: (staging) => forksRef?.sinkFor(staging),
    stagingToolsFor: (staging, task) => forksRef?.toolsFor(staging, task),
    stagingReadsFor: (staging) => forksRef?.readsFor(staging),
    ...(taskPollMs === undefined ? {} : { pollMs: taskPollMs }),
    canClaim: () => updateGate.accepting() && (forksRef?.canClaim(forkPool) ?? true),
    newRunId: () => db.newId(),
    trace: {
      start: (turn) => taskTrace.start(turn),
      event: (turn, ev) => {
        if (ev.type === "usage") forksRef?.meter(turn.taskId, ev.usage, turn.runId);
        taskTrace.event(turn, ev);
      },
      end: (turn, outcome, error) => taskTrace.end(turn, outcome, error),
    },
    claim: FORK_POOL_CLAIM,
  });
  // Background specialists (specialists §4.5): their own slots (Settings, 1–6, default 3), FIFO,
  // at most 2 running per parent thread; a job parked on the owner frees its slot.
  const specialistPool = new TaskWorkerPool({
    engine: tasks,
    loop,
    clock,
    broker,
    notifier,
    tools: registry,
    owner: "specialist",
    concurrency: specialistSlots(),
    // Specialist runs are child runs in the trace, recorded like any task turn (run trace §4.2).
    newRunId: () => db.newId(),
    // Each child step also reaches the parent thread as `specialist.progress` (specialists §7.3).
    trace: withSpecialistProgress(
      taskRunTrace({
        db,
        sink: () => gatewayRef?.context.runTrace,
        publish,
        modelRef,
        onError: (err) =>
          gwOptions.logger?.log("warn", "specialist run trace failed", {
            code: PsycheError.from(err).code,
          }),
      }),
      { publish, now: () => clock.now() },
    ),
    ...(taskPollMs === undefined ? {} : { pollMs: taskPollMs }),
    claim: { origins: ["subagent"], perParentLimit: 2 },
    // While an update is prepared, a helper job of a chat or task that is already running still
    // starts (its parent is waiting on it); nothing new does.
    canClaim: () =>
      updateGate.accepting() ||
      (
        db.sqlite
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE status = 'running' AND parent_run_id IS NULL",
          )
          .get() as { n: number }
      ).n > 0,
  });
  pokeSpecialists = () => specialistPool.poke();
  // An update that never came: queued tasks are claimed again.
  updateGate.onReopen(() => {
    pool.poke();
    specialistPool.poke();
    forkPool.poke();
  });
  const speechPart = parts.find(
    (p): p is ComposedPart & { meetings: MeetingIngest } => "meetings" in p,
  );
  // S15: goal check-ins and the Feed run in-process; the heartbeat gets its 5k-token budget (O2).
  // The Host helper's shared availability (one state for every helper-backed source and job): they
  // skip quietly while it is offline, back off between attempts, and resume on reconnect.
  const helperConnected = (): boolean => gatewayRef?.context.nodes.hostHelper() !== undefined;
  const helperAvailability = new HelperAvailability(false, {
    now: () => clock.now(),
    log: (level, msg, fields) => gwOptions.logger?.log(level, msg, fields),
    // The app's banner reads this setting (`settings.get`), so it follows the Gateway's own view.
    onChange: (status) => {
      publish("settings.changed", {
        entries: [setSetting(db, HELPER_AVAILABILITY_SETTING, status)],
      });
    },
  });
  // A status left by the previous run (two helpers connected when it stopped) must not outlive
  // it: no helper is connected yet. Quiet write; later changes publish through `onChange`.
  setSetting(db, HELPER_AVAILABILITY_SETTING, helperAvailability.status());
  // The Space trackers are composed last; the mail poll, calendar watch and folder watcher ask
  // them through this ref whether anything listens (spaces-2026 §6.2).
  const spaceTrackers: SpaceTrackersRef = {};
  const proactive = composeProactive({
    db,
    clock,
    spaceListens: (source) => spaceTrackers.current?.listensTo(source) === true,
    helper: { state: helperAvailability, connected: helperConnected },
    scheduler,
    notifier,
    tasks,
    memory,
    provider,
    model: utility ?? modelRef,
    publish,
    broker,
    registry,
    audit,
    // Calendar changes from the Host's helper (`calendar.watch`) for calendar.changed automations.
    calendarHelper: macHelper(() => gatewayRef ?? undefined),
    channelSurfaces: () =>
      relays.flatMap((r) => r.surfaces()).filter((x) => x.startsWith("imessage:")),
    learned: () => everything.learnedYesterday(),
    comingUp: () => everything.comingUp(),
    // The brief also posts any new nudge cards, so the Feed and the brief agree.
    keepInTouch: () => {
      nudges.refresh();
      return nudges.keepInTouch();
    },
    quietThreads: () => mailFollowups.briefLines(),
    nightShift: () => nightShiftRef?.briefLine(),
    // Catching up and `memory.catchup.*` (MW4): the graph, and what the agent may read of it.
    catchup: { graph: people.graph, em: everything.store, access: people.agentAccess },
    // Ideas proposes folding a skill's lessons into it once it has three (teaching loop §6).
    skillUpdates: () => skills.updates(),
    // Post-meeting notes transcribe on the Mac through the speech part (§4.6). Record meeting
    // stays unavailable until a helper offers microphone capture.
    meetings: {
      home: config.home,
      primary: modelRef,
      primaryIsRemote: () => {
        const providers = "router" in modelSetup ? modelSetup.router.providers : [];
        const p = providers.find((c) => c.id === modelRef.split("/")[0]);
        return p !== undefined && !isLocalKind(p.kind);
      },
      ...(speechPart === undefined
        ? {}
        : {
            transcriber: speechPart.meetings,
            transcriberAvailable: () => speechPart.meetings.available(),
            runningApps: () => speechPart.meetings.runningApps(),
          }),
    },
    // The people graph while the owner has it on: prep's attendees and loops, notes' loops.
    graph: () => (people?.settings().enabled === true ? people.graph : undefined),
    // The recordings-folder watch reads only inside these (#953).
    folders: () => rawBroker.grantedFolders(),
    timeZoneNow: () => timeZone,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  // The agent's proactive tools (goals.*, ideas.*, feed.*): reads allow, changes ask.
  for (const tool of proactiveTools({
    goals: proactive.goals,
    ideas: proactive.ideas,
    feed: proactive.feed,
    ...(proactive.drafts === undefined ? {} : { drafts: proactive.drafts }),
    ...(proactive.scheduling === undefined ? {} : { scheduling: proactive.scheduling }),
    clock,
  })) {
    registry.register(tool);
  }
  nightShiftRef = composeNightShift({
    db,
    clock,
    scheduler,
    notifier,
    tasks: tasks as never,
    poke: () => pool.poke(),
    registry,
    lookup: () => connectorToolLookup(registry),
    keepAwake,
    readState: () => readSystemState(),
    timeZone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    connectors: async () => (connectorsPart === undefined ? [] : connectorsPart.registry.list()),
    folders: () => rawBroker.grantedFolders(),
    mailCandidates: () => mailFollowups.nightCandidates(),
    followups: proactive.followups,
    redact: (text) => redactor.redact(text),
    publish: (event, payload) => publish(event as never, payload as never),
    broker: rawBroker,
    surfaceOf: (deviceId) => surfaceOf(db, deviceId),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  forksRef = composeForks({
    db,
    clock,
    tasks: tasks as never,
    poke: () => forkPool.poke(),
    registry,
    stagerParts: nightShiftRef.stagerParts,
    router,
    redact: (text) => redactor.redact(text),
    publish: (event, payload) => publish(event as never, payload as never),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  // The report host the loop files each branch's one report to (fork_report, F1).
  forkReportHost.current = forksRef.service.reports;
  // #557: web.search / web.fetch on every surface (read-only, untrusted output).
  const webTools = composeWebTools(
    {
      db,
      env: gwOptions.env ?? process.env,
      publish,
      redactor,
      vault: () => vault.vault,
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    },
    webSetup,
  );
  for (const tool of webTools.tools) registry.register(tool);
  // The capability catalogue: find_capability / install_capability and Settings' Available lists.
  const mcpPart = parts.find((p): p is ComposedMcp => "adder" in p && "host" in p);
  const capabilities = capabilityTools({
    services,
    catalogue: capabilityCatalogue({ services, skills: skills.loader, fetch }),
    ...(mcpPart === undefined ? {} : { adder: mcpPart.adder, idle: () => mcpPart.idle() }),
    skills: skills.loader,
  });
  for (const tool of capabilities.tools) registry.register(tool);
  // Build and run: scripts Psyche writes run under srt after one card; kept ones become connectors.
  for (const tool of scriptTools({
    services,
    srt: execHostSrt,
    // Windows: scripts run in the sandbox PC's guest instead of srt.
    vm: () => vmPart()?.runner,
    vault: vault.vault,
    record: (change) => void changes.record(change),
    ...(execHostSetup.driver === undefined ? {} : { driver: execHostSetup.driver }),
  })) {
    registry.register(tool);
  }
  const scheduledKv = {
    get: (key: string) => getSetting(db, key)?.value,
    set: (key: string, value: unknown) => void setSetting(db, key, value),
  };
  // The dreaming automation runs memory dreaming and the people graph pass in-process.
  // Dreaming, then the lesson pass (teaching loop §6, #681), then the people graph pass.
  // Automations with a `specialist` run as unattended specialist jobs (specialists §4.10).
  // A scheduled recording holds to its rules (stops on a changed page, no guessing); other
  // automations pass through. The guard watches the loop's tool calls for those tasks only.
  const recordedRuns = new RecordedRuns({
    // The guard lives in memory. A task whose goal carries the recorded run's rules and has no
    // guard (after a restart) gets no tools and is stopped.
    isRecorded: async (taskId) =>
      (await tasks.get(taskId))?.goal.includes(RECORDED_RUN_RULES) === true,
  });
  attachRecordedRunGuard(
    loop.hooks,
    recordedRuns,
    (taskId, reason) => tasks.cancel(taskId, reason),
    () => skills.recorded.names(),
    skills.recorded,
  );
  launcher = withPausedRoutines(
    withRecordedSkillRuns(
      withAutomationSpecialists(
        people.launcher(
          // The weekly "What I learned" Feed post (teaching loop §5.4) runs in-process too.
          withWeeklyCard(
            // Everything memory (#1010) is its own scheduled job (03:15, after dreaming), so
            // Scheduled shows it and can Run it now.
            withProactiveJobs(
              proactive.launcher(createTaskLauncher({ engine: tasks, pool }), pool),
              {
                jobs: [everything.job, ...(nightShiftRef === undefined ? [] : [nightShiftRef.job])],
              },
            ),
            {
              store: teaching.service.store,
              memory,
              clock,
              enabled: () =>
                teachingSettings(db).enabled &&
                getSetting(db, "teaching.weeklyCard")?.value !== false,
              post: (card) => proactive.feed.postGrowth(card),
            },
          ),
          [
            async () => {
              if (!teachingSettings(db).enabled) return undefined;
              const r = await consolidateLessons(teaching.service, memory, { clock });
              // "Still true?" left unanswered: the lesson goes dormant (teaching loop §3.3).
              const dormant = await retireUnanswered(teaching.service, memory, { clock });
              return `lessons: ${r.merged} merged, ${r.promoted} promoted, ${r.proposed} proposed, ${r.flagged} flagged, ${dormant} dormant`;
            },
          ],
        ),
        { db, tasks, host: specialists, now: () => clock.now() },
      ),
      {
        skills: skills.recorded,
        runs: recordedRuns,
        pause: (id) => scheduler.update(id, { enabled: false }),
        automationOf: (id) => scheduler.get(id),
      },
    ),
    // Scheduled → Pause: a paused routine skips its scheduled runs (Run now still goes through).
    () => pausedRoutines(scheduledKv),
  );
  scheduler.subscribe((e) => publish(e.event, e.payload as never));

  // C10: Claude Code behind harness.delegate, only once the owner configured harness.claudeCode.
  parts.push(
    composeHarnesses({
      db,
      loop,
      vault: vault.vault,
      broker: executorBroker,
      sandbox: parts.find(
        (p): p is ComposedSandbox => "runner" in p && "egress" in p && "track" in p,
      ),
      folders: () => rawBroker.grantedFolders(),
    }),
  );
  // A device that goes away ends the meeting recording it was capturing (§4.6).
  const meetingsDisconnect = (deviceId: string) => proactive.meetings?.deviceGone(deviceId);
  let unsubscribeWorkflows: (() => void) | undefined;
  parts.push({
    start: (gw) => {
      gw.context.deviceDisconnected.add(meetingsDisconnect);
      // Settings → Mail & meetings: a changed key re-syncs the jobs' schedules (the digest's time
      // and days, the mail check cadence, each workflow's switch). Everything else is read per run.
      unsubscribeWorkflows = gw.bus.subscribe(["operator.read"], (frame) => {
        const f = JSON.parse(frame) as {
          event?: string;
          payload?: { entries?: { key: string }[] };
        };
        if (f.event !== "settings.changed") return;
        const keys: readonly string[] = [...WORKFLOW_SETTING_KEYS, ...DAILY_SETTING_KEYS];
        if ((f.payload?.entries ?? []).some((e) => keys.includes(e.key))) {
          void proactive.syncWorkflowSchedules();
        }
      });
    },
    stop: () => {
      gatewayRef?.context.deviceDisconnected.delete(meetingsDisconnect);
      unsubscribeWorkflows?.();
      unsubscribeWorkflows = undefined;
    },
  });
  // New chats get a short title after the first reply (heuristic at once, then the utility model).
  parts.push(
    createAutoTitler({
      db,
      provider,
      model: utility ?? modelRef,
      redactor,
      publish: (event, payload, threadId) => publish(event, payload as never, threadId),
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    }).part(),
  );
  parts.push(otherChats.part());
  // S1 unified search: `state/search.sqlite`, kept current from the bus, and `search.query`.
  const appleSearch = appleSearchSeams({
    connectors: async () => (connectorsPart === undefined ? [] : connectorsPart.registry.list()),
    tools: services.tools,
    messages: graphMessagesHelper,
    helperOnline: () => {
      helperAvailability.observe(helperConnected());
      return helperAvailability.status().connected;
    },
    onContactsDenied: (denied) => helperAvailability.setContactsDenied(denied),
    // The Contacts source reads through the Host's own helper, like Messages.
    contacts: () => gatewayRef?.context.nodes.hostHelper("contacts.read")?.client,
    graph: () => (people?.settings().enabled === true ? people.graph : undefined),
    now: () => clock.now(),
  });
  // Encryption at rest for the search index, with its own key beside the vault's (R8).
  const searchEncryption = await resolveSearchKey({
    db,
    keyFile: join(config.home, "state", "search.key.json"),
    wrapper: vault.wrapper,
    slot: vault.slot,
    derived: new DerivedKeyStore(vault.helper),
  });
  const power = powerReader();
  // Whether a model ref runs off this Mac. A ref the router does not know counts as cloud.
  const isCloudRef = (ref: string): boolean => {
    const providers = "router" in modelSetup ? modelSetup.router.providers : [];
    const p = providers.find((c) => c.id === ref.split("/")[0]);
    return p === undefined || !isLocalKind(p.kind);
  };
  const searchModelEngine = searchEngine(db);
  const searchModels = searchModelProvider(provider, searchModelEngine);
  const search = composeSearch({
    encryption: searchEncryption,
    // Chat messages' sender for `from:` (the owner's profile name; see `messageSender`).
    ownerName: async () => readHeader((await memory.readFile("USER.md"))?.content ?? "").name,
    // Local sources: each off until the owner turns it on in Settings → Search sources.
    sources: {
      apple: appleSearch.deps,
      refresh: appleSearch.refresh,
      // Memory as a source: only while the owner has the memory graph on, and only what the graph
      // may show on a surface (`search-memory.ts`).
      memory: memorySourceDeps({
        graph: () => (people?.settings().enabled === true ? people.graph : undefined),
        em: everything.store,
        ...memorySettings(db),
        ...(memoryLate === undefined ? {} : { ready: () => memoryLate.ready }),
      }),
      files: filesSourceDeps({
        folders: () => rawBroker.grantedFolders(),
        // The indexer follows the roots itself: only roots looked at within the fresh window.
        freshFolders: () => rawBroker.freshGrantedFolders(),
        // Vision OCR in the Mac helper (opt-in per source), one file at a time, on power only.
        ocr: { recognize: helperRecognizer(ocrHelper), power },
      }),
      power,
      watch: background,
      pageReads,
      // Folders added only to a Space are watched too, for its files tracker (spaces-2026 §6.2).
      spaceFolders: {
        roots: () => spaceTrackers.current?.watchedFolders() ?? [],
        changed: (root) => spaceTrackers.current?.signal({ kind: "folder", root }),
      },
    },
    db,
    home: config.home,
    memory,
    tasks,
    feed: proactive.feed,
    ideas: proactive.ideas,
    goals: proactive.goals,
    ...(timeZone === undefined ? {} : { timeZone }),
    // "from Alex": the people graph's names, aliases and addresses for that person.
    resolvePerson: (name) => {
      const graph = people?.graph;
      if (graph === undefined) return undefined;
      return graphNames(graph, name);
    },
    // `search.semantic.engine: router`: the `embedding` role; a cloud one only with allowCloud (S4).
    routerEmbedder: (allowCloud) => routerEmbedder(router, allowCloud),
    // Context cards at ingest: a background job, so a cheap model only (the owner's utility pick or
    // the provider's own cheap default, never the primary), one bounded step every 10 minutes, on AC
    // power with the Mac idle, within a daily budget.
    // `search.model.engine: apple` moves all three jobs to Apple's on-device model (fail closed).
    engine: searchModelEngine,
    cards: {
      provider: searchModels,
      model: () =>
        searchModelEngine() === "apple"
          ? (utility ?? modelRef)
          : router === undefined
            ? utility
            : router.utilityRef(),
      readState: () => readSystemState(),
    },
    // Cloud rerank of the top hits: the utility model, only when one is set and the owner opts in.
    ...(utility === undefined ? {} : { rerank: { provider: searchModels, model: utility } }),
    // Plain-English questions the rules cannot filter: the utility model, only when one is set.
    ...(utility === undefined ? {} : { queryModel: { provider: searchModels, model: utility } }),
    ...(gwOptions.semanticEngines === undefined
      ? {}
      : { semanticEngines: gwOptions.semanticEngines }),
    now: () => clock.now(),
    onSemanticChange: () => void memoryRecall.apply(),
    // Tests reconcile the Library by hand.
    ...(background ? {} : { librarySyncMs: 0 }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  parts.push(search);
  searchRef = search;
  // `search_everything`: the agent's tool over the main index (roadmap §6); deferred by default.
  registry.register(
    searchEverythingTool({
      index: search.index,
      provider,
      model: utility ?? modelRef,
      // Processing none/local keeps a source's text off cloud models, here and in research.
      cloudBlocked: () => search.sources?.cloudBlocked() ?? [],
      synthesisIsCloud: () => isCloudRef(utility ?? modelRef),
      outputIsCloud: () => isCloudRef(modelRef),
    }),
  );
  void memoryRecall.apply();
  // Deep research (`/research`): plan, confirmed run, cited report artifact, follow-ups.
  for (const tool of researchTools({
    db,
    home: config.home,
    provider,
    model: modelRef,
    cheapModel: utility ?? modelRef,
    web: webTools,
    // The agent audience: owner-only sources (Messages, Contacts, Memory) are never read into research.
    localSearch: agentLocalSearch(search.index, 5, {
      cloudBlocked: () => search.sources?.cloudBlocked() ?? [],
      cloud: () => isCloudRef(modelRef) || isCloudRef(utility ?? modelRef),
    }),
    publish: (artifact, version) =>
      publish("artifact.updated", { artifact, version }, artifact.threadId ?? undefined),
  })) {
    registry.register(tool);
  }
  parts.push(
    everything.part(scheduler, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  parts.push(nudges.part());
  parts.push(
    composeSpaces({
      scheduler,
      projects: () => people.graph,
      services,
      trackers: spaceTrackers,
      tools: connectorToolLookup(registry),
      folderEnv: () => folderAccessEnv(config.home),
    }),
  );
  parts.push(mailFollowups.part());
  // Proposals and migration offers (Spaces S7): the agent only proposes, the owner taps Create.
  parts.push(
    composeSpaceOffers({
      db,
      register: (tool) => registry.register(tool),
      publish,
      memory: () => people.graph,
      states: new SqliteThreadStateStore(db),
    }),
  );
  parts.push(composeSpaceFolders({ broker: () => rawBroker, home: config.home }));
  parts.push(
    composeWork({
      db,
      clock,
      people,
      apple: appleSearch,
      broker: rawBroker,
      ...(background ? {} : { intervalMs: 0 }),
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    }).part(),
  );
  // A conversation gist can show the source it was written from, opened in the source viewer: the
  // lookup and the open check are Search's (read late: the index may be unlocked after start).
  people.useGistSources({
    docIdFor: (ref) => search.sources?.docIdFor(ref),
    canOpen: (call, id, kinds) =>
      canOpenGistSource({ indexer: () => search.sources }, call, id, kinds),
  });
  // Review's citations follow the same per-connection rule (document ids, and Messages quotes).
  everything.useCitationScrub((call, citations) =>
    scrubCitations({ indexer: () => search.sources }, call, citations),
  );
  // The same two checks put source chips on Home's catch-up lines.
  proactive.useCatchUpSources({
    docIdFor: (ref) => search.sources?.docIdFor(ref),
    canOpen: (call, id, kinds) =>
      canOpenGistSource({ indexer: () => search.sources }, call, id, kinds),
  });
  parts.push(people.part(scheduler, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  // Code plugins (T4): off until the owner turns on `plugins.enabled`.
  parts.push(
    composePlugins({
      db,
      home: config.home,
      broker: executorBroker,
      events: rawBroker,
      notifier,
      loop,
      publish,
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    }),
  );
  // documents.convert: LibreOffice in its own sandbox on the full image (P4).
  // The Library's quarantine gate, shared by files.read and documents.convert (phone reads of Library files).
  const libraryGate = {
    rows: () =>
      listLibraryGateRows(db).map((item) => ({
        name: item.name,
        path: item.path,
        quarantined: item.quarantined === true,
      })),
  };
  parts.push(
    composeConversion({
      folders: () => rawBroker.grantedFolders(),
      home: config.home,
      library: libraryGate,
    }),
  );
  // app.uninstall.authorize: the presence gate in front of the uninstall sheet's "Delete my data".
  parts.push({ handlers: uninstallHandlers(services) });
  // Forget everywhere (memory wave 3A): the graph, lessons and search index, previewed by every
  // dry run and cleaned by every forget (the RPC and the agent's tool both go through the store).
  const forgetDeps = {
    memory,
    db,
    graphSqlite: () => (memoryLate === undefined ? db.sqlite : memoryDb.sqlite),
    graph: () => people?.graph,
    cards: () => people?.cards,
    teaching: () => ({ store: teaching.service.store, service: teaching.service }),
    searchIndex: () => search.index,
  };
  memory.setForgetCascade(composeForgetCascade(forgetDeps));
  const handlers: Record<string, HandlerDef> = {
    ...mountPermissions(db, createPermissionHandlers(rawBroker, audit), tokens),
    // memory.search and memory.explain return chunk text: held to the connection's viewer.
    ...mountMemoryHandlers(
      createMemoryHandlers(memory, {
        teaching: teaching.service.store,
        graphReset: composeGraphReset(forgetDeps),
      }),
      memory,
    ),
    // memory.status also says how recall works (`memory.recall.mode`).
    "memory.status": {
      run: async () => ({
        ...(await memory.status()),
        recall: memoryRecall.status(),
        store: memoryStoreStatus(db, memoryDb),
      }),
    },
    "memory.store.setEncrypted": {
      run: async (_call: unknown, p: { on: boolean }) => setMemoryEncrypted(db, memoryDb, p.on),
    },
    ...mountParamsOnly(userProfile.handlers as never),
    // The owner's list and delete for the agent's own notes (memory/agent/).
    ...mountParamsOnly(createAgentNoteHandlers(memory) as never),
    ...teaching.handlers,
    // The owner's Clear chat: empties a thread in place (the main chat cannot be deleted).
    ...createThreadClear({ db, audit, broker, isRunning: (threadId) => loop.isBusy(threadId) }),
    ...context.pinHandlers(() => loop),
    ...mountParamsOnly(
      context.handlers(
        () => loop,
        (threadId) =>
          loop.effectiveContextLimits(threadId, getThread(db, threadId)?.modelRef ?? undefined),
      ) as never,
    ),
    ...mountParamsOnly(
      createTaskHandlers({
        engine: tasks,
        pool,
        pools: [specialistPool, forkPool],
        broker,
      }) as never,
    ),
    ...mountParamsOnly(
      taskUpdateHandlers({
        tasks,
        roles: skills.roles,
        now: () => clock.now(),
        raise: (taskId, patch) =>
          raiseSpecialistBudget({ tasks, host: specialists }, taskId, patch),
        poke: () => specialistPool.poke(),
      }) as never,
    ),
    ...mountParamsOnly(
      specialistHandlers({
        db,
        tasks,
        roles: skills.roles,
        host: specialists,
        slots: specialistSlots,
      }) as never,
    ),
    ...mountParamsOnly(createAutomationHandlers(scheduler) as never),
    // "Run it every week" for a skill made from a recording: the desktop shell only.
    ...createRecordingScheduleHandlers({
      skills: skills.recorded,
      scheduler,
      timezone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    ...mountParamsOnly(
      createScheduledHandlers({
        scheduler,
        kv: scheduledKv,
        timezone: () => timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        browserAvailable: () => browserAvailability.check?.(),
        taskStatus: async (taskId) => (await tasks.get(taskId))?.status,
        pendingApprovals: async () => {
          const byTask = new Map<string, number>();
          for (const a of await broker.list({ status: "pending" })) {
            const tid = a.requestedBy.taskId;
            if (tid != null) byTask.set(tid, (byTask.get(tid) ?? 0) + 1);
          }
          return byTask;
        },
      }) as never,
    ),
    ...withNotificationScrub(
      mountParamsOnly(createNotificationHandlers(notifier) as never),
      () => people?.loopVisibility,
    ),
    ...proactive.handlers,
    ...(nightShiftRef?.defs ?? {}),
    ...capabilities.handlers,
    ...questionHandlers(loop, tasks),
    ...receiptHandlers(broker),
    ...threadSettingsHandlers(modelPins),
    ...vault.handlers,
    ...bootstrapAdminHandlers({ db, audit }),
    ...setupTokenHandlers({ db, audit }),
    // view.*: pane control forwarded to the desktop shell (view.ts).
    ...viewHandlers(),
    // "Restart to update": stop taking new work and report what is busy (desktop shell only).
    ...updateHandlers({
      db,
      home: config.home,
      gate: updateGate,
      runningTasks: () => tasks.list({ status: ["running"] }),
      broker,
      busy: busySources,
      ...(gwOptions.logger === undefined ? {} : { log: gwOptions.logger }),
    }),
    ...changeHandlers({ audit }),
    ...filesHandlers({
      folders: () => rawBroker.grantedFolders(),
      home: config.home,
      audit,
      library: libraryGate,
      share: {
        broker: executorBroker,
        surfaces: ["desktop", "web"],
        folderEnv: () => folderAccessEnv(config.home),
        grantedFolders: (threadId) => [
          ...rawBroker.grantedFolders(),
          ...rawBroker.liveSessionFolders(threadId),
          // The thread's current Space folders count as already shared (a read, nothing stored).
          ...rawBroker.spaceFoldersOfThread(threadId),
        ],
      },
    }),
    ...attentionHandlers(attention),
    ...cookieImportHandlers(audit),
    ...libraryHandlers({ db, home: config.home, audit }),
    ...modelSettingsHandlers(modelSettings),
    ...apiKeyHandlers({
      vault: () => vault.vault,
      env: keyEnv,
      audit,
      modelKeysInVault: vaultKeys,
      onChanged: (id) => {
        if (id === "brave") webTools.refresh();
      },
      onKeyReplaced: noticeKeyChange,
    }),
    // The Overview's aggregates (docs/design/agent-overview-2026.md §6.2): read-only SQL.
    ...insightsHandlers({
      db,
      ...(memoryLate === undefined ? {} : { memorySqlite: memoryDb.sqlite }),
    }),
    // The sidebar's usage footer (#599): a read over the run ledger.
    ...usageSummaryHandlers({
      db,
      providers: modelSettings.providers,
      primary: () => router?.role("primary")?.model ?? modelSettings.fixedModel,
    }),
  };
  for (const part of parts) Object.assign(handlers, part.handlers ?? {});
  // "Erase all memory" and "forget everything learned" also erase the safety copies of the data
  // that sit in backups/pre-update: they hold what the owner just asked to be gone.
  for (const name of PURGES_SNAPSHOTS) {
    const def = handlers[name];
    if (def === undefined) continue;
    handlers[name] = {
      ...def,
      run: async (call, params) => {
        const result = await (def.run as (c: unknown, p: unknown) => unknown)(call, params);
        if ((params as { dryRun?: boolean } | undefined)?.dryRun !== true)
          purgePreUpdateSnapshots(config.home);
        return result;
      },
    };
  }
  const webhooks: Record<string, WebhookRoute> = { ...gwOptions.webhooks };
  for (const part of parts) {
    for (const [path, route] of Object.entries(part.webhooks ?? {})) {
      if (path in webhooks) throw new PsycheError("conflict", `two webhooks for ${path}`);
      webhooks[path] = route;
    }
  }

  const publicRoutes: Record<string, PublicRoute> = {};
  for (const part of parts) {
    for (const [path, route] of Object.entries(part.publicRoutes ?? {})) {
      if (path in publicRoutes) throw new PsycheError("conflict", `two public routes for ${path}`);
      publicRoutes[path] = route;
    }
  }

  const gateway = await startGateway({
    ...gwOptions,
    updateGate,
    db,
    agent: loop,
    broker,
    memory,
    handlers,
    webhooks,
    publicRoutes,
    onSetupTokenUsed: setupTokenUsedHook({ db, audit, log: gwOptions.logger }),
    // A fresh psyche-server (deb, rpm or tarball on Linux) waits for the app's setup code.
    claim: gwOptions.claim ?? {
      enabled: process.platform === "linux" && psycheServerKind() !== null,
    },
    // The first admin made with the setup code: audited like the desktop's first admin, so
    // `psyche security audit` counts it with the others (devices.bootstrap_repeated).
    onClaimed: (device) => {
      void audit
        .append({
          kind: BOOTSTRAP_ADMIN_AUDIT_KIND,
          actor: { type: "device", deviceId: device.id },
          data: { deviceId: device.id, name: device.name, via: "claim" },
        })
        .catch((err: unknown) =>
          gwOptions.logger?.log("warn", "audit append for a claimed server failed", {
            code: PsycheError.from(err).code,
          }),
        );
    },
    onMachineChange: ((notice) => (change: Parameters<typeof notice>[0]) => {
      // A removed machine keeps no folder grant (H5's revoke cascade on the Gateway side).
      if (change.change === "removed") machineFolders.forgetMachine(change.deviceId);
      notice(change);
    })(machineChangeHook({ audit, notifier, log: gwOptions.logger })),
    onDeviceSelfRevoked: (revoked) => {
      void audit
        .append({
          kind: "device.revoked_self",
          actor: { type: "device", deviceId: revoked.deviceId },
          data: { deviceId: revoked.deviceId, name: revoked.name },
        })
        .catch((err: unknown) =>
          gwOptions.logger?.log("warn", "audit append for a device removing itself failed", {
            code: PsycheError.from(err).code,
          }),
        );
    },
    onDeviceRevoked: (deviceId) => {
      revocations.recordDevice(deviceId);
      return rawBroker.revokeGrantsByDevice(deviceId);
    },
    // Its receipt events are forwarded to the bus above; nodes.invoke must not repeat them.
    brokerPublishesReceipts: true,
    // Security settings need fresh presence once a verifier can verify (security §10): an
    // explicit one, or a part's with a registered key (the helper without keys is not).
    settingsPresence: () => presence !== NO_PRESENCE || presenceReady.some((ready) => ready()),
    // Adding a verifier must pass the Mac sheet whenever any verifier can verify, the auto-paired
    // helper's device key included (`presenceCanVerify` in context.ts).
    presenceCanVerify: () =>
      presence !== NO_PRESENCE || presenceCanVerify.some((canVerify) => canVerify()),
    threadModels: modelPins,
    // Run trace §4.6: the one redactor, and credential-like URL parameters.
    traceRedact: (text) =>
      redactor.redact(text).replace(/https?:\/\/[^\s"'<>)\]]+/g, (url) => redactUrl(url)),
  });
  bus = gateway.bus;
  webTools.refresh();
  // approval.created carries each approver's own surface token (issue #50, security §3.7):
  // only to devices that hold operator.approvals, and only their surface's token.
  gateway.bus.setPersonalizer((event, payload, sub) => {
    // A life answer in a transcript is read again for each subscriber (a remote window gets no
    // Messages chips); a subscriber with no identity (a Gateway part) is read as the least trusted.
    if (event === "chat.message")
      return personalizeMessageEvent(gateway.context, payload as { message: Message }, sub.reader);
    // A promise or a loop is read again for each subscriber (promise scrub): the desktop shell
    // gets it whole, a remote one the stripped form, and a hidden one nothing. With the graph not
    // composed, nobody gets it.
    if (event === "promise.updated")
      return personalizePromiseEvent(
        payload as { promise: PromiseView },
        sub.reader,
        people?.loopVisibility,
      );
    if (event === "memory.loop.updated")
      return personalizeLoopEvent(
        payload as { loop: GraphLoop },
        sub.reader,
        people?.loopVisibility,
      );
    if (
      event === "notification.created" ||
      event === "notification.updated" ||
      event === "notification.resolved"
    )
      return personalizeNotificationEvent(
        payload as { notification: Notification },
        sub.reader,
        people?.loopVisibility,
      );
    // A Night shift item made from Messages reaches only the desktop shell on this Mac in full.
    if (event === "nightShift.item.updated")
      return personalizeNightShiftItem(payload as { item: StagedAction }, sub.reader);
    if (event !== "approval.created" || sub.deviceId === null) return undefined;
    if (!sub.scopes.includes("operator.approvals")) return undefined;
    const p = payload as { approval: { id: string } };
    const answerToken = tokens.tokenFor(p.approval.id, surfaceOf(db, sub.deviceId));
    return answerToken === undefined ? undefined : { ...p, answerToken };
  });
  gatewayRef = gateway;
  // The owner's own messages and approval answers count as input (pause-when-unwatched, #272).
  const unsubscribeAttention = gateway.bus.subscribe(["operator.read"], (frame) =>
    attention.observe(frame),
  );
  vault.attach(gateway.context.nodes);
  // The helper's availability follows connect and disconnect directly: the banner clears and the
  // paused sources and jobs resume the moment it returns, not at the next job run or search.
  const syncHelperAvailability = (): void => {
    helperAvailability.observe(helperConnected());
    helperAvailability.setAmbiguous(gateway.context.nodes.ambiguousHelpers());
  };
  const unsubscribeHelperChange = gateway.context.nodes.onHostHelperChange(syncHelperAvailability);
  syncHelperAvailability();
  // The owner's folder grants and rules apply without a restart (settings.set → broker policy).
  // A run that ends lets a waiting Forget trace pass go on (no polling). This relies on the
  // `run.updated` frame; a run that ends without one is picked up at the next wake or at the
  // pass's 24 h expiry.
  const unsubscribeTraceScrub = gateway.bus.subscribe(["operator.read"], (frame) => {
    if (!frame.includes('"run.updated"')) return;
    try {
      const f = JSON.parse(frame) as { event?: string; payload?: { run?: { status?: string } } };
      const status = f.payload?.run?.status;
      if (f.event === "run.updated" && status !== "running" && !status?.startsWith("awaiting")) {
        traceScrub.wake();
      }
    } catch {
      // A frame that is not JSON is not a run ending.
    }
  });
  const unsubscribePolicy = gateway.bus.subscribe(["operator.read"], (frame) => {
    const f = JSON.parse(frame) as {
      event?: string;
      payload?: { entries?: { key: string; value: unknown }[] };
    };
    if (f.event !== "settings.changed") return;
    for (const entry of f.payload?.entries ?? []) {
      if (entry.key === CROSS_THREAD_SETTING) crossThread.sync(entry.value);
      if (entry.key === MEMORY_RECALL_MODE_SETTING) void memoryRecall.apply();
      if (entry.key === WEB_SEARCH_PROVIDER_SETTING || entry.key === WEB_SEARCH_SEARXNG_SETTING)
        webTools.refresh();
      // The optional sensitive categories (Settings → Permissions) apply to the next call.
      // Only this layer changes: connector matrices, lifted floors and Computer use tiers stay.
      if (entry.key.startsWith(SENSITIVE_CATEGORY_SETTING_PREFIX)) {
        applySensitiveCategories(rawBroker, db);
        continue;
      }
      if (entry.key !== "permissions.policy") continue;
      try {
        rawBroker.setPolicy(hostPolicy((entry.value ?? {}) as PolicyConfig, db));
      } catch (err) {
        gwOptions.logger?.log("warn", "invalid permissions.policy ignored", {
          code: PsycheError.from(err).code,
        });
      }
    }
  });
  memory.watch();
  await restoreModelPins(db, modelPins, (msg, fields) =>
    gwOptions.logger?.log("warn", msg, fields),
  );
  ownPorts.add(gateway.port, "gateway (bound)");
  // The granted roots' first looks, before the indexer, the work sweep and the folder watchers
  // start (bounded: a hung mount must not hold the start; those roots stay out until looked at).
  await rawBroker.foldersSettled(2_000);
  for (const part of parts) await part.start?.(gateway);
  // Ask about this (Feed) and a search result in a side chat: `chat.send.context` names what the
  // agent reads as data (a search result by what the index holds, not what the window says).
  const baseChatContext = withMemoryEntityContext(
    chatContextResolver(
      feedContextResolver(proactive.feed.store),
      (id) => search.index.docOf(id),
      (id) => agentBlockedHit(search.sources, id),
    ),
    () => people?.graph,
  );
  // "Open as a chat" on a Search answer: the Gateway holds the answer and reads its citations
  // again for this connection and this chat's model; every reader of the transcript gets the
  // same pass (`chat.history`, `chat.export`, and the `chat.message` event through the bus).
  everything.useThreadModel(
    (threadId) => {
      const ref = getThread(db, threadId)?.modelRef ?? modelPins.defaultModel?.();
      return ref == null ? true : isCloudRef(ref);
    },
    // An answer opens a chat that has no message yet.
    (threadId) =>
      getThread(db, threadId) !== undefined &&
      db.sqlite.prepare("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1").get(threadId) ===
        undefined,
  );
  // A forget or a retract cuts the words it supported out of the answers kept in chats.
  gateway.context.messageScrub.heal = () => {
    everything.healTranscripts();
    // Recall saved in a thread for its turn goes too (the agent drops it at its next run anyway).
    scrubSavedRecall(db, (threadId) => loop.isActive(threadId));
  };
  gateway.context.chatContext.resolve = (ref, caller) =>
    ref.kind === "life_answer"
      ? everything.lifeChat.resolve(ref, caller)
      : ref.kind === "mail_followup"
        ? mailFollowups.resolveContext(ref)
        : baseChatContext(ref, caller);
  // `$skill` in an owner's message: the chat send path reads the enabled skills it names.
  gateway.context.skillReferences.resolve = (text) => skills.references(text);
  gateway.context.chatFiles.attach = (threadId, paths, by) =>
    rawBroker.attachFiles(threadId, paths, by);
  gateway.context.chatFiles.attached = (threadId) => rawBroker.attachedFiles(threadId);
  // Clear chat and delete end the conversation: its "Allow once" folders and attached files go.
  gateway.context.threadEnded.add(endSessionQuietly(rawBroker, gwOptions.logger));
  gateway.context.messageScrub.scrub = (message, who) => everything.lifeChat.scrub(message, who);
  // Phrases still queued by a Forget before the last shutdown resume here.
  traceScrub.start();
  await proactive.start();
  await nightShiftRef?.start();
  await forksRef?.start();
  const systemZone = new SystemZone();
  const effectiveZone = () => timeZone ?? systemZone.zone;
  await ensureWeeklyCardAutomation(scheduler, { timezone: effectiveZone() });
  // The owner may have travelled (Mac asleep, or hours since the last look): re-read the zone, and
  // when it moved re-sync what is zone-dependent. Automations the owner made keep their own zone.
  async function refreshTimeZone(): Promise<void> {
    const before = effectiveZone();
    systemZone.refresh();
    timeZone = timeZoneOption ?? ownerTimeZoneAt(join(config.home, "workspace", "USER.md"));
    const now = effectiveZone();
    if (now === before) return;
    gwOptions.logger?.log("info", "time zone changed", { from: before, to: now });
    await proactive.syncWorkflowSchedules();
    await ensureWeeklyCardAutomation(scheduler, { timezone: now });
  }
  const logWakeError = (what: string) => (err: unknown) =>
    gwOptions.logger?.log("warn", what, { code: PsycheError.from(err).code });
  // libuv timers stop while the Mac sleeps but the wall clock (leases, due times) does not: when
  // the two drift apart, renew running turns first, then catch the scheduler up and re-read the zone.
  const wakeDetector = createWakeDetector({
    onWake: async () => {
      await pool.renewLeases().catch(logWakeError("lease renewal after wake failed"));
      await specialistPool.renewLeases().catch(logWakeError("lease renewal after wake failed"));
      await forkPool.renewLeases().catch(logWakeError("lease renewal after wake failed"));
      pool.poke();
      specialistPool.poke();
      await scheduler.wake().catch(logWakeError("scheduler catch-up after wake failed"));
      await refreshTimeZone().catch(logWakeError("time zone refresh failed"));
    },
    onError: logWakeError("wake handling failed"),
  });
  const zoneTimer = setInterval(
    () => void refreshTimeZone().catch(logWakeError("time zone refresh failed")),
    3_600_000,
  );
  zoneTimer.unref();
  // Lesson cards that were open at shutdown are awaited again (or settled).
  await teaching.resume().catch(() => undefined);

  if (background) {
    // Recorded runs that were still going when the app stopped have lost their guard (it is in
    // memory). They are cancelled before the pool can requeue an expired lease and run them on;
    // the scheduler then records them as failed and pauses their schedules.
    for (const row of db.sqlite
      .prepare(
        `SELECT id FROM tasks WHERE created_from = 'automation' AND instr(goal, ?) > 0
           AND status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})`,
      )
      .all(RECORDED_RUN_RULES, ...TERMINAL_TASK_STATUSES) as { id: string }[]) {
      await tasks.cancel(row.id, "The app restarted during a recorded run").catch(() => undefined);
    }
    pool.start();
    specialistPool.start();
    forkPool.start();
    wakeDetector.start();
    try {
      await pool.onApprovalsReissued(tokens.takeReissued());
    } catch (err) {
      gwOptions.logger?.log("warn", "rebinding reissued approvals failed", {
        code: PsycheError.from(err).code,
      });
    }
    await scheduler.start();
    keepAwake.sync();
  }

  return {
    gateway,
    db,
    loop,
    otherChats,
    people,
    everything,
    search,
    broker,
    audit,
    memory,
    tasks,
    pool,
    specialistPool,
    raiseSpecialistBudget: (taskId, patch) =>
      raiseSpecialistBudget({ tasks, host: specialists }, taskId, patch),
    scheduler,
    notifier,
    proactive,
    teaching,
    provider,
    vault: vault.vault,
    redactor,
    web: webTools,
    parts,
    async stop(reason) {
      for (const part of [...parts].reverse()) await part.stop?.();
      proactive.stop();
      traceScrub.stop();
      vault.stop();
      wakeDetector.stop();
      clearInterval(zoneTimer);
      await pool.stop();
      await specialistPool.stop();
      await forkPool.stop();
      forksRef?.stop();
      scheduler.stop();
      keepAwake.stop();
      memory.unwatch();
      unsubscribePolicy();
      unsubscribeTraceScrub();
      unsubscribeHelperChange();
      unsubscribeAttention();
      // Suspended subscription-CLI runs end with the Gateway.
      for (const p of router?.providers() ?? []) if (p instanceof CliAdapter) await p.close();
      await gateway.stop(reason);
      if (ownsDb) db.close();
      // A stopped Gateway no longer uses the data folder. Letting go of its lock here (a real
      // Gateway exits next, which releases it anyway) is what lets the folder be removed on
      // Windows, where an open file pins its directory.
      releaseGatewayLock(config.home);
    },
  };
}

export { fileTools } from "@psyche/files";
export {
  BOT_AUTH_SETTING,
  type BrowserSetup,
  botAuthFromSetting,
  type ComposedBrowser,
  composeBrowser,
} from "./browser.ts";
export { CallContexts } from "./call-context.ts";
export {
  type ChannelsSetup,
  type ComposedChannels,
  channelsSetupFromEnv,
  composeChannels,
  type TelegramSetup,
  turnText,
} from "./channels.ts";
export { composeCoding, hostGit } from "./coding.ts";
export { type ComputerDeps, type ComputerUse, createComputerUse } from "./computer.ts";
export {
  type ConnectorsSetup,
  composeConnectors,
  MemoryTokenVault,
} from "./connectors.ts";
export { type ExecToolDeps, execTool } from "./exec-tool.ts";
export {
  composeHelper,
  HELPER_SURFACE,
  type HelperSetup,
  helperPresenceMessage,
  helperPresenceVerifier,
} from "./helper.ts";
export {
  IndexedQuarantineWriter,
  indexedChannelLibrary,
  kindOfMime,
  type LibrarySetup,
  libraryHandlers,
} from "./library.ts";
export { type McpGrantRevoker, type McpLifecycleEvent, mcpGrantRevocation } from "./mcp-grants.ts";
export { modelSetupFromEnv, NO_MODEL, vaultModelSetup } from "./models.ts";
export { partsFromEnv } from "./parts.ts";
export { composePasskeys, PasskeyService, webauthnChallengeFor } from "./passkeys.ts";
export { type ComposedProactive, composeProactive, type ProactiveSetup } from "./proactive.ts";
export { protectedRoots } from "./protected-paths.ts";
export {
  createRealChromeMode,
  type RealChromeMode,
  type RealChromeSetup,
  type RealChromeStatus,
} from "./real-chrome.ts";
export type { ApprovalRelay, ComposedPart, ComposeServices, OwnPorts } from "./services.ts";
export {
  composeSpeech,
  FsAudioLibrary,
  type SpeechSetup,
  speechNode,
  speechSetupFromEnv,
} from "./speech.ts";
export { SqliteThreadStateStore } from "./thread-state.ts";
export { CROSS_THREAD_SETTING, crossThreadToggle, threadTools } from "./thread-tools.ts";
export { type ModelPins, modelPinsFor, restoreModelPins } from "./threads.ts";
export {
  type ComposedVault,
  chooseWrapper,
  composeVault,
  HelperNodeClient,
  isKeychainHelper,
  maskingLogger,
  SECRET_PARAM_METHODS,
  type VaultSetup,
  vaultSetupFromEnv,
} from "./vault.ts";
export { createLogger, surfaceOf };

/**
 * The broker policy as this Gateway applies it: the engine's default workspace root
 * (`/workspace`, the sandbox's) would grant read-write on a host `/workspace` to the host file
 * tools, so here no workspace root exists unless the owner names one (#287).
 */
function hostPolicy(p: PolicyConfig | undefined, db: PsycheDb): PolicyConfig {
  // Lifted floors come only from Settings' confirmed opt-in (`permissions.liftedFloors.<id>`,
  // connector-matrix.ts), never from a stored or imported policy (security §3.12).
  const { liftedFloors: _imported, sensitiveCategories: _stored, ...rest } = p ?? {};
  return {
    ...rest,
    sensitiveCategories: sensitiveCategoriesFrom(db),
    workspaceRoots: p?.workspaceRoots ?? [],
  };
}

/**
 * A broker handle that publishes an approval it issues as `approval.created` once its answer
 * tokens are recorded, so devices see the card (and their own token through the personalizer):
 * every approval for executors, and only `which` ones for the agent loop, whose chat turns the
 * session controller announces itself.
 */
function announcing<B extends PermissionBroker>(
  broker: B,
  publish: (
    event: "approval.created",
    payload: EventPayload<"approval.created">,
    threadId?: string,
  ) => void,
  which: (approval: IssuedApproval["approval"]) => boolean = () => true,
): B {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          const issued = await target.requestApproval(input);
          if (!which(issued.approval)) return issued;
          publish(
            "approval.created",
            { approval: issued.approval },
            issued.approval.requestedBy.threadId ?? undefined,
          );
          return issued;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Approvals also go to the owner's chat surfaces (S10 `ownerSurfaces`, `deliverApproval`) and
 * to the Mac helper's notifications. The broker drops chat surfaces from device-only kinds
 * itself (security §3.7), and the channel service refuses ineligible kinds, so delivery is
 * best-effort and never blocks the request.
 */
function withRelay<B extends PermissionBroker>(
  broker: B,
  relays: readonly ApprovalRelay[],
  log: ComposeOptions["logger"],
): B {
  const deliver = (issued: IssuedApproval) => {
    for (const r of relays) {
      r.deliver(issued).catch((err) =>
        log?.log("warn", "approval delivery failed", { code: PsycheError.from(err).code }),
      );
    }
  };
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          const extra = relays.flatMap((r) => r.surfaces());
          // Decided on the caller's own surfaces, before the relays add theirs: the Mac helper's
          // `notification` must not put a `["desktop"]` card on the phone (broker `offMac`).
          const offMac = input.surfaces.some((s) => s === "notification" || s === "web");
          const withOffMac: PolicyApprovalInput = {
            ...input,
            offMac,
            surfaces:
              extra.length === 0 ? input.surfaces : [...new Set([...input.surfaces, ...extra])],
          };
          const issued = await target.requestApproval(withOffMac);
          deliver(issued);
          return issued;
        };
      }
      if (prop === "reissue") {
        return async () => {
          const issued = await target.reissue();
          for (const i of issued) deliver(i);
          return issued;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
