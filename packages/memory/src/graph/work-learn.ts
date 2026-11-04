import type { GraphEntity, GraphFactAttribute, GraphWorkStatus } from "@psyche/protocol";
import { cleanItemText } from "../extraction/clean.ts";
import { classifySensitivity } from "../extraction/sensitivity.ts";
import {
  locateQuote,
  MAX_QUOTE_CHARS,
  type OwnerWorkUpdate,
  quoteProblem,
  valueProblem,
  valueSupportedByQuote,
} from "../extraction/validate.ts";
import { CHAT_WORK_PROPOSAL, type EverythingStore } from "./everything.ts";
import { hasHiddenChars, mixedScript, normalizeName, sha256 } from "./normalize.ts";
import { ownWords } from "./own-words.ts";
import type { GraphStore } from "./store.ts";
import { nextWorkStatus } from "./work.ts";
import { isOpenWork, namedAdjacent, nameTokens, workNames } from "./work-signals.ts";
import { dateInQuote, localDate, parseDueInZone } from "./zoned-date.ts";

export { MAX_OWN_PARAGRAPH_CHARS, MAX_OWN_PARAGRAPH_LINES, ownWords } from "./own-words.ts";

/**
 * What the owner's own words do to their work (docs/design/memory-everything-2026.md §3.1, §3.2,
 * §3.4). Two inputs reach here: the USER.md learner reading the owner's chat message, and the
 * owner-authored notes the extraction pass validated. Both are the owner's text (trusted), and
 * in both the model only proposes: code resolves the item name against open work and verifies the
 * quote is in the owner's own words. Chat writes only progress, where they stopped and the next
 * step; a status, a deadline and a new to-do become proposals the owner confirms in Review. Text from anyone else never comes here;
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

// --- resolving a name against work --------------------------------------------------------------

export interface WorkMatch {
  entity?: GraphEntity;
  /** More than one item answers to the name: never guessed at. */
  ambiguous: boolean;
}

/**
 * The item a name stands for: its exact name, an alias or a course code, compared as whole words
 * (so `HW7` is not `HW70`). More than one match is ambiguous and binds to nothing.
 */
export function findWork(
  graph: GraphStore,
  name: string,
  kinds: ("assignment" | "project")[] = ["assignment", "project"],
  state: "open" | "closed" = "open",
): WorkMatch {
  const want = normalizeName(name);
  const tokens = nameTokens(name).join(" ");
  if (want === "" || tokens === "") return { ambiguous: false };
  const hits = graph
    .listEntities(kinds)
    .filter((e) => (state === "open" ? isOpenWork(e) : !isOpenWork(e)))
    .filter((e) =>
      workNames(graph, e).some(
        (n) => normalizeName(n) === want || nameTokens(n).join(" ") === tokens,
      ),
    );
  return hits.length === 1
    ? { entity: hits[0] as GraphEntity, ambiguous: false }
    : { ambiguous: hits.length > 1 };
}

export function resolveWorkName(
  graph: GraphStore,
  name: string,
  kinds: ("assignment" | "project")[] = ["assignment", "project"],
): GraphEntity | undefined {
  return findWork(graph, name, kinds).entity;
}

/**
 * Open, non-private to-dos and projects, for a prompt: handles `w1`.. with their names. The list
 * stops at 30 so the prompt stays small; items past it are simply not offered tonight.
 */
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
  targets: {
    entityId: string;
    names: string[];
    private: boolean;
    hasDeadline: boolean;
    parentNames: string[];
  }[];
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
        parentNames: graph
          .edges(e.id)
          .filter((x) => x.rel === "part_of" && x.src === e.id)
          .flatMap((x) => {
            const p = graph.getEntity(x.dst);
            return p === undefined ? [] : workNames(graph, p);
          }),
      })),
  };
}

// --- statuses: code decides ---------------------------------------------------------------------

/** Wording about part of the item: a range, a problem, a part, "most of it", a percentage. */
const PARTIAL =
  /\b(problems?|probs?|parts?|questions?|sections?|pages?|steps?|half|some|most|first|second|last|q\s?\d+|draft|reading|except)\b|#\s?\d+|\bno\.\s?\d+|\d\s*%|\d+\s*(?:[-–—]|to|through|thru|and|&|,)\s*\d+|\bq\d+\s*[-–—]\s*q?\d+/i;
/** Negation, hedges, wishes and the future, and phrases that use a cue word for something else. */
const HEDGE =
  /\b(not|never|yet|still|almost|nearly|barely|about to|going to|gonna|will|plan(?:ning)? to|need to|needs to|should|could|would|might|if|when|once|after|before|unless|trying to|try to|hope|hoping|no way|wish|for today|wrong file|thinking about|think about|thought about|considering|dropped the ball|dropped by|dropped off|jk|lol)\b|n['’]t\b/i;
const SUBMITTED = /\b(submitted|handed in|turned in|sent in)\b/i;
const DONE = /\b(finished|done|completed|complete|wrapped up)\b/i;
const DROPPED = /\b(dropped|dropping|cancel(?:l)?ed|scrapped|no longer (?:doing|need))\b/i;
/** Somebody else's subject: "Sam finished", "she submitted", "they turned in". */
const THIRD_PERSON =
  /\b(?:he|she|they|(?!(?:I|We|Just|Finally|Already|Also|Then|Today|Yesterday|Now|Ok|Okay|So|Well|Yes|Yeah|Done|Actually|Honestly|Not|Never|Still|Almost|Nearly)\b)[A-Z][a-z]+)\s+(?:has |had |have |just |already |also )?(?:finished|done|completed|submitted|handed|turned|dropped|sent)\b/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The status the owner's quote supports, or undefined. This is only a noise filter: a status from
 * chat is never applied, it is proposed (see `applyOwnerChatWork`). The model's `value` only has
 * to agree. The quote must name the item (`names`, when given), be about the whole thing (a range,
 * a problem, a part, "most of it" or a percentage is progress), be a statement in the first
 * person (no question mark, no other subject), and not be negated, hedged or about the future.
 */
export function statusFromQuote(
  quote: string,
  claimed: string,
  names: readonly string[] = [],
): Exclude<GraphWorkStatus, "not_started" | "in_progress"> | undefined {
  const c = claimed.toLowerCase().replace(/[\s-]+/g, "_");
  if (/[?？]/.test(quote)) return undefined;
  // The item's own name ("Problem Set 3", "Lab Report 3") is not wording about part of it.
  let q = quote;
  for (const n of names) {
    if (n.trim() !== "") q = q.replace(new RegExp(escapeRe(n.trim()), "gi"), " ");
  }
  if (names.length > 0 && !names.some((n) => namedAdjacent(n, quote))) return undefined;
  if (PARTIAL.test(q) || HEDGE.test(q) || THIRD_PERSON.test(q)) return undefined;
  if ((c === "submitted" || c === "handed_in") && SUBMITTED.test(q)) return "submitted";
  if (c === "done" && (DONE.test(q) || SUBMITTED.test(q))) return "done";
  if (c === "dropped" && DROPPED.test(q)) return "dropped";
  return undefined;
}

// --- applying -----------------------------------------------------------------------------------

export interface AppliedWork {
  /**
   * `fact`: progress, stopped at or next step, written. `proposed`, `suggested`: waiting for the
   * owner in Review. Nothing else is ever written from chat.
   */
  kind: "fact" | "suggested" | "proposed";
  entityId?: string;
  name: string;
  attribute?: GraphFactAttribute;
  value: string;
  /**
   * `proposed`: the pending fact the owner decides in Review. `fact`: the fact just written, set
   * only when this turn created it (not when the owner had already said the same), so
   * `EverythingStore.undoChatWork` can take it back.
   */
  factId?: string;
  /** For `fact`: the value this line replaced (a single-valued field), or null. */
  previousValue?: string | null;
}

export interface OwnerWorkResult {
  applied: AppliedWork[];
  /** Counts by reason, never text. */
  dropped: Record<string, number>;
}

function plain(value: string, max: number): string | undefined {
  const v = value.replace(/\s+/g, " ").trim();
  if (v === "" || v.length > max || hasHiddenChars(v)) return undefined;
  return valueProblem(v) === undefined ? v : undefined;
}

/** Dates beyond about two years ahead, or more than a week back, are not deadlines. */
const MAX_AHEAD_MS = 2 * 366 * 86_400_000;
const MAX_BEHIND_MS = 7 * 86_400_000;

export interface ChatWorkInput {
  ownerText: string;
  threadId: string;
  parsed: ParsedOwnerWork;
  /** The owner's clock and zone: "Friday" and a bare date mean the owner's day. */
  now: number;
  timeZone: string;
  /**
   * Where a status or a deadline is proposed (a pending owner-stated fact the owner confirms in
   * Review). Without it such claims are dropped.
   */
  em?: EverythingStore;
}

/**
 * What the owner said in one chat message. The text is first reduced to the owner's own
 * sentences (`ownWords`); the quote must be in them and name the item. Then:
 *
 * - progress, stopped at, next step: low-harm, so written at once as an `owner_stated` fact cited
 *   to the thread and the quote;
 * - a status, a new or changed deadline, and a new to-do: **never applied from chat.** Each
 *   becomes a pending proposal the owner confirms with one tap in Review (a pending
 *   `owner_stated` fact for a status or deadline, an `assignment` suggestion for a new item).
 *   Confirming writes the owner's fact; the heuristics here only decide whether to propose. A
 *   deadline is proposed only when the quote's own date expression is the model's date.
 */
export function applyOwnerChatWork(graph: GraphStore, input: ChatWorkInput): OwnerWorkResult {
  const result: OwnerWorkResult = { applied: [], dropped: {} };
  const drop = (r: string) => {
    result.dropped[r] = (result.dropped[r] ?? 0) + 1;
  };
  const source = { kind: "chat" as const, ref: input.threadId };
  const own = ownWords(input.ownerText);
  const tz = input.timeZone;
  const clean = (text: string) => cleanItemText(text, { format: "text", keepQuoted: true }).text;
  const quoted = (quote: string): string | undefined => {
    if (quoteProblem(quote) !== undefined) return undefined;
    const span = locateQuote(own, quote);
    if (span === undefined) return undefined;
    const located = clean(own.slice(span[0], span[1]));
    return located === "" || located.length > MAX_QUOTE_CHARS ? undefined : located;
  };
  const names = (e: GraphEntity) => workNames(graph, e);
  const namesIt = (e: GraphEntity, quote: string) => names(e).some((n) => namedAdjacent(n, quote));

  /** The date the quote states, if it is the one the model gave (same local day) and sane. */
  const statedDate = (quote: string, modelValue: string | null): string | undefined => {
    const stated = dateInQuote(quote, input.now, tz);
    const model = parseDueInZone(modelValue, tz);
    if (stated === undefined || model === null) return undefined;
    const t = Date.parse(stated);
    if (t > input.now + MAX_AHEAD_MS || t < input.now - MAX_BEHIND_MS) return undefined;
    return localDate(t, tz) === localDate(Date.parse(model), tz) ? stated : undefined;
  };

  /** A pending, owner-stated proposal on an existing item. The owner's tap makes it theirs. */
  const propose = (
    entity: GraphEntity,
    attribute: "status" | "deadline",
    value: string,
    located: string,
  ): void => {
    if (input.em === undefined) {
      drop("no_review_store");
      return;
    }
    const out = input.em.proposeFact({
      entityId: entity.id,
      attribute,
      value,
      provenance: "agent",
      subjectKind: "owner_stated",
      sensitivity: "none",
      confidence: 0.8,
      extractor: CHAT_WORK_PROPOSAL,
      citations: [
        {
          source: "chats",
          sourceRef: input.threadId,
          quote: located.slice(0, 200),
          start: 0,
          end: Math.min(located.length, 200),
          sourceHash: sha256(input.ownerText),
          authorEntityId: null,
        },
      ],
    });
    if (out.status === "refused") {
      drop(`proposal_${out.reason}`);
      return;
    }
    result.applied.push({
      kind: "proposed",
      entityId: entity.id,
      name: entity.name,
      attribute,
      value,
      ...(out.fact.review === "pending" ? { factId: out.fact.id } : {}),
    });
  };

  const suggest = (
    name: string,
    located: string,
    parentId: string | undefined,
    dueAt: string | null,
  ) => {
    const flag = mixedScript(name) ? " (check the spelling: it mixes alphabets)" : "";
    const s = graph.suggest({
      kind: "assignment",
      entityIds: parentId === undefined ? [] : [parentId],
      name,
      reason: `You said: "${located.slice(0, 200)}"${flag}`,
      ...(dueAt === null ? {} : { dueAt }),
    });
    if (s === undefined) drop("duplicate_suggestion");
    else result.applied.push({ kind: "suggested", name, value: located });
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
    const entity = findWork(graph, name).entity;
    if (entity === undefined) {
      // Not something the owner tracks (or two things are): a suggestion with their own words.
      if (!namedAdjacent(name, located)) {
        drop("quote_not_naming_item");
        continue;
      }
      if (findWork(graph, name, ["assignment", "project"], "closed").entity !== undefined) {
        drop("already_finished");
        continue;
      }
      suggest(name, located, undefined, null);
      continue;
    }
    if (!namesIt(entity, located)) {
      drop("quote_not_naming_item");
      continue;
    }
    try {
      if (claim.attribute === "status") {
        const to = statusFromQuote(located, claim.value.trim().slice(0, 40), names(entity));
        if (to === undefined || entity.kind !== "assignment" || entity.workStatus == null) {
          drop("status_unsupported");
          continue;
        }
        if (nextWorkStatus(entity.workStatus, { type: "owner_set", to }).changed) {
          propose(entity, "status", to, located);
        }
        continue;
      }
      if (claim.attribute === "deadline") {
        if (/[?？]/.test(located)) {
          drop("date_not_in_quote");
          continue;
        }
        const due = statedDate(located, claim.value.trim().slice(0, 40));
        if (due === undefined) {
          drop("date_not_in_quote");
          continue;
        }
        if (entity.dueAt !== due) propose(entity, "deadline", due, located);
        continue;
      }
      const value = plain(claim.value, 200);
      if (value === undefined) {
        drop("bad_value");
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
      const before = new Set(graph.facts(entity.id).map((f) => f.id));
      const was = graph.getEntity(entity.id);
      const written = graph.setFact({
        entityId: entity.id,
        attribute: claim.attribute,
        value,
        provenance: "owner",
        subjectKind: "owner_stated",
        source,
        evidence: located,
      });
      graph.recordSignal(entity.id, { provenance: "owner" });
      const created = written !== undefined && !before.has(written.fact.id);
      if (created) {
        // What the write moved besides the fact (a to-do starting, the last signal), for Undo.
        const now = graph.getEntity(entity.id);
        const moved = (was?.workStatus ?? null) !== (now?.workStatus ?? null);
        graph.recordWorkUndo({
          factId: written.fact.id,
          entityId: entity.id,
          statusBefore: was?.workStatus ?? null,
          statusAfter: now?.workStatus ?? null,
          statusFactId: moved
            ? (graph.facts(entity.id).find((f) => f.attribute === "status")?.id ?? null)
            : null,
          signalBefore: was?.lastSignalAt ?? null,
          signalAfter: now?.lastSignalAt ?? null,
        });
      }
      result.applied.push({
        kind: "fact",
        entityId: entity.id,
        name: entity.name,
        attribute: claim.attribute,
        value,
        ...(created ? { factId: written.fact.id } : {}),
        ...(created
          ? {
              previousValue:
                written.superseded === null
                  ? null
                  : (graph.getFact(written.superseded)?.value ?? null),
            }
          : {}),
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
    if (!namedAdjacent(title, located)) {
      drop("quote_not_naming_item");
      continue;
    }
    // A date counts only when the quote states it (and it is the model's date); else no date.
    const due = a.due === null ? null : (statedDate(located, a.due) ?? null);
    const parent = a.parent === null ? undefined : findWork(graph, a.parent, ["project"]).entity;
    const known = findWork(graph, title, ["assignment"]);
    try {
      if (known.entity !== undefined && !known.ambiguous) {
        // Something already tracked: a stated new date is a proposal, nothing else changes.
        if (due !== null && known.entity.dueAt !== due) {
          propose(known.entity, "deadline", due, located);
        }
        continue;
      }
      if (
        !known.ambiguous &&
        findWork(graph, title, ["assignment"], "closed").entity !== undefined
      ) {
        drop("already_finished");
        continue;
      }
      // New (or ambiguous): never created from chat. The owner's Track makes it a to-do.
      suggest(title, located, parent?.id, due);
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
