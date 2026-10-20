import { join } from "node:path";
import {
  AgentToolRegistry,
  type CompactionPolicy,
  createAgentLoop,
  type PsycheAgentLoop,
} from "@psyche/agent-core";
import { createAuditLog, type HashChainAuditLog } from "@psyche/audit";
import { getDevice, getSetting, getThread, openDb, type PsycheDb } from "@psyche/db";
import { fileTools } from "@psyche/files";
import {
  brokerApprovalCheck,
  createMemoryHandlers,
  createMemoryStore,
  type SqliteMemoryStore,
} from "@psyche/memory";
import { createModelRouter, type KeySource, type ModelRouterConfig } from "@psyche/model-router";
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
} from "@psyche/protocol";
import {
  createAutomationHandlers,
  createDbSessionResolver,
  createDeliverer,
  createTaskLauncher,
  type RunLauncher,
  SqliteScheduler,
} from "@psyche/scheduler";
import { createTaskHandlers, SqliteTaskEngine, TaskWorkerPool } from "@psyche/tasks";
import { SecretRedactor, type Vault } from "@psyche/vault";
import { resolveConfig } from "../config.ts";
import type { HandlerDef } from "../context.ts";
import { createLogger } from "../log.ts";
import { type Gateway, type GatewayOptions, startGateway } from "../server.ts";
import { ApprovalTokens } from "./approval-tokens.ts";
import { CallContexts } from "./call-context.ts";
import { ChannelConversations } from "./channel-conversations.ts";
import { composeComputer } from "./computer.ts";
import { composeConversion } from "./convert.ts";
import { composeDictation } from "./dictation.ts";
import { filesHandlers } from "./files.ts";
import {
  mountParamsOnly,
  mountPermissions,
  questionHandlers,
  receiptHandlers,
  surfaceOf,
} from "./handlers.ts";
import { libraryHandlers } from "./library.ts";
import { composePasskeys } from "./passkeys.ts";
import { type ComposedProactive, composeProactive } from "./proactive.ts";
import {
  type ApprovalRelay,
  type ComposedPart,
  type ComposeServices,
  createOwnPorts,
} from "./services.ts";
import { composeSkills } from "./skills.ts";
import { composeSpeech, type SpeechSetup, speechSetupFromEnv } from "./speech.ts";
import { SqliteThreadStateStore } from "./thread-state.ts";
import { CROSS_THREAD_SETTING, crossThreadToggle, threadTools } from "./thread-tools.ts";
import { modelPinsFor, restoreModelPins, threadSettingsHandlers } from "./threads.ts";
import { composeVault, maskingLogger, type VaultSetup, vaultSetupFromEnv } from "./vault.ts";

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
  | { router: ModelRouterConfig; keys?: KeySource; model?: ModelRef; utilityModel?: ModelRef };

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
}

/**
 * The broker only checks presence when it has a verifier. Fail closed: an assertion kind no
 * verifier handles (passkeys until S01 #79) is refused, so approvals that require
 * authentication cannot be answered with it.
 */
const NO_PRESENCE: PresenceVerifier = { verify: async () => false };

export interface ComposedGateway {
  readonly gateway: Gateway;
  readonly db: PsycheDb;
  readonly loop: PsycheAgentLoop;
  readonly broker: PsychePermissionBroker;
  readonly audit: HashChainAuditLog;
  readonly memory: SqliteMemoryStore;
  readonly tasks: SqliteTaskEngine;
  readonly pool: TaskWorkerPool;
  readonly scheduler: SqliteScheduler;
  readonly notifier: PsycheNotifier;
  readonly proactive: ComposedProactive;
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
): { provider: ModelProvider; model: ModelRef; utility?: ModelRef } {
  if ("provider" in setup) {
    return {
      provider: setup.provider,
      model: setup.model,
      ...(setup.utilityModel === undefined ? {} : { utility: setup.utilityModel }),
    };
  }
  const router = createModelRouter(setup.router, {
    clock,
    ...(setup.keys === undefined ? {} : { keys: setup.keys }),
  });
  return {
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

  const audit = createAuditLog({ dir: join(config.home, "audit"), clock });
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
    ...((policy ?? storedPolicy) === undefined
      ? {}
      : { policy: (policy ?? storedPolicy) as PolicyConfig }),
  });
  const broker = withRelay(tokens.wrap(rawBroker), relays, gwOptions.logger);
  // Executors (vault fills, the browser's mid-run gate, sandbox secrets) request approvals
  // outside the loop, which announces only its own: they announce theirs here.
  const executorBroker = announcing(broker, publish);
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
    } else if (e.type === "receipt.created") {
      publish("receipt.created", { receipt: e.receipt });
    }
  });

  const vault = composeVault(
    { home: config.home, db, permissions: executorBroker, audit, clock, publish, redactor },
    vaultSetup ?? vaultSetupFromEnv(gwOptions.env ?? process.env),
  );

  const { provider, model: modelRef, utility } = providerFor(model, clock);
  const modelPins = modelPinsFor(provider);
  const memory = await createMemoryStore({
    db,
    workspaceDir: join(config.home, "workspace"),
    clock,
    ...(timeZone === undefined ? {} : { timeZone }),
    approvals: brokerApprovalCheck(broker),
    audit,
    flush: { provider, model: utility ?? modelRef },
    onEvent: (e) => publish(e.event, e.payload as never),
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
  for (const tool of fileTools({ folders: () => rawBroker.policy.folders }))
    registry.register(tool);
  // E12 cross-thread awareness: registered only while the owner has turned it on.
  let gatewayRef: Gateway | null = null;
  const crossThread = crossThreadToggle(
    (tool) => registry.register(tool),
    threadTools({ db, gateway: () => gatewayRef }),
  );
  crossThread.sync(getSetting(db, CROSS_THREAD_SETTING)?.value);
  const calls = new CallContexts();
  const ownPorts = createOwnPorts();
  ownPorts.add(config.port, "gateway (configured)");
  const services: ComposeServices = {
    db,
    clock,
    home: config.home,
    broker: executorBroker,
    rawBroker,
    channelConversations,
    audit,
    notifier,
    tools: calls.adopt(registry),
    calls,
    publish,
    vault: vault.vault,
    redactor,
    ownPorts,
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  };
  const skills = composeSkills();
  const partFactories = [
    composeComputer,
    skills.part,
    composeSpeech(speechSetup ?? speechSetupFromEnv(gwOptions.env)),
    composeDictation(),
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
  const loop = createAgentLoop({
    // Model-side history survives a restart (issue #52); secrets the vault knows are masked.
    state: new SqliteThreadStateStore(db, redactor),
    provider,
    model: modelRef,
    ...(utility === undefined ? {} : { utilityModel: utility }),
    broker,
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
    // Incognito threads are memory-only (E9, security §8): the loop never flushes them.
    isIncognito: (threadId) => getThread(db, threadId)?.kind === "incognito",
  });
  const pool = new TaskWorkerPool({
    engine: tasks,
    loop,
    clock,
    broker,
    notifier,
    tools: registry,
    ...(taskPollMs === undefined ? {} : { pollMs: taskPollMs }),
  });
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
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(gwOptions.logger === undefined ? {} : { logger: gwOptions.logger }),
  });
  // The agent's proactive tools (goals.*, ideas.*, feed.*): reads allow, changes ask.
  for (const tool of proactiveTools({
    goals: proactive.goals,
    ideas: proactive.ideas,
    feed: proactive.feed,
    clock,
  })) {
    registry.register(tool);
  }
  launcher = proactive.launcher(createTaskLauncher({ engine: tasks, pool }), pool);
  scheduler.subscribe((e) => publish(e.event, e.payload as never));

  // documents.convert: LibreOffice in its own sandbox on the full image (P4).
  parts.push(
    composeConversion({ folders: () => rawBroker.policy.folders ?? [], home: config.home }),
  );
  const handlers: Record<string, HandlerDef> = {
    ...mountPermissions(db, createPermissionHandlers(rawBroker, audit), tokens),
    ...mountParamsOnly(createMemoryHandlers(memory) as never),
    ...mountParamsOnly(createTaskHandlers({ engine: tasks, pool, broker }) as never),
    ...mountParamsOnly(createAutomationHandlers(scheduler) as never),
    ...mountParamsOnly(createNotificationHandlers(notifier) as never),
    ...proactive.handlers,
    ...questionHandlers(loop, tasks),
    ...receiptHandlers(broker),
    ...threadSettingsHandlers(modelPins),
    ...vault.handlers,
    ...filesHandlers({ folders: () => rawBroker.policy.folders ?? [], home: config.home }),
    ...libraryHandlers({ db, home: config.home }),
  };
  for (const part of parts) Object.assign(handlers, part.handlers ?? {});

  const gateway = await startGateway({
    ...gwOptions,
    db,
    agent: loop,
    broker,
    memory,
    handlers,
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
  });
  bus = gateway.bus;
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
      if (entry.key !== "permissions.policy") continue;
      try {
        rawBroker.setPolicy((entry.value ?? {}) as PolicyConfig);
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
  await proactive.start();

  if (background) {
    pool.start();
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
    broker,
    audit,
    memory,
    tasks,
    pool,
    scheduler,
    notifier,
    proactive,
    provider,
    vault: vault.vault,
    redactor,
    parts,
    async stop(reason) {
      for (const part of [...parts].reverse()) await part.stop?.();
      vault.stop();
      await pool.stop();
      scheduler.stop();
      memory.unwatch();
      unsubscribePolicy();
      await gateway.stop(reason);
      if (ownsDb) db.close();
    },
  };
}

export { fileTools } from "@psyche/files";
export { type BrowserSetup, type ComposedBrowser, composeBrowser } from "./browser.ts";
export { CallContexts } from "./call-context.ts";
export {
  type ChannelsSetup,
  type ComposedChannels,
  channelsSetupFromEnv,
  composeChannels,
  type TelegramSetup,
  turnText,
} from "./channels.ts";
export {
  type ConnectorsSetup,
  composeConnectors,
  MemoryTokenVault,
} from "./connectors.ts";
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
export { modelSetupFromEnv, NO_MODEL } from "./models.ts";
export { partsFromEnv } from "./parts.ts";
export { composePasskeys, PasskeyService, webauthnChallengeFor } from "./passkeys.ts";
export { type ComposedProactive, composeProactive, type ProactiveSetup } from "./proactive.ts";
export {
  createRealChromeMode,
  type RealChromeMode,
  type RealChromeSetup,
  type RealChromeStatus,
} from "./real-chrome.ts";
export type { ApprovalRelay, ComposedPart, ComposeServices, OwnPorts } from "./services.ts";
export {
  composeSpeech,
  dbMessageSource,
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
 * A broker handle for executors: an approval they request is published as `approval.created`
 * once its answer tokens are recorded, so devices see the card (and their own token through the
 * personalizer). The agent loop keeps the plain handle and announces its approvals itself.
 */
function announcing<B extends PermissionBroker>(
  broker: B,
  publish: (
    event: "approval.created",
    payload: EventPayload<"approval.created">,
    threadId?: string,
  ) => void,
): B {
  return new Proxy(broker, {
    get(target, prop, receiver) {
      if (prop === "requestApproval") {
        return async (input: ApprovalRequestInput) => {
          const issued = await target.requestApproval(input);
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
