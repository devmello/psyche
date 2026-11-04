import type { GraphEntity, GraphFactAttribute, GraphWorkStatus } from "@psyche/protocol";
import { classifySensitivity } from "../extraction/sensitivity.ts";
import {
  locateQuote,
  MAX_QUOTE_CHARS,
  type OwnerWorkUpdate,
  quoteProblem,
  valueProblem,
  valueSupportedByQuote,
} from "../extraction/validate.ts";
import { normalizeName } from "./normalize.ts";
import { type GraphStore, normalizeDueAt } from "./store.ts";
import { nextWorkStatus } from "./work.ts";
import { isOpenWork, nameTokens, workNames } from "./work-signals.ts";

/**
 * What the owner's own words do to their work (docs/design/memory-everything-2026.md §3.1, §3.2,
 * §3.4). Two inputs reach here: the USER.md learner reading the owner's chat message, and the
 * owner-authored notes the extraction pass validated. Both are the owner's text (trusted), and
 * in both the model only proposes: code resolves the item name against open work, verifies the
 * quote is in the owner's text, and decides the status. Text from anyone else never comes here;
 * it has the work lane (`extraction/work-lane.ts`), which can only suggest.
 */

export const OWNER_WORK_ATTRIBUTES = [
  "progress",
  "stopped_at",
  "deadline",
  "status",
  "next_step",
] as const;
export type OwnerWorkAttributeName = (typeof OWNER_WORK_ATTRIBUTES)[number];

/** The learner's `work` output, as the model wrote it. */
export interface OwnerWorkClaim {
  item: string;
  attribute: OwnerWorkAttributeName;
  value: string;
  quote: string;
}

/** The learner's `assignments` output: something new the owner said they have to do. */
export interface OwnerNewWork {
  title: string;
  due: string | null;
  parent: string | null;
  quote: string;
}

export interface ParsedOwnerWork {
  claims: OwnerWorkClaim[];
  assignments: OwnerNewWork[];
}

export const MAX_OWNER_WORK_CLAIMS = 5;
export const MAX_OWNER_NEW_WORK = 3;
export const MAX_WORK_TITLE = 120;

const isAttr = (v: unknown): v is OwnerWorkAttributeName =>
  typeof v === "string" && (OWNER_WORK_ATTRIBUTES as readonly string[]).includes(v);

/** The model's JSON as claims; anything malformed is no claim. */
export function parseOwnerWork(raw: unknown): ParsedOwnerWork {
  const out: ParsedOwnerWork = { claims: [], assignments: [] };
  if (typeof raw !== "object" || raw === null) return out;
  const { work, assignments } = raw as { work?: unknown; assignments?: unknown };
  if (Array.isArray(work)) {
    for (const w of work.slice(0, MAX_OWNER_WORK_CLAIMS)) {
      const c = w as Partial<Record<keyof OwnerWorkClaim, unknown>>;
      if (
        typeof c?.item === "string" &&
        isAttr(c.attribute) &&
        typeof c.value === "string" &&
        typeof c.quote === "string"
      ) {
        out.claims.push({ item: c.item, attribute: c.attribute, value: c.value, quote: c.quote });
      }
    }
  }
  if (Array.isArray(assignments)) {
    for (const a of assignments.slice(0, MAX_OWNER_NEW_WORK)) {
      const c = a as Partial<Record<keyof OwnerNewWork, unknown>>;
      if (typeof c?.title === "string" && typeof c.quote === "string") {
        out.assignments.push({
          title: c.title,
          due: typeof c.due === "string" ? c.due : null,
          parent: typeof c.parent === "string" ? c.parent : null,
          quote: c.quote,
        });
      }
    }
  }
  return out;
}

// --- resolving a name against open work ---------------------------------------------------------

/**
 * The one open item a name stands for: its exact name, an alias or a course code, compared as
 * whole words (so `HW7` is not `HW70`). More than one match is no match: the owner is asked
 * rather than guessed at.
 */
export function resolveWorkName(
  graph: GraphStore,
  name: string,
  kinds: ("assignment" | "project")[] = ["assignment", "project"],
): GraphEntity | undefined {
  const want = normalizeName(name);
  const tokens = nameTokens(name).join(" ");
  if (want === "" || tokens === "") return undefined;
  const hits = graph
    .listEntities(kinds)
    .filter(isOpenWork)
    .filter((e) =>
      workNames(graph, e).some(
        (n) => normalizeName(n) === want || nameTokens(n).join(" ") === tokens,
      ),
    );
  return hits.length === 1 ? hits[0] : undefined;
}

/** Open, non-private to-dos and projects, for a prompt: handles `w1`.. with their names. */
export function openWorkForPrompt(
  graph: GraphStore,
  max = 30,
): { handle: string; name: string; entityId: string }[] {
  return graph
    .listEntities(["assignment", "project"])
    .filter((e) => isOpenWork(e) && e.private !== true)
    .slice(0, max)
    .map((e, i) => ({ handle: `w${i + 1}`, name: e.name, entityId: e.id }));
}

/**
 * What the work lane may bind to: the open projects and courses (for `parent_hint`) and the open
 * to-dos (for a deadline change or a "submitted" notice), by their names, aliases and course
 * codes. Private ones are marked so the validator never names them from third-party text.
 */
export function workLaneContext(graph: GraphStore): {
  parents: { entityId: string; names: string[]; private: boolean }[];
  targets: { entityId: string; names: string[]; private: boolean; hasDeadline: boolean }[];
} {
  const open = graph.listEntities(["project", "assignment"]).filter(isOpenWork);
  return {
    parents: open
      .filter((e) => e.kind === "project")
      .map((e) => ({ entityId: e.id, names: workNames(graph, e), private: e.private === true })),
    targets: open
      .filter((e) => e.kind === "assignment")
      .map((e) => ({
        entityId: e.id,
        names: workNames(graph, e),
        private: e.private === true,
        hasDeadline: e.dueAt != null,
      })),
  };
}

// --- statuses: code decides ---------------------------------------------------------------------

const PARTIAL = /\b(problems?|parts?|questions?|sections?|pages?|steps?|half|some|first)\b/i;
const SUBMITTED = /\b(submitted|handed in|turned in|sent in)\b/i;
const DONE = /\b(finished|done|completed|complete|wrapped up)\b/i;
const DROPPED = /\b(dropped|dropping|cancel(?:l)?ed|scrapped|no longer (?:doing|need))\b/i;

/**
 * The status the owner's quote supports, or undefined. The model's `value` only has to agree; it
 * never picks the status. A quote about part of the item ("finished problems 1-3") is progress,
 * not a status.
 */
export function statusFromQuote(
  quote: string,
  claimed: string,
): Exclude<GraphWorkStatus, "not_started" | "in_progress"> | undefined {
  const c = claimed.toLowerCase().replace(/[\s-]+/g, "_");
  if (PARTIAL.test(quote)) return undefined;
  if ((c === "submitted" || c === "handed_in") && SUBMITTED.test(quote)) return "submitted";
  if (c === "done" && (DONE.test(quote) || SUBMITTED.test(quote))) return "done";
  if (c === "dropped" && DROPPED.test(quote)) return "dropped";
  return undefined;
}

// --- applying -----------------------------------------------------------------------------------

export interface AppliedWork {
  kind: "fact" | "status" | "deadline" | "created" | "suggested";
  entityId?: string;
  name: string;
  attribute?: GraphFactAttribute;
  value: string;
}

export interface OwnerWorkResult {
  applied: AppliedWork[];
  /** Counts by reason, never text. */
  dropped: Record<string, number>;
}

function plain(value: string, max: number): string | undefined {
  const v = value.replace(/\s+/g, " ").trim();
  if (v === "" || v.length > max) return undefined;
  return valueProblem(v) === undefined ? v : undefined;
}

/**
 * Applies what the owner said in one chat message. `claims` update items the owner already has;
 * `assignments` add new ones. Each needs a quote that is really in `ownerText`. An item that
 * resolves gets an `owner_stated` fact citing the thread; an item that does not resolve becomes
 * an `assignment` suggestion (never a silent create), and a new item with a due date and a
 * title becomes an accepted to-do (the owner said it exists, §3.2). Facts cannot hold secrets,
 * links or instruction-like text, and a status only follows a quote that says it.
 */
export function applyOwnerChatWork(
  graph: GraphStore,
  input: { ownerText: string; threadId: string; parsed: ParsedOwnerWork },
): OwnerWorkResult {
  const result: OwnerWorkResult = { applied: [], dropped: {} };
  const drop = (r: string) => {
    result.dropped[r] = (result.dropped[r] ?? 0) + 1;
  };
  const source = { kind: "chat" as const, ref: input.threadId };
  const quoted = (quote: string): string | undefined => {
    if (quoteProblem(quote) !== undefined) return undefined;
    const span = locateQuote(input.ownerText, quote);
    if (span === undefined) return undefined;
    const located = input.ownerText.slice(span[0], span[1]);
    return located.length > MAX_QUOTE_CHARS ? undefined : located;
  };

  for (const claim of input.parsed.claims.slice(0, MAX_OWNER_WORK_CLAIMS)) {
    const located = quoted(claim.quote);
    if (located === undefined) {
      drop("quote_not_found");
      continue;
    }
    const name = plain(claim.item, MAX_WORK_TITLE);
    if (name === undefined) {
      drop("bad_item");
      continue;
    }
    const entity = resolveWorkName(graph, name);
    if (entity === undefined) {
      // Not something the owner tracks: a suggestion with their own quote, never a create.
      const s = graph.suggest({
        kind: "assignment",
        entityIds: [],
        name,
        reason: `You said: "${located.slice(0, 200)}"`,
      });
      if (s === undefined) drop("duplicate_suggestion");
      else result.applied.push({ kind: "suggested", name, value: located });
      continue;
    }
    // A status or a date is read by code from a closed form (a status word, an ISO date), never
    // stored as text; every other value is plain text that must pass the same checks as a fact.
    const value =
      claim.attribute === "status" || claim.attribute === "deadline"
        ? claim.value.trim().slice(0, 40)
        : plain(claim.value, 200);
    if (value === undefined || value === "") {
      drop("bad_value");
      continue;
    }
    try {
      if (claim.attribute === "status") {
        const to = statusFromQuote(located, value);
        if (to === undefined || entity.kind !== "assignment" || entity.workStatus == null) {
          drop("status_unsupported");
          continue;
        }
        const t = nextWorkStatus(entity.workStatus, { type: "owner_set", to });
        if (!t.changed) continue;
        graph.setFact({
          entityId: entity.id,
          attribute: "status",
          value: to,
          provenance: "owner",
          subjectKind: "owner_stated",
          source,
          evidence: located,
        });
        result.applied.push({ kind: "status", entityId: entity.id, name: entity.name, value: to });
        continue;
      }
      if (claim.attribute === "deadline") {
        const due = normalizeDueAt(value);
        if (due === null) {
          drop("bad_date");
          continue;
        }
        graph.setFact({
          entityId: entity.id,
          attribute: "deadline",
          value: due,
          provenance: "owner",
          subjectKind: "owner_stated",
          source,
          evidence: located,
        });
        result.applied.push({
          kind: "deadline",
          entityId: entity.id,
          name: entity.name,
          value: due,
        });
        continue;
      }
      if (!valueSupportedByQuote(value, located)) {
        drop("value_not_in_quote");
        continue;
      }
      if (classifySensitivity(`${value} ${located}`, "note") !== "none") {
        drop("sensitive_work");
        continue;
      }
      graph.setFact({
        entityId: entity.id,
        attribute: claim.attribute,
        value,
        provenance: "owner",
        subjectKind: "owner_stated",
        source,
        evidence: located,
      });
      graph.recordSignal(entity.id, { provenance: "owner" });
      result.applied.push({
        kind: "fact",
        entityId: entity.id,
        name: entity.name,
        attribute: claim.attribute,
        value,
      });
    } catch {
      // A rule refused it (secrets, an unknown item kind): counted, never thrown at a chat turn.
      drop("refused");
    }
  }

  for (const a of input.parsed.assignments.slice(0, MAX_OWNER_NEW_WORK)) {
    const located = quoted(a.quote);
    if (located === undefined) {
      drop("quote_not_found");
      continue;
    }
    const title = plain(a.title, MAX_WORK_TITLE);
    if (title === undefined) {
      drop("bad_title");
      continue;
    }
    const due = normalizeDueAt(a.due);
    const parent = a.parent === null ? undefined : resolveWorkName(graph, a.parent, ["project"]);
    const known = resolveWorkName(graph, title, ["assignment"]);
    try {
      if (known !== undefined) {
        // The owner restated something they already track: a new date is a deadline update.
        if (due !== null && due !== known.dueAt) {
          graph.setFact({
            entityId: known.id,
            attribute: "deadline",
            value: due,
            provenance: "owner",
            subjectKind: "owner_stated",
            source,
            evidence: located,
          });
          result.applied.push({
            kind: "deadline",
            entityId: known.id,
            name: known.name,
            value: due,
          });
        }
        continue;
      }
      if (due === null) {
        const s = graph.suggest({
          kind: "assignment",
          entityIds: parent === undefined ? [] : [parent.id],
          name: title,
          reason: `You said: "${located.slice(0, 200)}"`,
        });
        if (s === undefined) drop("duplicate_suggestion");
        else result.applied.push({ kind: "suggested", name: title, value: located });
        continue;
      }
      const made = graph.createEntity({
        kind: "assignment",
        name: title,
        dueAt: due,
        source: "chat",
      });
      // The creation wrote the deadline; add the quote and thread to its citation.
      graph.setFact({
        entityId: made.id,
        attribute: "deadline",
        value: due,
        provenance: "owner",
        subjectKind: "owner_stated",
        source,
        evidence: located,
      });
      if (parent !== undefined) {
        graph.setEdge({
          src: made.id,
          rel: "part_of",
          dst: parent.id,
          provenance: "owner",
          source,
        });
      }
      result.applied.push({ kind: "created", entityId: made.id, name: made.name, value: due });
    } catch {
      drop("refused");
    }
  }
  return result;
}

/**
 * Writes the work updates the extraction pass validated from owner-authored notes. Progress,
 * where the owner stopped and the next step only (never a status or a due date): each is an
 * owner-signal fact cited to the note, and refreshes the item's last signal.
 */
export function applyWorkUpdates(
  graph: GraphStore,
  updates: readonly OwnerWorkUpdate[],
): { written: number; refused: number } {
  let written = 0;
  let refused = 0;
  for (const u of updates) {
    try {
      const entity = graph.getEntity(u.entityId);
      if (entity === undefined || !isOpenWork(entity)) {
        refused++;
        continue;
      }
      const r = graph.setFact({
        entityId: u.entityId,
        attribute: u.attribute,
        value: u.value,
        provenance: "owner",
        subjectKind: "owner_stated",
        sources: [`${u.citation.source}:${u.citation.sourceRef}`],
        evidence: u.citation.quote,
      });
      if (r === undefined) {
        refused++;
        continue;
      }
      graph.recordSignal(u.entityId, { provenance: "owner" });
      written++;
    } catch {
      refused++;
    }
  }
  return { written, refused };
}
