import {
  countPinnedWidgets,
  getWidget,
  insertWidget,
  listLiveWidgetsOwnedBy,
  listThreadWidgets,
  type PsycheDb,
  updateWidget,
} from "@psyche/db";
import {
  applyWidgetOps,
  collectWidgetBinds,
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
  /** Checks bindings in a spec's root for a thread; returns the taint they add or throws. */
  bindings?: (root: unknown, threadId: string, spaceId?: string | null) => TaintSource[];
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

/**
 * A tracker the Gateway drew for a Space (a template): its owner is `run space:<id>`. No chat
 * drew it, so it has no chat to patch it, list it or count it against a cap; it lives on a host
 * thread only because a widget row needs one (spaces-2026 SR7, SR10).
 */
export const isSpaceHosted = (w: { owner: WidgetOwner }): boolean =>
  w.owner.kind === "run" && w.owner.runId.startsWith("space:");

export interface PatchReach {
  /** The chat that drew the widget. */
  widgetThreadId: string;
  /** The Gateway drew it for a Space (a template): the host thread has no say. */
  widgetHosted?: boolean;
  /** The Space whose shelf holds it, if any. */
  shelfSpaceId: string | null;
  shelfArchived: boolean;
  /** The chat calling `update_ui`, and the Space that chat is in. */
  callerThreadId: string;
  callerThreadSpaceId: string | null;
  /** The Space the calling run belongs to, when known (an automation of the Space). */
  callerRunSpaceId: string | null;
  /** The calling thread's kind; a channel thread never reaches into a Space (SR11). */
  callerThreadKind?: string | null;
  /** The caller is not the owner (a channel peer, a delegated persona): SR11. Default false. */
  callerNotOwner?: boolean;
}

/**
 * Who may patch a widget (generative-ui D9; spaces-2026 SR7): the chat that drew it, plus runs in
 * chats and automations of the Space whose shelf holds it, while that Space is not archived.
 * Nothing outside the Space can address a tracker: another Space, a chat in no Space, an MCP
 * server or a channel all look like "no such widget".
 */
export function mayPatch(r: PatchReach): boolean {
  if (r.callerNotOwner === true) return r.callerThreadId === r.widgetThreadId && !r.widgetHosted;
  if (r.callerThreadId === r.widgetThreadId && r.widgetHosted !== true) return true;
  if (r.shelfSpaceId === null || r.shelfArchived) return false;
  if (r.callerThreadKind === "channel") return false;
  return r.callerThreadSpaceId === r.shelfSpaceId || r.callerRunSpaceId === r.shelfSpaceId;
}

export class WidgetStore {
  readonly #db: PsycheDb;
  readonly #publish: Publish;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (t: unknown) => void;
  readonly #bindings: (root: unknown, threadId: string, spaceId?: string | null) => TaintSource[];
  readonly #pending = new Map<string, Pending>();
  readonly #lastPublish = new Map<string, number>();

  constructor(opts: WidgetStoreOptions) {
    this.#db = opts.db;
    this.#publish = opts.publish;
    this.#bindings = opts.bindings ?? (() => []);
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
    /** The Space a tracker is drawn for, when the widget is not drawn in one of its chats. */
    spaceId?: string;
  }): Widget {
    const v = validateWidgetSpec(input.spec);
    if (!v.ok) throw invalid("The widget spec", v.issues);
    const bound = this.#bindings((input.spec as WidgetSpec).root, input.threadId, input.spaceId);
    const widget = insertWidget(this.#db, {
      threadId: input.threadId,
      messageId: input.messageId,
      spec: input.spec as WidgetSpec,
      taint: mergeTaint([], [...input.taint, ...bound]),
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
    /** The Space the calling run belongs to, when the caller knows it (spaces-2026 SR7). */
    runSpaceId?: string | null;
    /** The caller is not the owner (a channel peer or delegated persona): no reach into a Space. */
    notOwner?: boolean;
  }): Widget {
    const shape = validateWidgetPatch({
      widgetId: input.widgetId,
      ...(input.baseRev === undefined ? {} : { baseRev: input.baseRev }),
      ops: input.ops,
    });
    if (!shape.ok) throw invalid("The patch", shape.issues);
    this.#freezeIdle(input.threadId);
    const current = this.#reach(input.widgetId, input.threadId, input.runSpaceId, input.notOwner);
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
    const bound = this.#bindings(
      applied.spec.root,
      input.threadId,
      this.shelfSpace(current.id)?.id,
    );
    const taint = mergeTaint(current.taint, [...input.taint, ...bound]);
    const next = updateWidget(this.#db, current.id, current.rev, {
      spec: applied.spec,
      taint,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    if (next === null) {
      throw new PsycheError("conflict", "The widget changed while patching; retry.");
    }
    this.#queue(next, current.rev, ops);
    for (const l of this.#patched) l(next);
    return next;
  }

  readonly #patched = new Set<(w: Widget) => void>();

  /** Called after a chat or run patched a widget (not for the Gateway's own recompute). */
  onPatched(listener: (w: Widget) => void): () => void {
    this.#patched.add(listener);
    return () => this.#patched.delete(listener);
  }

  /**
   * The Gateway's own patch of a tracker on a Space's shelf (a query recompute, spaces-2026 section
   * 6.3): no chat is involved, and only a live widget on the shelf of a Space that is not archived
   * can be reached this way. The result is validated whole and its taint only grows, like any
   * patch. Returns null when nothing changed, so an idle recompute writes and publishes nothing.
   */
  patchShelved(input: {
    widgetId: string;
    ops: WidgetOp[];
    taint: readonly TaintSource[];
  }): Widget | null {
    const shelf = this.shelfSpace(input.widgetId);
    const current = getWidget(this.#db, input.widgetId);
    if (shelf === null || shelf.archived || current === null || current.state === "frozen") {
      throw new PsycheError("not_found", `No live tracker ${input.widgetId} on a Space shelf.`);
    }
    const applied = applyWidgetOps(current.spec, input.ops);
    if (!applied.ok) throw invalid("The tracker refresh", applied.issues);
    const taint = mergeTaint(current.taint, input.taint);
    const unchanged =
      JSON.stringify(applied.spec) === JSON.stringify(current.spec) &&
      taint.length === current.taint.length;
    if (unchanged) return null;
    const next = updateWidget(this.#db, current.id, current.rev, {
      spec: applied.spec,
      taint,
      updatedAt: new Date(this.#now()).toISOString(),
    });
    if (next === null) throw new PsycheError("conflict", "The widget changed while refreshing.");
    this.#queue(next, current.rev, input.ops);
    return next;
  }

  /** The Space whose shelf holds this widget, and whether that Space is archived. */
  shelfSpace(widgetId: string): { id: string; archived: boolean } | null {
    const row = this.#db.sqlite
      .prepare(
        `SELECT t.space_id AS id, s.archived_at AS archived_at FROM space_trackers t
           JOIN spaces s ON s.id = t.space_id WHERE t.widget_id = ?`,
      )
      .get(widgetId) as { id: string; archived_at: string | null } | undefined;
    return row === undefined ? null : { id: row.id, archived: row.archived_at !== null };
  }

  /** Freezes a widget now (a Space was archived, or its source is gone). Frozen stays frozen. */
  freezeWidget(widgetId: string): void {
    const w = getWidget(this.#db, widgetId);
    if (w !== null && w.state === "live") this.#freeze(w);
  }

  /** `list_ui`: this thread's widgets, newest patch first, without their specs. */
  list(
    threadId: string,
  ): Array<
    Pick<Widget, "id" | "rev" | "state" | "updatedAt"> & { title: string; fallbackText: string }
  > {
    this.#freezeIdle(threadId);
    return listThreadWidgets(this.#db, threadId)
      .filter((w) => !isSpaceHosted(w))
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

  /**
   * The owner (a task, automation or job) ended: its widgets freeze, unless they are bound to a
   * live entity (then the host keeps them current; §5.1). A run-owned widget never freezes here:
   * the agent may patch it in later runs of the same chat (D9).
   */
  freezeOwnedBy(kind: "task" | "automation" | "job", id: string): number {
    let n = 0;
    for (const w of listLiveWidgetsOwnedBy(this.#db, kind, id)) {
      if (collectWidgetBinds(w.spec.root).length > 0) continue;
      this.#freeze(w);
      n++;
    }
    return n;
  }

  /**
   * Pin to the Overview (D5): at most 6 across the app; the widget keeps its bindings and taint.
   * Unpinning is always allowed. Returns the widget as it now is.
   */
  setPinned(widgetId: string, pinned: boolean): Widget {
    const w = getWidget(this.#db, widgetId);
    if (w === null) throw new PsycheError("not_found", "No such widget.");
    if (w.pinned === pinned) return w;
    if (pinned && countPinnedWidgets(this.#db) >= WIDGET_LIMITS.pinned) {
      throw new PsycheError(
        "conflict",
        `You can pin up to ${WIDGET_LIMITS.pinned} widgets to the Overview. Unpin one first.`,
      );
    }
    const next = updateWidget(this.#db, w.id, w.rev, { pinned, updatedAt: w.updatedAt });
    if (next === null) throw new PsycheError("conflict", "The widget changed; try again.");
    this.#publish(
      "widget.updated",
      { widgetId: w.id, threadId: w.threadId, rev: next.rev, ops: [], pinned },
      w.threadId,
    );
    return next;
  }

  /** Publishes anything still waiting (shutdown, tests). */
  flush(): void {
    for (const id of [...this.#pending.keys()]) this.#emit(id);
  }

  /**
   * The widget `threadId` may patch (D9 plus spaces-2026 SR7): its own chat's, and a tracker on the
   * shelf of the Space the caller's chat or run belongs to. Anything else looks like a missing one.
   */
  #reach(
    widgetId: string,
    threadId: string,
    runSpaceId?: string | null,
    notOwner?: boolean,
  ): Widget {
    const w = getWidget(this.#db, widgetId);
    const shelf = w === null ? null : this.shelfSpace(w.id);
    const thread = this.#db.sqlite
      .prepare("SELECT space_id, kind FROM threads WHERE id = ?")
      .get(threadId) as { space_id: string | null; kind: string } | undefined;
    const threadSpace = thread?.space_id;
    // Another thread's widget looks exactly like a missing one: ids cannot be probed (D9).
    if (
      w === null ||
      !mayPatch({
        widgetThreadId: w.threadId,
        widgetHosted: isSpaceHosted(w),
        callerThreadKind: thread?.kind ?? null,
        callerNotOwner: notOwner === true,
        shelfSpaceId: shelf?.id ?? null,
        shelfArchived: shelf?.archived ?? false,
        callerThreadId: threadId,
        callerThreadSpaceId: threadSpace ?? null,
        callerRunSpaceId: runSpaceId ?? null,
      })
    ) {
      throw new PsycheError(
        "not_found",
        `No widget ${widgetId} in this chat. list_ui shows yours.`,
      );
    }
    return w;
  }

  #enforceCap(threadId: string, keep: string): void {
    // A tracker on a Space shelf neither counts against the cap nor freezes for it (section 6.1).
    const live = listThreadWidgets(this.#db, threadId, { state: "live" }).filter(
      (w) => !this.#shelved(w.id) && !isSpaceHosted(w),
    );
    const over = live.length - WIDGET_LIMITS.livePerThread;
    if (over <= 0) return;
    // Oldest `updatedAt` first: the least recently patched freezes first.
    const victims = live.filter((w) => w.id !== keep).slice(0, over);
    for (const w of victims) this.#freeze(w);
  }

  #freezeIdle(threadId: string): void {
    const cutoff = this.#now() - WIDGET_IDLE_FREEZE_MS;
    for (const w of listThreadWidgets(this.#db, threadId, { state: "live" })) {
      // A pinned widget bound to a live entity stays current without patches (§5.4, D5).
      if (w.pinned && collectWidgetBinds(w.spec.root).length > 0) continue;
      // A tracker stays live while it is on the shelf of a Space that is not archived (section 6.1).
      if (this.#shelved(w.id)) continue;
      if (Date.parse(w.updatedAt) < cutoff) this.#freeze(w);
    }
  }

  #shelved(widgetId: string): boolean {
    const shelf = this.shelfSpace(widgetId);
    return shelf !== null && !shelf.archived;
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
