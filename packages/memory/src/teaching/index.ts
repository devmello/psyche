// The teaching loop's Gateway side (docs/agent/teaching-loop-2026.md §3–4, issue #679).

import { normalizeEmail, normalizeName } from "../graph/normalize.ts";
import type { GraphStore } from "../graph/store.ts";

export * from "./confidence.ts";
export * from "./growth.ts";
export * from "./lines.ts";
export * from "./router.ts";
export * from "./service.ts";
export * from "./store.ts";
export * from "./writers.ts";

/**
 * A person or project in the people graph by email address, name or alias (exact, case- and
 * accent-insensitive); `undefined` when none or more than one matches, so a lesson never lands
 * on the wrong person.
 */
export function graphEntityResolver(
  graph: GraphStore,
): (nameOrAddress: string) => string | undefined {
  return (raw) => {
    const email = raw.includes("@") ? normalizeEmail(raw) : undefined;
    if (email !== undefined) {
      const id = graph.resolveIdentifier("email", email);
      if (id !== undefined) return graph.resolveMerged(id);
    }
    const want = normalizeName(raw);
    if (want === "") return undefined;
    const hits = graph
      .listEntities(["person", "project", "org"])
      .filter(
        (e) => normalizeName(e.name) === want || e.aliases.some((a) => normalizeName(a) === want),
      );
    return hits.length === 1 ? hits[0]?.id : undefined;
  };
}
