import type { RunStep } from "@psyche/protocol";
import type { Gap } from "../../components/timeline/scale.ts";
import { ms } from "./model.ts";

/**
 * Replay (docs/design/run-trace-2026.md §3.5): re-render a trace's state at a point in time. Pure:
 * nothing re-executes; the waterfall, the inspector and the frame viewer read `stepsAt(steps, t)`.
 */

export type ReplaySpeed = 1 | 4 | 16;
export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 4, 16];
/** Reduced motion: play advances one event every 600 ms instead of animating bars. */
export const REDUCED_STEP_MS = 600;

/**
 * The steps as they were at `t`: not-yet-started steps are gone; a step that hadn't ended is
 * running (or waiting, for approvals and questions) with no end; a retried step shows the attempt
 * that was live at `t`, with only the attempts that had finished by then.
 */
export function stepsAt(steps: readonly RunStep[], t: number): RunStep[] {
  const out: RunStep[] = [];
  for (const s of steps) {
    const earlier = s.attempts ?? [];
    const firstStart = ms(earlier[0]?.startedAt) ?? ms(s.startedAt) ?? 0;
    if (firstStart > t) continue;
    const start = ms(s.startedAt) ?? 0;
    if (start > t) {
      // Inside an earlier attempt (or between attempts): show that attempt as the step.
      const done = earlier.filter((a) => (ms(a.endedAt) ?? Number.POSITIVE_INFINITY) <= t);
      const live = earlier.find(
        (a) => (ms(a.startedAt) ?? 0) <= t && (ms(a.endedAt) ?? Number.POSITIVE_INFINITY) > t,
      );
      const last = live ?? done.at(-1);
      if (last === undefined) continue;
      const attemptNo = done.length + (live ? 1 : 0);
      out.push({
        ...s,
        startedAt: last.startedAt,
        endedAt: live ? null : last.endedAt,
        status: live ? "running" : last.status,
        attempt: attemptNo,
        attempts: live ? done : done.slice(0, -1),
        ...(last.error ? { error: last.error } : {}),
      });
      continue;
    }
    const end = ms(s.endedAt);
    if (end !== null && end <= t) {
      out.push(s);
      continue;
    }
    const waiting = s.kind === "approval" || s.kind === "question";
    const { error: _error, doneLabel: _done, ...rest } = s;
    out.push({
      ...rest,
      status: waiting ? "waiting" : "running",
      endedAt: null,
      ...(s.doneLabel ? { doneLabel: s.doneLabel } : {}),
    });
  }
  return out;
}

/** Every start and end in the trace, ascending and unique: `,` and `.` step between them. */
export function eventTimes(steps: readonly RunStep[]): number[] {
  const set = new Set<number>();
  for (const s of steps) {
    for (const a of s.attempts ?? []) {
      const a0 = ms(a.startedAt);
      const a1 = ms(a.endedAt);
      if (a0 !== null) set.add(a0);
      if (a1 !== null) set.add(a1);
    }
    const s0 = ms(s.startedAt);
    const s1 = ms(s.endedAt);
    if (s0 !== null) set.add(s0);
    if (s1 !== null) set.add(s1);
  }
  return [...set].sort((a, b) => a - b);
}

export function nextEvent(events: readonly number[], t: number): number | null {
  return events.find((e) => e > t) ?? null;
}

export function prevEvent(events: readonly number[], t: number): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i] as number;
    if (e < t) return e;
  }
  return null;
}

/** When steps failed (an attempt or the step itself): "Stop at failures" pauses there. */
export function failureTimes(steps: readonly RunStep[]): number[] {
  const out: number[] = [];
  for (const s of steps) {
    for (const a of s.attempts ?? []) {
      const end = ms(a.endedAt);
      if (a.status === "failed" && end !== null) out.push(end);
    }
    const end = ms(s.endedAt);
    if (s.status === "failed" && end !== null) out.push(end);
  }
  return out.sort((a, b) => a - b);
}

export interface PlayOptions {
  speed: ReplaySpeed;
  end: number;
  gaps: readonly Gap[];
  skipWaits: boolean;
  stopAtFailures: boolean;
  failures: readonly number[];
}

export type PlayStop = "end" | "failure" | null;

/**
 * One tick of the replay clock: `dtMs` of wall time at `speed`. With "Skip waits" a tick that
 * lands inside an idle gap jumps to the gap's end; with "Stop at failures" it stops on the first
 * failure it crosses; it never passes `end`.
 */
export function advance(t: number, dtMs: number, o: PlayOptions): { t: number; stop: PlayStop } {
  let next = t + dtMs * o.speed;
  if (o.skipWaits) {
    for (const g of o.gaps) {
      if (next > g.from && next < g.to && g.to > t) {
        next = g.to;
        break;
      }
    }
  }
  if (o.stopAtFailures) {
    const hit = o.failures.find((f) => f > t && f <= next);
    if (hit !== undefined) return { t: hit, stop: "failure" };
  }
  if (next >= o.end) return { t: o.end, stop: "end" };
  return { t: next, stop: null };
}

/** Reduced motion: play jumps to the next event (skipping waits the same way). */
export function advanceReduced(
  t: number,
  events: readonly number[],
  o: Omit<PlayOptions, "speed">,
): { t: number; stop: PlayStop } {
  const next = nextEvent(events, t);
  if (next === null || next >= o.end) return { t: o.end, stop: "end" };
  if (o.stopAtFailures && o.failures.includes(next)) return { t: next, stop: "failure" };
  return { t: next, stop: null };
}

/** The step under the playhead: the latest one that had started by `t` (the inspector follows). */
export function stepAtTime(steps: readonly RunStep[], t: number): RunStep | null {
  let best: RunStep | null = null;
  for (const s of stepsAt(steps, t)) {
    if (best === null || (ms(s.startedAt) ?? 0) >= (ms(best.startedAt) ?? 0)) best = s;
  }
  return best;
}
