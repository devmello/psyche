import type { PointsDigest } from "@psyche/protocol";
import {
  foldPointsText,
  parsePointsDates,
  sanitizePointsNote,
} from "@psyche/protocol/points-rules";
import type { PointsCheckedPlan, PointsCheckedStep } from "./points-plan.ts";

/**
 * Psyche points, the step tracker and the budget (docs/design/psyche-points-2026.md §3.4, §7, W6).
 * Pure state with no timers, no events and no model calls: it answers "where does the arrow go
 * now" from what the helper reports, and "may another model call be made".
 *
 * - **Moving on is local.** The target moves to the next planned step when the target field loses
 *   focus with a new value, or when focus lands on the planned next field. Skip and Back move it
 *   by hand. A `skip` step is shown in passing and never waited on. The `review` and `next_page`
 *   buttons come last.
 * - **Pages.** A digest with a new fingerprint is a new page and needs one plan call. A fingerprint
 *   seen before (the owner pressed the form's own Back) reuses its plan: no call.
 * - **Mistakes** are found without a model: a committed value that misses the step's expectation,
 *   or a field the form marks invalid. Both are returned as data for the card to word.
 * - **Budget.** At most 30 calls or 300k input tokens a session. At the cap nothing more is asked
 *   and the card keeps pointing from the last plan.
 */

export const POINTS_BUDGET_LIMITS = { maxCalls: 30, maxInputTokens: 300_000 } as const;
/** Pages kept for replay; the oldest one that is not on screen goes first. */
export const POINTS_PAGES_MAX = 50;
/** A page whose plan failed this many times is not asked again until the form changes. */
export const POINTS_PLAN_FAILURES_MAX = 2;

export type PointsCallKind = "plan" | "check" | "stuck" | "form_error";

export type PointsBudgetRefusal = "calls" | "tokens";

/** The session's model-call budget (§7). Counts calls and input tokens, never content. */
export class PointsBudget {
  #calls = 0;
  #inputTokens = 0;
  readonly #limits: { maxCalls: number; maxInputTokens: number };

  constructor(limits: Partial<{ maxCalls: number; maxInputTokens: number }> = {}) {
    this.#limits = { ...POINTS_BUDGET_LIMITS, ...limits };
  }

  get calls(): number {
    return this.#calls;
  }

  get inputTokens(): number {
    return this.#inputTokens;
  }

  /** Why no further call may be made, or `null`. */
  exhausted(): PointsBudgetRefusal | null {
    if (this.#calls >= this.#limits.maxCalls) return "calls";
    if (this.#inputTokens >= this.#limits.maxInputTokens) return "tokens";
    return null;
  }

  /**
   * Take one call. `estimatedInput` is checked against what is left, so one big request cannot
   * step over the cap. The call counts from here, whether or not it succeeds.
   */
  begin(estimatedInput = 0): { ok: true } | { ok: false; reason: PointsBudgetRefusal } {
    const stop = this.exhausted();
    if (stop !== null) return { ok: false, reason: stop };
    if (this.#inputTokens + Math.max(0, estimatedInput) > this.#limits.maxInputTokens)
      return { ok: false, reason: "tokens" };
    this.#calls += 1;
    return { ok: true };
  }

  /** Add the input tokens a finished call used (the provider's number, else the estimate). */
  settle(inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0)
      this.#inputTokens += Math.trunc(inputTokens);
  }
}

// ---- Expectations ----

/** What a committed value is checked against (§3.4 mistakes, 1). */
export type PointsMismatch =
  | { type: "shape"; fieldId: string; shape: string; detail?: string }
  | { type: "value"; fieldId: string; suggested: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;
const POSTAL_SHAPE = /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9 -]{1,8}[A-Za-z0-9]$/u;

function digitsOf(value: string): string {
  return value.normalize("NFKC").replace(/[\s().\-/]/gu, "");
}

/** Whether `value` has the shape the step expects. Unknown details never fail a value. */
export function meetsExpectation(
  expect: NonNullable<PointsCheckedStep["expect"]>,
  value: string,
): boolean {
  const v = value.normalize("NFKC").trim();
  switch (expect.shape) {
    case "date":
      return parsePointsDates(v).length === 1;
    case "email":
      return EMAIL_SHAPE.test(v);
    case "phone": {
      const d = digitsOf(v).replace(/^\+/u, "");
      return /^\d{7,15}$/u.test(d);
    }
    case "postal":
      return POSTAL_SHAPE.test(v);
    case "digits": {
      const d = digitsOf(v);
      if (!/^\d+$/u.test(d)) return false;
      const n = /\b(\d{1,2})\b/u.exec(expect.detail ?? "")?.[1];
      return n === undefined ? true : d.length === Number(n);
    }
    case "oneOf": {
      const want = foldPointsText(v);
      return (expect.options ?? []).some((o) => foldPointsText(o) === want);
    }
  }
}

// ---- Pages and steps ----

interface PageState {
  fingerprint: string;
  title: string;
  fieldCount: number;
  lastSeen: number;
  plan?: PointsCheckedPlan;
  /** Planned steps in the order they are walked: `review` and `next_page` last. */
  order: PointsCheckedStep[];
  /** Index of the target in `order`; `order.length` when every step is done. */
  index: number;
  done: Set<string>;
  states: Map<string, "empty" | "filled" | "unknown">;
  failures: number;
  inFlight: boolean;
  /** Error texts already pointed at, per field. */
  quoted: Map<string, string>;
}

export type PointsPageChange = "new" | "same" | "returned";

export type PointsPlanGate =
  | { ok: true }
  | {
      ok: false;
      reason: "has_plan" | "in_flight" | "failed" | "no_page" | PointsBudgetRefusal;
    };

export type PointsTarget =
  | {
      type: "step";
      step: PointsCheckedStep;
      /** `skip` steps right before this one, shown in passing. */
      passing: PointsCheckedStep[];
      n: number;
      total: number;
    }
  | { type: "finished"; total: number }
  | { type: "no_plan" };

export interface PointsPageSummary {
  title: string;
  fields: number;
}

const LAST_KINDS: ReadonlySet<string> = new Set(["review", "next_page"]);

function orderSteps(steps: readonly PointsCheckedStep[]): PointsCheckedStep[] {
  return [
    ...steps.filter((s) => !LAST_KINDS.has(s.kind)),
    ...steps.filter((s) => LAST_KINDS.has(s.kind)),
  ];
}

/** The tracker for one Points session. One page is on screen at a time. */
export class PointsStepTracker {
  readonly budget: PointsBudget;
  readonly #pages = new Map<string, PageState>();
  readonly #left: PointsPageSummary[] = [];
  readonly #now: () => number;
  #current: PageState | undefined;
  #mismatch: PointsMismatch | undefined;
  #tick = 0;

  constructor(options: { budget?: PointsBudget; now?: () => number } = {}) {
    this.budget = options.budget ?? new PointsBudget();
    this.#now = options.now ?? (() => (this.#tick += 1));
  }

  // ---- Pages ----

  /** The helper sent a digest. Says whether it is a new page, the same one or one seen before. */
  observe(digest: PointsDigest): PointsPageChange {
    const fp = digest.fingerprint;
    const known = this.#pages.get(fp);
    const fresh = known === undefined;
    const page = known ?? this.#newPage(digest);
    page.lastSeen = this.#now();
    page.title = sanitizePointsNote(digest.windowTitle, 120);
    page.fieldCount = digest.fields.length;
    for (const f of digest.fields) page.states.set(f.fieldId, f.state);
    const previous = this.#current;
    this.#current = page;
    if (previous === page) return "same";
    if (previous !== undefined) this.#leave(previous);
    this.#mismatch = undefined;
    this.#evict();
    return fresh ? "new" : "returned";
  }

  #newPage(digest: PointsDigest): PageState {
    const page: PageState = {
      fingerprint: digest.fingerprint,
      title: "",
      fieldCount: digest.fields.length,
      lastSeen: this.#now(),
      order: [],
      index: 0,
      done: new Set(),
      states: new Map(),
      failures: 0,
      inFlight: false,
      quoted: new Map(),
    };
    this.#pages.set(digest.fingerprint, page);
    return page;
  }

  #leave(page: PageState): void {
    this.#left.push({ title: page.title, fields: page.fieldCount });
    if (this.#left.length > 100) this.#left.shift();
  }

  #evict(): void {
    while (this.#pages.size > POINTS_PAGES_MAX) {
      let oldest: PageState | undefined;
      for (const p of this.#pages.values())
        if (p !== this.#current && (oldest === undefined || p.lastSeen < oldest.lastSeen))
          oldest = p;
      if (oldest === undefined) return;
      this.#pages.delete(oldest.fingerprint);
    }
  }

  /** Titles and field counts of the pages the owner has left, newest last. No values. */
  earlierPages(): PointsPageSummary[] {
    return this.#left.map((p) => ({ ...p }));
  }

  // ---- The plan call gate ----

  /**
   * May a plan call be made for the page on screen? `has_plan` is the multi-page replay: a page
   * seen again never costs a call. `failed` stops a loop on a page whose plan keeps failing. The
   * budget is taken here, so one gate covers the cap.
   */
  beginPlan(estimatedInput = 0): PointsPlanGate {
    const page = this.#current;
    if (page === undefined) return { ok: false, reason: "no_page" };
    if (page.plan !== undefined) return { ok: false, reason: "has_plan" };
    if (page.inFlight) return { ok: false, reason: "in_flight" };
    if (page.failures >= POINTS_PLAN_FAILURES_MAX) return { ok: false, reason: "failed" };
    const b = this.budget.begin(estimatedInput);
    if (!b.ok) return b;
    page.inFlight = true;
    return { ok: true };
  }

  /** The plan for the page `beginPlan` was called on (still on screen or not). */
  completePlan(fingerprint: string, plan: PointsCheckedPlan, usage?: { input: number }): void {
    if (usage !== undefined) this.budget.settle(usage.input);
    const page = this.#pages.get(fingerprint);
    if (page === undefined) return;
    page.inFlight = false;
    page.plan = plan;
    page.order = orderSteps(plan.steps);
    page.done = new Set();
    page.index = 0;
    // Fields the form already holds a value in are not waited on.
    this.#settle(page, 0);
  }

  failPlan(fingerprint: string, usage?: { input: number }): void {
    if (usage !== undefined) this.budget.settle(usage.input);
    const page = this.#pages.get(fingerprint);
    if (page === undefined) return;
    page.inFlight = false;
    page.failures += 1;
  }

  /** The fingerprint of the page on screen. */
  get fingerprint(): string | undefined {
    return this.#current?.fingerprint;
  }

  // ---- Moving ----

  /** Put `index` on the first step from `from` that is not a `skip` and not already filled in. */
  #settle(page: PageState, from: number): void {
    let i = from;
    while (i < page.order.length) {
      const s = page.order[i];
      if (s === undefined) break;
      const prefilled =
        (s.kind === "fill" || s.kind === "choose") && page.states.get(s.fieldId) === "filled";
      if (s.kind !== "skip" && !prefilled && !page.done.has(s.fieldId)) break;
      i += 1;
    }
    page.index = i;
  }

  #advance(page: PageState): void {
    const s = page.order[page.index];
    if (s !== undefined) page.done.add(s.fieldId);
    this.#mismatch = undefined;
    let i = page.index + 1;
    while (i < page.order.length) {
      const n = page.order[i];
      if (n !== undefined && (n.kind === "skip" || page.done.has(n.fieldId))) i += 1;
      else break;
    }
    page.index = i;
  }

  /** Where the arrow goes now. */
  target(): PointsTarget {
    const page = this.#current;
    if (page === undefined || page.plan === undefined) return { type: "no_plan" };
    const work = page.order.filter((s) => s.kind !== "skip");
    const step = page.order[page.index];
    if (step === undefined) return { type: "finished", total: work.length };
    const passing: PointsCheckedStep[] = [];
    for (let i = page.index - 1; i >= 0; i -= 1) {
      const p = page.order[i];
      if (p === undefined || p.kind !== "skip") break;
      passing.unshift(p);
    }
    const n = work.findIndex((s) => s.fieldId === step.fieldId) + 1;
    return { type: "step", step, passing, n, total: work.length };
  }

  /**
   * Focus landed on a field. If it is the planned next one, the target moves to it. Focus on any
   * other field changes nothing. Returns whether the target moved.
   */
  focus(fieldId: string): boolean {
    const page = this.#current;
    if (page === undefined || page.plan === undefined) return false;
    const here = page.order[page.index];
    if (here === undefined || here.fieldId === fieldId) return false;
    let next = page.index + 1;
    while (next < page.order.length) {
      const s = page.order[next];
      if (s !== undefined && s.kind !== "skip" && !page.done.has(s.fieldId)) break;
      next += 1;
    }
    if (page.order[next]?.fieldId !== fieldId) return false;
    this.#mismatch = undefined;
    page.done.add(here.fieldId);
    page.index = next;
    return true;
  }

  /**
   * A field lost focus. `changed` is true when it now holds a new value (a checked box or a chosen
   * option counts). `value` is the committed value of a non-sensitive field and is only read for
   * the expectation check; a sensitive step never has one compared.
   *
   * On the target: with a value that misses the step's expectation (or its suggested value) the
   * target stays and the mismatch is returned; otherwise it moves on. A later planned field filled
   * out of order is marked done so it is passed when reached.
   */
  commit(
    fieldId: string,
    change: { changed: boolean; value?: string | undefined },
  ): { moved: boolean; mismatch?: PointsMismatch } {
    const page = this.#current;
    if (page === undefined || page.plan === undefined || !change.changed) return { moved: false };
    page.states.set(fieldId, "filled");
    const step = page.order[page.index];
    if (step === undefined) return { moved: false };
    if (step.fieldId !== fieldId) {
      const later = page.order.find((s, i) => i > page.index && s.fieldId === fieldId);
      if (later !== undefined && later.kind !== "skip" && !LAST_KINDS.has(later.kind))
        page.done.add(fieldId);
      return { moved: false };
    }
    const mismatch = this.#check(step, change.value);
    if (mismatch !== undefined) {
      this.#mismatch = mismatch;
      return { moved: false, mismatch };
    }
    this.#advance(page);
    return { moved: true };
  }

  #check(step: PointsCheckedStep, value: string | undefined): PointsMismatch | undefined {
    // A sensitive field's value is never compared, and the tracker never keeps one.
    if (step.sensitive !== undefined || value === undefined || value.trim() === "")
      return undefined;
    if (step.expect !== undefined) {
      if (!meetsExpectation(step.expect, value))
        return {
          type: "shape",
          fieldId: step.fieldId,
          shape: step.expect.shape,
          ...(step.expect.detail === undefined ? {} : { detail: step.expect.detail }),
        };
      return undefined;
    }
    if (step.value !== undefined && foldPointsText(value) !== foldPointsText(step.value))
      return { type: "value", fieldId: step.fieldId, suggested: step.value };
    return undefined;
  }

  /** "Keep it" on a mismatch: the target moves on. */
  keep(): boolean {
    const page = this.#current;
    if (page === undefined || this.#mismatch === undefined) return false;
    this.#advance(page);
    return true;
  }

  /** "Show me" on a mismatch: the target stays and the mismatch is cleared. */
  showMe(): PointsMismatch | undefined {
    const m = this.#mismatch;
    this.#mismatch = undefined;
    return m;
  }

  get pendingMismatch(): PointsMismatch | undefined {
    return this.#mismatch;
  }

  /** Skip on the card: pass the target by hand. Returns whether the target moved. */
  skip(): boolean {
    const page = this.#current;
    if (page === undefined || page.plan === undefined || page.index >= page.order.length)
      return false;
    this.#advance(page);
    return true;
  }

  /** Back on the card: the previous waited-on step becomes the target again. */
  back(): boolean {
    const page = this.#current;
    if (page === undefined || page.plan === undefined) return false;
    for (let i = page.index - 1; i >= 0; i -= 1) {
      const s = page.order[i];
      if (s === undefined || s.kind === "skip") continue;
      page.done.delete(s.fieldId);
      page.index = i;
      this.#mismatch = undefined;
      return true;
    }
    return false;
  }

  // ---- The form says so ----

  /**
   * A field turned invalid or got new error text. Returns the text to quote, plain and at most
   * 200 characters, once per distinct text per field; `undefined` for a repeat. A sensitive
   * field's error text is never quoted: it can echo what the owner typed.
   */
  invalid(fieldId: string, errorText: string): { fieldId: string; quote: string } | undefined {
    const page = this.#current;
    if (page === undefined) return undefined;
    const planned = page.order.find((s) => s.fieldId === fieldId);
    if (planned?.sensitive !== undefined) return undefined;
    const quote = sanitizePointsNote(errorText, 200);
    if (quote === "" || page.quoted.get(fieldId) === quote) return undefined;
    page.quoted.set(fieldId, quote);
    return { fieldId, quote };
  }
}
