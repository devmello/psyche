import type { Artifact } from "@psyche/protocol";
import { type LoadState, useGatewayQuery } from "./hooks.ts";

/**
 * `artifacts.list` across all threads, newest first (docs/design/agent-overview-2026.md §5.4,
 * "Built for you"). The store marks the query stale on `artifact.updated` (with the insights
 * queries), so the grid follows new artifacts and new versions.
 */
export function useRecentArtifacts(limit = 8): LoadState & { artifacts: readonly Artifact[] } {
  const { data, ...load } = useGatewayQuery("artifacts.list", { limit });
  return { ...load, artifacts: data?.artifacts ?? NONE };
}

const NONE: readonly Artifact[] = [];
