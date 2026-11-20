import { getWidget, type PsycheDb } from "@psyche/db";
import {
  collectWidgetBinds,
  type EventName,
  type EventPayload,
  isSpaceQuerySource,
  type MethodName,
  type MethodParams,
  PsycheError,
  SPACE_LIMITS,
  type SpaceDetail,
  type SpaceTrackerTemplate,
  type SpaceTrackerValue,
  type TaintSource,
  type WidgetOp,
  type WidgetSpec,
  type WorkflowEvent,
} from "@psyche/protocol";
import { anchorMatches } from "@psyche/scheduler";
import type { Call, HandlerDef } from "../context.ts";
import { SpaceStore } from "../spaces/store.ts";
import type { WidgetStore } from "../widgets/store.ts";
import {
  isProjectOrChild,
  nodeProps,
  type QueryDeps,
  runQuery,
  spaceAnchors,
  unavailableProps,
} from "./space-queries.ts";

/**
 * Trackers on a Space's shelf and how they stay current (docs/design/spaces-2026.md section 6).
 *
 * SP6: nothing here calls a model. Opening a Space, a connector event, a folder event and a memory
 * event recompute query trackers from typed queries (space-queries.ts) and write the result with
 * `WidgetStore.patchShelved`. A model runs only through `runAgent`, which is called for exactly
 * one case: the owner's Refresh on an agent tracker. The automations the owner set run through the
 * scheduler on their own, not through this file.
 *
 * Limits: 12 trackers a Space (SP10); one recompute per tracker per minute for free triggers; one
 * `spaces.open` recompute per Space per 30 s; events fold into one recompute per Space per 2 min.
 */

export const OPEN_RECOMPUTE_MS = 30_000;
export const TRACKER_MIN_MS = 60_000;
export const EVENT_DEBOUNCE_MS = 120_000;
export const QUERY_STALE_AFTER_S = 900;

/** The `refresh` column: what a tracker reads and why it last changed. */
export interface TrackerRefresh {
  /** Query sources its nodes bind (empty for a checklist the owner edits). */
  sources: string[];
  template?: string;
  /** The automation an agent tracker's Refresh runs. */
  automationId?: string;
  /** A free event touched what an agent tracker reads; it shows "may be out of date". */
  staleSince?: string;
  /** The source that last changed it, for "Updated 2h ago from mail". */
  lastSource?: string;
  unavailable?: boolean;
}

interface Row {
  space_id: string;
  widget_id: string;
  position: number;
  kind: "bound" | "query" | "agent";
  refresh: string | null;
  stale_after_s: number | null;
  refreshed_at: string | null;
  added_by: string;
  created_at: string;
}

type Publish = <E extends EventName>(event: E, payload: EventPayload<E>, threadId?: string) => void;

export interface SpaceTrackersDeps {
  db: PsycheDb;
  widgets: WidgetStore;
  publish: Publish;
  /** Checks a spec's bindings for a chat and a Space; returns the taint they add or throws. */
  bindings: (root: unknown, threadId: string, spaceId?: string | null) => TaintSource[];
  /** A read-only connector tool; undefined result means none is connected. */
  read?: QueryDeps["read"];
  listFolder?: QueryDeps["listFolder"];
  /** Starts one automation run: the only path in this file that can reach a model. */
  runAgent?: (automationId: string) => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  debounceMs?: number;
  onError?: (err: unknown) => void;
}

const nodeTypes = (root: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== "object" || Array.isArray(n) || depth > 12) return;
    const node = n as Record<string, unknown>;
    if (typeof node.id === "string" && typeof node.type === "string") out.set(node.id, node.type);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, depth + 1);
    if (Array.isArray(node.tabs)) {
      for (const t of node.tabs) {
        const kids = (t as { children?: unknown[] }).children;
        if (Array.isArray(kids)) for (const c of kids) walk(c, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
};

const parse = (r: Row): TrackerRefresh => {
  try {
    const v = JSON.parse(r.refresh ?? "{}") as TrackerRefresh;
    return { ...v, sources: Array.isArray(v.sources) ? v.sources : [] };
  } catch {
    return { sources: [] };
  }
};

const under = (path: string, folder: string): boolean => {
  const f = folder.endsWith("/") ? folder : `${folder}/`;
  return path === folder || path.startsWith(f);
};

/** Which signals refresh which sources (section 6.2's last column). */
export type SpaceSignal =
  | { kind: "memory"; entityId: string }
  | { kind: "event"; event: WorkflowEvent }
  | { kind: "folder"; root: string };

export class SpaceTrackers {
  readonly #d: SpaceTrackersDeps;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (t: unknown) => void;
  readonly #lastOpen = new Map<string, number>();
  readonly #pending = new Map<string, { sources: Set<string>; timer: unknown }>();
  /** Recomputes that ran, by trigger. Tests read it; nothing else does. */
  readonly counters = { recomputes: 0, agentRuns: 0 };

  constructor(deps: SpaceTrackersDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  // --- shelf -------------------------------------------------------------------------------

  rows(spaceId: string): Row[] {
    return this.#d.db.sqlite
      .prepare("SELECT * FROM space_trackers WHERE space_id = ? ORDER BY position, created_at")
      .all(spaceId) as Row[];
  }

  #row(spaceId: string, widgetId: string): Row {
    const r = this.#d.db.sqlite
      .prepare("SELECT * FROM space_trackers WHERE space_id = ? AND widget_id = ?")
      .get(spaceId, widgetId) as Row | undefined;
    if (r === undefined) throw new PsycheError("not_found", "No such tracker on this Space.");
    return r;
  }

  #store(): SpaceStore {
    return new SpaceStore(this.#d.db);
  }

  #changed(spaceId: string, what: string[]): void {
    this.#d.publish("space.updated", { spaceId, changed: what });
  }

  /** Puts a widget or a template on the shelf; recomputes a query tracker at once. */
  async add(
    spaceId: string,
    input: { widgetId?: string | undefined; template?: SpaceTrackerTemplate | undefined },
    addedBy: "owner" | "agent" | "template" = "owner",
  ): Promise<void> {
    this.#store().requireOpen(spaceId);
    if ((input.widgetId === undefined) === (input.template === undefined)) {
      throw new PsycheError("invalid_params", "Give either a widgetId or a template.");
    }
    const count = this.rows(spaceId).length;
    if (count >= SPACE_LIMITS.trackers) {
      throw new PsycheError(
        "conflict",
        `A Space holds up to ${SPACE_LIMITS.trackers} trackers. Remove one first.`,
      );
    }
    let widgetId: string;
    let by = addedBy;
    if (input.template !== undefined) {
      widgetId = this.#drawTemplate(spaceId, input.template);
      by = "template";
    } else {
      widgetId = input.widgetId as string;
      const w = getWidget(this.#d.db, widgetId);
      if (w === null) throw new PsycheError("not_found", "No such widget.");
      if (w.state === "frozen") {
        throw new PsycheError("conflict", "A frozen widget cannot go on the shelf.");
      }
      if (
        this.#d.db.sqlite.prepare("SELECT 1 FROM space_trackers WHERE widget_id = ?").get(widgetId)
      ) {
        throw new PsycheError("conflict", "That widget is already on a shelf.");
      }
      // Its bindings must be valid for this Space (a mail bind of another Space is not).
      this.#d.bindings(w.spec.root, w.threadId, spaceId);
    }
    const w = getWidget(this.#d.db, widgetId);
    if (w === null) throw new PsycheError("not_found", "No such widget.");
    const binds = collectWidgetBinds(w.spec.root);
    const sources = [
      ...new Set(binds.map((b) => b.bind.source).filter((s) => isSpaceQuerySource(s))),
    ];
    const kind: Row["kind"] =
      sources.length > 0 || input.template === "checklist"
        ? "query"
        : binds.length > 0
          ? "bound"
          : "agent";
    const refresh: TrackerRefresh = {
      sources,
      ...(input.template === undefined ? {} : { template: input.template }),
    };
    const now = new Date(this.#now()).toISOString();
    const position = (
      this.#d.db.sqlite
        .prepare(
          "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM space_trackers WHERE space_id = ?",
        )
        .get(spaceId) as { p: number }
    ).p;
    this.#d.db.sqlite
      .prepare(
        `INSERT INTO space_trackers (space_id, widget_id, position, kind, refresh, stale_after_s,
           refreshed_at, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        spaceId,
        widgetId,
        position,
        kind,
        JSON.stringify(refresh),
        kind === "query" && sources.length > 0 ? QUERY_STALE_AFTER_S : null,
        by,
        now,
      );
    this.#changed(spaceId, ["trackers"]);
    if (kind === "query" && sources.length > 0) await this.#recompute(spaceId, widgetId, "add");
  }

  remove(spaceId: string, widgetId: string): void {
    this.#row(spaceId, widgetId);
    this.#d.db.sqlite
      .prepare("DELETE FROM space_trackers WHERE space_id = ? AND widget_id = ?")
      .run(spaceId, widgetId);
    this.#changed(spaceId, ["trackers"]);
  }

  reorder(spaceId: string, widgetIds: readonly string[]): void {
    const have = new Set(this.rows(spaceId).map((r) => r.widget_id));
    for (const id of widgetIds) {
      if (!have.has(id)) throw new PsycheError("not_found", "No such tracker on this Space.");
    }
    const order = [...new Set(widgetIds), ...[...have].filter((id) => !widgetIds.includes(id))];
    const set = this.#d.db.sqlite.prepare(
      "UPDATE space_trackers SET position = ? WHERE space_id = ? AND widget_id = ?",
    );
    this.#d.db.sqlite.transaction(() => {
      order.forEach((id, i) => {
        set.run(i, spaceId, id);
      });
    })();
    this.#changed(spaceId, ["trackers"]);
  }

  /** A Space was archived: its trackers freeze (section 6.1). */
  freezeShelf(spaceId: string): void {
    for (const r of this.rows(spaceId)) this.#d.widgets.freezeWidget(r.widget_id);
  }

  #drawTemplate(spaceId: string, template: SpaceTrackerTemplate): string {
    const space = this.#store().require(spaceId);
    const main = this.#d.db.sqlite
      .prepare("SELECT id FROM threads WHERE kind = 'main' ORDER BY created_at LIMIT 1")
      .get() as { id: string } | undefined;
    if (main === undefined) throw new PsycheError("conflict", "There is no main chat to hold it.");
    const automations = this.#d.db.sqlite
      .prepare(
        "SELECT id, title FROM automations WHERE space_id = ? ORDER BY created_at, id LIMIT 6",
      )
      .all(spaceId) as Array<{ id: string; title: string }>;
    if (template === "automation_status" && automations.length === 0) {
      throw new PsycheError(
        "invalid_params",
        "This Space has no automations yet, so there is no status to show.",
      );
    }
    const spec = templateSpec(template, space.id, automations);
    const widget = this.#d.widgets.create({
      threadId: main.id,
      messageId: `space:${spaceId}`,
      spec,
      taint: [],
      owner: { kind: "run", runId: `space:${spaceId}` },
      spaceId,
    });
    return widget.id;
  }

  // --- values --------------------------------------------------------------------------------

  value(r: Row): SpaceTrackerValue {
    const refresh = parse(r);
    const at = r.refreshed_at ?? r.created_at;
    const ageS = (this.#now() - Date.parse(at)) / 1000;
    const stale =
      refresh.staleSince !== undefined ||
      (r.stale_after_s !== null && (r.refreshed_at === null || ageS >= r.stale_after_s));
    return {
      widgetId: r.widget_id,
      refreshedAt: at,
      stale,
      ...(refresh.unavailable === true ? { unavailable: true } : {}),
      ...(refresh.lastSource === undefined ? {} : { source: refresh.lastSource }),
    };
  }

  values(spaceId: string): SpaceTrackerValue[] {
    return this.rows(spaceId).map((r) => this.value(r));
  }

  // --- free triggers (no model call) ---------------------------------------------------------

  /** `spaces.open`: recompute stale query trackers (at most once per Space per 30 s). */
  async open(spaceId: string): Promise<SpaceTrackerValue[]> {
    const space = this.#store().require(spaceId);
    const now = this.#now();
    const last = this.#lastOpen.get(spaceId);
    if (space.archivedAt === null && (last === undefined || now - last >= OPEN_RECOMPUTE_MS)) {
      this.#lastOpen.set(spaceId, now);
      for (const r of this.rows(spaceId)) {
        if (r.kind !== "query" || parse(r).sources.length === 0) continue;
        if (this.value(r).stale) await this.#recompute(spaceId, r.widget_id, "open");
      }
    }
    return this.values(spaceId);
  }

  /** The owner's Refresh: a query tracker recomputes now; an agent tracker starts its one run. */
  async refresh(spaceId: string, widgetId: string): Promise<SpaceTrackerValue> {
    const space = this.#store().requireOpen(spaceId);
    const row = this.#row(spaceId, widgetId);
    if (row.kind === "query" && parse(row).sources.length > 0) {
      await this.#recompute(spaceId, widgetId, "refresh", true);
    } else if (row.kind === "agent") {
      const refresh = parse(row);
      const own = refresh.automationId ? [refresh.automationId] : [];
      const ids =
        own.length > 0
          ? own
          : (
              this.#d.db.sqlite
                .prepare("SELECT id FROM automations WHERE space_id = ? AND enabled = 1")
                .all(space.id) as Array<{ id: string }>
            ).map((a) => a.id);
      if (ids.length !== 1 || this.#d.runAgent === undefined) {
        throw new PsycheError(
          "conflict",
          "This tracker refreshes when the Space's automation runs. Set one automation in the Space first.",
        );
      }
      this.counters.agentRuns++;
      await this.#d.runAgent(ids[0] as string);
      const next: TrackerRefresh = { ...refresh };
      next.staleSince = undefined;
      this.#mark(row, next, "refresh");
    }
    return this.value(this.#row(spaceId, widgetId));
  }

  /** Whether any live Space has a query tracker on `source`: the mail and calendar poll's reason. */
  listensTo(source: string): boolean {
    const rows = this.#d.db.sqlite
      .prepare(
        `SELECT t.refresh FROM space_trackers t JOIN spaces s ON s.id = t.space_id
          WHERE s.archived_at IS NULL AND t.kind = 'query'`,
      )
      .all() as Array<{ refresh: string | null }>;
    return rows.some((r) => parse({ refresh: r.refresh } as Row).sources.includes(source));
  }

  /** The folders a live Space with a files tracker wants watched (the search watcher extends to them). */
  watchedFolders(): string[] {
    const rows = this.#d.db.sqlite
      .prepare(
        `SELECT DISTINCT f.path, t.refresh FROM space_trackers t
           JOIN spaces s ON s.id = t.space_id JOIN space_folders f ON f.space_id = t.space_id
          WHERE s.archived_at IS NULL AND t.kind = 'query'`,
      )
      .all() as Array<{ path: string; refresh: string | null }>;
    return [
      ...new Set(
        rows
          .filter((r) => parse({ refresh: r.refresh } as Row).sources.includes("files"))
          .map((r) => r.path),
      ),
    ];
  }

  /**
   * A free signal. It finds the Spaces it concerns and folds the source into that Space's pending
   * set; one recompute runs 2 minutes after the first (per Space). Agent trackers that read the
   * source are only marked stale.
   */
  signal(sig: SpaceSignal): void {
    const hits = new Map<string, Set<string>>();
    const add = (spaceId: string, source: string) => {
      const set = hits.get(spaceId) ?? new Set<string>();
      set.add(source);
      hits.set(spaceId, set);
    };
    const spaces = this.#d.db.sqlite
      .prepare("SELECT id, entity_id FROM spaces WHERE archived_at IS NULL")
      .all() as Array<{ id: string; entity_id: string | null }>;
    for (const s of spaces) {
      if (this.rows(s.id).length === 0) continue;
      if (sig.kind === "memory") {
        if (s.entity_id !== null && isProjectOrChild(this.#d.db, s.entity_id, sig.entityId)) {
          for (const src of ["entity", "work_due", "reminders"]) add(s.id, src);
        }
      } else if (sig.kind === "event") {
        const anchors = spaceAnchors(this.#d.db, s.entity_id);
        if (!anchorMatches(sig.event, anchors)) continue;
        if (sig.event.source === "mail.received") add(s.id, "mail");
        else if (sig.event.source === "calendar.changed") add(s.id, "calendar");
        else if (sig.event.path !== undefined) add(s.id, "files");
      } else {
        const folders = this.#d.db.sqlite
          .prepare("SELECT path FROM space_folders WHERE space_id = ?")
          .all(s.id) as Array<{ path: string }>;
        if (folders.some((f) => under(sig.root, f.path) || under(f.path, sig.root))) {
          add(s.id, "files");
        }
      }
    }
    for (const [spaceId, sources] of hits) this.#schedule(spaceId, sources);
  }

  #schedule(spaceId: string, sources: Set<string>): void {
    const pending = this.#pending.get(spaceId);
    if (pending !== undefined) {
      for (const s of sources) pending.sources.add(s);
      return;
    }
    const entry = { sources: new Set(sources), timer: undefined as unknown };
    this.#pending.set(spaceId, entry);
    entry.timer = this.#setTimer(() => {
      void this.flush(spaceId).catch((err) => this.#d.onError?.(err));
    }, this.#d.debounceMs ?? EVENT_DEBOUNCE_MS);
  }

  /** Runs a Space's folded signals now (the debounce timer calls it). */
  async flush(spaceId: string): Promise<void> {
    const pending = this.#pending.get(spaceId);
    if (pending === undefined) return;
    this.#pending.delete(spaceId);
    this.#clearTimer(pending.timer);
    for (const r of this.rows(spaceId)) {
      const refresh = parse(r);
      const hit = refresh.sources.find((s) => pending.sources.has(s));
      // An agent tracker names no source (the model drew it), so any signal for the Space may
      // have made it out of date; it is marked, never run.
      if (r.kind === "agent") {
        this.#d.db.sqlite
          .prepare("UPDATE space_trackers SET refresh = ? WHERE space_id = ? AND widget_id = ?")
          .run(
            JSON.stringify({ ...refresh, staleSince: new Date(this.#now()).toISOString() }),
            spaceId,
            r.widget_id,
          );
      } else if (hit !== undefined && r.kind === "query") {
        await this.#recompute(spaceId, r.widget_id, hit);
      }
    }
  }

  dispose(): void {
    for (const p of this.#pending.values()) this.#clearTimer(p.timer);
    this.#pending.clear();
  }

  // --- the recompute -------------------------------------------------------------------------

  #mark(row: Row, refresh: TrackerRefresh, source: string): void {
    const at = new Date(this.#now()).toISOString();
    const next: TrackerRefresh = { ...refresh, lastSource: source };
    this.#d.db.sqlite
      .prepare(
        "UPDATE space_trackers SET refreshed_at = ?, refresh = ? WHERE space_id = ? AND widget_id = ?",
      )
      .run(at, JSON.stringify(next), row.space_id, row.widget_id);
    this.#d.publish("space.tracker.refreshed", {
      spaceId: row.space_id,
      widgetId: row.widget_id,
      refreshedAt: at,
    });
  }

  async #recompute(
    spaceId: string,
    widgetId: string,
    source: string,
    force = false,
  ): Promise<void> {
    const row = this.#row(spaceId, widgetId);
    const space = this.#store().require(spaceId);
    if (space.archivedAt !== null) return;
    if (
      !force &&
      row.refreshed_at !== null &&
      this.#now() - Date.parse(row.refreshed_at) < TRACKER_MIN_MS
    ) {
      return;
    }
    const widget = getWidget(this.#d.db, widgetId);
    if (widget === null || widget.state === "frozen") return;
    const refresh = parse(row);
    const types = nodeTypes(widget.spec.root);
    const ops: WidgetOp[] = [];
    const taint: TaintSource[] = [];
    let unavailable = false;
    const binds = collectWidgetBinds(widget.spec.root).filter((b) =>
      isSpaceQuerySource(b.bind.source),
    );
    const groups = new Map<string, { source: string; id: string; fields: Set<string> }>();
    for (const { bind } of binds) {
      const key = `${bind.source}:${bind.id}`;
      const g = groups.get(key) ?? { source: bind.source, id: bind.id, fields: new Set<string>() };
      g.fields.add(bind.field);
      groups.set(key, g);
    }
    this.counters.recomputes++;
    const qdeps: QueryDeps = {
      db: this.#d.db,
      now: () => new Date(this.#now()),
      read: this.#d.read,
      listFolder: this.#d.listFolder,
    };
    const results = new Map<string, Awaited<ReturnType<typeof runQuery>>>();
    for (const [key, g] of groups) {
      const res = await runQuery(
        qdeps,
        g.source,
        { id: spaceId, entityId: space.entityId ?? null },
        g.id,
        [...g.fields],
      );
      results.set(key, res);
      taint.push(...res.taint);
      if (res.unavailable === true) unavailable = true;
    }
    for (const { nodeId, bind } of binds) {
      const type = types.get(nodeId);
      const res = results.get(`${bind.source}:${bind.id}`);
      if (type === undefined || res === undefined) continue;
      const value = res.values[bind.field];
      const props =
        res.unavailable === true || value === undefined
          ? unavailableProps(type)
          : nodeProps(type, value);
      if (props !== undefined) ops.push({ op: "set", id: nodeId, props });
    }
    if (ops.length > 0 || taint.length > 0) {
      this.#d.widgets.patchShelved({ widgetId, ops, taint });
    }
    const next: TrackerRefresh = { ...refresh, unavailable };
    next.staleSince = undefined;
    this.#mark(row, next, source);
  }
}

// --- templates (section 6.1): query trackers built by code ------------------------------------------

function templateSpec(
  template: SpaceTrackerTemplate,
  spaceId: string,
  automations: Array<{ id: string; title: string }>,
): WidgetSpec {
  const bind = (source: string, field: string, id: string = spaceId) => ({ source, id, field });
  const card = (title: string, children: unknown[], fallbackText: string): WidgetSpec => ({
    v: 1,
    title,
    fallbackText,
    root: { id: "root", type: "card", title, children },
  });
  switch (template) {
    case "work_due":
      return card(
        "Work due",
        [
          {
            id: "count",
            type: "stat",
            label: "Open items",
            value: 0,
            bind: bind("work_due", "count"),
          },
          { id: "next", type: "checklist", items: [], bind: bind("work_due", "next") },
        ],
        "Open assignments of this Space's project, with the next five due.",
      );
    case "next_events":
      return card(
        "Next events",
        [
          {
            id: "week",
            type: "stat",
            label: "This week",
            value: 0,
            bind: bind("calendar", "countWeek"),
          },
          { id: "next", type: "checklist", items: [], bind: bind("calendar", "next") },
        ],
        "The next events on this Space's calendars.",
      );
    case "recent_files":
      return card(
        "Recent files",
        [
          { id: "count", type: "stat", label: "Files", value: 0, bind: bind("files", "count") },
          { id: "recent", type: "checklist", items: [], bind: bind("files", "recent") },
        ],
        "The most recently changed files in this Space's folders.",
      );
    case "mail_on_this":
      return card(
        "Mail on this",
        [
          { id: "unread", type: "stat", label: "Unread", value: 0, bind: bind("mail", "unread") },
          { id: "latest", type: "checklist", items: [], bind: bind("mail", "latest") },
        ],
        "Unread mail and the latest subjects in this Space's mail threads.",
      );
    case "checklist":
      return card(
        "Checklist",
        [{ id: "items", type: "checklist", items: [] }],
        "A checklist kept by the owner.",
      );
    case "automation_status":
      return card(
        "Automations",
        automations.map((a, i) => ({
          id: `a${i + 1}`,
          type: "status",
          label: a.title.slice(0, 120) || "Automation",
          tone: "neutral",
          bind: { source: "automation", id: a.id, field: "status" },
        })),
        "The status of this Space's automations.",
      );
  }
}

// --- handlers -----------------------------------------------------------------------------------

type P<M extends MethodName> = MethodParams<M>;

export function spaceTrackerHandlers(engine: SpaceTrackers): Record<string, HandlerDef> {
  const detail = (call: Call, spaceId: string): SpaceDetail =>
    new SpaceStore(call.ctx.db).detail(spaceId);
  return {
    "spaces.trackers.add": {
      async run(call: Call, p: P<"spaces.trackers.add">): Promise<SpaceDetail> {
        await engine.add(p.spaceId, { widgetId: p.widgetId, template: p.template });
        call.ctx.bus.bumpStateVersion();
        return detail(call, p.spaceId);
      },
    },
    "spaces.trackers.remove": {
      run(call: Call, p: P<"spaces.trackers.remove">): SpaceDetail {
        engine.remove(p.spaceId, p.widgetId);
        call.ctx.bus.bumpStateVersion();
        return detail(call, p.spaceId);
      },
    },
    "spaces.trackers.reorder": {
      run(call: Call, p: P<"spaces.trackers.reorder">): SpaceDetail {
        engine.reorder(p.spaceId, p.widgetIds);
        call.ctx.bus.bumpStateVersion();
        return detail(call, p.spaceId);
      },
    },
    "spaces.trackers.refresh": {
      async run(call: Call, p: P<"spaces.trackers.refresh">) {
        return { tracker: await engine.refresh(p.spaceId, p.widgetId) };
      },
    },
    "spaces.open": {
      async run(_call: Call, p: P<"spaces.open">) {
        return { trackers: await engine.open(p.spaceId) };
      },
    },
  };
}

/** A read-only connector tool as the queries use it. `undefined` when no connector offers it. */
export function toolReader(
  lookup: {
    get(name: string):
      | {
          run?: (params: unknown, ctx: never) => Promise<{ output?: unknown; isError?: boolean }>;
          execute?: (...args: never[]) => Promise<{ output?: unknown; isError?: boolean }>;
        }
      | undefined;
  },
  makeContext: (callId: string, signal: AbortSignal) => unknown,
): NonNullable<QueryDeps["read"]> {
  return async (tool, params) => {
    const reg = lookup.get(tool);
    if (reg === undefined) return undefined;
    const callId = `space:${tool}:${Date.now()}`;
    const signal = AbortSignal.timeout(20_000);
    const ctx = makeContext(callId, signal) as never;
    const r =
      reg.run !== undefined
        ? await reg.run(params, ctx)
        : await (
            reg.execute as unknown as (...a: unknown[]) => Promise<{
              output?: unknown;
              isError?: boolean;
            }>
          )(callId, params, signal, () => {});
    if (r.isError === true) throw new Error(`${tool} failed`);
    return r.output;
  };
}
