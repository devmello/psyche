import type { SearchEmbedder } from "./semantic.ts";

/** An embedder that can give its memory back (the ONNX session). */
export interface ReleasableEmbedder extends SearchEmbedder {
  release?(): Promise<void>;
}

export interface LazyEmbedder extends SearchEmbedder {
  /** Whether the model is in memory now. */
  loaded(): boolean;
  /** Frees the model now (it loads again on the next `embed`). */
  release(): Promise<void>;
}

/**
 * Loads the model on the first `embed` and frees it after `idleMs` without one, so a feature
 * that embeds now and then (memory recall) costs no RAM while idle. `model` must be the vector
 * space the loaded embedder reports, known before loading. A failed load is not cached: the
 * next call tries again.
 */
export function lazyEmbedder(options: {
  model: string;
  floor?: number;
  load: () => Promise<ReleasableEmbedder>;
  idleMs?: number;
}): LazyEmbedder {
  const idleMs = options.idleMs ?? 60_000;
  let current: Promise<ReleasableEmbedder> | null = null;
  let running = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const release = async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const was = current;
    current = null;
    const e = await was?.catch(() => undefined);
    await e?.release?.().catch(() => undefined);
  };
  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (running === 0) void release();
    }, idleMs);
    timer.unref?.();
  };

  return {
    model: options.model,
    ...(options.floor === undefined ? {} : { floor: options.floor }),
    loaded: () => current !== null,
    release,
    async embed(texts, purpose, signal) {
      running++;
      try {
        if (current === null) {
          const loading = options.load();
          current = loading;
          loading.catch(() => {
            if (current === loading) current = null;
          });
        }
        const e = await current;
        return await e.embed(texts, purpose, signal);
      } finally {
        running--;
        arm();
      }
    },
  };
}
