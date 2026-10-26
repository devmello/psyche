import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentToolRegistry,
  type CompactionPolicy,
  createAgentLoop,
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
import { getDevice, getSetting, getThread, openDb, type PsycheDb, setSetting } from "@psyche/db";
import { fileTools } from "@psyche/files";
import {
  brokerApprovalCheck,
  consolidateLessons,
  createMemoryHandlers,
  createMemoryStore,
  retireUnanswered,
  type SqliteMemoryStore,
} from "@psyche/memory";
import {
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
  createNotificationHandlers,
  PsycheNotifier,
  SqliteNotificationStore,
  toGatewayEvent,
} from "@psyche/notifications";
import {
  compilePolicy,
  createPermissionHandlers,
  DENY_ALL_LOOPBACK,
  type LocalProjectVerifier,
  type PolicyConfig,
  type PresenceVerifier,
  PsychePermissionBroker,
  RESTORE_MARKER,
  RevocationLedger,
  replayRevocations,
  SqlitePermissionStore,
} from "@psyche/permissions";
import { proactiveTools, publicFetch } from "@psyche/proactive";
import {
  type ApprovalRequestInput,
  type Clock,
  type EventName,
  type EventPayload,
  type IssuedApproval,
  type ModelProvider,
  type ModelRef,
  type PermissionBroker,
  PsycheError,
  type Task,
} from "@psyche/protocol";
import {
  createAutomationHandlers,
  createDbSessionResolver,
  createDeliverer,
  createTaskLauncher,
  type RunLauncher,
  SqliteScheduler,
} from "@psyche/scheduler";
import { WEB_SEARCH_PROVIDER_SETTING, WEB_SEARCH_SEARXNG_SETTING } from "@psyche/search";
import { createTaskHandlers, SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import { SecretRedactor, type Vault } from "@psyche/vault";
import { resolveConfig } from "../config.ts";
import type { HandlerDef } from "../context.ts";
import type { PublicRoute, WebhookRoute } from "../http.ts";
import { createLogger } from "../log.ts";
import { taskRunTrace } from "../run-trace/tasks.ts";
import { type Gateway, type GatewayOptions, startGateway } from "../server.ts";
import { ApprovalTokens } from "./approval-tokens.ts";
import { artifactContextProvider, composeArtifacts } from "./artifacts.ts";
import { attentionHandlers, OwnerAttention, parkWhenUnwatched } from "./attention.ts";
import { createAutoTitler } from "./auto-title.ts";
import { withAutomationSpecialists } from "./automation-specialists.ts";
import { bootstrapAdminHandlers } from "./bootstrap-admin.ts";
import { CallContexts } from "./call-context.ts";
import { ChannelConversations } from "./channel-conversations.ts";
import { composeComputer } from "./computer.ts";
import { createContext } from "./context.ts";
import { composeConversion } from "./convert.ts";
import { composeDictation } from "./dictation.ts";
import { feedContextResolver } from "./feed-context.ts";
import { filesHandlers } from "./files.ts";
import {
  mountParamsOnly,
  mountPermissions,
  questionHandlers,
  receiptHandlers,
  surfaceOf,
} from "./handlers.ts";
import { composeHarnesses } from "./harnesses.ts";
import { insightsHandlers } from "./insights.ts";
import { libraryHandlers } from "./library.ts";
import {
  clearModelKey,
  type HostedModelKind,
  hasModelKey,
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
import { createOtherChats, type OtherChats } from "./other-chats.ts";
import { composePasskeys } from "./passkeys.ts";
import { composePayments, paymentsSetupFromEnv } from "./payments.ts";
import { composePeople, type People } from "./people.ts";
import { graphSourceAdapters } from "./people-sources.ts";
import { composePlugins } from "./plugins.ts";
import { type ComposedProactive, composeProactive } from "./proactive.ts";
import { protectedRoots } from "./protected-paths.ts";
import { createRateLimits } from "./rate-limits.ts";
import type { ComposedSandbox } from "./sandbox.ts";
import { composeScreenAsk, type ScreenAskOptions } from "./screen-ask.ts";
import { type ComposedSearch, composeSearch } from "./search.ts";
import {
  type ApprovalRelay,
  type ComposedPart,
  type ComposeServices,
  createOwnPorts,
} from "./services.ts";
import { composeSkills } from "./skills.ts";
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
import { taskUpdateHandlers } from "./task-controls.ts";
import {
  type ComposedTeaching,
  composeTeaching,
  TEACHING_ASK_RULES_KEY,
  teachingAskRules,
  teachingSettings,
} from "./teaching.ts";
import { SqliteThreadStateStore } from "./thread-state.ts";
import { CROSS_THREAD_SETTING, crossThreadToggle, threadTools } from "./thread-tools.ts";
import { modelPinsFor, restoreModelPins, threadSettingsHandlers } from "./threads.ts";
import { usageSummaryHandlers } from "./usage-summary.ts";
import { createUserProfile } from "./user-profile.ts";
import { composeVault, maskingLogger, type VaultSetup, vaultSetupFromEnv } from "./vault.ts";
import { composeWebTools, type WebToolsSetup } from "./web-tools.ts";
import { ensureWeeklyCardAutomation, withWeeklyCard } from "./weekly-card.ts";
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
   * Speech (S17: dictation, voice memos, read-aloud, voices) is always mounted; this sets its
   * process runner prefix (default: `speechSetupFromEnv`).
   */
  speech?: SpeechSetup;
  /** Ask about my screen is always mounted; this swaps what takes the capture (default: the Mac helper). */
  screenAsk?: ScreenAskOptions;
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
  readonly parts: readonly ComposedPart[];
  stop(reason?: string): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now() };

function providerFor(
  setup: ModelSetup,
  clock: Clock,
  db: PsycheDb,
  home: string,
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
  const router = createModelRouter(
    { ...setup.router, providers },
    {
      clock,
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

export async function composeGateway(options: ComposeOptions): Promise<ComposedGateway> {
  const {
    model,
    policy,
    clock: clockOpt,
    timeZone,
    background = true,
    taskPollMs,
    compaction,
    parts: extraParts = [],
    speech: speechSetup,
    presence = NO_PRESENCE,
    vault: vaultSetup,
    web: webSetup,
    ...gwOptions
  } = options;
  const clock =
    clockOpt ??
    (options.now ? { now: () => options.now?.().getTime() ?? Date.now() } : systemClock);
  const config = resolveConfig(gwOptions.env ?? process.env, gwOptions.config ?? {});
  // One redactor for the vault, payments and logs: a value the vault handed out is masked
  // wherever it would be written.
  const redactor = new SecretRedactor();
  gwOptions.logger = maskingLogger(gwOptions.logger ?? createLogger(), redactor);
  // A database the caller passes in stays theirs to close; one compose opens, `stop()` closes.
  const ownsDb = gwOptions.db === undefined;
  const db =
    gwOptions.db ?? openDb(config.dbPath, { now: () => new Date(clock.now()).toISOString() });

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
  });
  // A restored backup's log is shorter than what this key anchored; the restore is audited with
  // the head it had (replayRevocations below consumes the marker).
  if (existsSync(join(config.home, RESTORE_MARKER))) {
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
  // Revocations live outside the backup scope; a restored database cannot bring a revoked device
  // or grant back (S23 design-26). Replay before anything authenticates.
  const nowIso = () => new Date(clock.now()).toISOString();
  const revocations = new RevocationLedger(config.home, nowIso);
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
  const notifier = new PsycheNotifier({
    // Tables come from @psyche/db's migration ledger (202610190200_notifications_init).
    store: new SqliteNotificationStore(db.sqlite),
    clock,
  });
  const storedPolicy = validPolicy(getSetting(db, "permissions.policy")?.value, gwOptions.logger);
  const tokens = new ApprovalTokens();
  const relays: ApprovalRelay[] = [];
  const parts: ComposedPart[] = [];
  const presenceByKind = new Map<string, PresenceVerifier>();
  const presenceReady: (() => boolean)[] = [];
  // The localhost rule (security §3.10) needs OS probes a part supplies (the browser's dev
  // preview); until one does, no loopback origin is the owner's project.
  let localProject: LocalProjectVerifier = DENY_ALL_LOOPBACK;
  // Inbound channel decisions (filled by the channels part) back the broker's reply authority.
  const channelConversations = new ChannelConversations();
  const attention = new OwnerAttention(() => clock.now());
  const rawBroker = new PsychePermissionBroker({
    channelConversations: (ref) => channelConversations.get(ref),
    approvers: {
      async device(deviceId) {
        const d = getDevice(db, deviceId);
        if (d === undefined) return undefined;
        // The mac helper answers only through its part's relay, on the `notification` surface.
        const viaPart = parts.some((p) => p.approver?.(deviceId) === true);
        return {
          scopes: viaPart ? [...d.scopes, "operator.approvals"] : d.scopes,
          ...(d.revokedAt ? { revoked: true } : {}),
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
    store: new SqlitePermissionStore(db.sqlite),
    audit,
    notifier,
    clock,
    revocations,
    psycheHome: config.home,
    presence: {
      verify: (assertion, challenge, deviceId) =>
        (presenceByKind.get(assertion.kind) ?? presence).verify(assertion, challenge, deviceId),
    },
    localProject: { check: (url) => localProject.check(url) },
    // The agent never acts on Psyche's own UI (prohibitions `gateway_origin`): every origin it is served on.
    gatewayOrigins: [
      `http://127.0.0.1:${config.port}`,
      `http://localhost:${config.port}`,
      ...config.allowedOrigins.filter((o) => /^https?:\/\//.test(o)),
    ],
    policy: hostPolicy((policy ?? storedPolicy) as PolicyConfig | undefined),
  });
  const broker = withRelay(tokens.wrap(rawBroker), relays, gwOptions.logger);
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

  const vaultKeys = "router" in model && model.vaultKeys === true;
  const modelSetup: ModelSetup = vaultKeys
    ? { ...model, keys: vaultModelKeys(() => vault.vault) }
    : model;
  const routed = providerFor(modelSetup, clock, db, config.home);
  const { model: modelRef, utility, router } = routed;
  const provider = vaultKeys && router !== undefined ? untilPrimaryPicked(router) : routed.provider;
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
            has: (id: string) => hasModelKey(vault.vault, id),
            store: (id: HostedModelKind, key: string) => storeModelKey(vault.vault, id, key),
            clear: (id: HostedModelKind) => clearModelKey(vault.vault, id),
          },
        }
      : {}),
  };
  await restoreModelSettings(modelSettings);
  const modelPins = modelPinsFor(provider);
  // The people graph is composed once the tool registry exists; card edits reach it from here.
  let people: People | undefined;
  const memory = await createMemoryStore({
    db,
    workspaceDir: join(config.home, "workspace"),
    clock,
    ...(timeZone === undefined ? {} : { timeZone }),
    approvals: brokerApprovalCheck(broker),
    audit,
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
  for (const tool of fileTools({
    // No folder list means nothing is granted (#287), never "only the broker checks".
    folders: () => rawBroker.policy.folders ?? [],
    protectedRoots: () => protectedRoots(config.home),
  }))
    registry.register(tool);
  // E12 cross-thread awareness: registered only while the owner has turned it on.
  let gatewayRef: Gateway | null = null;
  const crossThread = crossThreadToggle(
    (tool) => registry.register(tool),
    threadTools({ db, gateway: () => gatewayRef }),
  );
  crossThread.sync(getSetting(db, CROSS_THREAD_SETTING)?.value);
  // People and projects (#651): handlers, owner-only agent tools, search docs, the nightly pass.
  people = composePeople({
    db,
    clock,
    memory,
    provider,
    model: utility ?? modelRef,
    publish: (event, payload) => publish(event, payload as never),
    register: (tool) => registry.register(tool),
    // Tests drive `people.poll()` by hand.
    ...(background ? {} : { pollIntervalMs: 0, afterRunDelayMs: 0 }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  const calls = new CallContexts();
  const ownPorts = createOwnPorts();
  ownPorts.add(config.port, "gateway (configured)");
  const services: ComposeServices = {
    db,
    clock,
    home: config.home,
    approvalTokens: tokens,
    broker: executorBroker,
    rawBroker,
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
    skills.part,
    composeSpeech(speechSetup ?? speechSetupFromEnv(gwOptions.env)),
    composeDictation(),
    composeScreenAsk(gwOptions.screenAsk),
    // Canvas artifacts (chat-experience-2026 §4.3): the version store and `artifact.*` tools.
    composeArtifacts,
    composePayments(paymentsSetupFromEnv(gwOptions.env)),
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
    }
    if (part.localProject !== undefined) {
      localProject = part.localProject;
      localProjectSupplied = true;
    }
  }
  // The people graph's deterministic pass reads the connected apps through their tools (#732).
  const connectorsPart = parts.find(
    (p): p is ComposedPart & { registry: ConnectorRegistry } => "registry" in p && "mail" in p,
  );
  people.useSources(() =>
    graphSourceAdapters({
      connectors: async () => (connectorsPart === undefined ? [] : connectorsPart.registry.list()),
      tools: services.tools,
      clock,
      db,
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
    cancel: async (run, reason) => launcher?.cancel?.(run, reason),
  };
  const scheduler = new SqliteScheduler({
    db,
    clock,
    notifier,
    launcher: lateLauncher,
    sessions: createDbSessionResolver(db),
    deliverer: createDeliverer({ notifier, broker }),
    // Watches (O3) read public pages through the guarded fetch until S09 exports its own.
    watchFetch: publicFetch(),
    ...(timeZone === undefined ? {} : { defaultTimezone: timeZone }),
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
  const userProfile = createUserProfile({
    db,
    memory,
    provider,
    model: utility ?? modelRef,
    active: utility !== undefined,
    redactor,
    audit,
    broker: executorBroker,
    surfaces: ["desktop", "web"],
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
    onForgotten: (factId, threadId) => teachingRef?.onLearnedUndo(factId, threadId),
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
        rawBroker.setPolicy(hostPolicy(next as PolicyConfig));
        publish("settings.changed", { entries: [entry] });
      },
      owned: () => (getSetting(db, TEACHING_ASK_RULES_KEY)?.value as string[] | undefined) ?? [],
      setOwned: (rules) => void setSetting(db, TEACHING_ASK_RULES_KEY, rules),
    }),
    publish: (event, payload, threadId) => publish(event, payload as never, threadId),
  });
  teachingRef = teaching;
  parts.push(teaching.part);
  const loop = createAgentLoop({
    // Model-side history survives a restart (issue #52); secrets the vault knows are masked.
    state: new SqliteThreadStateStore(db, redactor),
    provider,
    model: modelRef,
    ...(utility === undefined ? {} : { utilityModel: utility }),
    broker: loopBroker,
    memory,
    tasks,
    notifier,
    scheduler,
    registry,
    clock,
    ...(timeZone === undefined ? {} : { timeZone }),
    approvalSurfaces: ["desktop", "web"],
    skills: skills.loader,
    ...(compaction === undefined ? {} : { compaction }),
    contextProviders: [
      otherChats.provider,
      ...(people === undefined ? [] : [people.recall]),
      artifactContextProvider(db),
    ],
    contextLimits: context.contextLimits,
    onContextUsage: context.onContextUsage,
    onCompaction: context.onCompaction,
    onOwnerTurn: userProfile.onOwnerTurn,
    // Incognito threads are memory-only (E9, security §8): the loop never flushes them.
    isIncognito: (threadId) => getThread(db, threadId)?.kind === "incognito",
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
  // Awaited by the loop before its `end` event, so a chat run's lessons are known before the
  // controller commits the transcript and publishes `run.updated`.
  loop.hooks.on("agent_end", (ctx) =>
    teaching.onRunEnd({
      runId: ctx.runId,
      ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
      subagent: ctx.subagent,
    }),
  );
  const pool = new TaskWorkerPool({
    engine: tasks,
    loop,
    clock,
    broker,
    notifier,
    tools: registry,
    ...(taskPollMs === undefined ? {} : { pollMs: taskPollMs }),
    // Run trace §4.2: each task turn is its own run (ULID), recorded like a chat turn.
    newRunId: () => db.newId(),
    trace: taskRunTrace({
      db,
      sink: () => gatewayRef?.context.runTrace,
      publish,
      modelRef,
      onError: (err) =>
        gwOptions.logger?.log("warn", "task run trace failed", {
          code: PsycheError.from(err).code,
        }),
    }),
    // Specialist jobs run in their own pool, so they never take the chat tasks' slots.
    claim: { excludeOrigins: ["subagent"] },
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
  });
  pokeSpecialists = () => specialistPool.poke();
  const speechPart = parts.find(
    (p): p is ComposedPart & { meetings: MeetingIngest } => "meetings" in p,
  );
  // S15: goal check-ins and the Feed run in-process; the heartbeat gets its 5k-token budget (O2).
  const proactive = composeProactive({
    db,
    clock,
    scheduler,
    notifier,
    tasks,
    memory,
    provider,
    model: utility ?? modelRef,
    publish,
    broker,
    registry,
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
          }),
    },
    // The people graph while the owner has it on: prep's attendees and loops, notes' loops.
    graph: () => (people?.settings().enabled === true ? people.graph : undefined),
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
  // #557: web.search / web.fetch on every surface (read-only, untrusted output).
  const webTools = composeWebTools(
    {
      db,
      env: gwOptions.env ?? process.env,
      publish,
      redactor,
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    },
    webSetup,
  );
  for (const tool of webTools.tools) registry.register(tool);
  // The dreaming automation runs memory dreaming and the people graph pass in-process.
  // Dreaming, then the lesson pass (teaching loop §6, #681), then the people graph pass.
  // Automations with a `specialist` run as unattended specialist jobs (specialists §4.10).
  launcher = withAutomationSpecialists(
    people.launcher(
      // The weekly "What I learned" Feed post (teaching loop §5.4) runs in-process too.
      withWeeklyCard(proactive.launcher(createTaskLauncher({ engine: tasks, pool }), pool), {
        store: teaching.service.store,
        memory,
        clock,
        enabled: () =>
          teachingSettings(db).enabled && getSetting(db, "teaching.weeklyCard")?.value !== false,
        post: (card) => proactive.feed.postGrowth(card),
      }),
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
      folders: () => rawBroker.policy.folders ?? [],
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
        const keys: readonly string[] = WORKFLOW_SETTING_KEYS;
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
  const search = composeSearch({
    db,
    home: config.home,
    memory,
    tasks,
    now: () => clock.now(),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  parts.push(search);
  parts.push(people.part(scheduler, timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone));
  // Code plugins (T4): off until the owner turns on `plugins.enabled`.
  parts.push(
    composePlugins({
      db,
      home: config.home,
      broker: executorBroker,
      loop,
      ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
    }),
  );
  // documents.convert: LibreOffice in its own sandbox on the full image (P4).
  parts.push(
    composeConversion({ folders: () => rawBroker.policy.folders ?? [], home: config.home }),
  );
  const handlers: Record<string, HandlerDef> = {
    ...mountPermissions(db, createPermissionHandlers(rawBroker, audit), tokens),
    ...mountParamsOnly(createMemoryHandlers(memory, { teaching: teaching.service.store }) as never),
    ...mountParamsOnly(userProfile.handlers as never),
    ...teaching.handlers,
    ...mountParamsOnly(
      context.handlers(
        () => loop,
        (threadId) =>
          loop.effectiveContextLimits(threadId, getThread(db, threadId)?.modelRef ?? undefined),
      ) as never,
    ),
    ...mountParamsOnly(
      createTaskHandlers({ engine: tasks, pool, pools: [specialistPool], broker }) as never,
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
    ...mountParamsOnly(createNotificationHandlers(notifier) as never),
    ...proactive.handlers,
    ...questionHandlers(loop, tasks),
    ...receiptHandlers(broker),
    ...threadSettingsHandlers(modelPins),
    ...vault.handlers,
    ...bootstrapAdminHandlers({ db, audit }),
    ...filesHandlers({ folders: () => rawBroker.policy.folders ?? [], home: config.home }),
    ...attentionHandlers(attention),
    ...libraryHandlers({ db, home: config.home }),
    ...modelSettingsHandlers(modelSettings),
    // The Overview's aggregates (docs/design/agent-overview-2026.md §6.2): read-only SQL.
    ...insightsHandlers({ db }),
    // The sidebar's usage footer (#599): a read over the run ledger.
    ...usageSummaryHandlers({
      db,
      providers: modelSettings.providers,
      primary: () => router?.role("primary")?.model ?? modelSettings.fixedModel,
    }),
  };
  for (const part of parts) Object.assign(handlers, part.handlers ?? {});
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
    db,
    agent: loop,
    broker,
    memory,
    handlers,
    webhooks,
    publicRoutes,
    onDeviceRevoked: (deviceId) => {
      revocations.recordDevice(deviceId);
      return rawBroker.revokeGrantsByDevice(deviceId);
    },
    // Its receipt events are forwarded to the bus above; nodes.invoke must not repeat them.
    brokerPublishesReceipts: true,
    // Security settings need fresh presence once a verifier can verify (security §10): an
    // explicit one, or a part's with a registered key (the helper without keys is not).
    settingsPresence: () => presence !== NO_PRESENCE || presenceReady.some((ready) => ready()),
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
  // The owner's folder grants and rules apply without a restart (settings.set → broker policy).
  const unsubscribePolicy = gateway.bus.subscribe(["operator.read"], (frame) => {
    const f = JSON.parse(frame) as {
      event?: string;
      payload?: { entries?: { key: string; value: unknown }[] };
    };
    if (f.event !== "settings.changed") return;
    for (const entry of f.payload?.entries ?? []) {
      if (entry.key === CROSS_THREAD_SETTING) crossThread.sync(entry.value);
      if (entry.key === WEB_SEARCH_PROVIDER_SETTING || entry.key === WEB_SEARCH_SEARXNG_SETTING)
        webTools.refresh();
      if (entry.key !== "permissions.policy") continue;
      try {
        rawBroker.setPolicy(hostPolicy((entry.value ?? {}) as PolicyConfig));
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
  for (const part of parts) await part.start?.(gateway);
  // Ask about this (Feed): `chat.send.context` names a feed item the agent reads as untrusted data.
  gateway.context.chatContext.resolve = feedContextResolver(proactive.feed.store);
  await proactive.start();
  await ensureWeeklyCardAutomation(scheduler, {
    timezone: timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  // Lesson cards that were open at shutdown are awaited again (or settled).
  await teaching.resume().catch(() => undefined);

  if (background) {
    pool.start();
    specialistPool.start();
    try {
      await pool.onApprovalsReissued(tokens.takeReissued());
    } catch (err) {
      gwOptions.logger?.log("warn", "rebinding reissued approvals failed", {
        code: PsycheError.from(err).code,
      });
    }
    await scheduler.start();
  }

  return {
    gateway,
    db,
    loop,
    otherChats,
    people,
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
    parts,
    async stop(reason) {
      for (const part of [...parts].reverse()) await part.stop?.();
      proactive.stop();
      vault.stop();
      await pool.stop();
      await specialistPool.stop();
      scheduler.stop();
      memory.unwatch();
      unsubscribePolicy();
      unsubscribeAttention();
      // Suspended subscription-CLI runs end with the Gateway.
      for (const p of router?.providers() ?? []) if (p instanceof CliAdapter) await p.close();
      await gateway.stop(reason);
      if (ownsDb) db.close();
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
function hostPolicy(p: PolicyConfig | undefined): PolicyConfig {
  return { ...(p ?? {}), workspaceRoots: p?.workspaceRoots ?? [] };
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
          const issued = await target.requestApproval(
            extra.length === 0
              ? input
              : { ...input, surfaces: [...new Set([...input.surfaces, ...extra])] },
          );
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
