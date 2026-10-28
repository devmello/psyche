/** The slice of `models.list` that says which models may run a thread in Auto. */
export interface ListedAutoModels {
  providers?: { models?: { ref: string; autoMode?: boolean }[] }[];
  roles?: { primary?: string };
}

/**
 * The model that keeps a thread out of Auto, or null when Auto is (or may be) available.
 * A thread without a pin runs on the primary role's model. Only a model the Gateway reported
 * with `autoMode: false` blocks; anything unknown is left to the Gateway to judge.
 */
export function autoModeBlockedBy(
  listed: ListedAutoModels | undefined,
  modelRef: string | null | undefined,
): string | null {
  const ref = modelRef ?? listed?.roles?.primary;
  if (ref === undefined) return null;
  for (const p of listed?.providers ?? []) {
    for (const m of p.models ?? []) {
      if (m.ref === ref && m.autoMode === false) return ref;
    }
  }
  return null;
}
