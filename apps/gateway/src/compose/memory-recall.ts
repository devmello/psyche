import type { TurnContextProvider } from "@psyche/agent-core";
import { getSetting, getThread, type PsycheDb } from "@psyche/db";
import {
  type Embedder,
  memoryRecall,
  recentAgentNotes,
  type SqliteMemoryStore,
} from "@psyche/memory";
import {
  MEMORY_RECALL_MODE_SETTING,
  type MemoryRecallMode,
  type MemoryRecallStatus,
} from "@psyche/protocol";
import {
  createOnnxEmbedder,
  embeddingModel,
  type LazyEmbedder,
  lazyEmbedder,
  type SearchEmbedder,
} from "@psyche/search";
import { ModelManager } from "@psyche/speech";
import { type SemanticEngines, semanticConfig } from "./search-semantic.ts";

/**
 * Memory recall with embeddings (setting `memory.recall.mode`, default `markdown`). The Markdown
 * workspace stays the source of truth; `embeddings` adds an index of its chunks in the memory
 * store and puts the memories most relevant to each owner turn into the prompt, beside the
 * persona files (which are still injected whole).
 *
 * The embedder follows Search's choice (`search.semantic.engine`, `.model`, `.allowCloud`):
 * - semantic search is running: memory shares its embedder, so nothing more is loaded;
 * - `router`: the `embedding` role, a cloud one only with `allowCloud`;
 * - `builtin`: the on-device model if it is already downloaded (turning on semantic search
 *   downloads it), loaded on the first embed and freed after a minute idle, so idle RAM stays
 *   where it was. Nothing is downloaded from here.
 * In `markdown` mode the section carries only the agent's own recent notes (`memory/agent/`).
 * Without one (model missing, role blocked) recall still runs and matches words only (FTS5),
 * the status says why (`text_only` + `fallback`). Memory changes reindex as they happen.
 */

export const RECALL_TITLE = "From your memory";
/** Owner threads that get recall (never channels, automations, specialists or incognito). */
const RECALL_THREADS = new Set(["main", "side"]);

export function memoryRecallMode(db: PsycheDb): MemoryRecallMode {
  return getSetting(db, MEMORY_RECALL_MODE_SETTING)?.value === "embeddings"
    ? "embeddings"
    : "markdown";
}

/** How memory recall gets an on-device model that is already on disk (tests pass a fake). */
export type LocalEmbedderLoader = (model: string) => Promise<
  | {
      model: string;
      floor?: number;
      load: () => Promise<SearchEmbedder & { release?(): Promise<void> }>;
    }
  | undefined
>;

/** The built-in model's files, if both are downloaded; never downloads. */
export function defaultLocalLoader(home: string): LocalEmbedderLoader {
  return async (id) => {
    const spec = embeddingModel(id);
    if (spec === undefined) return undefined;
    const files = [spec.model, spec.tokenizer];
    const manager = new ModelManager({
      home,
      catalog: files.map((f) => ({
        id: f.file,
        engine: "embeddings",
        file: f.file,
        url: f.url,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        license: spec.license,
      })),
    });
    for (const f of files) if (!(await manager.has(f.file))) return undefined;
    return {
      model: `builtin/${spec.id}`,
      floor: spec.floor,
      load: () =>
        createOnnxEmbedder({
          spec,
          modelPath: manager.path(spec.model.file),
          tokenizerPath: manager.path(spec.tokenizer.file),
        }),
    };
  };
}

/** A search embedder as the memory index's embedder (vectors as plain arrays). */
function asMemoryEmbedder(e: SearchEmbedder): Embedder {
  return {
    model: e.model,
    embed: async (texts, purpose, signal) =>
      (await e.embed(texts, purpose, signal)).map((v) => Array.from(v)),
  };
}

export interface MemoryRecallDeps {
  db: PsycheDb;
  memory: SqliteMemoryStore;
  /** Semantic search's current embedder (late-bound: search is composed later). */
  searchEmbedder: () => SearchEmbedder | undefined;
  router: SemanticEngines["router"];
  local: LocalEmbedderLoader;
  /** Idle time before a lazily loaded model is freed (default 60 s). */
  idleMs?: number;
}

export function createMemoryRecall(deps: MemoryRecallDeps) {
  const { db, memory } = deps;
  let status: MemoryRecallStatus = { mode: "markdown", state: "off" };
  /** What the memory index uses now, to re-apply only on a change. */
  let source: SearchEmbedder | LazyEmbedder | undefined;
  let lazy: LazyEmbedder | undefined;
  let applying: Promise<void> = Promise.resolve();

  const use = (next: SearchEmbedder | undefined) => {
    if (next === source) return;
    source = next;
    memory.setEmbedder(next === undefined ? undefined : asMemoryEmbedder(next));
  };
  const dropLazy = () => {
    void lazy?.release();
    lazy = undefined;
  };

  const run = async () => {
    const mode = memoryRecallMode(db);
    if (mode === "markdown") {
      use(undefined);
      dropLazy();
      status = { mode, state: "off" };
      return;
    }
    const config = semanticConfig((key) => getSetting(db, key)?.value);
    const shared = deps.searchEmbedder();
    if (shared !== undefined) {
      dropLazy();
      use(shared);
      status = { mode, state: "semantic", model: shared.model };
      return;
    }
    if (config.engine === "router") {
      dropLazy();
      const r = deps.router(config.allowCloud);
      if ("blocked" in r) {
        use(undefined);
        status = { mode, state: "text_only", fallback: r.blocked };
        return;
      }
      use(r.embedder);
      status = { mode, state: "semantic", model: r.embedder.model };
      return;
    }
    if (lazy === undefined || lazy.model !== `builtin/${config.model}`) {
      dropLazy();
      const found = await deps.local(config.model).catch(() => undefined);
      if (found === undefined) {
        use(undefined);
        status = { mode, state: "text_only", fallback: "model_missing" };
        return;
      }
      lazy = lazyEmbedder({
        model: found.model,
        ...(found.floor === undefined ? {} : { floor: found.floor }),
        load: found.load,
        ...(deps.idleMs === undefined ? {} : { idleMs: deps.idleMs }),
      });
    }
    use(lazy);
    status = { mode, state: "semantic", model: lazy.model };
  };

  /** Re-reads the settings and Search's embedder; resolves when applied. */
  const apply = (): Promise<void> => {
    applying = applying.then(run).catch(() => {
      status = { mode: memoryRecallMode(db), state: "text_only", fallback: "error" };
    });
    return applying;
  };

  const recall: TurnContextProvider = {
    name: "memory_recall",
    async provide(input) {
      if (!RECALL_THREADS.has(getThread(db, input.threadId)?.kind ?? "")) return undefined;
      // Only owner and agent text: the section is trusted and the turn keeps its tools. Markdown
      // mode has no search, so the agent's own notes (memory/agent/) are what it recalls.
      const lines =
        status.mode === "embeddings"
          ? await memoryRecall(memory, input.text, { limit: 5, maxChars: 1_100 })
          : await recentAgentNotes(memory, { limit: 5, maxChars: 1_100 });
      if (lines.length === 0) return undefined;
      return {
        sections: [{ title: RECALL_TITLE, text: lines.join("\n") }],
        source: { sourceKind: "memory_recall" },
        trusted: true,
      };
    },
  };

  return {
    apply,
    recall,
    status(): MemoryRecallStatus {
      if (status.mode === "markdown") return status;
      const counts = memory.embeddingCounts();
      return {
        ...status,
        chunks: counts.chunks,
        ...(status.state === "semantic" ? { vectors: counts.vectors } : {}),
      };
    },
    /** Frees a lazily loaded model (Gateway shutdown). */
    stop: dropLazy,
  };
}
