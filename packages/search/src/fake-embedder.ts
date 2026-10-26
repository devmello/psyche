import type { SearchEmbedder } from "./semantic.ts";

/**
 * A tiny deterministic embedder for tests (never a real model): each word maps to a concept,
 * either its synonym group in `groups` or a hash bucket of its own, and a text's vector counts its
 * concepts. Texts sharing concepts are close, so "trip budget" finds "how much we can spend in
 * Lisbon" when `[["budget", "spend"], ["trip", "lisbon"]]` are groups.
 */
export interface FakeEmbedder extends SearchEmbedder {
  /** Texts embedded so far, by purpose. */
  readonly calls: { purpose: "document" | "query"; texts: string[] }[];
}

export function fakeEmbedder(
  groups: readonly (readonly string[])[] = [],
  options: { model?: string; dims?: number; queryDelayMs?: number; floor?: number } = {},
): FakeEmbedder {
  const dims = options.dims ?? 64;
  const concept = new Map<string, number>();
  groups.forEach((g, i) => {
    for (const w of g) concept.set(w.toLowerCase(), i % dims);
  });
  const bucket = (w: string) => {
    let h = 2166136261;
    for (const c of w) h = Math.imul(h ^ (c.codePointAt(0) ?? 0), 16777619);
    return groups.length + (Math.abs(h) % Math.max(1, dims - groups.length));
  };
  const calls: FakeEmbedder["calls"] = [];
  return {
    model: options.model ?? `fake/concepts-${dims}`,
    ...(options.floor === undefined ? {} : { floor: options.floor }),
    calls,
    async embed(texts, purpose, signal) {
      calls.push({ purpose, texts: [...texts] });
      if (purpose === "query" && options.queryDelayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, options.queryDelayMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      return texts.map((text) => {
        const v = new Array<number>(dims).fill(0);
        for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
          if (w.length < 3) continue;
          const i = concept.get(w) ?? bucket(w);
          v[i] = (v[i] ?? 0) + 1;
        }
        return v;
      });
    },
  };
}
