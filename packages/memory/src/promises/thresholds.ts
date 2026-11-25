/**
 * Feedback tunes how sure the ledger must be before a promise opens by itself (design 3.5).
 * Deterministic and stateless: recomputed from the last 90 days of `graph_feedback`.
 */

export type PromiseSource = "mail" | "messages" | "meeting" | "chat" | "manual";
export const PROMISE_SOURCES: readonly PromiseSource[] = [
  "mail",
  "messages",
  "meeting",
  "chat",
  "manual",
];

export const BASE_THRESHOLD = 0.8;
export const MIN_THRESHOLD = 0.7;
export const MAX_THRESHOLD = 0.95;
export const NOT_PROMISE_STEP = 0.02;
export const CONFIRM_STEP = 0.01;
export const WINDOW_DAYS = 90;
const DAY = 86_400_000;

export interface PromiseFeedback {
  kind: "not_promise" | "confirmed_promise";
  source: PromiseSource | null;
  at: number;
  entityId?: string | null;
  cue?: string | null;
}

export function clampThreshold(v: number): number {
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(v * 1000) / 1000));
}

export function computeThreshold(
  source: PromiseSource,
  feedback: readonly PromiseFeedback[],
  nowMs: number,
): number {
  let v = BASE_THRESHOLD;
  for (const f of feedback) {
    if (f.source !== source || f.at > nowMs || nowMs - f.at > WINDOW_DAYS * DAY) continue;
    v += f.kind === "not_promise" ? NOT_PROMISE_STEP : -CONFIRM_STEP;
  }
  return clampThreshold(v);
}

export function computeThresholds(
  feedback: readonly PromiseFeedback[],
  nowMs: number,
): Record<PromiseSource, number> {
  const out = {} as Record<PromiseSource, number>;
  for (const s of PROMISE_SOURCES) out[s] = computeThreshold(s, feedback, nowMs);
  return out;
}

/**
 * Cue phrases with 3 or more `not_promise` and a precision under 50% over 30 days leave the
 * prefilter for that owner. Precision is confirms / (confirms + not_promise).
 */
export function cuesToDisable(feedback: readonly PromiseFeedback[], nowMs: number): string[] {
  const stats = new Map<string, { bad: number; good: number }>();
  for (const f of feedback) {
    if (f.cue === undefined || f.cue === null || f.cue === "") continue;
    if (f.at > nowMs || nowMs - f.at > 30 * DAY) continue;
    const s = stats.get(f.cue) ?? { bad: 0, good: 0 };
    if (f.kind === "not_promise") s.bad += 1;
    else s.good += 1;
    stats.set(f.cue, s);
  }
  return [...stats]
    .filter(([, s]) => s.bad >= 3 && s.good / (s.good + s.bad) < 0.5)
    .map(([cue]) => cue)
    .sort();
}

/** Three `not_promise` for one counterpart in 30 days: their promises always need a confirm. */
export function needsAlwaysConfirm(
  feedback: readonly PromiseFeedback[],
  entityId: string,
  nowMs: number,
): boolean {
  let n = 0;
  for (const f of feedback) {
    if (f.kind !== "not_promise" || f.entityId !== entityId) continue;
    if (f.at <= nowMs && nowMs - f.at <= 30 * DAY) n += 1;
  }
  return n >= 3;
}

/** Stored at 0.6 or more; shown in To confirm at 0.7 or more. */
export const STORE_MIN_CONFIDENCE = 0.6;
export const CONFIRM_MIN_CONFIDENCE = 0.7;
