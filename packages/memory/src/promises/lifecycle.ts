/**
 * The promise state machine (design section 4.1) as pure functions: which action is allowed from
 * which state, what it changes, and what the hourly sweep does. `store.ts` applies the results and
 * writes the history, so every rule here runs on a fake clock without a database.
 */

import type { GraphLoop, GraphLoopStatus } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import type { LoopLedger, LoopPatch } from "../graph/store.ts";
import { brokenThreshold, DAY_MS, dueSoonFrom, hasConfidentDue, parseMs, warnAt } from "./due.ts";

export type LedgerLoop = GraphLoop & LoopLedger;
export type PromiseState = GraphLoopStatus | "due_soon";

export type EventKind =
  | "created"
  | "confirmed"
  | "source_added"
  | "due_changed"
  | "due_proposed"
  | "status"
  | "warned"
  | "asked"
  | "nudge_drafted"
  | "nudge_sent"
  | "auto_done"
  | "undo";
export type EventBy = "owner" | "auto" | "model" | "rule";

export type PromiseActionInput =
  | { action: "confirm" }
  | { action: "not_promise" }
  | { action: "done"; by?: "owner" | "auto" | "reply_seen" }
  | { action: "reopen" }
  | { action: "release" }
  | { action: "dismiss" }
  | { action: "snooze"; until: string }
  | { action: "set_due"; dueAt: string }
  | { action: "more_time"; days: number }
  | { action: "accept_proposed" }
  | { action: "reject_proposed" }
  | { action: "answer"; answer: "yes" | "not_yet" };

/** The last open question asked about a promise, from its `asked` events. */
export interface LastAsk {
  /** `done` ("Did Sam send it?"), `still_on` ("Still on?") or a `same_as:<id>` question. */
  question: string;
  at: number;
  /** `not_yet` once the owner answered that way. */
  answered?: "yes" | "not_yet";
}

export interface Decision {
  patch: LoopPatch;
  event: {
    kind: EventKind;
    from: string | null;
    to: string | null;
    by: EventBy;
  } | null;
  feedback?: "not_promise" | "confirmed_promise";
}

export const UNDO_AUTO_DONE_DAYS = 7;
export const NOT_YET_SUPPRESS_DAYS = 3;
export const STILL_ON_AFTER_DAYS = 14;
export const NUDGE_AFTER_DAYS_NO_DUE = 7;
export const AGE_OUT_DAYS = 60;
export const MAX_NUDGES = 2;

const bad = (message: string): never => {
  throw new PsycheError("invalid_params", message);
};

const ACTIVE: readonly GraphLoopStatus[] = ["suggested", "open", "snoozed", "broken"];
const iso = (ms: number) => new Date(ms).toISOString();

/** The computed state: `open` with a confident due date becomes `due_soon` from the day before. */
export function computeState(
  loop: Pick<LedgerLoop, "status" | "dueAt" | "dueKind" | "dueConfidence">,
  nowMs: number,
  tz: string,
): PromiseState {
  if (loop.status !== "open" || !hasConfidentDue(loop)) return loop.status;
  const due = parseMs(loop.dueAt);
  if (due === null) return loop.status;
  return nowMs >= dueSoonFrom(due, tz) ? "due_soon" : "open";
}

function closeStatus(
  loop: LedgerLoop,
  status: "done" | "dismissed" | "released",
  closedBy: NonNullable<LedgerLoop["closedBy"]>,
  nowMs: number,
  by: EventBy,
  kind: EventKind = "status",
): Decision {
  return {
    patch: { status, closedAt: iso(nowMs), closedBy, snoozedUntil: null },
    event: { kind, from: loop.status, to: status, by },
  };
}

function dueChange(loop: LedgerLoop, dueMs: number, by: EventBy): Decision {
  const next = iso(dueMs);
  const reopens = loop.status === "broken";
  return {
    patch: {
      dueAt: next,
      dueKind: "explicit",
      dueConfidence: 1,
      dueText: null,
      proposedDueAt: null,
      warnedAt: null,
      brokenAt: null,
      ...(reopens ? { status: "open" as const } : {}),
    },
    event: { kind: "due_changed", from: loop.dueAt ?? null, to: next, by },
  };
}

/** What an owner action does to a promise, or an `invalid_params` error when it cannot. */
export function decide(
  loop: LedgerLoop,
  input: PromiseActionInput,
  ctx: { nowMs: number; lastAsk?: LastAsk; autoDone?: boolean },
): Decision {
  const { nowMs } = ctx;
  const active = ACTIVE.includes(loop.status);
  switch (input.action) {
    case "confirm": {
      if (loop.status !== "suggested") return bad("only a suggested promise can be confirmed");
      return {
        patch: { status: "open" },
        event: { kind: "confirmed", from: "suggested", to: "open", by: "owner" },
        feedback: "confirmed_promise",
      };
    }
    case "not_promise": {
      if (!active) return bad("this promise is already closed");
      return {
        ...closeStatus(loop, "dismissed", "owner", nowMs, "owner"),
        feedback: "not_promise",
      };
    }
    case "dismiss": {
      if (!active) return bad("this promise is already closed");
      return closeStatus(loop, "dismissed", "owner", nowMs, "owner");
    }
    case "release": {
      if (!active) return bad("this promise is already closed");
      return closeStatus(loop, "released", "released", nowMs, "owner");
    }
    case "done": {
      if (loop.status === "suggested" || !active) return bad("this promise cannot be marked done");
      const by = input.by ?? "owner";
      return closeStatus(
        loop,
        "done",
        by,
        nowMs,
        by === "owner" ? "owner" : "auto",
        by === "owner" ? "status" : "auto_done",
      );
    }
    case "reopen": {
      if (loop.status !== "done" && loop.status !== "dismissed" && loop.status !== "released")
        return bad("only a closed promise can be reopened");
      const closedAt = parseMs(loop.closedAt) ?? nowMs;
      // Undo (limited to 7 days) is for a done the ledger closed itself: an `auto_done` event for
      // this very close, or `closedBy: auto`. Any other reopen, such as a `reply_seen` the ingest
      // rule closed, is the owner's plain reopen and has no limit.
      const undo = loop.status === "done" && (loop.closedBy === "auto" || ctx.autoDone === true);
      if (undo && nowMs - closedAt > UNDO_AUTO_DONE_DAYS * DAY_MS)
        return bad("an automatic done can be undone for 7 days");
      return {
        patch: { status: "open", closedAt: null, closedBy: null, brokenAt: null, warnedAt: null },
        event: {
          kind: undo ? "undo" : "status",
          from: loop.status,
          to: "open",
          by: "owner",
        },
      };
    }
    case "snooze": {
      if (loop.status !== "open" && loop.status !== "snoozed")
        return bad("only an open promise can be snoozed");
      const until = Date.parse(input.until);
      if (Number.isNaN(until) || until <= nowMs) return bad("snooze until a time in the future");
      return {
        patch: { status: "snoozed", snoozedUntil: iso(until) },
        event: { kind: "status", from: loop.status, to: "snoozed", by: "owner" },
      };
    }
    case "set_due": {
      if (!active) return bad("this promise is already closed");
      const due = Date.parse(input.dueAt);
      if (Number.isNaN(due)) return bad("not a date");
      return dueChange(loop, due, "owner");
    }
    case "more_time": {
      if (!active) return bad("this promise is already closed");
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365)
        return bad("days must be a whole number from 1 to 365");
      const base = Math.max(parseMs(loop.dueAt) ?? nowMs, nowMs);
      return dueChange(loop, base + input.days * DAY_MS, "owner");
    }
    case "accept_proposed": {
      const proposed = parseMs(loop.proposedDueAt);
      if (proposed === null || !active) return bad("there is no proposed date");
      return dueChange(loop, proposed, "owner");
    }
    case "reject_proposed": {
      if (loop.proposedDueAt === null) return bad("there is no proposed date");
      return {
        patch: { proposedDueAt: null },
        event: { kind: "due_proposed", from: loop.proposedDueAt, to: null, by: "owner" },
      };
    }
    case "answer": {
      const ask = ctx.lastAsk;
      if (
        ask === undefined ||
        ask.answered !== undefined ||
        (ask.question !== "done" && ask.question !== "still_on")
      )
        return bad("there is no open question");
      if (ask.question === "done") {
        if (input.answer === "yes") return closeStatus(loop, "done", "owner", nowMs, "owner");
        return {
          patch: {},
          event: { kind: "asked", from: "done", to: "not_yet", by: "owner" },
        };
      }
      return {
        patch: {},
        event: {
          kind: input.answer === "yes" ? "confirmed" : "asked",
          from: "still_on",
          to: input.answer === "yes" ? "still_on" : "not_yet",
          by: "owner",
        },
      };
    }
  }
}

/** Whether a `done` question for this promise is held back (a "Not yet" in the last 3 days). */
export function askSuppressed(ask: LastAsk | undefined, nowMs: number): boolean {
  return (
    ask !== undefined &&
    ask.answered === "not_yet" &&
    nowMs - ask.at < NOT_YET_SUPPRESS_DAYS * DAY_MS
  );
}

/** Theirs: whether a chase may be offered. The rate limits are the Gateway's (W4). */
export function nudgeEligible(loop: LedgerLoop, nowMs: number): boolean {
  if (loop.direction !== "waiting_on" || loop.basis !== "promise") return false;
  if (loop.nudgeCount >= MAX_NUDGES) return false;
  if (loop.status === "broken") return true;
  if (loop.status !== "open" || hasConfidentDue(loop)) return false;
  const created = parseMs(loop.createdAt);
  return created !== null && nowMs - created >= NUDGE_AFTER_DAYS_NO_DUE * DAY_MS;
}

export type SweepStep =
  | { kind: "wake" }
  | { kind: "break"; brokenAt: string }
  | { kind: "warn"; dueAt: string }
  | { kind: "still_on" }
  | { kind: "age_out" };

export interface SweepContext {
  nowMs: number;
  tz: string;
  graceDays: number;
  /** The latest sign of life: creation, a re-mention, a date change or an owner action. */
  activityAtMs: number;
  /** When it last became open (creation or confirmation). */
  openSinceMs: number;
  /** When "Still on?" was last asked, if ever. */
  stillOnAskedAtMs?: number;
}

/**
 * The hourly sweep for one promise: the steps it takes now, in order. A step is idempotent by
 * its own guard (a state change, `warned_at`, the asked event), so running the sweep twice, or
 * twice in the same hour, changes nothing the second time.
 */
export function planSweep(loop: LedgerLoop, ctx: SweepContext): SweepStep[] {
  if (loop.basis !== "promise") return [];
  const steps: SweepStep[] = [];
  let status = loop.status;
  if (status === "snoozed") {
    const until = parseMs(loop.snoozedUntil);
    if (until === null || until > ctx.nowMs) return [];
    steps.push({ kind: "wake" });
    status = "open";
  }
  if (status !== "open") return steps;
  const due = parseMs(loop.dueAt);
  if (due !== null && hasConfidentDue(loop)) {
    const grace = loop.direction === "i_owe" ? 0 : ctx.graceDays;
    const at = brokenThreshold(due, grace, ctx.tz);
    if (ctx.nowMs >= at) {
      steps.push({ kind: "break", brokenAt: iso(ctx.nowMs) });
      return steps;
    }
    if (loop.direction === "i_owe") {
      const warn = warnAt(due, ctx.tz);
      const warned = parseMs(loop.warnedAt);
      if (ctx.nowMs >= warn && (warned === null || warned < warn))
        steps.push({ kind: "warn", dueAt: loop.dueAt as string });
    }
    return steps;
  }
  // No usable due date: age out after 60 quiet days, else ask "Still on?" for yours at 14.
  if (ctx.nowMs - ctx.activityAtMs >= AGE_OUT_DAYS * DAY_MS) {
    steps.push({ kind: "age_out" });
    return steps;
  }
  if (
    loop.direction === "i_owe" &&
    ctx.nowMs - ctx.openSinceMs >= STILL_ON_AFTER_DAYS * DAY_MS &&
    (ctx.stillOnAskedAtMs === undefined ||
      ctx.nowMs - ctx.stillOnAskedAtMs >= STILL_ON_AFTER_DAYS * DAY_MS)
  )
    steps.push({ kind: "still_on" });
  return steps;
}
