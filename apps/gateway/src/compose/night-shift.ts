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
  createThread,
  getNight,
  getNightByDate,
  getSetting,
  getStagedAction,
  insertNight,
  insertStagedAction,
  listNights,
  listStagedActions,
  type PsycheDb,
  updateNight,
  updateStagedAction,
} from "@psyche/db";
import type { PsycheNotifier } from "@psyche/notifications";
import type { GateState } from "@psyche/proactive";
import {
  type CalendarEventInput,
  type CandidateSource,
  calendarOverlapCandidates,
  createAdapters,
  createReadRegistry,
  createStager,
  type FollowupInput,
  type FollowupStore,
  fileCandidates,
  followupsSource,
  type NightJobInput,
  type NightNotice,
  NightShiftService,
  type NightStore,
  quietThreadCandidates,
  readNightShiftSettings,
  readTool,
  type SchedulerLike,
  type ToolLookup,
} from "@psyche/proactive";
import type { Clock, MethodParams, MethodResult, Staging, Task, Usage } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
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
        adapters: (connectorId) =>
          createAdapters(
            // Read-only tools of the staged call's own connector: never a write method.
            createReadRegistry({
              reads: readsFor(connectorId),
              now: () => clock.now(),
              ownerAddresses: () => ownerAddrs,
            }),
            {
              grants: () => setup.folders().map((f) => ({ root: f.path, mode: f.mode })),
            },
            connectorTypes,
          ),
        connectors: () => connectorTypes,
        domains: domainsOn,
        whyFor,
        ...(setup.redact === undefined ? {} : { redact: setup.redact }),
        // The hashes of a call the stager rewrote follow the tool's own binding fields.
        rehash: (tool, args, kind) => {
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
        },
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

  const status = async (): Promise<MethodResult<"nightShift.status">> => {
    const s = settings();
    const ready = [...store.listNights("ready"), ...store.listNights("partial")].sort((a, b) =>
      b.night.localeCompare(a.night),
    )[0];
    const latest = store
      .listNights()
      .filter((n) => n.reviewStatus !== "none")
      .at(-1);
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
      .map((i) =>
        !desktop && i.taintSources.some((t) => t.sourceKind === "message")
          ? { ...i, why: null }
          : i,
      );
    return { night: { ...night, candidates: null }, items };
  };

  const runNow = async (): Promise<MethodResult<"nightShift.runNow">> => {
    if (!settings().enabled) return { started: false, reason: "Night shift is off" };
    void service.run({ manual: true }).catch((err) =>
      setup.logger?.log("warn", "night shift run failed", {
        code: PsycheError.from(err).code,
      }),
    );
    return { started: true };
  };

  /** The Gateway's handler table for the read side of `nightShift.*`. */
  const defs: Record<string, HandlerDef> = {
    "nightShift.status": { run: () => status() },
    "nightShift.review.get": {
      run: (call: Call, params: never) => reviewGet(call, params as never),
    },
    "nightShift.runNow": { run: () => runNow() },
  };

  return {
    service,
    job: service.job(),
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
