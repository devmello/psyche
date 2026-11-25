import type { Provenance } from "@psyche/protocol";

/**
 * One trust order for fact writes (EM design §4.5), shared by `setFact` and `proposeFact` so a
 * contradiction is decided the same way on both paths: a lower-ranked value never replaces a
 * higher-ranked one, it becomes a "Which is right?" review item.
 */
export const FACT_RANK: Record<Provenance, number> = {
  untrusted: 1,
  agent: 2,
  system: 3,
  owner: 4,
};

/** True when `incoming` ranks below `existing`. */
export function isLowerRanked(incoming: Provenance, existing: Provenance): boolean {
  return FACT_RANK[incoming] < FACT_RANK[existing];
}
