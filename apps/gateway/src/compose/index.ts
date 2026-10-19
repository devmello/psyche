import { join } from "node:path";
import {
  AgentToolRegistry,
  type CompactionPolicy,
  createAgentLoop,
  type PsycheAgentLoop,
} from "@psyche/agent-core";
import { createAuditLog, type HashChainAuditLog } from "@psyche/audit";
import { getDevice, getSetting, openDb, type PsycheDb } from "@psyche/db";
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
  createPermissionHandlers,
  type PolicyConfig,
  PsychePermissionBroker,
  SqlitePermissionStore,
} from "@psyche/permissions";
import {
  type Clock,
  type EventName,
  type EventPayload,
  type ModelProvider,
  type ModelRef,
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
import { resolveConfig } from "../config.ts";
import type { HandlerDef } from "../context.ts";
import { createLogger } from "../log.ts";
import { type Gateway, type GatewayOptions, startGateway } from "../server.ts";
import { ApprovalTokens } from "./approval-tokens.ts";
import { fileTools } from "./file-tools.ts";
import { mountParamsOnly, mountPermissions, questionHandlers, surfaceOf } from "./handlers.ts";

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
}

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
  readonly provider: ModelProvider;
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

export async function composeGateway(options: ComposeOptions): Promise<ComposedGateway> {
  const {
    model,
    policy,
    clock: clockOpt,
    timeZone,
    background = true,
    taskPollMs,
    compaction,
    ...gwOptions
  } = options;
  const clock =
    clockOpt ??
    (options.now ? { now: () => options.now?.().getTime() ?? Date.now() } : systemClock);
  const config = resolveConfig(gwOptions.env ?? process.env, gwOptions.config ?? {});
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
  const notifier = new PsycheNotifier({
    store: new SqliteNotificationStore(db.sqlite, { migrate: true }),
    clock,
  });
  const storedPolicy = getSetting(db, "permissions.policy")?.value as PolicyConfig | undefined;
  const tokens = new ApprovalTokens();
  const rawBroker = new PsychePermissionBroker({
    approvers: {
      async device(deviceId) {
        const d = getDevice(db, deviceId);
        return d === undefined
          ? undefined
          : { scopes: d.scopes, ...(d.revokedAt ? { revoked: true } : {}) };
      },
      // Channels (S10) are not on the INT-1 path: no channel sender is the owner here.
      isOwnerSender: async () => false,
    },
    store: new SqlitePermissionStore(db.sqlite),
    audit,
    notifier,
    clock,
    psycheHome: config.home,
    gatewayOrigins: [`127.0.0.1:${config.port}`, `localhost:${config.port}`],
    ...((policy ?? storedPolicy) === undefined
      ? {}
      : { policy: (policy ?? storedPolicy) as PolicyConfig }),
  });
  const broker = tokens.wrap(rawBroker);
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

  const { provider, model: modelRef, utility } = providerFor(model, clock);
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
  tasks.subscribe((e) => publish(e.event, e.payload as never));
  notifier.subscribe((e) => {
    const { event, payload } = toGatewayEvent(e);
    publish(event, payload as never);
  });

  const registry = new AgentToolRegistry();
  for (const tool of fileTools()) registry.register(tool);

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
    ...(timeZone === undefined ? {} : { defaultTimezone: timeZone }),
  });
  const loop = createAgentLoop({
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
    ...(compaction === undefined ? {} : { compaction }),
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
  launcher = createTaskLauncher({ engine: tasks, pool });
  scheduler.subscribe((e) => publish(e.event, e.payload as never));

  const handlers: Record<string, HandlerDef> = {
    ...mountPermissions(db, createPermissionHandlers(rawBroker, audit), tokens),
    ...mountParamsOnly(createMemoryHandlers(memory) as never),
    ...mountParamsOnly(createTaskHandlers({ engine: tasks, pool, broker }) as never),
    ...mountParamsOnly(createAutomationHandlers(scheduler) as never),
    ...mountParamsOnly(createNotificationHandlers(notifier) as never),
    ...questionHandlers(loop, tasks),
  };

  const gateway = await startGateway({
    ...gwOptions,
    db,
    agent: loop,
    broker,
    memory,
    handlers,
  });
  bus = gateway.bus;
  // The owner's folder grants and rules apply without a restart (settings.set → broker policy).
  const unsubscribePolicy = gateway.bus.subscribe(["operator.read"], (frame) => {
    const f = JSON.parse(frame) as {
      event?: string;
      payload?: { entries?: { key: string; value: unknown }[] };
    };
    if (f.event !== "settings.changed") return;
    for (const entry of f.payload?.entries ?? []) {
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

  if (background) {
    pool.start();
    pool.onApprovalsReissued(tokens.reissued);
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
    provider,
    async stop(reason) {
      await pool.stop();
      scheduler.stop();
      memory.unwatch();
      unsubscribePolicy();
      await gateway.stop(reason);
    },
  };
}

export { modelSetupFromEnv, NO_MODEL } from "./models.ts";
export { createLogger, surfaceOf };
