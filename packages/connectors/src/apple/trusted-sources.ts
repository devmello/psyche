/**
 * Owner-declared trusted sources (security §3.6): the owner marks a Reminders list, a Notes
 * folder or one of their own calendars as "mine" in Settings → Connectors. A read whose every row
 * comes from such a source is the owner's own content and does not taint the turn. Everything
 * else stays untrusted: one row from any other source, a source that is shared or read-only
 * *now*, a calendar event someone else organised, and anything we cannot resolve (fail closed).
 *
 * The list lives in the connector's `config.trustedSources` (ids), which only the owner's
 * `connectors.configure` (operator.admin, Settings) writes; no agent tool reaches it.
 */

export type TrustedApp = "reminders" | "notes" | "calendar";

export const TRUSTED_APPS: readonly TrustedApp[] = ["reminders", "notes", "calendar"];

export const MAX_TRUSTED_SOURCES = 500;

/** What we learn about one source from the helper right now. */
export interface SourceFact {
  id: string;
  title: string;
  /** Someone else can edit or owns it (read-only, subscribed, shared); the toggle is refused. */
  shared: boolean;
}

/** `config.trustedSources` as stored: only well-formed ids survive. */
export function readTrustedSources(config: unknown): Set<string> {
  const raw = (config as { trustedSources?: unknown } | null | undefined)?.trustedSources;
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const id of raw) if (typeof id === "string" && id !== "" && id.length <= 200) out.add(id);
  return out;
}

/** Facts for the source list of `app`, from the helper's `*.list_lists` / `list_calendars` / `notes.folders`. */
export function sourceFacts(app: TrustedApp, output: unknown): SourceFact[] {
  const key = app === "reminders" ? "lists" : app === "calendar" ? "calendars" : "folders";
  const rows = (output as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows)) return [];
  const facts: SourceFact[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as { id?: unknown; title?: unknown; name?: unknown; writable?: unknown };
    if (typeof o.id !== "string") continue;
    const title = typeof o.title === "string" ? o.title : typeof o.name === "string" ? o.name : "";
    // The helper cannot see sharing itself (EventKit has no such flag), but a list or calendar
    // the owner cannot write to is subscribed, shared read-only or a system calendar. Notes
    // folders expose no flag: they are as shared as the owner says.
    facts.push({ id: o.id, title, shared: o.writable === false });
  }
  return facts;
}

export interface TrustContext {
  /** Ids the owner marked as theirs (`config.trustedSources`). */
  trusted: ReadonlySet<string>;
  /** Current facts by source id (a source missing here is unknown, so untrusted). */
  facts: ReadonlyMap<string, SourceFact>;
}

function rowsOf(app: TrustedApp, output: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(output)) return output as Record<string, unknown>[];
  if (typeof output !== "object" || output === null) return undefined;
  const o = output as Record<string, unknown>;
  const key =
    app === "reminders"
      ? ["reminders", "lists"]
      : app === "calendar"
        ? ["events", "calendars", "busy", "blocks"]
        : ["notes", "folders"];
  for (const k of key) if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
  // A single record (a created reminder, a read note).
  return typeof o.id === "string" ? [o] : undefined;
}

function sourceTrusted(id: unknown, ctx: TrustContext): boolean {
  if (typeof id !== "string" || !ctx.trusted.has(id)) return false;
  const fact = ctx.facts.get(id);
  return fact !== undefined && !fact.shared;
}

/** The owner wrote it: no author other than the owner (#1004's rule, shared by both paths). */
function byOwner(row: Record<string, unknown>): boolean {
  return row.createdBy === undefined || row.createdBy === "owner";
}

/**
 * Whether every row of `output` is the owner's own content. Two ways in, both fail closed:
 * the helper attests `shared: false` with no other author (#1004, Reminders), or the row belongs
 * to a source the owner declared theirs that is still unshared. Empty results are untrusted.
 */
export function ownerContent(app: TrustedApp, output: unknown, ctx: TrustContext): boolean {
  const rows = rowsOf(app, output);
  if (rows === undefined || rows.length === 0) return false;
  return rows.every((r) => {
    if (typeof r !== "object" || r === null || !byOwner(r)) return false;
    if (app === "reminders") {
      if (r.shared === false) return true;
      return r.shared !== true && sourceTrusted(r.listId ?? r.id, ctx);
    }
    if (app === "calendar") {
      if (r.calendarId === undefined) return sourceTrusted(r.id, ctx);
      return sourceTrusted(r.calendarId, ctx) && ownEvent(r);
    }
    return notesRowTrusted(r, ctx);
  });
}

/** An event with attendees is trusted only when the owner is its organiser (an invite is not). */
function ownEvent(e: Record<string, unknown>): boolean {
  const attendees = e.attendees;
  if (attendees === undefined || attendees === null) return true;
  if (!Array.isArray(attendees)) return false;
  if (attendees.length === 0) return true;
  const organisers = attendees.filter(
    (a) => typeof a === "object" && a !== null && (a as { organizer?: unknown }).organizer === true,
  ) as { me?: unknown }[];
  return organisers.length > 0 && organisers.every((a) => a.me === true);
}

/**
 * A note row names its folder (not its id), and names repeat across accounts, so the folder
 * counts only when every folder with that name is trusted and unshared.
 */
function notesRowTrusted(r: Record<string, unknown>, ctx: TrustContext): boolean {
  if (r.noteCount !== undefined && typeof r.id === "string") return sourceTrusted(r.id, ctx);
  const folder = r.folder;
  if (typeof folder !== "string") return false;
  const same = [...ctx.facts.values()].filter((f) => f.title === folder);
  return same.length > 0 && same.every((f) => sourceTrusted(f.id, ctx));
}
