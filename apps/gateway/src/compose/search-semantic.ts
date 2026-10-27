import { AiSdkAdapter, isLocalKind, type ModelRouter } from "@psyche/model-router";
import type { SearchSemanticStatus } from "@psyche/protocol";
import {
  createOnnxEmbedder,
  DEFAULT_EMBEDDING_MODEL,
  type EmbeddingModelSpec,
  embeddingModel,
  type SearchEmbedder,
  type SemanticIndex,
  type SemanticProgress,
} from "@psyche/search";
import { ModelManager } from "@psyche/speech";
import { ensureOrtRuntime, ortRuntimeDownloadBytes } from "./ort-runtime.ts";

/**
 * Semantic search on the Gateway (docs/design/search-2026.md §3, S3): reads the owner's settings,
 * builds the embedder and hands it to the index's `SemanticIndex`.
 *
 * - `search.semantic.enabled` (default off): turning it off drops every stored vector.
 * - `search.semantic.engine`: `builtin` (default) runs an ONNX model on the CPU, downloaded on the
 *   first enable (pinned URL and SHA-256, `$PSYCHE_HOME/models/embeddings/`), with progress. On
 *   Apple silicon the onnxruntime library downloads the same way first (`$PSYCHE_HOME/runtimes/`;
 *   ./ort-runtime.ts), as Psyche.app does not ship it; lexical search never needs either;
 *   `router` uses the model router's `embedding` role (Ollama, LM Studio, another local server).
 *   A role bound to a cloud provider is refused (`blocked: cloud_not_allowed`) unless
 * - `search.semantic.allowCloud` (S4, default off, admin-only like every `search.*` key) is on:
 *   then chats, tasks and Library text are sent to that provider to be embedded, the status says
 *   so (`cloud: true`), and its key comes from the vault through the router as for any model.
 */

export const SEMANTIC_SETTINGS = {
  enabled: "search.semantic.enabled",
  engine: "search.semantic.engine",
  model: "search.semantic.model",
  allowCloud: "search.semantic.allowCloud",
} as const;

export type SemanticEngine = "builtin" | "router";

export interface SemanticConfig {
  enabled: boolean;
  engine: SemanticEngine;
  model: string;
  allowCloud: boolean;
}

export function semanticConfig(read: (key: string) => unknown): SemanticConfig {
  const model = read(SEMANTIC_SETTINGS.model);
  return {
    enabled: read(SEMANTIC_SETTINGS.enabled) === true,
    engine: read(SEMANTIC_SETTINGS.engine) === "router" ? "router" : "builtin",
    model:
      typeof model === "string" && embeddingModel(model) !== undefined
        ? model
        : DEFAULT_EMBEDDING_MODEL,
    allowCloud: read(SEMANTIC_SETTINGS.allowCloud) === true,
  };
}

/** How the controller gets an embedder (tests pass fakes; nothing real downloads or runs). */
export interface SemanticEngines {
  builtin(
    spec: EmbeddingModelSpec,
    onDownload: (receivedBytes: number, totalBytes: number) => void,
    signal: AbortSignal,
  ): Promise<SearchEmbedder>;
  router(
    allowCloud: boolean,
  ):
    | { embedder: SearchEmbedder; cloud: boolean }
    | { blocked: "no_embedding_model" | "cloud_not_allowed" };
}

/** The real engines: ModelManager downloads, onnxruntime-node runs. `fetchImpl` is for tests. */
export function defaultSemanticEngines(
  home: string,
  router: SemanticEngines["router"],
  fetchImpl?: typeof fetch,
): SemanticEngines {
  return {
    async builtin(spec, onDownload, signal) {
      const files = [spec.model, spec.tokenizer];
      // The runtime first, when this build does not carry it: its bytes count toward the progress.
      const runtimeBytes = ortRuntimeDownloadBytes({ home });
      if (runtimeBytes > 0) {
        await ensureOrtRuntime({
          home,
          signal,
          ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
          onProgress: (received) =>
            onDownload(received, runtimeBytes + files.reduce((n, f) => n + f.sizeBytes, 0)),
        });
      }
      const manager = new ModelManager({
        home,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
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
      const total = runtimeBytes + files.reduce((n, f) => n + f.sizeBytes, 0);
      let before = runtimeBytes;
      const paths: string[] = [];
      for (const f of files) {
        const offset = before;
        paths.push(
          await manager.ensure(f.file, {
            signal,
            onProgress: (p) => onDownload(offset + p.receivedBytes, total),
          }),
        );
        before += f.sizeBytes;
      }
      onDownload(total, total);
      const [modelPath, tokenizerPath] = paths as [string, string];
      return createOnnxEmbedder({ spec, modelPath, tokenizerPath, runtime: { home } });
    },
    router,
  };
}

/**
 * The router engine: the provider bound to the `embedding` role, if it runs on this machine
 * (Ollama, LM Studio, llama.cpp, another local server). A cloud-bound role is refused unless
 * `allowCloud()` (S4); the router never falls back across providers for embeddings.
 */
export function routerEmbedder(
  router: ModelRouter | undefined,
  allowCloud: boolean,
): ReturnType<SemanticEngines["router"]> {
  const binding = router?.role("embedding");
  if (router === undefined || binding === undefined) return { blocked: "no_embedding_model" };
  const providerId = binding.model.split("/")[0];
  const provider = router.providers().find((p) => p.id === providerId);
  const local = provider instanceof AiSdkAdapter && isLocalKind(provider.config.kind);
  if (!local && !allowCloud) return { blocked: "cloud_not_allowed" };
  return {
    cloud: !local,
    embedder: {
      model: `router/${binding.model}`,
      embed: (texts, purpose, signal) =>
        router.embed(texts, { task: purpose, ...(signal === undefined ? {} : { signal }) }),
    },
  };
}

export class SemanticController {
  readonly #semantic: SemanticIndex;
  readonly #engines: SemanticEngines;
  readonly #onChange: () => void;
  #config: SemanticConfig = {
    enabled: false,
    engine: "builtin",
    model: DEFAULT_EMBEDDING_MODEL,
    allowCloud: false,
  };
  #status: SearchSemanticStatus = { enabled: false, engine: "builtin", state: "off" };
  #abort: AbortController | null = null;
  #applying: Promise<void> = Promise.resolve();

  constructor(semantic: SemanticIndex, engines: SemanticEngines, onChange: () => void) {
    this.#semantic = semantic;
    this.#engines = engines;
    this.#onChange = onChange;
  }

  status(): SearchSemanticStatus {
    const p = this.#semantic.progress();
    const s: SearchSemanticStatus = { ...this.#status };
    if (s.state === "indexing" || s.state === "ready" || s.state === "error") {
      s.vectors = this.#semantic.count();
      if (p.model !== undefined) s.model = p.model;
      if (p.dims !== undefined) s.dims = p.dims;
      if (p.state === "indexing" || p.state === "ready") {
        s.state = p.state;
        s.done = p.done;
        s.total = p.total;
      }
      if (p.state === "error") {
        s.state = "error";
        if (p.error !== undefined) s.error = p.error;
      }
    }
    return s;
  }

  /** The semantic index reported progress. */
  progressed(_p: SemanticProgress): void {
    this.#onChange();
  }

  /** Applies settings; a change while a download runs cancels it. Resolves when applied. */
  apply(config: SemanticConfig): Promise<void> {
    const same =
      config.enabled === this.#config.enabled &&
      config.engine === this.#config.engine &&
      config.model === this.#config.model &&
      config.allowCloud === this.#config.allowCloud;
    if (same && this.#status.state !== "error") return this.#applying;
    this.#config = config;
    this.#abort?.abort();
    const ac = new AbortController();
    this.#abort = ac;
    this.#applying = this.#applying.then(() => this.#apply(config, ac.signal));
    return this.#applying;
  }

  /** Stops a running download (Gateway shutdown). */
  stop(): void {
    this.#abort?.abort();
  }

  async #apply(config: SemanticConfig, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const base = { enabled: config.enabled, engine: config.engine };
    if (!config.enabled) {
      this.#semantic.setEmbedder(undefined);
      this.#semantic.clear();
      this.#set({ ...base, state: "off" });
      return;
    }
    if (config.engine === "router") {
      const r = this.#engines.router(config.allowCloud);
      if ("blocked" in r) {
        this.#semantic.setEmbedder(undefined);
        this.#set({ ...base, state: "blocked", blocked: r.blocked });
        return;
      }
      this.#semantic.setEmbedder(r.embedder);
      this.#set({
        ...base,
        state: "indexing",
        model: r.embedder.model,
        ...(r.cloud ? { cloud: true } : {}),
      });
      return;
    }
    const spec = embeddingModel(config.model);
    if (spec === undefined) {
      this.#set({ ...base, state: "error", error: `unknown embedding model ${config.model}` });
      return;
    }
    try {
      let last = 0;
      this.#set({ ...base, state: "downloading", receivedBytes: 0, totalBytes: 0 });
      const embedder = await this.#engines.builtin(
        spec,
        (receivedBytes, totalBytes) => {
          const now = Date.now();
          if (now - last < 250 && receivedBytes < totalBytes) return;
          last = now;
          this.#set({ ...base, state: "downloading", receivedBytes, totalBytes });
        },
        signal,
      );
      if (signal.aborted) return;
      this.#semantic.setEmbedder(embedder);
      this.#set({ ...base, state: "indexing", model: embedder.model, dims: spec.dims });
    } catch (err) {
      if (signal.aborted) return;
      this.#set({
        ...base,
        state: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #set(status: SearchSemanticStatus): void {
    this.#status = status;
    this.#onChange();
  }
}
