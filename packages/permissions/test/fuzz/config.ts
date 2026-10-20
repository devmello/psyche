/**
 * Fuzz run settings. CI runs a fixed seed and a small count; a long run is opt-in:
 *
 *   PSYCHE_FUZZ_LONG=1 pnpm --filter @psyche/permissions test fuzz        # 20,000 runs per property
 *   PSYCHE_FUZZ_SEED=123 PSYCHE_FUZZ_RUNS=5000 pnpm --filter @psyche/permissions test fuzz
 *
 * A failing property prints its seed and path; replay with PSYCHE_FUZZ_SEED and fast-check's
 * `path` from the report.
 */
const long = process.env.PSYCHE_FUZZ_LONG === "1";

export const FUZZ = {
  seed: Number(process.env.PSYCHE_FUZZ_SEED ?? 20261020),
  numRuns: Number(process.env.PSYCHE_FUZZ_RUNS ?? (long ? 20_000 : 120)),
  /** Async properties (broker decisions) are slower: a quarter of the count. */
  asyncRuns: Number(process.env.PSYCHE_FUZZ_RUNS ?? (long ? 5_000 : 40)),
  timeoutMs: long ? 600_000 : 30_000,
};
