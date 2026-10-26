import type { AgentToolRegistration } from "@psyche/agent-core";
import { getSetting, getThread, type PsycheDb } from "@psyche/db";
import {
  assignProjects,
  CardSync,
  createGraphHandlers,
  ensureDreamingAutomation,
  type GraphEvent,
  type GraphHandlers,
  GraphStore,
  GraphTools,
  graphToolSpecs,
  isGraphCard,
  type Launcher,
  type LaunchRequest,
  type MemoryEvent,
  type NightlyStep,
  runGraphModelPass,
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
import { entityDoc, graphDocId, SqliteSearchIndex } from "@psyche/search";
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
 * Ingest from connectors (Contacts, Mail, Calendar, Messages) and the meeting-prep job come with
 * the connector adapters; entity recall waits for a context path that does not taint the turn.
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
  publish: (event: GraphEvent["event"], payload: GraphEvent["payload"]) => void;
  /** Registers a tool; returns its unregister function. */
  register: (tool: AgentToolRegistration) => () => unknown;
}

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
  graph = new GraphStore({
    sqlite: db.sqlite,
    clock,
    newId: db.newId,
    onEvent: (e) => {
      deps.publish(e.event, e.payload);
      if (e.event !== "memory.entity.updated") return;
      touched?.add(e.payload.id);
      void reindex(e.payload.id).catch(() => undefined);
    },
  });
  const store = graph;
  const cards = new CardSync(store, memory);
  let lastPass = store.cursor(LAST_PASS_CURSOR) as {
    at: string;
    entities: number;
    tokens: number;
  } | null;
  const handlers = createGraphHandlers(store, {
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

  const graphTools = new GraphTools(store, { now: () => clock.now() });
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
    nightly,
    part(scheduler, timezone) {
      let unsubscribe: (() => void) | undefined;
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
        },
        stop() {
          unsubscribe?.();
        },
      };
    },
  };
}
