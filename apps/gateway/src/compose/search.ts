import { join } from "node:path";
import { getLibraryItem, getSetting, getThread, openDb, setSetting } from "@psyche/db";
import type { GraphStore } from "@psyche/memory";
import type {
  DeviceScope,
  MemoryStore,
  ModelProvider,
  ModelRef,
  SearchIndexStatus,
} from "@psyche/protocol";
import {
  type AppleSourceDeps,
  appleAdapters,
  Backfill,
  type BackfillStatus,
  CardQueue,
  createSearchHandlers,
  type FilesSourceDeps,
  filesAdapter,
  generateCard,
  libraryDoc,
  OWNER,
  type PowerState,
  readSourcesConfig,
  type SearchEmbedder,
  SearchIndexer,
  SemanticIndex,
  type SourceId,
  SourceIndexer,
  type SourcesConfig,
  SqliteSearchIndex,
  syncMemoryNotes,
  tzOffsetMinutesAt,
} from "@psyche/search";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import { watchFolders } from "./search-files.ts";
import {
  defaultSemanticEngines,
  SEMANTIC_SETTINGS,
  SemanticController,
  type SemanticEngines,
  semanticConfig,
} from "./search-semantic.ts";
import { libraryText, type SearchSourceDeps, searchSources } from "./search-sources.ts";
import type { ComposedPart } from "./services.ts";

/**
 * Unified search (feature S1, architecture §4.12, docs/design/search-2026.md): the main index in
 * its own file, `$PSYCHE_HOME/state/search.sqlite` (derived data, safe to delete), kept current
 * from the Gateway's events by `SearchIndexer`, and the `search.query` method. Every paired
 * operator device is the owner, so the method searches every scope; delegated viewers (a
 * designated person's agent) go through `index.search` with their own `scopeKey`.
 *
 * S2: a resumable, throttled backfill from the stores runs at start when the index is new or the
 * adapters changed, and on `search.reindex` (a full rebuild that also drops vanished rows).
 * Library items have no events, so new and removed items are reconciled every minute.
 * `search.status` and `search.status.updated` report progress.
 *
 * S3: optional on-device semantic search (`search-semantic.ts`), fused into `search.query`.
 */
export interface ComposedSearch extends ComposedPart {
  readonly index: SqliteSearchIndex;
  readonly indexer: SearchIndexer;
  readonly backfill: Backfill;
  readonly semantic: SemanticIndex;
  /** Resolves when the semantic settings in effect are applied (download and model load). */
  semanticReady(): Promise<void>;
  /** The embedder semantic search uses now, if any (shared with memory recall). */
  embedder(): SearchEmbedder | undefined;
  /** Resolves once every event seen so far is indexed (tests, the backfill). */
  idle(): Promise<void>;
  status(): Promise<SearchIndexStatus>;
  /** Indexes Library items added since the last sync and drops removed ones. */
  syncLibrary(): Promise<void>;
  /** One step over the enabled local sources (tests; the timer runs it every few minutes). */
  sourceTick(): Promise<void>;
  /** The local-source indexer (absent when the host offers none). */
  readonly sources?: SourceIndexer;
}

export const SOURCES_SETTING = "search.sources";

export interface SearchDeps extends Omit<SearchSourceDeps, "pageSize"> {
  memory: MemoryStore;
  now: () => number;
  logger?: Logger;
  /**
   * Local sources (Mail, Messages, Notes, Calendar, Reminders, granted folders; roadmap §2): each
   * is off until the owner turns it on in Settings → Search sources. Absent = none offered.
   */
  sources?: {
    apple: AppleSourceDeps;
    /** Re-reads the connector list before each pass. */
    refresh?: () => Promise<void>;
    files?: FilesSourceDeps;
    power?: () => PowerState;
    /** Watch granted folders for changes (FSEvents); off in tests. */
    watch?: boolean;
  };
  /** The owner's IANA zone (USER.md): "yesterday" and "last week" mean their days. */
  timeZone?: string;
  /**
   * Names and addresses a person is known by (the people graph), so "from Alex" also finds mail
   * from alex@… and messages from "Alex Rivera".
   */
  resolvePerson?: (name: string) => readonly string[] | undefined;
  /** Index file; defaults to `<home>/state/search.sqlite`. */
  path?: string;
  /** Library reconcile interval (default 60 s; 0 = only after a backfill and on demand). */
  librarySyncMs?: number;
  /** Pause between backfill pages (default 10 ms). */
  backfillPauseMs?: number;
  /** Semantic search's state changed (memory recall follows its embedder). */
  onSemanticChange?: () => void;
  /** Embedders for semantic search; defaults download and run the on-device model. */
  semanticEngines?: SemanticEngines;
  /** The router's `embedding` role for `search.semantic.engine: router`. */
  routerEmbedder?: SemanticEngines["router"];
  /** Options for the semantic index (tests: a low floor, no pauses). */
  semanticOptions?: ConstructorParameters<typeof SemanticIndex>[1];
  /**
   * Context cards at ingest (`search.cards.enabled`, default on): the cheap model that writes
   * them. Without it no cards are generated.
   */
  cards?: {
    provider: ModelProvider;
    model: ModelRef;
    resolvePerson?: (name: string, kind: "person" | "org") => string | undefined;
    /** Cards generated per tick, tests raise it. */
    batchSize?: number;
  };
}

export const CARD_SETTINGS = {
  enabled: "search.cards.enabled",
  dailyTokenBudget: "search.cards.dailyTokenBudget",
} as const;

/** At most one `search.status.updated` per this many ms while a backfill runs. */
const STATUS_EVERY_MS = 500;

/** Every scope, so the indexer sees each event whatever scope it is published under. */
const ALL_SCOPES: DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
  "node",
];

/**
 * Every name and email the people graph knows for the person called `name` (a full name, an
 * alias, or a first name when only one person has it); undefined when nobody matches.
 */
export function graphNames(
  graph: Pick<GraphStore, "listEntities" | "identifiers">,
  name: string,
): string[] | undefined {
  const want = name.trim().toLowerCase();
  if (want === "") return undefined;
  const matches = graph.listEntities(["person", "org"]).filter((e) => {
    const names = [e.name, ...e.aliases].map((n) => n.toLowerCase());
    return names.some((n) => n === want || n.split(/\s+/)[0] === want);
  });
  if (matches.length === 0 || matches.length > 3) return undefined;
  const out = new Set<string>();
  for (const e of matches) {
    out.add(e.name.toLowerCase());
    for (const a of e.aliases) out.add(a.toLowerCase());
    for (const id of graph.identifiers(e.id))
      if (id.kind === "email") out.add(id.value.toLowerCase());
  }
  return [...out];
}

export function composeSearch(deps: SearchDeps): ComposedSearch {
  // Its own file, not psyche.sqlite: it can be rebuilt any time and its writes never contend
  // with the transcript writer.
  const file = openDb(deps.path ?? join(deps.home, "state", "search.sqlite"), { migrate: false });
  const index = new SqliteSearchIndex(file.sqlite, {
    memory: deps.memory,
    now: deps.now,
    tzOffsetMinutes: () => tzOffsetMinutesAt(deps.timeZone, deps.now()),
    ...(deps.resolvePerson === undefined ? {} : { resolvePerson: deps.resolvePerson }),
  });
  const indexer = new SearchIndexer(index, {
    lookupThread: async (id) => getThread(deps.db, id),
    lookupTask: (id) => deps.tasks.get(id),
    onError: (err, event) =>
      deps.logger?.log("warn", "search: indexing an event failed", { event, err: String(err) }),
  });
  const api = createSearchHandlers(index);
  let sourceIndexer: SourceIndexer | undefined;
  let gateway: Gateway | undefined;
  const cardDeps = deps.cards;
  const cardQueue =
    cardDeps === undefined
      ? undefined
      : new CardQueue(index, {
          enabled: () => getSetting(deps.db, CARD_SETTINGS.enabled)?.value !== false,
          dailyTokenBudget: () => {
            const v = getSetting(deps.db, CARD_SETTINGS.dailyTokenBudget)?.value;
            return typeof v === "number" && v > 0 ? v : undefined;
          },
          ...(cardDeps.batchSize === undefined ? {} : { batchSize: cardDeps.batchSize }),
          blockedSources: () => sourceIndexer?.cardBlocked() ?? [],
          now: deps.now,
          generate: (item) =>
            generateCard(item, {
              provider: cardDeps.provider,
              model: cardDeps.model,
              now: deps.now,
              ...(cardDeps.resolvePerson === undefined
                ? {}
                : { resolvePerson: cardDeps.resolvePerson }),
            }),
        });
  const cardTick = async () => {
    if (cardQueue === undefined) return;
    try {
      await syncMemoryNotes(index, cardQueue, deps.memory);
      await cardQueue.tick();
    } catch (err) {
      deps.logger?.log("warn", "search: card generation failed", { err: String(err) });
    }
  };
  let lastStatusAt = 0;
  const statusOf = async (backfill: BackfillStatus): Promise<SearchIndexStatus> => ({
    docs: await index.count(),
    backfill,
    semantic: controller.status(),
  });
  const publishStatus = () => {
    deps.onSemanticChange?.();
    void statusOf(backfill.status()).then((st) =>
      gateway?.bus.publish("search.status.updated", st),
    );
  };
  let lastSemanticAt = 0;
  const semantic = new SemanticIndex(index.db, {
    ...deps.semanticOptions,
    onProgress: (p) => {
      const now = Date.now();
      if (p.state === "indexing" && now - lastSemanticAt < STATUS_EVERY_MS) return;
      lastSemanticAt = now;
      controller.progressed(p);
    },
  });
  index.setSemantic(semantic);
  const controller: SemanticController = new SemanticController(
    semantic,
    deps.semanticEngines ??
      defaultSemanticEngines(
        deps.home,
        deps.routerEmbedder ?? (() => ({ blocked: "no_embedding_model" as const })),
      ),
    publishStatus,
  );
  const applySemantic = () =>
    controller.apply(semanticConfig((key) => getSetting(deps.db, key)?.value));
  const backfill: Backfill = new Backfill(index, searchSources(deps), {
    now: deps.now,
    ...(deps.backfillPauseMs === undefined ? {} : { pauseMs: deps.backfillPauseMs }),
    onStatus: (b) => {
      const now = Date.now();
      if (b.state === "running" && now - lastStatusAt < STATUS_EVERY_MS) return;
      lastStatusAt = now;
      void statusOf(b).then((st) => gateway?.bus.publish("search.status.updated", st));
    },
  });
  const sourcesConfig = (): SourcesConfig =>
    readSourcesConfig(getSetting(deps.db, SOURCES_SETTING)?.value);
  const filesSource =
    deps.sources?.files === undefined ? undefined : filesAdapter(deps.sources.files);
  if (deps.sources !== undefined) {
    sourceIndexer = new SourceIndexer(
      index,
      [...appleAdapters(deps.sources.apple), ...(filesSource === undefined ? [] : [filesSource])],
      {
        config: sourcesConfig,
        now: deps.now,
        ...(deps.sources.power === undefined ? {} : { power: deps.sources.power }),
        ...(deps.backfillPauseMs === undefined ? {} : { pauseMs: deps.backfillPauseMs }),
        onChange: () => publishSources(),
        onError: (source, err) =>
          deps.logger?.log("warn", "search: a source failed", { source, err: String(err) }),
      },
    );
  }
  const publishSources = () => {
    if (sourceIndexer !== undefined && gateway !== undefined)
      gateway.bus.publish("search.sources.updated", sourceIndexer.status());
  };
  let grantsKey = "";
  let stopWatch: (() => void) | undefined;
  /** (Re)starts the folder watcher when files are on and the grants changed; sweeps revoked roots. */
  const syncFolders = () => {
    const files = deps.sources?.files;
    if (files === undefined || sourceIndexer === undefined) return;
    const on = sourcesConfig().sources.files.enabled;
    const roots = files.folders().map((f) => f.path);
    const key = `${on}:${roots.join("\n")}`;
    if (key === grantsKey) return;
    const hadGrants = grantsKey !== "";
    grantsKey = key;
    stopWatch?.();
    stopWatch = undefined;
    filesSource?.invalidate();
    if (!on) return;
    if (hadGrants) void sourceIndexer.sweep("files");
    if (deps.sources?.watch === true)
      stopWatch = watchFolders(roots, () => {
        filesSource?.invalidate();
        void sourceIndexer?.tick();
      });
  };
  const sourceTick = async () => {
    if (sourceIndexer === undefined) return;
    syncFolders();
    await deps.sources?.refresh?.();
    await sourceIndexer.tick();
  };
  const syncLibrary = async () => {
    const have = new Set(
      (deps.db.sqlite.prepare("SELECT id FROM library_items").all() as { id: string }[]).map(
        (r) => r.id,
      ),
    );
    const indexed = new Set(
      (
        index.db.prepare("SELECT id FROM search_docs WHERE kind = 'library'").all() as {
          id: string;
        }[]
      ).map((r) => r.id),
    );
    for (const id of indexed) if (!have.has(id)) await index.remove(id);
    for (const id of have) {
      if (indexed.has(id)) continue;
      const item = getLibraryItem(deps.db, id);
      if (item !== undefined)
        await index.index(libraryDoc(item, await libraryText(deps.home, item)));
    }
  };
  const runBackfill = (full: boolean) => {
    const run = backfill.start({ full });
    void run.done
      .then(() => syncLibrary())
      .catch((err) => deps.logger?.log("warn", "search: backfill failed", { err: String(err) }));
    return run.started;
  };
  const sourcesOrThrow = (): SourceIndexer => {
    if (sourceIndexer === undefined) throw new Error("this host offers no local search sources");
    return sourceIndexer;
  };
  let libraryTimer: ReturnType<typeof setInterval> | undefined;
  // Events are indexed one at a time in publish order (a thread before its messages).
  let queue: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const handlers: Record<string, HandlerDef> = {
    "search.query": {
      run: (_call, params: never) => api["search.query"](params, { viewer: OWNER }),
    },
    "search.status": { run: () => statusOf(backfill.status()) },
    "search.reindex": { run: () => ({ started: runBackfill(true) }) },
    "search.sources": { run: () => sourcesOrThrow().status() },
    "search.sources.configure": {
      run: async (_call, params: never) => {
        const indexer = sourcesOrThrow();
        const p = params as {
          source?: SourceId;
          enabled?: boolean;
          processing?: "cloud" | "local" | "none";
          agent?: boolean;
          exclude?: Partial<SourcesConfig["exclude"]>;
        };
        const next = sourcesConfig();
        if (p.source !== undefined) {
          if (p.enabled !== undefined) next.sources[p.source].enabled = p.enabled;
          if (p.processing !== undefined) next.sources[p.source].processing = p.processing;
          if (p.agent !== undefined) next.sources[p.source].agent = p.agent;
        }
        if (p.exclude !== undefined) Object.assign(next.exclude, p.exclude);
        setSetting(deps.db, SOURCES_SETTING, readSourcesConfig(next));
        await indexer.applyConfig();
        syncFolders();
        void indexer.tick();
        publishSources();
        return indexer.status();
      },
    },
    "search.sources.rebuild": {
      run: async (_call, params: never) => {
        const indexer = sourcesOrThrow();
        await indexer.rebuild((params as { source: SourceId }).source);
        void indexer.tick();
        return indexer.status();
      },
    },
  };
  return {
    index,
    indexer,
    backfill,
    semantic,
    semanticReady: () => applySemantic(),
    embedder: () => controller.embedder(),
    handlers,
    idle: () => queue,
    status: () => statusOf(backfill.status()),
    syncLibrary,
    sourceTick,
    ...(sourceIndexer === undefined ? {} : { sources: sourceIndexer }),
    start(gw: Gateway) {
      gateway = gw;
      unsubscribe = gw.bus.subscribe(ALL_SCOPES, (frame) => {
        const f = JSON.parse(frame) as { event?: string; payload?: unknown };
        const event = f.event;
        if (event === undefined) return;
        if (event === "settings.changed") {
          const entries = (f.payload as { entries?: { key: string }[] }).entries ?? [];
          const keys: string[] = Object.values(SEMANTIC_SETTINGS);
          if (entries.some((e) => keys.includes(e.key))) void applySemantic();
          return;
        }
        queue = queue.then(() => indexer.handle(event, f.payload));
      });
      void applySemantic();
      // A new index (or new adapters) fills from the stores; an interrupted pass resumes.
      if (backfill.needed()) runBackfill(false);
      const every = deps.librarySyncMs ?? 60_000;
      if (every > 0) {
        // Local sources: a bounded step every few minutes on the same timer, and soon after start.
        let beat = 0;
        const first = setTimeout(() => void sourceTick().catch(() => undefined), 20_000);
        first.unref?.();
        libraryTimer = setInterval(() => {
          beat += 1;
          if (beat % 5 === 0 && !backfill.running) void sourceTick().catch(() => undefined);
          if (!backfill.running) void syncLibrary().catch(() => undefined);
          // Cards share this timer: no extra always-on process (a bounded step per tick).
          if (!backfill.running) void cardTick();
        }, every);
        libraryTimer.unref?.();
      }
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (libraryTimer !== undefined) clearInterval(libraryTimer);
      stopWatch?.();
      await sourceIndexer?.stop();
      gateway = undefined;
      controller.stop();
      semantic.setEmbedder(undefined);
      await backfill.stop();
      await semantic.idle();
      await queue;
      file.sqlite.close();
    },
  };
}
