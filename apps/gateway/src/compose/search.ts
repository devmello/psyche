import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLibraryItem, getSetting, getThread, type PsycheDb, setSetting } from "@psyche/db";
import type { GraphStore } from "@psyche/memory";
import {
  type DeviceScope,
  type MemoryStore,
  type ModelProvider,
  type ModelRef,
  PsycheError,
  type SearchIndexEncryption,
  type SearchIndexStatus,
  type SearchModelEngine,
} from "@psyche/protocol";
import {
  type AppleSourceDeps,
  appleAdapters,
  Backfill,
  type BackfillStatus,
  browserAdapter,
  CardQueue,
  createSearchHandlers,
  DEFAULT_TOP_N,
  type FilesSourceDeps,
  filesAdapter,
  generateCard,
  libraryDoc,
  type MemorySourceDeps,
  ModelReranker,
  memoryAdapter,
  OWNER,
  type PowerState,
  QueryModel,
  RebuildRefused,
  readSourcesConfig,
  type SearchEmbedder,
  SearchIndexer,
  SemanticIndex,
  type SourceId,
  SourceIndexer,
  type SourcesConfig,
  SqliteSearchIndex,
  syncMemoryNotes,
  transcriptsAdapter,
  tzOffsetMinutesAt,
} from "@psyche/search";
import type { HandlerDef } from "../context.ts";
import type { Logger } from "../log.ts";
import type { Gateway } from "../server.ts";
import { DeferredOpen } from "./deferred-open.ts";
import type { PageReadHub } from "./page-reads.ts";
import { openSearchDatabase } from "./search-db.ts";
import { APPLE_RERANK_TOP_N } from "./search-engine.ts";
import { watchFolders } from "./search-files.ts";
import type { Recognize } from "./search-ocr.ts";
import {
  defaultSemanticEngines,
  SEMANTIC_SETTINGS,
  SemanticController,
  type SemanticEngines,
  semanticConfig,
} from "./search-semantic.ts";
import {
  isOcrCandidate,
  libraryText,
  recordingTranscripts,
  type SearchSourceDeps,
  searchSources,
} from "./search-sources.ts";
import type { ComposedPart } from "./services.ts";

/** New Library images and scans read per sync (every minute). */
const LIBRARY_OCR_PER_SYNC = 5;

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

/** Settings the Memory source follows: memory on or off, its agent access, the two encryptions. */
const MEMORY_SOURCE_SETTINGS = [
  "memory.graph",
  "memory.everything",
  "memory.encrypt",
  "search.encrypt",
];
/** Wait this long after a memory change before the pass, so a burst of changes is one pass. */
const MEMORY_KICK_MS = 1500;

/** The error code a refused rebuild carries (the message already says why). */
const REBUILD_CODE = {
  off: "invalid_params",
  unavailable: "unavailable",
  power: "unavailable",
  busy: "conflict",
} as const;

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
    /**
     * What Psyche remembers (people, projects, work due, events, accepted non-sensitive facts):
     * the opt-in "Memory" source. Absent = not offered.
     */
    memory?: MemorySourceDeps;
    /** Pages the browser read; the opt-in "Browser pages" source keeps them (roadmap §2). */
    pageReads?: PageReadHub;
    /** `fresh` (optional) re-reads it now, for an owner action such as Rebuild. */
    power?: (() => PowerState) & { fresh?: () => Promise<PowerState> };
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
  /**
   * Encryption at rest (`search.encrypt`): the key for this start and the state to report. Absent
   * means plain, as before.
   */
  encryption?: {
    key?: Buffer;
    /** The key is fetched later (Mac helper): see `composeSearch`. */
    pending?: () => Promise<Buffer | undefined>;
    status: SearchIndexEncryption;
  };
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
  /** Cloud rerank (`search.rerank.enabled`, off by default): the cheap model that reads the top hits. */
  rerank?: { provider: ModelProvider; model: ModelRef };
  queryModel?: { provider: ModelProvider; model: ModelRef };
  /** The engine behind the search model jobs; `apple` narrows rerank to fit the on-device window. */
  engine?: () => SearchModelEngine;
  cards?: {
    provider: ModelProvider;
    model: ModelRef;
    resolvePerson?: (name: string, kind: "person" | "org") => string | undefined;
    /** Cards generated per tick, tests raise it. */
    batchSize?: number;
  };
}

/** Cloud re-ranking of the top hits (roadmap R12): off until the owner turns it on. */
export const RERANK_SETTINGS = {
  enabled: "search.rerank.enabled",
  topN: "search.rerank.topN",
} as const;
/** Search settings for reading questions with a cheap model (roadmap R13). */
export const QUERY_MODEL_SETTINGS = { enabled: "search.queryModel.enabled" } as const;

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

/**
 * Search is composed in one step when the index can open now (plain, or a key already in hand).
 * With `encryption.pending` (the key lives in the Mac helper, which connects after the Gateway
 * starts) the index opens when the key arrives: until then `search.*` answers empty with the
 * reason, `search.status` says `pending`, and nothing is written. Derived data, so events seen
 * meanwhile are recovered by the backfill that follows the open.
 */
export function composeSearch(deps: SearchDeps): ComposedSearch {
  const searchPath = deps.path ?? join(deps.home, "state", "search.sqlite");
  mkdirSync(dirname(searchPath), { recursive: true, mode: 0o700 });
  const pending = deps.encryption?.pending;
  if (pending === undefined) {
    // Its own file, not psyche.sqlite: it can be rebuilt any time and its writes never contend
    // with the transcript writer.
    const file = openSearchDatabase(searchPath, deps.encryption?.key, (msg) =>
      deps.logger?.log("info", msg),
    );
    return buildSearch(deps, file.sqlite);
  }
  return deferredSearch(deps, searchPath, pending);
}

function buildSearch(deps: SearchDeps, sqlite: PsycheDb["sqlite"]): ComposedSearch {
  // The Memory source needs to know whether this index is really encrypted (it is plain when the
  // key was unavailable, though the switch is on).
  deps.sources?.memory?.bindIndex?.(() => deps.encryption?.status.state === "on");
  const index = new SqliteSearchIndex(sqlite, {
    memory: deps.memory,
    now: deps.now,
    tzOffsetMinutes: () => tzOffsetMinutesAt(deps.timeZone, deps.now()),
    ...(deps.resolvePerson === undefined ? {} : { resolvePerson: deps.resolvePerson }),
    ...(deps.rerank === undefined
      ? {}
      : {
          rerank: {
            reranker: new ModelReranker(deps.rerank),
            enabled: () => getSetting(deps.db, RERANK_SETTINGS.enabled)?.value === true,
            topN: () => {
              const v = getSetting(deps.db, RERANK_SETTINGS.topN)?.value;
              const n = typeof v === "number" ? v : DEFAULT_TOP_N;
              return deps.engine?.() === "apple" ? Math.min(n, APPLE_RERANK_TOP_N) : n;
            },
          },
        }),
    ...(deps.queryModel === undefined
      ? {}
      : {
          queryModel: {
            model: new QueryModel(deps.queryModel),
            enabled: () => getSetting(deps.db, QUERY_MODEL_SETTINGS.enabled)?.value !== false,
          },
        }),
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
    ...(deps.encryption === undefined ? {} : { encryption: deps.encryption.status }),
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
  /**
   * Vision OCR for Library images and scans: the Files source's switch, the Mac helper, and the
   * power state (a new item is read unless low-power mode is on; a backfill only on power).
   */
  const libraryOcr = (mode: "add" | "backfill"): Recognize | undefined => {
    const files = deps.sources?.files?.ocr;
    const cfg = sourcesConfig().sources.files;
    if (files === undefined || !cfg.enabled || !cfg.ocr) return undefined;
    const power = files.power?.();
    if (power !== undefined && (power.lowPower || (mode === "backfill" && power.onBattery)))
      return undefined;
    return files.recognize;
  };
  const backfill: Backfill = new Backfill(index, searchSources({ ...deps, libraryOcr }), {
    now: deps.now,
    ...(deps.backfillPauseMs === undefined ? {} : { pauseMs: deps.backfillPauseMs }),
    onStatus: (b) => {
      const now = Date.now();
      if (b.state === "running" && now - lastStatusAt < STATUS_EVERY_MS) return;
      lastStatusAt = now;
      void statusOf(b).then((st) => gateway?.bus.publish("search.status.updated", st));
    },
  });
  const sourcesConfig = (): SourcesConfig => {
    const cfg = readSourcesConfig(getSetting(deps.db, SOURCES_SETTING)?.value);
    // Memory is never open to the agent while memory's own agent access is none, whatever was
    // ticked before that changed.
    if (deps.sources?.memory?.agentBlocked?.() !== undefined) cfg.sources.memory.agent = false;
    return cfg;
  };
  const filesSource =
    deps.sources?.files === undefined
      ? undefined
      : filesAdapter({
          ...deps.sources.files,
          // The owner's switch (Settings → Search sources → Files), read on every pull.
          ...(deps.sources.files.ocr === undefined
            ? {}
            : {
                ocr: {
                  ...deps.sources.files.ocr,
                  enabled: () => sourcesConfig().sources.files.ocr,
                },
              }),
        });
  const browserSource = browserAdapter({
    enabled: () => sourcesConfig().sources.browser.enabled,
  });
  const stopPageReads = deps.sources?.pageReads?.subscribe((page) => browserSource.offer(page));
  // Recordings' transcripts (voice memos, meetings) from the Library, as speaker-turn children.
  const transcriptsSource = transcriptsAdapter({
    recordings: (since, afterId, limit) =>
      recordingTranscripts(deps.db, deps.home, since, afterId, limit),
  });
  if (deps.sources !== undefined) {
    sourceIndexer = new SourceIndexer(
      index,
      [
        ...appleAdapters(deps.sources.apple),
        ...(filesSource === undefined ? [] : [filesSource]),
        browserSource,
        transcriptsSource,
        ...(deps.sources.memory === undefined ? [] : [memoryAdapter(deps.sources.memory)]),
      ],
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
  /**
   * Memory stands down (nothing is read) while it is encrypted and the search index is not; what
   * was indexed before that changed goes with it.
   */
  const purgeMemoryIfBlocked = async () => {
    const memory = deps.sources?.memory;
    if (sourceIndexer === undefined || memory?.blocked?.() === undefined) return;
    if ((sourceIndexer.status().sources.find((x) => x.id === "memory")?.items ?? 0) > 0)
      await sourceIndexer.purge("memory");
  };
  const sourceTick = async () => {
    if (sourceIndexer === undefined) return;
    syncFolders();
    await deps.sources?.refresh?.();
    await purgeMemoryIfBlocked();
    await sourceIndexer.tick();
  };
  let memoryKick: ReturnType<typeof setTimeout> | undefined;
  /**
   * Memory changed (a fact retracted, a person hidden or made private, memory switched off): a
   * pass over the Memory source soon, so what it dropped leaves the index now and not at the next
   * timer tick. Several changes in a row are one pass.
   */
  const kickMemory = (reapply = false) => {
    if (sourceIndexer === undefined || deps.sources?.memory === undefined) return;
    if (!sourcesConfig().sources.memory.enabled) return;
    if (memoryKick !== undefined) clearTimeout(memoryKick);
    memoryKick = setTimeout(() => {
      memoryKick = undefined;
      void (async () => {
        if (reapply) await sourceIndexer?.applyConfig();
        await purgeMemoryIfBlocked();
        // Only the Memory source: a pass over Mail and Files is not what a memory change needs.
        await sourceIndexer?.pullSource("memory");
      })().catch(() => undefined);
    }, MEMORY_KICK_MS);
    memoryKick.unref?.();
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
    // Images are read a few at a time; the rest stay unindexed until the next sync.
    let ocrLeft = LIBRARY_OCR_PER_SYNC;
    for (const id of have) {
      if (indexed.has(id)) continue;
      const item = getLibraryItem(deps.db, id);
      if (item === undefined) continue;
      const recognize = isOcrCandidate(item) ? libraryOcr("add") : undefined;
      if (recognize !== undefined && ocrLeft-- <= 0) continue;
      await index.index(libraryDoc(item, await libraryText(deps.home, item, recognize)));
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
          ocr?: boolean;
          exclude?: Partial<SourcesConfig["exclude"]>;
        };
        const next = sourcesConfig();
        if (p.source === "memory") {
          // Said in the owner's terms; the switch is greyed in Settings with the same words.
          const memory = deps.sources?.memory;
          const refuse = (why: string | undefined) => {
            if (why !== undefined) throw new PsycheError("invalid_params", why);
          };
          if (p.enabled === true) refuse(memory?.blocked?.());
          if (p.agent === true) refuse(memory?.agentBlocked?.());
        }
        if (p.source !== undefined) {
          if (p.enabled !== undefined) next.sources[p.source].enabled = p.enabled;
          if (p.processing !== undefined) next.sources[p.source].processing = p.processing;
          if (p.agent !== undefined) next.sources[p.source].agent = p.agent;
          // Reading text in images is Files only (readSourcesConfig drops it elsewhere).
          if (p.ocr !== undefined) next.sources[p.source].ocr = p.ocr;
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
        // The cached power state can be stale after a long idle; the owner just asked, so re-read.
        await deps.sources?.power?.fresh?.().catch(() => undefined);
        try {
          await indexer.rebuild((params as { source: SourceId }).source);
        } catch (err) {
          // Said in the owner's terms; nothing was removed (see `SourceIndexer.rebuild`).
          if (err instanceof RebuildRefused)
            throw new PsycheError(REBUILD_CODE[err.reason], err.message, {
              retryable: err.reason === "unavailable" || err.reason === "power",
            });
          throw err;
        }
        // The read starts now and goes on in the background: the reply is the emptied source in
        // state `indexing`, and `search.sources.updated` follows as items arrive.
        void indexer.kick().catch(() => undefined);
        publishSources();
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
          // Memory on or off, its agent access, either encryption switch: the Memory source
          // follows them (the agent flag is synced into the index by applyConfig).
          if (entries.some((e) => MEMORY_SOURCE_SETTINGS.includes(e.key))) kickMemory(true);
          return;
        }
        if (event.startsWith("memory.entity.") || event.startsWith("memory.graph.")) {
          kickMemory();
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
      if (memoryKick !== undefined) clearTimeout(memoryKick);
      stopPageReads?.();
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
      sqlite.close();
    },
  };
}

const EMPTY_RESULT = { hits: [], groups: [], total: 0, warnings: [], tookMs: 0 };
const NO_BACKFILL = { state: "idle", processed: 0, total: 0 } as never;

/** A proxy that forwards to `get()` and, while that is undefined, answers with `fallback`. */
function lazy<T extends object>(get: () => T | undefined, fallback: Record<string, unknown>): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const inner = get();
      if (inner !== undefined) {
        const v = Reflect.get(inner, prop, inner);
        return typeof v === "function" ? v.bind(inner) : v;
      }
      const f = fallback[String(prop)];
      if (f !== undefined) return typeof f === "function" ? f : () => f;
      return () => Promise.resolve(undefined);
    },
  });
}

function deferredSearch(
  deps: SearchDeps,
  searchPath: string,
  provider: () => Promise<Buffer | undefined>,
): ComposedSearch {
  let inner: ComposedSearch | undefined;
  let gateway: Gateway | undefined;
  let sqlite: PsycheDb["sqlite"] | undefined;
  const waiting = (): SearchIndexEncryption => ({
    state: "pending",
    reason: opener.reason,
  });
  const opener = new DeferredOpen<ComposedSearch>({
    provider,
    open: (key) => {
      const file = openSearchDatabase(searchPath, key, (msg) => deps.logger?.log("info", msg));
      sqlite = file.sqlite;
      return buildSearch({ ...deps, encryption: { status: { state: "on" } } }, file.sqlite);
    },
    onReady: (built) => {
      inner = built;
      deps.logger?.log("info", "search: the encrypted index is open");
      if (gateway !== undefined) {
        built.start?.(gateway);
        void built.status().then((st) => gateway?.bus.publish("search.status.updated", st));
      }
    },
    onWaiting: (reason) =>
      deps.logger?.log("debug", "search: waiting for the index key", { reason }),
  });
  const pendingStatus = (): SearchIndexStatus => ({
    docs: 0,
    backfill: NO_BACKFILL,
    encryption: waiting(),
  });
  const unavailable = (): never => {
    throw new PsycheError("unavailable", `search is waiting for the Mac helper (${opener.reason})`);
  };
  const delegate = (name: string, fallback: (p: never) => unknown) => ({
    run: (call: never, params: never) => {
      const h = inner?.handlers?.[name];
      return h === undefined ? fallback(params) : h.run(call, params);
    },
  });
  const handlers: Record<string, HandlerDef> = {
    "search.query": delegate("search.query", () => EMPTY_RESULT) as HandlerDef,
    "search.status": delegate("search.status", pendingStatus) as HandlerDef,
    "search.reindex": delegate("search.reindex", () => ({ started: false })) as HandlerDef,
    "search.sources": delegate("search.sources", unavailable) as HandlerDef,
    "search.sources.configure": delegate("search.sources.configure", unavailable) as HandlerDef,
    "search.sources.rebuild": delegate("search.sources.rebuild", unavailable) as HandlerDef,
  };
  return {
    index: lazy(() => inner?.index, {
      search: EMPTY_RESULT,
      query: { hits: [], total: 0 },
      count: 0,
      textOf: {},
    }),
    indexer: lazy(() => inner?.indexer, {}),
    backfill: lazy(() => inner?.backfill, { status: NO_BACKFILL, needed: false, running: false }),
    semantic: lazy(() => inner?.semantic, {}),
    semanticReady: () => inner?.semanticReady() ?? Promise.resolve(),
    embedder: () => inner?.embedder(),
    handlers,
    idle: () => inner?.idle() ?? Promise.resolve(),
    status: () => inner?.status() ?? Promise.resolve(pendingStatus()),
    syncLibrary: () => inner?.syncLibrary() ?? Promise.resolve(),
    sourceTick: () => inner?.sourceTick() ?? Promise.resolve(),
    get sources() {
      return inner?.sources;
    },
    start(gw: Gateway) {
      gateway = gw;
      inner?.start?.(gw);
      opener.start();
    },
    async stop() {
      opener.stop();
      await inner?.stop?.();
      if (inner === undefined) sqlite?.close();
    },
  };
}
