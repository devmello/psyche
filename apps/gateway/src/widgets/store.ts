import {
  getWidget,
  insertWidget,
  listThreadWidgets,
  type PsycheDb,
  updateWidget,
} from "@psyche/db";
import {
  applyWidgetOps,
  type EventName,
  type EventPayload,
  formatWidgetIssues,
  PsycheError,
  type TaintSource,
  validateWidgetPatch,
  validateWidgetSpec,
  WIDGET_LIMITS,
  type Widget,
  type WidgetOp,
  type WidgetOwner,
  type WidgetSpec,
} from "@psyche/protocol";

/**
 * The Gateway's widget store (docs/design/generative-ui-2026.md §5): validates, applies patches,
 * keeps taint monotone, enforces the live cap (D6), freezes idle widgets and publishes
 * `widget.updated` coalesced to ≤ 4 per widget per second. Only the latest snapshot is stored (D7).
 */

export const WIDGET_PUBLISH_MS = 250;
export const WIDGET_IDLE_FREEZE_MS = 7 * 24 * 60 * 60 * 1000;

type Publish = <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;

export interface WidgetStoreOptions {
  db: PsycheDb;
  publish: Publish;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Pending {
  threadId: string;
  fromRev: number;
  rev: number;
  ops: WidgetOp[];
  timer: unknown;
}

const taintKey = (s: TaintSource) =>
  `${s.sourceKind}|${s.origin ?? ""}|${s.sender ?? ""}|${s.toolCallId ?? ""}`;

/** Union by identity, order kept: taint is monotone (§7.3). */
export function mergeTaint(
  base: readonly TaintSource[],
  add: readonly TaintSource[],
): TaintSource[] {
  const seen = new Set(base.map(taintKey));
  const out = [...base];
  for (const s of add) {
    if (!seen.has(taintKey(s))) {
      seen.add(taintKey(s));
      out.push(s);
    }
  }
  return out;
}

const invalid = (what: string, issues: Parameters<typeof formatWidgetIssues>[0]) =>
  new PsycheError(
    "invalid_params",
    `${what} was rejected. Fix these and call again:\n${formatWidgetIssues(issues)}`,
  );

export class WidgetStore {
  readonly #db: PsycheDb;
  readonly #publish: Publish;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (t: unknown) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #lastPublish = new Map<string, number>();

  constructor(opts: WidgetStoreOptions) {
    this.#db = opts.db;
    this.#publish = opts.publish;
    this.#now = opts.now ?? Date.now;
    this.#setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** `render_ui`: validate, store at rev 1, freeze the least recently patched past the cap. */
  create(input: {
    threadId: string;
    messageId: string;
    spec: unknown;
    taint: readonly TaintSource[];
    owner: WidgetOwner;
  }): Widget {
    const v = validateWidgetSpec(input.spec);
    if (!v.ok) throw invalid("The widget spec", v.issues);
    const widget = insertWidget(this.#db, {
      threadId: input.threadId,
      messageId: input.messageId,
      spec: input.spec as WidgetSpec,
      taint: mergeTaint([], input.taint),
      owner: input.owner,
      createdAt: new Date(this.#now()).toISOString(),
    });
    this.#enforceCap(input.threadId, widget.id);
    return widget;
  }

  /** `update_ui`: same thread only (D9), live only, whole result re-validated, taint added. */
  patch(input: {
    widgetId: string;
    threadId: string;
    baseRev?: number;
    ops: unknown;
    taint: readonly TaintSource[];
  }): Widget {
    const shape = validateWidgetPatch({
      widgetId: input.widgetId,
      ...(input.baseRev === undefined ? {} : { baseRev: input.baseRev }),
      ops: input.ops,
    });
    if (!shape.ok) throw invalid("The patch", shape.issues);
    this.#freezeIdle(input.threadId);
    const current = this.#own(input.widgetId, input.threadId);
    if (current.state === "frozen") {
      throw new PsycheError(
        "conflict",
        `Widget ${current.id} is frozen and takes no more patches. Draw a new one with render_ui if it still matters.`,
      );
    }
    if (input.baseRev !== undefined && input.baseRev !== current.rev) {
      throw new PsycheError(
        "conflict",
        `Stale baseRev ${input.baseRev}: the widget is at rev ${current.rev}. Nothing was changed; re-read it with list_ui and retry on the current rev.`,
      );
    }
    const ops = input.ops as WidgetOp[];
    const applied = applyWidgetOps(current.spec, ops);
    if (!applied.ok) throw invalid("The patch", applied.issues);
    const taint = mergeTaint(current.taint, input.taint);
    const next = updateWidget(this.#db, current.id, current.rev, {
      spec: applied.spec,
      taint,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    if (next === null) {
      throw new PsycheError("conflict", "The widget changed while patching; retry.");
    }
    this.#queue(next, current.rev, ops);
    return next;
  }

  /** `list_ui`: this thread's widgets, newest patch first, without their specs. */
  list(
    threadId: string,
  ): Array<
    Pick<Widget, "id" | "rev" | "state" | "updatedAt"> & { title: string; fallbackText: string }
  > {
    this.#freezeIdle(threadId);
    return listThreadWidgets(this.#db, threadId)
      .reverse()
      .map((w) => ({
        id: w.id,
        rev: w.rev,
        state: w.state,
        updatedAt: w.updatedAt,
        title: w.spec.title,
        fallbackText: w.spec.fallbackText,
      }));
  }

  /** Publishes anything still waiting (shutdown, tests). */
  flush(): void {
    for (const id of [...this.#pending.keys()]) this.#emit(id);
  }

  #own(widgetId: string, threadId: string): Widget {
    const w = getWidget(this.#db, widgetId);
    // Another thread's widget looks exactly like a missing one: ids cannot be probed (D9).
    if (w === null || w.threadId !== threadId) {
      throw new PsycheError(
        "not_found",
        `No widget ${widgetId} in this chat. list_ui shows yours.`,
      );
    }
    return w;
  }

  #enforceCap(threadId: string, keep: string): void {
    const live = listThreadWidgets(this.#db, threadId, { state: "live" });
    const over = live.length - WIDGET_LIMITS.livePerThread;
    if (over <= 0) return;
    // Oldest `updatedAt` first: the least recently patched freezes first.
    const victims = live.filter((w) => w.id !== keep).slice(0, over);
    for (const w of victims) this.#freeze(w);
  }

  #freezeIdle(threadId: string): void {
    const cutoff = this.#now() - WIDGET_IDLE_FREEZE_MS;
    for (const w of listThreadWidgets(this.#db, threadId, { state: "live" })) {
      if (Date.parse(w.updatedAt) < cutoff) this.#freeze(w);
    }
  }

  #freeze(w: Widget): void {
    this.#emit(w.id); // anything queued goes out before the state change
    const frozen = updateWidget(this.#db, w.id, w.rev, { state: "frozen", updatedAt: w.updatedAt });
    if (frozen === null) return;
    this.#publish(
      "widget.updated",
      { widgetId: w.id, threadId: w.threadId, rev: frozen.rev, ops: [], state: "frozen" },
      w.threadId,
    );
  }

  /** Coalesces to ≤ 4 events/s per widget; the event spans `fromRev` → `rev`. */
  #queue(next: Widget, fromRev: number, ops: WidgetOp[]): void {
    const pending = this.#pending.get(next.id);
    if (pending) {
      pending.ops.push(...ops);
      pending.rev = next.rev;
      return;
    }
    const wait = WIDGET_PUBLISH_MS - (this.#now() - (this.#lastPublish.get(next.id) ?? 0));
    const entry: Pending = {
      threadId: next.threadId,
      fromRev,
      rev: next.rev,
      ops: [...ops],
      timer: undefined,
    };
    this.#pending.set(next.id, entry);
    if (wait <= 0) this.#emit(next.id);
    else entry.timer = this.#setTimer(() => this.#emit(next.id), wait);
  }

  #emit(widgetId: string): void {
    const p = this.#pending.get(widgetId);
    if (!p) return;
    this.#pending.delete(widgetId);
    if (p.timer !== undefined) this.#clearTimer(p.timer);
    this.#lastPublish.set(widgetId, this.#now());
    this.#publish(
      "widget.updated",
      { widgetId, threadId: p.threadId, rev: p.rev, fromRev: p.fromRev, ops: p.ops },
      p.threadId,
    );
  }
}
