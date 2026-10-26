import type { AgentToolRegistration } from "@psyche/agent-core";
import { getSetting, getThread, type PsycheDb, setSetting } from "@psyche/db";
import {
  assignProjects,
  CardSync,
  createGraphHandlers,
  ensureDreamingAutomation,
  type GraphEvent,
  type GraphHandlers,
  type GraphPollReport,
  type GraphSourceAdapter,
  GraphStore,
  GraphTools,
  graphToolSpecs,
  isGraphCard,
  type Launcher,
  type LaunchRequest,
  type MeetingPrep,
  type MemoryEvent,
  type ModelPassReport,
  meetingPrep,
  type NightlyStep,
  runGraphModelPass,
  runGraphPoll,
  type SchedulerLike,
  type SqliteMemoryStore,
  suggestProjects,
  withDreaming,
} from "@psyche/memory";
import {
  type Clock,
  type GraphSource,
  type ModelProvider,
  type ModelRef,
  PsycheError,
} from "@psyche/protocol";
import { entityDoc, GRAPH_SEARCH_SOURCE, graphDocId, SqliteSearchIndex } from "@psyche/search";
import type { Gateway } from "../server.ts";
import { mountParamsOnly } from "./handlers.ts";
import type { ComposedPart } from "./services.ts";

/**
 * The people and projects memory graph (docs/memory/people-and-projects-2026.md, PG1 part 4):
 *
 * - `memory.entities.*`, `memory.loops.*` and `memory.graph.status` for paired devices;
 * - the agent's five tools (`people_lookup`, `project_brief`, `waiting_on`, `meeting_prep`,
 *   `loop_update`), registered only while `memory.graph.enabled` is on, and answering only the
 *   owner's own turns;
 * - graph events on the bus, and People / Projects documents in the search index;
 * - owner edits of `people/*.md` and `projects/*.md` (in Psyche or on disk) applied to the graph;
 * - the nightly pass inside the dreaming window: project assignment and suggestions, retention,
 *   and the model pass on the `utility` role within its budget.
 *
 * Ingest from connectors (Contacts, Mail, Calendar, Messages) comes with the connector adapters;
 * the meeting-prep schedule and card belong to the mail and meetings workstream, which reads
 * `meetingPrep`. Entity recall waits for a context path that does not taint the turn.
 */

export const GRAPH_SETTING = "memory.graph";
const LAST_PASS_CURSOR = "model:last";

export interface GraphSettings {
  enabled: boolean;
  sources: Partial<Record<GraphSource, boolean>>;
  entityRecall: boolean;
  model: {
    nightly: boolean;
    afterRun: boolean;
    maxEntitiesPerNight: number;
    maxTokensPerNight: number;
  };
}

const SOURCES: GraphSource[] = ["contacts", "mail", "calendar", "messages", "notes", "chats"];

/** `memory.graph` with its defaults (§4.10): off, every source off, model nightly on. */
export function graphSettings(value: unknown): GraphSettings {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const src = (typeof v.sources === "object" && v.sources !== null ? v.sources : {}) as Record<
    string,
    unknown
  >;
  const model = (typeof v.model === "object" && v.model !== null ? v.model : {}) as Record<
    string,
    unknown
  >;
  const count = (x: unknown, fallback: number) =>
    typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : fallback;
  return {
    enabled: v.enabled === true,
    sources: Object.fromEntries(SOURCES.map((s) => [s, src[s] === true])),
    entityRecall: v.entityRecall !== false,
    model: {
      nightly: model.nightly !== false,
      afterRun: model.afterRun !== false,
      maxEntitiesPerNight: count(model.maxEntitiesPerNight, 200),
      maxTokensPerNight: count(model.maxTokensPerNight, 150_000),
    },
  };
}

export interface PeopleDeps {
  db: PsycheDb;
  clock: Clock;
  memory: SqliteMemoryStore;
  provider: ModelProvider;
  /** The `utility` role (local by default). */
  model: ModelRef;
  publish: (event: GraphEvent["event"] | "settings.changed", payload: unknown) => void;
  /** Registers a tool; returns its unregister function. */
  register: (tool: AgentToolRegistration) => () => unknown;
  /** Deterministic pass interval (§5.1, default 15 minutes); 0 disables the timer (tests). */
  pollIntervalMs?: number;
  /** Debounce of the after-run model pass (§5.2, default 5 minutes); 0 leaves it to `afterRun()`. */
  afterRunDelayMs?: number;
  logger?: { log(level: "warn", msg: string, fields?: Record<string, unknown>): void };
}

export const DEFAULT_GRAPH_POLL_MS = 15 * 60_000;
export const AFTER_RUN_DELAY_MS = 5 * 60_000;
/** At most this many entities per after-run pass, within this many tokens (§5.2). */
export const AFTER_RUN_ENTITIES = 3;
export const AFTER_RUN_TOKENS = 15_000;

export interface People {
  readonly graph: GraphStore;
  readonly cards: CardSync;
  readonly handlers: GraphHandlers;
  readonly settings: () => GraphSettings;
  /** Owner edits of card files reach the graph (wire to the memory store's `onEvent`). */
  onMemoryEvent(event: MemoryEvent): void;
  /** Applies a changed `memory.graph` setting (registers or removes the agent's tools). */
  sync(value: unknown): void;
  /** Wraps the scheduler's launcher: the dreaming automation runs dreaming, then the graph pass. */
  launcher<R extends LaunchRequest, Run>(inner: Launcher<R, Run>): Launcher<R, Run>;
  /**
   * The data side of meeting prep (attendees, their open loops and last interactions, the
   * project) for the mail and meetings workstream, which owns the schedule and the prep card.
   */
  meetingPrep(query: {
    interactionId?: string;
    source?: string;
    externalRef?: string;
    when?: string;
  }): MeetingPrep | undefined;
  /** The connected apps' ingest adapters, read at each poll (bound once connectors exist). */
  useSources(adapters: () => Promise<GraphSourceAdapter[]> | GraphSourceAdapter[]): void;
  /** One deterministic pass over the enabled sources; also run after a connector sync. */
  poll(signal?: AbortSignal): Promise<GraphPollReport | undefined>;
  /** Runs the pending after-run model pass now (the debounce timer calls it). */
  afterRun(): Promise<ModelPassReport | undefined>;
  /** The nightly graph step, for tests. */
  readonly nightly: NightlyStep;
  part(scheduler: SchedulerLike, timezone: string): ComposedPart;
}

export function composePeople(deps: PeopleDeps): People {
  const { db, clock, memory } = deps;
  const settings = () => graphSettings(getSetting(db, GRAPH_SETTING)?.value);
  const index = new SqliteSearchIndex(db.sqlite, { now: () => clock.now() });
  let graph: GraphStore | undefined;
  const reindex = async (id: string) => {
    const entity = graph?.getEntity(id);
    const doc = entity === undefined ? undefined : entityDoc(entity, graph?.summary(id) ?? {});
    if (doc === undefined) await index.remove(graphDocId(id));
    else await index.index(doc);
  };
  // Entities the nightly pass changed, whose cards are re-rendered after it.
  let touched: Set<string> | null = null;
  let cardSync: CardSync | undefined;
  graph = new GraphStore({
    sqlite: db.sqlite,
    clock,
    newId: db.newId,
    onEvent: (e) => {
      deps.publish(e.event, e.payload);
      if (e.event !== "memory.entity.updated") return;
      touched?.add(e.payload.id);
      void reindex(e.payload.id).catch(() => undefined);
      // A deleted source changed what the card shows.
      if (e.payload.changed.includes("source") && graph?.getEntity(e.payload.id)?.cardPath != null)
        void cardSync?.write(e.payload.id).catch(() => undefined);
    },
  });
  const store = graph;
  const cards = new CardSync(store, memory);
  cardSync = cards;
  let lastPass = store.cursor(LAST_PASS_CURSOR) as {
    at: string;
    entities: number;
    tokens: number;
  } | null;
  const base = createGraphHandlers(store, {
    cards,
    memory,
    settings: () => {
      const s = settings();
      return {
        enabled: s.enabled,
        sources: s.sources,
        lastModelPassAt: lastPass?.at ?? null,
        budget: {
          entitiesUsed: lastPass?.entities ?? 0,
          tokensUsed: lastPass?.tokens ?? 0,
          maxEntities: s.model.maxEntitiesPerNight,
          maxTokens: s.model.maxTokensPerNight,
        },
      };
    },
  });
  const writeSetting = (value: Record<string, unknown>) => {
    const entry = setSetting(db, GRAPH_SETTING, value);
    deps.publish("settings.changed", { entries: [entry] });
    sync(value);
  };
  const stored = () => {
    const v = getSetting(db, GRAPH_SETTING)?.value;
    return (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  };
  const handlers: GraphHandlers = {
    ...base,
    // Keep nothing: stray card files, the search entries, and the graph turns off.
    async "memory.graph.forgetAll"(p) {
      const result = await base["memory.graph.forgetAll"](p);
      if (result.dryRun) return result;
      const removed = new Set(result.cardPaths);
      for (const path of (await memory.listFiles()).filter(isGraphCard)) {
        await cards.remove(path).catch(() => undefined);
        removed.add(path);
      }
      await index.removeSource(GRAPH_SEARCH_SOURCE);
      lastPass = null;
      writeSetting({ ...stored(), enabled: false });
      return { ...result, cardPaths: [...removed] };
    },
    // The source is turned off so the next sync does not bring it back.
    async "memory.graph.deleteSource"(p) {
      const result = await base["memory.graph.deleteSource"](p);
      if (result.dryRun) return result;
      const sources = stored().sources;
      writeSetting({
        ...stored(),
        sources: {
          ...(typeof sources === "object" && sources !== null ? sources : {}),
          [p.source]: false,
        },
      });
      return result;
    },
  };

  const graphTools = new GraphTools(store, { now: () => clock.now() });

  // After-run pass (§5.2): the entities a run looked at are refreshed shortly after, debounced.
  const afterRunIds = new Set<string>();
  let afterRunTimer: ReturnType<typeof setTimeout> | undefined;
  const afterRunDelay = deps.afterRunDelayMs ?? AFTER_RUN_DELAY_MS;
  const afterRun = async (): Promise<ModelPassReport | undefined> => {
    if (afterRunTimer !== undefined) clearTimeout(afterRunTimer);
    afterRunTimer = undefined;
    const ids = [...afterRunIds].slice(0, AFTER_RUN_ENTITIES);
    afterRunIds.clear();
    const s = settings();
    if (ids.length === 0 || !s.enabled || !s.model.afterRun) return undefined;
    const report = await runGraphModelPass(
      store,
      {
        provider: deps.provider,
        model: deps.model,
        maxEntitiesPerNight: AFTER_RUN_ENTITIES,
        maxTokensPerNight: AFTER_RUN_TOKENS,
      },
      { clock, only: ids },
    );
    for (const id of ids) {
      const e = store.getEntity(id);
      if (e !== undefined && (e.cardPath != null || e.summary != null))
        await cards.write(id).catch(() => undefined);
    }
    return report;
  };
  const touch = (ids: (string | null | undefined)[]) => {
    const s = settings();
    if (!s.enabled || !s.model.afterRun) return;
    for (const id of ids) if (typeof id === "string") afterRunIds.add(id);
    if (afterRunIds.size === 0 || afterRunDelay <= 0) return;
    if (afterRunTimer !== undefined) clearTimeout(afterRunTimer);
    afterRunTimer = setTimeout(() => void afterRun().catch(() => undefined), afterRunDelay);
    afterRunTimer.unref?.();
  };
  /** The entity a lookup answered about, only when the answer named exactly one. */
  const looked = (name: string, params: unknown): string[] => {
    const p = (params ?? {}) as Record<string, unknown>;
    const q = typeof p.query === "string" ? p.query : undefined;
    if (name === "people_lookup" && q !== undefined) {
      const hits = store.search(q, { kinds: ["person", "org"], limit: 2 });
      return hits.length === 1 && hits[0] !== undefined ? [hits[0].id] : [];
    }
    if (name === "project_brief" && q !== undefined) {
      const hit = store.search(q, { kinds: ["project"], limit: 1 })[0];
      return hit === undefined ? [] : [hit.id];
    }
    if (name === "meeting_prep") {
      const prep = meetingPrep(store, {
        ...(typeof p.event_id === "string" ? { interactionId: p.event_id } : {}),
        ...(typeof p.when === "string" ? { when: p.when } : {}),
        now: clock.now(),
      });
      return [
        ...(prep?.attendees.map((a) => a.entity.id) ?? []),
        ...(prep?.project == null ? [] : [prep.project.id]),
      ];
    }
    return [];
  };
  const tools: AgentToolRegistration[] = graphToolSpecs.map((spec) => ({
    spec,
    async run(params, ctx) {
      // The owner's private graph: a designated person's or allowed sender's turn never sees it.
      if (ctx.requester !== undefined && ctx.requester.role !== "owner") {
        return {
          output: "People and projects are only available to the owner.",
          isError: true,
          provenance: "trusted",
        };
      }
      const out = await graphTools.execute(spec.name, params, {
        provenance: ctx.taint ? "untrusted" : "agent",
        incognito: getThread(db, ctx.threadId)?.kind === "incognito",
        privateSession: true,
      });
      if (out.isError !== true) touch(looked(spec.name, params));
      if (spec.name === "loop_update" && out.isError !== true) {
        const loop = store.getLoop((params as { id: string }).id);
        for (const id of [loop?.counterpartId, loop?.projectId])
          if (typeof id === "string") await cards.write(id).catch(() => undefined);
      }
      return {
        output: out.content,
        ...(out.isError === true ? { isError: true } : {}),
        provenance: out.provenance,
      };
    },
    execute: () =>
      Promise.reject(new PsycheError("internal", `${spec.name} runs in-process through the loop`)),
  }));
  let unregister: (() => unknown)[] | null = null;
  const sync = (value: unknown) => {
    const on = graphSettings(value).enabled;
    if (on && unregister === null) unregister = tools.map((t) => deps.register(t));
    if (!on && unregister !== null) {
      for (const u of unregister) u();
      unregister = null;
    }
  };

  const nightly: NightlyStep = async () => {
    const s = settings();
    if (!s.enabled || !s.model.nightly) return undefined;
    touched = new Set();
    try {
      store.retention();
      const assigned = assignProjects(store, clock);
      const suggested = suggestProjects(store, clock);
      const report = await runGraphModelPass(
        store,
        {
          provider: deps.provider,
          model: deps.model,
          maxEntitiesPerNight: s.model.maxEntitiesPerNight,
          maxTokensPerNight: s.model.maxTokensPerNight,
        },
        { clock },
      );
      lastPass = {
        at: new Date(clock.now()).toISOString(),
        entities: report.entities,
        tokens: report.tokens,
      };
      store.setCursor(LAST_PASS_CURSOR, lastPass);
      for (const id of touched) {
        const entity = store.getEntity(id);
        if (entity === undefined || (entity.kind !== "person" && entity.kind !== "project"))
          continue;
        if (entity.cardPath != null || entity.summary != null)
          await cards.write(id).catch(() => undefined);
      }
      return `people graph: ${report.entities} updated, ${report.facts} facts, ${report.loops} loops, ${assigned.assigned + suggested.suggestions} project changes${report.deferred > 0 ? `, ${report.deferred} left for tomorrow` : ""}`;
    } finally {
      touched = null;
    }
  };

  let sources: () => Promise<GraphSourceAdapter[]> | GraphSourceAdapter[] = () => [];
  let polling: Promise<GraphPollReport | undefined> | null = null;
  const poll = (signal?: AbortSignal): Promise<GraphPollReport | undefined> => {
    // One round at a time: a slow connector never stacks passes.
    if (polling !== null) return polling;
    const s = settings();
    if (!s.enabled || !Object.values(s.sources).some((on) => on === true))
      return Promise.resolve(undefined);
    polling = (async () => {
      const adapters = await sources();
      const report = await runGraphPoll(store, adapters, {
        enabled: s.sources,
        clock,
        ...(signal === undefined ? {} : { signal }),
      });
      for (const a of report.adapters)
        if (!a.ok)
          deps.logger?.log("warn", "people graph ingest failed", {
            adapter: a.id,
            source: a.source,
          });
      return report;
    })().finally(() => {
      polling = null;
    });
    return polling;
  };

  return {
    graph: store,
    cards,
    handlers,
    settings,
    onMemoryEvent(event) {
      if (event.event !== "memory.file.changed") return;
      const { path, source } = event.payload;
      // Psyche's own card writes come back as `job`; only the owner's edits teach the graph.
      if (!isGraphCard(path) || (source !== "external" && source !== "api")) return;
      void cards.onFileChanged(path).catch(() => undefined);
    },
    sync,
    launcher: (inner) => withDreaming(memory, inner, {}, [nightly]),
    useSources(adapters) {
      sources = adapters;
    },
    poll,
    afterRun,
    meetingPrep: (query) => meetingPrep(store, { ...query, now: clock.now() }),
    nightly,
    part(scheduler, timezone) {
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      const interval = deps.pollIntervalMs ?? DEFAULT_GRAPH_POLL_MS;
      return {
        handlers: mountParamsOnly(handlers as never),
        async start(gateway: Gateway) {
          sync(getSetting(db, GRAPH_SETTING)?.value);
          unsubscribe = gateway.bus.subscribe(["operator.read"], (frame) => {
            const f = JSON.parse(frame) as {
              event?: string;
              payload?: { entries?: { key: string; value: unknown }[] };
            };
            if (f.event !== "settings.changed") return;
            for (const entry of f.payload?.entries ?? [])
              if (entry.key === GRAPH_SETTING) sync(entry.value);
          });
          await ensureDreamingAutomation(scheduler, { timezone });
          if (interval > 0) {
            timer = setInterval(() => void poll().catch(() => undefined), interval);
            timer.unref?.();
          }
        },
        stop() {
          unsubscribe?.();
          if (timer !== undefined) clearInterval(timer);
          if (afterRunTimer !== undefined) clearTimeout(afterRunTimer);
        },
      };
    },
  };
}
