import type { ModelProvider, ModelRef } from "@psyche/protocol";

/**
 * Embeddings for the ledger's topics and the candidate pool. The provider's `embed` is used when
 * it has one; otherwise a deterministic hashed bag-of-words vector, so the Feed ranks the same
 * way offline and in tests (the scripted provider also has a fake `embed`).
 */

export type Embedder = (texts: string[]) => Promise<number[][]>;

const DIMS = 256;

function hash(word: string): number {
  let h = 2166136261;
  for (let i = 0; i < word.length; i += 1) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hashed bag of words (unigrams + bigrams), L2-normalized. */
export function lexicalEmbedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const add = (token: string, w: number) => {
    const h = hash(token);
    v[h % DIMS] = (v[h % DIMS] ?? 0) + w * ((h >>> 8) % 2 === 0 ? 1 : -1);
  };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    if (w.length < 3) continue;
    add(w, 1);
    const next = words[i + 1];
    if (next !== undefined && next.length >= 3) add(`${w} ${next}`, 0.5);
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** An embedder over the provider, with an in-memory cache and the lexical fallback. */
export function createEmbedder(
  provider: Pick<ModelProvider, "embed"> | undefined,
  options: { model?: ModelRef; signal?: AbortSignal } = {},
): Embedder {
  const cache = new Map<string, number[]>();
  return async (texts) => {
    const missing = [...new Set(texts.filter((t) => !cache.has(t)))];
    if (missing.length > 0) {
      let vectors: number[][] | undefined;
      if (provider?.embed !== undefined) {
        try {
          vectors = await provider.embed(missing, {
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          if (vectors.length !== missing.length) vectors = undefined;
        } catch {
          vectors = undefined;
        }
      }
      missing.forEach((t, i) => {
        cache.set(t, vectors?.[i] ?? lexicalEmbedding(t));
      });
    }
    return texts.map((t) => cache.get(t) ?? lexicalEmbedding(t));
  };
}
