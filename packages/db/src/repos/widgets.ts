import type { TaintSource, Widget, WidgetOwner, WidgetSpec } from "@psyche/protocol";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { PsycheDb } from "../open.ts";
import { type WidgetRow, widgets } from "../schema.ts";

/**
 * Generative-UI widgets (generative-ui-2026 §5.1). Latest snapshot only (D7). The Gateway's
 * widget store validates, applies patches, enforces the live cap and publishes events; this module
 * only reads and writes rows. Nothing here deletes.
 */

export interface NewWidget {
  id?: string;
  threadId: string;
  messageId: string;
  spec: WidgetSpec;
  taint: readonly TaintSource[];
  owner: WidgetOwner;
  createdAt?: string;
}

export function widgetFromRow(row: WidgetRow): Widget {
  return {
    id: row.id,
    threadId: row.threadId,
    messageId: row.messageId,
    rev: row.rev,
    spec: JSON.parse(row.spec) as WidgetSpec,
    taint: JSON.parse(row.taint) as TaintSource[],
    owner: JSON.parse(row.owner) as WidgetOwner,
    state: row.state as Widget["state"],
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function insertWidget(db: PsycheDb, input: NewWidget): Widget {
  const now = input.createdAt ?? db.now();
  const row = db.drizzle
    .insert(widgets)
    .values({
      id: input.id ?? db.newId(),
      threadId: input.threadId,
      messageId: input.messageId,
      rev: 1,
      spec: JSON.stringify(input.spec),
      taint: JSON.stringify(input.taint),
      owner: JSON.stringify(input.owner),
      state: "live",
      pinned: 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return widgetFromRow(row);
}

export function getWidget(db: PsycheDb, id: string): Widget | null {
  const row = db.drizzle.select().from(widgets).where(eq(widgets.id, id)).get();
  return row ? widgetFromRow(row) : null;
}

/** Batched read; order follows `ids`, unknown ids are skipped. */
export function getWidgets(db: PsycheDb, ids: readonly string[]): Widget[] {
  if (ids.length === 0) return [];
  const rows = db.drizzle
    .select()
    .from(widgets)
    .where(inArray(widgets.id, [...ids]))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    return r ? [widgetFromRow(r)] : [];
  });
}

export function listThreadWidgets(
  db: PsycheDb,
  threadId: string,
  filter: { state?: Widget["state"] } = {},
): Widget[] {
  const where = filter.state
    ? and(eq(widgets.threadId, threadId), eq(widgets.state, filter.state))
    : eq(widgets.threadId, threadId);
  return db.drizzle
    .select()
    .from(widgets)
    .where(where)
    .orderBy(asc(widgets.updatedAt))
    .all()
    .map(widgetFromRow);
}

export interface WidgetUpdate {
  spec?: WidgetSpec;
  taint?: readonly TaintSource[];
  state?: Widget["state"];
  pinned?: boolean;
  updatedAt?: string;
}

/**
 * Compare-and-set on `rev`: writes only when the stored rev is `expectedRev` and bumps it when
 * the spec changes. Returns the new widget, or `null` when the rev moved (the caller re-reads).
 */
export function updateWidget(
  db: PsycheDb,
  id: string,
  expectedRev: number,
  update: WidgetUpdate,
): Widget | null {
  return db.sqlite.transaction(() => {
    const row = db.drizzle.select().from(widgets).where(eq(widgets.id, id)).get();
    if (!row || row.rev !== expectedRev) return null;
    const next = db.drizzle
      .update(widgets)
      .set({
        rev: update.spec ? row.rev + 1 : row.rev,
        spec: update.spec ? JSON.stringify(update.spec) : row.spec,
        taint: update.taint ? JSON.stringify(update.taint) : row.taint,
        state: update.state ?? row.state,
        pinned: update.pinned === undefined ? row.pinned : update.pinned ? 1 : 0,
        updatedAt: update.updatedAt ?? db.now(),
      })
      .where(eq(widgets.id, id))
      .returning()
      .get();
    return widgetFromRow(next);
  })();
}

/** The pinned widgets, most recently updated first. */
export function listPinnedWidgets(db: PsycheDb): Widget[] {
  return db.drizzle
    .select()
    .from(widgets)
    .where(eq(widgets.pinned, 1))
    .orderBy(desc(widgets.updatedAt))
    .all()
    .map(widgetFromRow);
}

export function countPinnedWidgets(db: PsycheDb): number {
  const r = db.drizzle
    .select({ n: sql<number>`count(*)` })
    .from(widgets)
    .where(eq(widgets.pinned, 1))
    .get();
  return r?.n ?? 0;
}

/** Live widgets whose owner is the given task / automation / job (`owner.<key> = id`). */
export function listLiveWidgetsOwnedBy(
  db: PsycheDb,
  kind: WidgetOwner["kind"],
  id: string,
): Widget[] {
  const key = kind === "run" ? "runId" : `${kind}Id`;
  return db.drizzle
    .select()
    .from(widgets)
    .where(
      and(
        eq(widgets.state, "live"),
        sql`json_extract(${widgets.owner}, '$.kind') = ${kind}`,
        sql`json_extract(${widgets.owner}, ${`$.${key}`}) = ${id}`,
      ),
    )
    .all()
    .map(widgetFromRow);
}
