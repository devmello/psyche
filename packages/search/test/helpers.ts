import type { SearchIndexDocKind } from "@psyche/protocol";
import { FakeClock } from "@psyche/testing";
import { createSearchIndex, type SqliteSearchIndexOptions } from "../src/index.ts";
import type { SearchDoc } from "../src/types.ts";

export const NOW = Date.UTC(2026, 9, 18, 20, 0, 0);
export const DAY = 86_400_000;

export function setup(options: SqliteSearchIndexOptions = {}) {
  const clock = new FakeClock(NOW);
  const index = createSearchIndex({ now: () => clock.now(), ...options });
  return { clock, index };
}

let n = 0;
export function doc(partial: Partial<SearchDoc> & { text: string }): SearchDoc {
  n += 1;
  return {
    id: partial.id ?? `d${n}`,
    kind: (partial.kind ?? "message") as SearchIndexDocKind,
    title: partial.title ?? "",
    provenance: partial.provenance ?? "owner",
    createdAt: partial.createdAt ?? NOW - DAY,
    ...partial,
  };
}
