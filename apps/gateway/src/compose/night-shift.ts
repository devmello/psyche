import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AgentToolRegistry,
  bindingHash,
  connectorToolName,
  paramsHash,
  STAGING_CONNECTOR_TYPES,
  stagingToolVisible,
} from "@psyche/agent-core";
import {
  bindStagedApproval,
  createThread,
  getNight,
  getNightByDate,
  getPlanForkBranch,
  getSetting,
  getStagedAction,
  insertNight,
  insertStagedAction,
  listBoundStagedActions,
  listNights,
  listStagedActions,
  listStagedActionsByApproval,
  listStagedActionsForBranch,
  type PsycheDb,
  pruneClosedNights,
  unbindStagedApproval,
  updateNight,
  updateStagedAction,
} from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type {
  ApplyBroker,
  ApplySource,
  ApplyStore,
  GateState,
  NightShiftCaller,
} from "@psyche/proactive";
import {
  type CalendarEventInput,
  type CandidateSource,
  calendarOverlapCandidates,
  createAdapters,
  createNightShiftHandlers,
  createReadRegistry,
  createStager,
  type FollowupInput,
  type FollowupStore,
  fileCandidates,
  followupsSource,
  fromMessages,
  MESSAGES_ITEM_LINE,
  type NightJobInput,
  type NightNotice,
  NightShiftApply,
  NightShiftService,
  type NightStore,
  quietThreadCandidates,
  readNightShiftSettings,
  readTool,
  type SchedulerLike,
  type ToolLookup,
} from "@psyche/proactive";
import type {
  ApprovalRequest,
  Clock,
  MethodParams,
  MethodResult,
  StagedAction,
  Staging,
  Task,
  Usage,
} from "@psyche/protocol";
import { PsycheError, type Surface } from "@psyche/protocol";
import type { KeepAwake } from "@psyche/scheduler";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Night shift in the Gateway (docs/design/night-shift-2026.md §2.2, §3.1, §4). It wires the service
 * to the real stores, the task engine, the live connectors and the machine's state, and serves the
 * read side of `nightShift.*` (status, review.get, runNow). Apply, undo and dismiss belong to W5.
 *
 * Nothing here runs a tool. The stager records calls; the per-job toolset keeps browser, computer
 * use, exec, MCP, `web.*`, `machine_files`, `location_current` and connector authoring out of the
 * job's registry altogether.
 */

export interface NightShiftTasks {
  create(input: {
    threadId: string;
    title: string;
    goal: string;
    createdFrom: "automation";
    mode: "unattended";
    budget: { maxSteps?: number; maxTokens?: number; maxWallMs?: number };
    staging: Staging;
    taint?: boolean;
    taintSources?: { sourceKind: string; origin: string }[];
  }): Promise<Task>;
  get(id: string): Promise<Task | undefined>;
  cancel(id: string, reason: string): Promise<unknown>;
  subscribe(
    listener: (e: { event: string; payload: { task?: { id: string; status: string } } }) => void,
  ): () => void;
}

export interface NightShiftSetup {
  db: PsycheDb;
  clock: Clock;
  scheduler: SchedulerLike;
  notifier: Pick<PsycheNotifier, "notify">;
  tasks: NightShiftTasks;
  /** Wakes the task pool after a task is created. */
  poke: () => void;
  /** The loop's tool registry: the toolset predicate reads each tool's side effect from it. */
  registry: AgentToolRegistry;
  /** Bare connector tools (`mail_read`, ...): filtered to reads here. */
  lookup: () => ToolLookup | undefined;
  keepAwake: Pick<KeepAwake, "acquire">;
  readState: () => Promise<GateState>;
  timeZone: () => string;
  /** The live connectors: id and type (`apple`, `google`, `microsoft`, `mail`, ...). */
  connectors: () => Promise<
    readonly {
      id: string;
      type: string;
      status?: string;
      label?: string;
      config?: Record<string, unknown>;
    }[]
  >;
  /** Granted folders with their mode, judged at use time. */
  folders: () => readonly { path: string; mode: "ro" | "rw" }[];
  mailCandidates: () => Promise<Parameters<typeof quietThreadCandidates>[0]>;
  followups: FollowupStore;
  /** The promise ledger's provider replaces `daily.followups` here once it exists. */
  promiseCandidates?: () => readonly FollowupInput[];
  redact?: (text: string) => string;
  publish?: (event: string, payload: unknown) => void;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
  pollMs?: number;
  /** The Permission Broker: apply, undo and their children (W5). Absent: those methods refuse. */
  broker?: ApplyBroker;
  /** The calling device's approval surface: tokens go to it only. */
  surfaceOf?: (deviceId: string) => Surface;
  /**
   * A plan fork's Take settled (fork-a-plan-2026 §3.4): the apply ran, or the approval was
   * declined, expired or invalidated. `planForks.*` moves the fork on from here.
   */
  onForkApplySettled?: (
    source: Extract<ApplySource, { kind: "fork" }>,
    approval: ApprovalRequest,
    outcome: "applied" | "not_approved",
  ) => void;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** A `ToolLookup` that only ever hands out read tools (`none` or `read`): never a write method. */
export function readOnlyLookup(inner: ToolLookup | undefined): ToolLookup {
  return {
    get(name) {
      const reg = inner?.get(name);
      if (reg === undefined) return undefined;
      return reg.spec.sideEffect === "read" || reg.spec.sideEffect === "none" ? reg : undefined;
    },
  };
}

const PREVIEW_KIND = {
  mail: "mail",
  calendar: "calendar",
  reminders: "reminder",
  files: "file",
} as const;

/** What a remote caller sees in place of an item made from Messages (the owner rule: no Messages on remote devices). */
export { MESSAGES_ITEM_LINE };

/**
 * An item whose taint includes `message` keeps its counts, kind and status for a caller that is not
 * the desktop shell on this Mac, and nothing else: summary, preview, params, why, the capture and
 * the undo data are replaced or cleared.
 */
export function forRemote(item: StagedAction): StagedAction {
  if (!fromMessages(item)) return item;
  // The result keeps its refs and receipt; an error may quote the item (a provider's message).
  const result = item.result == null ? item.result : { ...item.result };
  if (result != null) delete result.error;
  return {
    ...item,
    result,
    withheld: "messages",
    summary: MESSAGES_ITEM_LINE,
    why: null,
    params: null,
    target: null,
    precondition: null,
    inverse: null,
    send: null,
    preview: {
      kind: PREVIEW_KIND[item.domain],
      title: MESSAGES_ITEM_LINE,
      rows: [],
      truncated: false,
    },
  };
}

/**
 * The `nightShift.item.updated` payload for one bus subscriber: the full item only for the
 * desktop shell on this Mac's loopback, `forRemote` for every other one (a part with no reader
 * included). Undefined sends the shared frame as it is.
 */
export function personalizeNightShiftItem(
  payload: { item: StagedAction },
  reader: { local?: boolean },
): { item: StagedAction } | undefined {
  if (reader.local === true || !fromMessages(payload.item)) return undefined;
  return { ...payload, item: forRemote(payload.item) };
}

/** The night's own work thread (an automation-kind thread keyed by the night), created once. */
function nightThread(db: PsycheDb, nightId: string): string {
  const key = `night-shift:${nightId}`;
  const found = db.sqlite
    .prepare("SELECT id FROM threads WHERE session_key = ? LIMIT 1")
    .get(key) as { id: string } | undefined;
  return (
    found?.id ??
    createThread(db, {
      kind: "automation",
      sessionKey: key,
      title: "Night shift",
      titleSource: "user",
    }).id
  );
}

/** The apply path's store: the night store plus the approval compare-and-set (W5). */
export function applyStoreFor(db: PsycheDb): ApplyStore {
  return {
    ...nightStoreFor(db),
    bindApproval: (ids, approvalId, from) => bindStagedApproval(db, ids, approvalId, from),
    unbindApproval: (approvalId, status) => unbindStagedApproval(db, approvalId, status),
    listByApproval: (approvalId) => listStagedActionsByApproval(db, approvalId),
    listBound: () => listBoundStagedActions(db),
    setInverse: (id, inverse) => void updateStagedAction(db, id, { inverse }),
  };
}

export function nightStoreFor(db: PsycheDb): NightStore {
  return {
    getNight: (id) => getNight(db, id),
    getNightByDate: (night) => getNightByDate(db, night),
    insertNight: (input) => insertNight(db, input),
    updateNight: (id, patch) => updateNight(db, id, patch),
    listNights: (status) => listNights(db, status),
    insertStagedAction: (input) => insertStagedAction(db, input),
    getStagedAction: (id) => getStagedAction(db, id),
    listStagedActions: (nightId) => listStagedActions(db, nightId),
    updateStagedAction: (id, patch) => updateStagedAction(db, id, patch),
  };
}

const FILE_FOLDERS = new Set(["downloads", "desktop"]);

async function topLevelFiles(folders: readonly { path: string; mode: string }[]) {
  const out: {
    path: string;
    folder: string;
    name: string;
    size: number;
    mtimeMs: number;
  }[] = [];
  for (const f of folders) {
    if (f.mode !== "rw" || !FILE_FOLDERS.has(basename(f.path).toLowerCase())) continue;
    let names: string[];
    try {
      names = await readdir(f.path);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(f.path, name);
      try {
        const st = await lstat(path);
        if (!st.isFile() || st.nlink !== 1) continue;
        out.push({ path, folder: f.path, name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // Gone or unreadable: not a candidate.
      }
    }
  }
  return out;
}

export function composeNightShift(setup: NightShiftSetup) {
  const { db, clock } = setup;
  const kv = { get: (key: string) => getSetting(db, key)?.value };
  const settings = () => readNightShiftSettings(kv);
  const store = nightStoreFor(db);
  /** Connector id to type, refreshed at the start of every night (the registry is async). */
  let connectorTypes: ReadonlyMap<string, string> = new Map();
  /** The owner's own mail addresses, read from the connectors' accounts: never a reply-all recipient. */
  let ownerAddrs: string[] = [];
  const refreshConnectors = async () => {
    const next = new Map<string, string>();
    const own = new Set<string>();
    for (const r of await setup.connectors()) {
      if (r.status === "disconnected") continue;
      next.set(r.id, r.type);
      next.set(r.id.replace(/[^a-z0-9-]/g, "-"), r.type);
      for (const v of [r.label, ...Object.values(r.config ?? {})]) {
        if (typeof v === "string" && /^[^\s@<>]+@[^\s@<>]+$/.test(v.trim())) {
          own.add(v.trim().toLowerCase());
        }
      }
    }
    connectorTypes = next;
    ownerAddrs = [...own];
  };

  /**
   * Reads for one connector: exactly `mcp__<id>__<tool>`, and only when that connector is live and
   * of a stageable type (apple, google, microsoft, mail). A custom connector or an MCP server that
   * offers the same bare tool name is never consulted, whatever its registration order.
   */
  const readsFor = (connectorId: string | undefined): ToolLookup => {
    const type = connectorId === undefined ? undefined : connectorTypes.get(connectorId);
    if (connectorId === undefined || type === undefined || !STAGING_CONNECTOR_TYPES.has(type)) {
      return { get: () => undefined };
    }
    const all = setup.lookup();
    return readOnlyLookup({ get: (bare) => all?.get(`mcp__${connectorId}__${bare}`) });
  };
  const stageableIds = (): string[] =>
    [...connectorTypes]
      .filter(([id, t]) => STAGING_CONNECTOR_TYPES.has(t) && id === id.replace(/[^a-z0-9-]/g, "-"))
      .map(([id]) => id);
  const sources = (): CandidateSource[] => [
    {
      name: "mail",
      domain: "mail",
      max: 8,
      list: async () => quietThreadCandidates(await setup.mailCandidates()),
    },
    {
      name: "calendar",
      domain: "calendar",
      max: 4,
      async list(now) {
        const day = 86_400_000;
        const events: CalendarEventInput[] = [];
        // Only live connectors of a stageable type, each by its own id.
        for (const id of stageableIds()) {
          let r: unknown;
          try {
            r = await readTool(readsFor(id), "calendar_list_events", {
              from: new Date(now).toISOString(),
              to: new Date(now + 3 * day).toISOString(),
            });
          } catch {
            continue;
          }
          const raw = Array.isArray(r) ? r : ((r as { events?: unknown[] } | null)?.events ?? []);
          for (const e of raw as Record<string, unknown>[]) {
            if (
              typeof e.id !== "string" ||
              typeof e.start !== "string" ||
              typeof e.end !== "string"
            ) {
              continue;
            }
            const attendees = Array.isArray(e.attendees) ? e.attendees : [];
            events.push({
              id: `${id}:${e.id}`,
              title: typeof e.title === "string" ? e.title : String(e.summary ?? ""),
              start: e.start,
              end: e.end,
              attendees: attendees.map(String),
              ...(e.subscribed === true || e.readOnly === true ? { subscribed: true } : {}),
            });
          }
        }
        return calendarOverlapCandidates(events, now);
      },
    },
    followupsSource(
      setup.promiseCandidates ??
        (() =>
          setup.followups.list().map((f) => ({
            id: f.id,
            text: f.text,
            source: f.source,
            ...(f.dueAt === undefined ? {} : { dueAt: f.dueAt }),
          }))),
    ),
    {
      name: "files",
      domain: "files",
      max: 10,
      async list(now) {
        return fileCandidates(await topLevelFiles(setup.folders()), now);
      },
    },
  ];

  const domainsOn = () => {
    const s = settings();
    return new Set(
      (["mail", "calendar", "reminders", "files"] as const).filter((d) => s.domains[d]),
    );
  };

  /** Read-only tools of a connector, as a registry: never a write method. */
  const readRegistryFor = (connectorId: string | undefined) =>
    createReadRegistry({
      reads: readsFor(connectorId),
      now: () => clock.now(),
      ownerAddresses: () => ownerAddrs,
    });
  const adaptersFor = (connectorId: string | undefined) =>
    createAdapters(
      readRegistryFor(connectorId),
      { grants: () => setup.folders().map((f) => ({ root: f.path, mode: f.mode })) },
      connectorTypes,
    );

  /** The hashes of a call a stager rewrote follow the tool's own binding fields. */
  const rehash = (
    tool: string,
    args: Record<string, unknown>,
    kind: string,
  ): { paramsHash: string; bindingHash: string } | undefined => {
    const reg = setup.registry.get(tool);
    if (reg === undefined) return undefined;
    let fields: unknown;
    try {
      fields = reg.describeCall?.(structuredClone(args), {
        runId: "night-shift",
      })?.bindingFields;
    } catch {
      return undefined;
    }
    const p = paramsHash(args);
    return {
      paramsHash: p,
      bindingHash: bindingHash(kind, {
        tool,
        paramsHash: p,
        ...(fields === undefined ? {} : { fields }),
      }),
    };
  };

  const service = new NightShiftService({
    clock,
    timezone: setup.timeZone,
    settings,
    store,
    sources,
    readState: setup.readState,
    keepAwake: setup.keepAwake,
    scheduler: setup.scheduler,
    ...(setup.pollMs === undefined ? {} : { pollMs: setup.pollMs }),
    // One isolated thread per night, never the owner's chat: the jobs never see the main
    // transcript and their mail-tainted transcripts never land in it.
    threadId: async (nightId) => {
      await refreshConnectors();
      return nightThread(db, nightId);
    },
    stagerFor: (nightId, whyFor, allowTask) =>
      createStager({
        nightId,
        store,
        allowTask,
        adapters: adaptersFor,
        connectors: () => connectorTypes,
        domains: domainsOn,
        whyFor,
        ...(setup.redact === undefined ? {} : { redact: setup.redact }),
        // The hashes of a call the stager rewrote follow the tool's own binding fields.
        rehash,
        onRefused: (info) =>
          setup.logger?.log("warn", "night shift refused a staged call", { ...info }),
      }),
    runJob: (input: NightJobInput) => runJob(input),
    cancelTask: async (taskId, reason) => void (await setup.tasks.cancel(taskId, reason)),
    notify: async (n: NightNotice) => {
      await setup.notifier.notify({
        kind: "briefing",
        title: n.title,
        body: n.body,
        route: n.route,
        dedupeKey: n.dedupeKey,
        surfaces: ["desktop", "web", "notification"],
      });
    },
    emit: (night) => setup.publish?.("nightShift.updated", { night }),
    onError: (err) =>
      setup.logger?.log("warn", "night shift step failed", { code: PsycheError.from(err).code }),
  });

  /** Creates the staging task and waits for its end. The task's usage reaches `service.meter`. */
  async function runJob(input: NightJobInput): Promise<{ taskId: string; status: string }> {
    const task = await setup.tasks.create({
      threadId: input.threadId,
      title: input.title,
      goal: input.goal,
      createdFrom: "automation",
      mode: "unattended",
      budget: input.budget,
      staging: input.staging,
      ...(input.taint === true ? { taint: true, taintSources: input.taintSources ?? [] } : {}),
    });
    input.onCreated(task.id);
    const ended = new Promise<string>((resolve) => {
      const off = setup.tasks.subscribe((e) => {
        const t = e.payload.task;
        if (e.event !== "task.updated" || t?.id !== task.id || !TERMINAL.has(t.status)) return;
        off();
        resolve(t.status);
      });
      void setup.tasks.get(task.id).then((t) => {
        if (t !== undefined && TERMINAL.has(t.status)) {
          off();
          resolve(t.status);
        }
      });
    });
    setup.poke();
    return { taskId: task.id, status: await ended };
  }

  /** The per-job toolset (§3.1): a tool outside it is not registered for the run at all. */
  const toolsFor = (staging: Staging) => {
    if (staging.kind !== "night") return undefined;
    const domains = domainsOn();
    const types = connectorTypes;
    return (tool: string): boolean => {
      const reg = setup.registry.get(tool);
      if (reg === undefined) return false;
      const id = connectorToolName(tool)?.id;
      return stagingToolVisible({
        tool,
        sideEffect: reg.spec.sideEffect,
        connectorType: id === undefined ? undefined : types.get(id),
        domains,
      });
    };
  };

  const counts = (id: string) => {
    const c = { mail: 0, calendar: 0, reminders: 0, files: 0 };
    for (const i of store.listStagedActions(id)) if (i.status === "ready") c[i.domain] += 1;
    return c;
  };

  /** How long `runNow` waits for a run that cannot start to say so. */
  const RUN_NOW_GRACE_MS = 1500;

  const status = async (): Promise<MethodResult<"nightShift.status">> => {
    const s = settings();
    const ready = [...store.listNights("ready"), ...store.listNights("partial")].sort((a, b) =>
      b.night.localeCompare(a.night),
    )[0];
    // The last night, even an empty one (reviewStatus none): "Try it now" must show what it did.
    const latest = store.listNights().at(-1);
    return {
      enabled: s.enabled,
      nextWindowAt: s.enabled ? nextWindowAt(clock.now(), setup.timeZone(), s.window.start) : null,
      latest:
        latest === undefined
          ? null
          : {
              id: latest.id,
              night: latest.night,
              status: latest.status,
              reviewStatus: latest.reviewStatus,
              counts: counts(latest.id),
              expiresAt: latest.expiresAt,
            },
      readyReviewId: ready?.id ?? null,
    };
  };

  /**
   * The review for one caller. The candidate list (mail subjects) never goes out. A why line whose
   * item came from an owner-only source (Messages) is cleared for every caller but the desktop
   * shell on this Mac (design §5.2, §6.2, §11): a paired phone or the web does not get it.
   */
  const reviewGet = async (
    call: Call,
    p: MethodParams<"nightShift.review.get">,
  ): Promise<MethodResult<"nightShift.review.get">> => {
    const night = store.getNight(p.reviewId);
    if (night === null || night.reviewStatus === "none") {
      throw new PsycheError("not_found", "that review is gone");
    }
    const desktop = call.identity.desktopShell === true && call.conn.peer.remoteLoopback === true;
    const items = store
      .listStagedActions(night.id)
      .slice(0, 200)
      .map((i) => (desktop ? i : forRemote(i)));
    return { night: { ...night, candidates: null }, items };
  };

  const runNow = async (): Promise<MethodResult<"nightShift.runNow">> => {
    if (!settings().enabled) {
      return { started: false, outcome: "off", reason: "Night shift is off" };
    }
    const settled = service.run({ manual: true }).then(
      (r) => r,
      (err) => {
        setup.logger?.log("warn", "night shift run failed", {
          code: PsycheError.from(err).code,
        });
        return undefined;
      },
    );
    // A run that cannot start settles at once (already running, a gate, nothing to do): say so.
    // One that is really going takes minutes, so it is answered as started.
    const early = await Promise.race([
      settled,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), RUN_NOW_GRACE_MS)),
    ]);
    if (early === undefined) return { started: true };
    const refused =
      early.outcome === "off" ||
      early.outcome === "already" ||
      early.outcome === "skipped" ||
      early.outcome === "no_candidates";
    return {
      started: !refused,
      outcome: early.outcome,
      ...(early.reason === undefined ? {} : { reason: early.reason.slice(0, 200) }),
    };
  };

  // Apply, undo and dismiss (W5): one staged_apply approval, children run in the night's thread.
  const applier =
    setup.broker === undefined
      ? undefined
      : new NightShiftApply({
          clock,
          store: applyStoreFor(db),
          broker: setup.broker,
          tools: setup.registry as never,
          adapters: adaptersFor,
          connectors: () => connectorTypes,
          connectorIds: () => new Set(connectorTypes.keys()),
          threadId: async (nightId) => {
            await refreshConnectors().catch(() => undefined);
            return nightThread(db, nightId);
          },
          // The full item: the bus personalizer gives every subscriber but the desktop shell on
          // this Mac `forRemote(item)` (`personalizeNightShiftItem`).
          onItem: (item) => setup.publish?.("nightShift.item.updated", { item }),
          onNight: (id) => {
            const n = store.getNight(id);
            if (n !== null)
              setup.publish?.("nightShift.updated", { night: { ...n, candidates: null } });
          },
          onError: (err) =>
            setup.logger?.log("warn", "night shift apply failed", {
              code: PsycheError.from(err).code,
            }),
          // Fork a plan's Take (fork-a-plan-2026 §3.4, §10): the same apply path, with the
          // branch's items, run in the branch's own hidden thread, never the owner's chat.
          listForBranch: (branchId) => listStagedActionsForBranch(db, branchId),
          forkThreadId: async (branchId) => {
            const branch = getPlanForkBranch(db, branchId);
            if (branch === null) throw new PsycheError("not_found", "no such plan branch");
            return branch.threadId;
          },
          onSourceSettled: (source, approval, outcome) => {
            if (source.kind === "fork") setup.onForkApplySettled?.(source, approval, outcome);
          },
        });
  const applyDefs: Record<string, HandlerDef> = {};
  if (applier !== undefined) {
    for (const [name, fn] of Object.entries(createNightShiftHandlers(applier))) {
      applyDefs[name] = {
        run: (call: Call, params: never) =>
          (fn as (p: unknown, c: NightShiftCaller) => Promise<unknown>)(params, {
            surface: setup.surfaceOf?.(call.identity.deviceId) ?? "desktop",
            local: call.identity.desktopShell === true && call.conn.peer.remoteLoopback === true,
          }),
      };
    }
  }
  /** Retention (§7): closed reviews go 30 days after they close; receipts are kept. */
  const prune = () => {
    try {
      pruneClosedNights(db, new Date(clock.now() - 30 * 86_400_000).toISOString());
    } catch (err) {
      setup.logger?.log("warn", "night shift prune failed", { code: PsycheError.from(err).code });
    }
  };
  const baseJob = service.job();
  const job: typeof baseJob = {
    ...baseJob,
    run: async (...args: Parameters<typeof baseJob.run>) => {
      prune();
      return baseJob.run(...args);
    },
  };

  /** The Gateway's handler table for `nightShift.*`. */
  const defs: Record<string, HandlerDef> = {
    ...applyDefs,
    "nightShift.status": { run: () => status() },
    "nightShift.review.get": {
      run: (call: Call, params: never) => reviewGet(call, params as never),
    },
    "nightShift.runNow": { run: () => runNow() },
  };

  return {
    /**
     * What Fork a plan reuses to stage a branch's writes (fork-a-plan-2026 §3.1, §10): the same
     * adapters over the same read registry, the same connector types and the same rehash.
     */
    stagerParts: {
      adapters: adaptersFor,
      connectors: () => connectorTypes,
      domains: domainsOn,
      rehash,
      refresh: refreshConnectors,
    },
    service,
    applier,
    prune,
    job,
    /** `TaskWorkerPool.stagingSinkFor`. */
    sinkFor: (staging: Staging) =>
      staging.kind === "night" ? service.sinkFor(staging.nightId) : undefined,
    toolsFor,
    meter: (taskId: string, usage: Usage, runId?: string) => service.meter(taskId, usage, runId),
    briefLine: () => service.briefLine(),
    defs,
    reviewGet,
    async start() {
      await refreshConnectors().catch(() => undefined);
      prune();
      await applier?.recover().catch((err) =>
        setup.logger?.log("warn", "night shift apply recovery failed", {
          code: PsycheError.from(err).code,
        }),
      );
      await service.ensureAutomation().catch((err) =>
        setup.logger?.log("warn", "night shift schedule sync failed", {
          code: PsycheError.from(err).code,
        }),
      );
    },
  };
}

/** The next window start, as an ISO instant. */
function nextWindowAt(now: number, tz: string, start: string): string {
  const [h = "1", m = "0"] = start.split(":");
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const minutesNow = (ms: number) => {
    const p = fmt.formatToParts(new Date(ms));
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return g("hour") * 60 + g("minute");
  };
  const target = Number(h) * 60 + Number(m);
  const cur = minutesNow(now);
  const ahead = ((target - cur + 1440) % 1440 || 1440) * 60_000;
  return new Date(Math.floor(now / 60_000) * 60_000 + ahead).toISOString();
}
