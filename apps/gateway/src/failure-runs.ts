/**
 * Repeated failures, logged as runs: the first failure of a run of identical errors is always
 * logged, then one line with the count of repeats once an hour. A success ends the run, so the
 * next failure is logged in full again. Nothing is hidden: the owner still sees that it fails.
 */
export interface FailureVerdict {
  /** Whether the caller should write a log line now. */
  log: boolean;
  /** Identical failures since the last line (0 on the first). */
  repeats: number;
}

export interface FailureRuns {
  fail(key: string, error: string): FailureVerdict;
  ok(key: string): void;
}

const HOUR = 3_600_000;

export function failureRuns(opts: { now: () => number; everyMs?: number }): FailureRuns {
  const everyMs = opts.everyMs ?? HOUR;
  const runs = new Map<string, { error: string; repeats: number; reportedAt: number }>();
  return {
    fail(key, error) {
      const now = opts.now();
      const run = runs.get(key);
      if (run === undefined || run.error !== error) {
        runs.set(key, { error, repeats: 0, reportedAt: now });
        return { log: true, repeats: 0 };
      }
      run.repeats += 1;
      if (now - run.reportedAt < everyMs) return { log: false, repeats: run.repeats };
      const repeats = run.repeats;
      run.repeats = 0;
      run.reportedAt = now;
      return { log: true, repeats };
    },
    ok(key) {
      runs.delete(key);
    },
  };
}
