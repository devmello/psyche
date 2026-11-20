import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { defangFence } from "@psyche/agent-core";
import type { PsycheDb } from "@psyche/db";
import { ACCEPTED_REVIEW_SQL } from "@psyche/memory";
import { grantedRootRefused, lookupRootFacts } from "@psyche/permissions";
import { isSpaceQuerySource, type SpaceQuerySource, type TaintSource } from "@psyche/protocol";

/**
 * Query sources for Space trackers (docs/design/spaces-2026.md section 6.2). Typed, closed
 * queries over data Psyche already holds or a read tool already returns: never code, never free
 * text, never a model. Each resolver answers for the fields a node binds and says which taint the
 * answer carries (section 5.5 rule 1), so the tracker's taint can only grow.
 *
 * Provenance per source:
 * - `entity`, `work_due`: the facts' own. An untrusted fact or title adds a `memory` source.
 * - `calendar`: owner calendars are trusted; an event with attendees other than the owner, or from
 *   a calendar the owner does not own, adds a `calendar` source (W8).
 * - `reminders`: the owner's.
 * - `mail`: always untrusted (subjects and senders).
 * - `files`: names are untrusted (W7), contents are never read.
 */

export type QueryTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface ChecklistItem {
  id: string;
  label: string;
  state: "todo" | "active" | "done";
  detail?: string;
}

/** One field's answer, before it is shaped for a node type. */
export interface FieldValue {
  text?: string;
  value?: string | number;
  items?: ChecklistItem[];
  tone?: QueryTone;
}

export interface QueryResult {
  values: Record<string, FieldValue>;
  taint: TaintSource[];
  /** The source is gone (entity deleted or archived, no connector, no folder): render "Unavailable". */
  unavailable?: boolean;
}

/** What a Space is to a query. */
export interface QuerySpace {
  id: string;
  entityId: string | null;
}

export interface FileEntry {
  name: string;
  mtimeMs: number;
}

export interface QueryDeps {
  db: PsycheDb;
  now: () => Date;
  /**
   * A read-only connector tool (`calendar_list_events`, `reminders_list`, `mail_search`). Resolves
   * `undefined` when no such connector is connected. Never a write tool.
   */
  read?: ((tool: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
  /** The names and times of the files directly in a folder; never contents. Default: the disk. */
  listFolder?: ((folder: string) => FileEntry[] | Promise<FileEntry[]>) | undefined;
}

/** Opening or closing tags of a prompt section (the same set `agent-core` neutralises). */
const NEUTRALISED_TAG =
  /[<\uFF1C\uFE64\u2039\u3008]\s*([/\uFF0F\u2215\u2044\u29F8]?)\s*(section|instructions|permissions|secrets|memory|browser|working)\b/gi;

/**
 * Third-party text for a node: one line, no control characters, no fence or section markers (the
 * prompt's own neutralisers, so a title cannot close a section or forge `<instructions>`), capped.
 */
export function cleanText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  const line = value
    .replace(/<<<\/?(?:end-)?untrusted-data>>>/g, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return defangFence(line).replace(
    NEUTRALISED_TAG,
    (_m, slash: string, name: string) => `<${slash === "" ? "" : "/"}\u200B${name}`,
  );
}

const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");

function itemsOf(rows: Array<{ label: string; detail?: string; done?: boolean }>): ChecklistItem[] {
  return rows.map((r, i) => ({
    id: `i${i + 1}`,
    label: r.label || "(untitled)",
    state: r.done === true ? "done" : "todo",
    ...(r.detail ? { detail: r.detail } : {}),
  }));
}

function asList(output: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(output)) return output as Record<string, unknown>[];
  const inner = (output as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(inner) ? (inner as Record<string, unknown>[]) : [];
}

const WORK_OPEN = "('not_started','in_progress')";

interface EntityRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  hidden: number;
  due_at: string | null;
  project_status: string | null;
  work_status: string | null;
  title_untrusted: number;
  last_signal_at: string | null;
  last_interaction_at: string | null;
}

const MEMORY_TAINT: TaintSource = { sourceKind: "memory" };

function untrustedFacts(db: PsycheDb, ids: readonly string[], attrs: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const row = db.sqlite
    .prepare(
      `SELECT 1 AS x FROM graph_facts
        WHERE entity_id IN (${ids.map(() => "?").join(",")})
          AND attribute IN (${attrs.map(() => "?").join(",")})
          AND provenance = 'untrusted' AND retracted_at IS NULL AND superseded_by IS NULL
          AND valid_to IS NULL AND review IN ${ACCEPTED_REVIEW_SQL} LIMIT 1`,
    )
    .get(...ids, ...attrs);
  return row !== undefined;
}

function latestFact(db: PsycheDb, entityId: string, attribute: string): string | undefined {
  const row = db.sqlite
    .prepare(
      `SELECT value FROM graph_facts
        WHERE entity_id = ? AND attribute = ? AND retracted_at IS NULL AND superseded_by IS NULL
          AND valid_to IS NULL AND review IN ${ACCEPTED_REVIEW_SQL} ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get(entityId, attribute) as { value: string } | undefined;
  return row?.value;
}

function entityRow(db: PsycheDb, id: string): EntityRow | undefined {
  const row = db.sqlite.prepare("SELECT * FROM graph_entities WHERE id = ?").get(id) as
    | EntityRow
    | undefined;
  if (row === undefined || row.status !== "active" || row.hidden === 1) return undefined;
  return row;
}

/** `id` is the project itself or a child that is `part_of` it (the check that bound it). */
export function isProjectOrChild(db: PsycheDb, entityId: string, id: string): boolean {
  if (id === entityId) return true;
  return (
    db.sqlite
      .prepare(
        `SELECT 1 AS x FROM graph_edges g JOIN graph_entities e ON e.id = g.src
          WHERE g.src = ? AND g.dst = ? AND g.rel = 'part_of' AND g.superseded_by IS NULL
            AND g.retracted_at IS NULL AND g.review IN ${ACCEPTED_REVIEW_SQL} AND e.private = 0
          LIMIT 1`,
      )
      .get(id, entityId) !== undefined
  );
}

/** The anchors of the Space's project (and nothing else): what calendar, reminders, mail read. */
export function spaceAnchors(
  db: PsycheDb,
  entityId: string | null,
): Array<{ kind: string; ref: string }> {
  if (entityId === null) return [];
  return db.sqlite
    .prepare(
      "SELECT kind, ref FROM graph_anchors WHERE entity_id = ? AND confirmed = 1 ORDER BY created_at, id",
    )
    .all(entityId) as Array<{ kind: string; ref: string }>;
}

function entityQuery(deps: QueryDeps, bindId: string, fields: string[]): QueryResult {
  const e = entityRow(deps.db, bindId);
  if (e === undefined) return { values: {}, taint: [], unavailable: true };
  const values: Record<string, FieldValue> = {};
  const status = latestFact(deps.db, e.id, "status") ?? e.work_status ?? e.project_status ?? "";
  const next = latestFact(deps.db, e.id, "next_step");
  const stopped = e.last_signal_at ?? e.last_interaction_at;
  for (const f of fields) {
    if (f === "status") {
      const label = cleanText(status.replace(/_/g, " "), 60) || "No status";
      const tone: QueryTone =
        status === "done"
          ? "success"
          : status === "dropped" || status === "paused"
            ? "warning"
            : "info";
      values.status = { text: label, tone };
    } else if (f === "nextStep") {
      values.nextStep = { text: cleanText(next, 300) || "No next step" };
    } else if (f === "stoppedAt") {
      values.stoppedAt = { text: stopped ? `Last activity ${day(stopped)}` : "No activity yet" };
    } else if (f === "due") {
      values.due = { text: e.due_at ? day(e.due_at) : "No due date", value: day(e.due_at) || "-" };
    }
  }
  const tainted =
    e.title_untrusted === 1 || untrustedFacts(deps.db, [e.id], ["status", "next_step", "deadline"]);
  return { values, taint: tainted ? [MEMORY_TAINT] : [] };
}

function workDueQuery(deps: QueryDeps, space: QuerySpace, fields: string[]): QueryResult {
  if (space.entityId === null || entityRow(deps.db, space.entityId) === undefined) {
    return { values: {}, taint: [], unavailable: true };
  }
  const rows = deps.db.sqlite
    .prepare(
      `SELECT e.id, e.name, e.due_at, e.title_untrusted, g.provenance AS edge_provenance
         FROM graph_edges g
         JOIN graph_entities e ON e.id = g.src
        WHERE g.dst = ? AND g.rel = 'part_of' AND g.superseded_by IS NULL AND g.retracted_at IS NULL
          AND g.review IN ${ACCEPTED_REVIEW_SQL} AND e.private = 0
          AND e.kind = 'assignment' AND e.status = 'active' AND e.hidden = 0
          AND e.work_status IN ${WORK_OPEN}
        ORDER BY (e.due_at IS NULL), e.due_at, e.name, e.id`,
    )
    .all(space.entityId) as Array<{
    id: string;
    name: string;
    due_at: string | null;
    title_untrusted: number;
    edge_provenance: string;
  }>;
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f === "count") values.count = { value: rows.length, text: String(rows.length) };
    else if (f === "next") {
      values.next = {
        items: itemsOf(
          rows.slice(0, 5).map((r) => ({
            label: cleanText(r.name, 200),
            ...(r.due_at ? { detail: `Due ${day(r.due_at)}` } : {}),
          })),
        ),
      };
    }
  }
  const shown = rows.slice(0, 5);
  const tainted =
    // A row reached through an edge someone else's text proposed is theirs, and so is the count.
    rows.some((r) => r.edge_provenance === "untrusted") ||
    shown.some((r) => r.title_untrusted === 1) ||
    untrustedFacts(
      deps.db,
      rows.map((r) => r.id),
      ["deadline", "status"],
    );
  return { values, taint: tainted ? [MEMORY_TAINT] : [] };
}

async function calendarQuery(
  deps: QueryDeps,
  space: QuerySpace,
  fields: string[],
): Promise<QueryResult> {
  const read = deps.read;
  const refs = spaceAnchors(deps.db, space.entityId)
    .filter((a) => a.kind === "calendar")
    .map((a) => a.ref)
    .slice(0, 50);
  if (read === undefined) return { values: {}, taint: [], unavailable: true };
  const now = deps.now();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  let events: Record<string, unknown>[] = [];
  const trusted = new Set<string>();
  // Without a calendar anchor the project has no events of its own: nothing is shown.
  if (refs.length > 0) {
    let out: unknown;
    try {
      // Apple and Outlook take a window and a list of calendars.
      out = await read("calendar_list_events", { from, to, calendarIds: refs, limit: 50 });
      events = asList(out, "events");
    } catch (err) {
      // Google and Microsoft take one calendar and `timeMin`/`timeMax`.
      const all: Record<string, unknown>[] = [];
      for (const id of refs.slice(0, 10)) {
        const o = await read("calendar_list_events", {
          calendarId: id,
          timeMin: from,
          timeMax: to,
          maxResults: 50,
        }).catch(() => {
          throw err;
        });
        out = o;
        all.push(...asList(o, "events").map((e) => ({ calendarId: id, ...e })));
      }
      events = all;
    }
    if (out === undefined) return { values: {}, taint: [], unavailable: true };
    // Trust is decided per calendar, and fails closed: only a calendar the owner can write and
    // anchored to the project is the owner's own. A list that cannot be read trusts none.
    try {
      const calendars = asList(await read("calendar_list_calendars", {}), "calendars");
      for (const c of calendars) {
        if (typeof c.id === "string" && c.writable === true && refs.includes(c.id))
          trusted.add(c.id);
      }
    } catch {
      // none trusted
    }
  }
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f === "countWeek") values.countWeek = { value: events.length, text: String(events.length) };
    else if (f === "next") {
      values.next = {
        items: itemsOf(
          events.slice(0, 3).map((ev) => ({
            label: cleanText(ev.title ?? ev.summary, 200),
            detail: cleanText(ev.start ?? ev.startDate, 40),
          })),
        ),
      };
    }
  }
  // Someone else's text unless the event sits on a trusted calendar and has no attendees at all
  // (an invitation lists the owner too, so one attendee is not "mine"): W8.
  const foreign = events.some(
    (ev) =>
      typeof ev.calendarId !== "string" ||
      !trusted.has(ev.calendarId) ||
      !Array.isArray(ev.attendees) ||
      ev.attendees.length > 0,
  );
  return { values, taint: foreign ? [{ sourceKind: "calendar" }] : [] };
}

async function remindersQuery(
  deps: QueryDeps,
  space: QuerySpace,
  fields: string[],
): Promise<QueryResult> {
  const lists = spaceAnchors(deps.db, space.entityId).filter((a) => a.kind === "reminder_list");
  if (deps.read === undefined) return { values: {}, taint: [], unavailable: true };
  const listIds = lists.map((a) => a.ref).slice(0, 50);
  if (listIds.length === 0) {
    const empty: Record<string, FieldValue> = {};
    for (const f of fields) {
      empty[f] = f === "nextDue" ? { text: "Nothing due" } : { value: 0, text: "0" };
    }
    return { values: empty, taint: [] };
  }
  const open = await deps.read("reminders_list", { listIds, completed: false, limit: 200 });
  if (open === undefined) return { values: {}, taint: [], unavailable: true };
  const done = fields.includes("done")
    ? await deps.read("reminders_list", { listIds, completed: true, limit: 200 })
    : undefined;
  const openRows = asList(open, "reminders");
  const doneRows = asList(done, "reminders");
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f === "open") values.open = { value: openRows.length, text: String(openRows.length) };
    else if (f === "done") values.done = { value: doneRows.length, text: String(doneRows.length) };
    else if (f === "nextDue") {
      const next = openRows.find((r) => typeof r.due === "string" || typeof r.dueDate === "string");
      values.nextDue = {
        text: next
          ? `${cleanText(next.title, 120)} · ${day(String(next.due ?? next.dueDate))}`
          : "Nothing due",
      };
    }
  }
  return { values, taint: [] };
}

async function mailQuery(
  deps: QueryDeps,
  space: QuerySpace,
  fields: string[],
): Promise<QueryResult> {
  // Mail is always someone else's text, even when nothing matches.
  const taint: TaintSource[] = [{ sourceKind: "email" }];
  if (deps.read === undefined) return { values: {}, taint, unavailable: true };
  const refs = new Set(
    spaceAnchors(deps.db, space.entityId)
      .filter((a) => a.kind === "mail_thread")
      .map((a) => a.ref),
  );
  const out = await deps.read("mail_search", { limit: 50 });
  if (out === undefined) return { values: {}, taint, unavailable: true };
  const rows = asList(out, "messages").filter((m) => {
    // Apple's `mail_search` has no thread id: its anchors are message ids (or `account:id`).
    const ids = [m.threadId, m.id].filter((x): x is string => typeof x === "string");
    const account = typeof m.account === "string" ? m.account : undefined;
    return ids.some(
      (id) => refs.has(id) || (account !== undefined && refs.has(`${account}:${id}`)),
    );
  });
  const unread = rows.filter((m) => m.read === false || m.unread === true);
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f === "unread") values.unread = { value: unread.length, text: String(unread.length) };
    else if (f === "latest") {
      values.latest = {
        items: itemsOf(
          rows.slice(0, 3).map((m) => ({
            label: cleanText(m.subject, 200),
            detail: cleanText(m.from, 120),
            done: m.read !== false && m.unread !== true,
          })),
        ),
      };
    }
  }
  return { values, taint };
}

/** The most names read from one folder: a huge directory cannot stall the Gateway. */
const MAX_FOLDER_ENTRIES = 500;

async function diskList(folder: string): Promise<FileEntry[]> {
  const names = (await readdir(folder))
    .filter((n) => !n.startsWith("."))
    .slice(0, MAX_FOLDER_ENTRIES);
  const out: FileEntry[] = [];
  for (const name of names) {
    try {
      // lstat: an entry that is a link is not followed (a mount behind it cannot hang the read).
      out.push({ name, mtimeMs: (await lstat(join(folder, name))).mtimeMs });
    } catch {
      // gone between the listing and the stat
    }
  }
  return out;
}

async function filesQuery(
  deps: QueryDeps,
  space: QuerySpace,
  fields: string[],
): Promise<QueryResult> {
  const folders = deps.db.sqlite
    .prepare("SELECT path, real FROM space_folders WHERE space_id = ? ORDER BY added_at, path")
    .all(space.id) as Array<{ path: string; real: string }>;
  if (folders.length === 0) return { values: {}, taint: [], unavailable: true };
  const list = deps.listFolder ?? diskList;
  const entries: FileEntry[] = [];
  let readable = 0;
  for (const f of folders) {
    try {
      // The same refusals as a folder grant (SR2): a folder swapped for a link, moved off its
      // recorded real path, or inside a sensitive root lists nothing.
      const facts = await lookupRootFacts(f.path);
      if (grantedRootRefused(f.path, facts, f.real)) continue;
      entries.push(...(await list(facts.real ?? f.path)));
      readable++;
    } catch {
      // an unreadable folder contributes nothing
    }
  }
  if (readable === 0) return { values: {}, taint: [], unavailable: true };
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const values: Record<string, FieldValue> = {};
  for (const f of fields) {
    if (f === "count") values.count = { value: entries.length, text: String(entries.length) };
    else if (f === "recent") {
      values.recent = {
        items: itemsOf(
          entries.slice(0, 5).map((e) => ({
            label: cleanText(e.name, 200),
            detail: new Date(e.mtimeMs).toISOString().slice(0, 16).replace("T", " "),
          })),
        ),
      };
    }
  }
  return { values, taint: [{ sourceKind: "file_names" }] };
}

/**
 * Runs one source for the fields a tracker binds. `bindId` is the node's own `bind.id`: the
 * project or child for `entity`, the Space for the rest. Throws nothing for a missing source:
 * that is `unavailable`.
 */
export async function runQuery(
  deps: QueryDeps,
  source: string,
  space: QuerySpace,
  bindId: string,
  fields: string[],
): Promise<QueryResult> {
  if (!isSpaceQuerySource(source)) return { values: {}, taint: [], unavailable: true };
  try {
    switch (source as SpaceQuerySource) {
      case "entity":
        return space.entityId !== null && isProjectOrChild(deps.db, space.entityId, bindId)
          ? entityQuery(deps, bindId, fields)
          : { values: {}, taint: [], unavailable: true };
      case "work_due":
        return workDueQuery(deps, space, fields);
      case "calendar":
        return await calendarQuery(deps, space, fields);
      case "reminders":
        return await remindersQuery(deps, space, fields);
      case "mail":
        return await mailQuery(deps, space, fields);
      case "files":
        return await filesQuery(deps, space, fields);
    }
  } catch {
    // A connector that failed leaves the last values and shows "Unavailable"; nothing throws up.
    return { values: {}, taint: [], unavailable: true };
  }
}

/** Shapes one field's answer for the node type that carries it (the types WIDGET_BINDINGS allows). */
export function nodeProps(nodeType: string, v: FieldValue): Record<string, unknown> | undefined {
  switch (nodeType) {
    case "stat":
      return { value: v.value ?? v.text ?? "-" };
    case "text":
      return { text: (v.text ?? String(v.value ?? "-")).slice(0, 500) };
    case "status":
      return { label: (v.text ?? "-").slice(0, 500), tone: v.tone ?? "neutral" };
    case "checklist":
      return { items: v.items ?? [] };
    default:
      return undefined;
  }
}

/** The props that mark a node as unavailable (the source is gone). */
export function unavailableProps(nodeType: string): Record<string, unknown> | undefined {
  switch (nodeType) {
    case "stat":
      return { value: "Unavailable" };
    case "text":
      return { text: "Unavailable" };
    case "status":
      return { label: "Unavailable", tone: "neutral" };
    case "checklist":
      return { items: [] };
    default:
      return undefined;
  }
}
