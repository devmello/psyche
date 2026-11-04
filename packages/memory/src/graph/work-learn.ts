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
import type { EverythingStore } from "./everything.ts";
import { hasHiddenChars, normalizeName, sha256 } from "./normalize.ts";
import type { GraphStore } from "./store.ts";
import { nextWorkStatus } from "./work.ts";
import { isOpenWork, namedIn, nameTokens, workNames } from "./work-signals.ts";
import { dateInQuote, localDate, parseDueInZone } from "./zoned-date.ts";

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

// --- text the owner did not write ---------------------------------------------------------------

const REPORTING =
  /(?:\b(?:says?|said|wrote|writes|told me|according to|forwarded|pasted|dice|dijo|escribi[óo]|escribe)\b|说道?|写道|写着|表示)[^.!?。！？\n]*(?:[.!?。！？]|$)/giu;
const QUOTED =
  /"[^"\n]{20,}"|“[^”]{20,}”|«[^»]{20,}»|「[^」]{20,}」|『[^』]{20,}』|„[^“]{20,}“|‘[^’]{20,}’|(?<![\p{L}\p{N}])'[^'\n]{20,}'(?![\p{L}\p{N}])/gu;
const FENCE = /```[\s\S]*?(?:```|$)/g;
const HEADER = /^\s*(?:from|to|cc|bcc|subject|date|sent|reply-to|de|para|asunto)\s*:/i;
/** A paragraph longer than this, or with this many lines, is a paste, not the owner talking. */
export const MAX_OWN_PARAGRAPH_CHARS = 400;
export const MAX_OWN_PARAGRAPH_LINES = 4;

/**
 * Only the owner's own sentences (H1): what is left of a chat message after quoted lines (`>`),
 * fenced blocks, mail header blocks and the paragraph under them, long quoted strings, long
 * pastes, and anything reported as another person's words ("my prof says ...", "the email said
 * ..."). A quote, a status cue or a date is read from this text only, so a pasted notice never
 * becomes the owner's word. Cheap and language-tolerant, not exhaustive: it errs towards
 * dropping.
 */
export function ownWords(text: string): string {
  const base = text.replace(FENCE, "\n").replace(QUOTED, " ");
  const kept: string[] = [];
  let afterHeader = false;
  for (const para of base.split(/\n\s*\n/)) {
    const lines = para.split("\n").filter((l) => l.trim() !== "");
    const headerLike = lines.filter((l) => HEADER.test(l)).length;
    const quoted = lines.filter((l) => /^\s*>/.test(l)).length;
    const paste = para.length > MAX_OWN_PARAGRAPH_CHARS || lines.length >= MAX_OWN_PARAGRAPH_LINES;
    if (headerLike >= 2 || (lines.length > 0 && HEADER.test(lines[0] as string))) {
      afterHeader = true;
      continue;
    }
    if (afterHeader || paste || (quoted > 0 && quoted === lines.length)) {
      afterHeader = false;
      continue;
    }
    kept.push(
      lines
        .filter((l) => !/^\s*>/.test(l))
        .join("\n")
        .replace(REPORTING, " "),
    );
  }
  return kept.join("\n\n");
}

// --- statuses: code decides ---------------------------------------------------------------------

/** Wording about part of the item, or about the future, or negated: progress at most, never a status. */
const PARTIAL =
  /\b(problems?|probs?|parts?|questions?|sections?|pages?|steps?|half|some|first|second|last|q\s?\d+)\b|#\s?\d+|\bno\.\s?\d+|\d+\s*(?:[-–—]|to|through|thru)\s*\d+|\bq\d+\s*[-–—]\s*q?\d+/i;
const HEDGE =
  /\b(not|never|yet|still|almost|nearly|barely|about to|going to|gonna|will|plan(?:ning)? to|need to|needs to|should|could|would|might|if|when|once|after|before|unless|trying to|try to|hope|hoping)\b|n['’]t\b/i;
const SUBMITTED = /\b(submitted|handed in|turned in|sent in)\b/i;
const DONE = /\b(finished|done|completed|complete|wrapped up)\b/i;
const DROPPED = /\b(dropped|dropping|cancel(?:l)?ed|scrapped|no longer (?:doing|need))\b/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The status the owner's quote supports, or undefined. The model's `value` only has to agree; it
 * never picks the status. The quote must name the item (`names`, when given), be about the whole
 * thing (a range, a problem, a part or "half" is progress), and not be negated, hedged or about
 * the future ("not finished", "almost done", "haven't submitted yet", "I'll hand it in").
 */
export function statusFromQuote(
  quote: string,
  claimed: string,
  names: readonly string[] = [],
): Exclude<GraphWorkStatus, "not_started" | "in_progress"> | undefined {
  const c = claimed.toLowerCase().replace(/[\s-]+/g, "_");
  // The item's own name ("Problem Set 3", "Lab Report 3") is not wording about part of it.
  let q = quote;
  for (const n of names) {
    if (n.trim() !== "") q = q.replace(new RegExp(escapeRe(n.trim()), "gi"), " ");
  }
  if (names.length > 0 && !names.some((n) => namedIn(n, quote, 1))) return undefined;
  if (PARTIAL.test(q) || HEDGE.test(q)) return undefined;
  if ((c === "submitted" || c === "handed_in") && SUBMITTED.test(q)) return "submitted";
  if (c === "done" && (DONE.test(q) || SUBMITTED.test(q))) return "done";
  if (c === "dropped" && DROPPED.test(q)) return "dropped";
  return undefined;
}

/** Cues that the owner is changing a date they already set, not just mentioning it. */
const CHANGE_CUE =
  /\b(now|moved|changed|pushed|extended|postponed|rescheduled|delayed|instead|new (?:deadline|due))\b/i;

// --- applying -----------------------------------------------------------------------------------

export interface AppliedWork {
  kind: "fact" | "status" | "deadline" | "created" | "suggested" | "proposed";
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
  if (v === "" || v.length > max || hasHiddenChars(v)) return undefined;
  return valueProblem(v) === undefined ? v : undefined;
}

export interface ChatWorkInput {
  ownerText: string;
  threadId: string;
  parsed: ParsedOwnerWork;
  /** The owner's clock and zone: "Friday" and a bare date mean the owner's day. */
  now: number;
  timeZone: string;
  /**
   * Where a deadline that would replace one the owner already set is proposed (a pending fact the
   * owner confirms in Review). Without it such a change is dropped.
   */
  em?: EverythingStore;
}

/**
 * Applies what the owner said in one chat message. `claims` update items the owner already has;
 * `assignments` add new ones. Only the owner's own sentences count (`ownWords`): a pasted mail, a
 * quoted notice or "my prof says ..." is not the owner's word. Each claim needs a quote that is
 * in those sentences and names the item, and a status or a date must be in the quote itself:
 *
 * - progress, stopped at, next step: an `owner_stated` fact cited to the thread and the quote;
 * - a status: only from the quote's own wording (`statusFromQuote`);
 * - a deadline: derived by code from the quote's date expression (an ISO date, "Nov 9", "Friday",
 *   "tomorrow", in the owner's zone), which must equal the model's; it replaces an existing date
 *   only when the owner says it changed ("now", "moved"), otherwise it is a pending proposal;
 * - a name that resolves to nothing, or to two things, becomes an `assignment` suggestion; a new
 *   item with a stated date is an accepted to-do (the owner said it exists, §3.2) that inherits
 *   `private` from its project.
 */
export function applyOwnerChatWork(graph: GraphStore, input: ChatWorkInput): OwnerWorkResult {
  const result: OwnerWorkResult = { applied: [], dropped: {} };
  const drop = (r: string) => {
    result.dropped[r] = (result.dropped[r] ?? 0) + 1;
  };
  const source = { kind: "chat" as const, ref: input.threadId };
  const own = ownWords(input.ownerText);
  const tz = input.timeZone;
  const quoted = (quote: string): string | undefined => {
    if (quoteProblem(quote) !== undefined) return undefined;
    const span = locateQuote(own, quote);
    if (span === undefined) return undefined;
    const located = own.slice(span[0], span[1]);
    return located.length > MAX_QUOTE_CHARS ? undefined : located;
  };
  const names = (e: GraphEntity) => workNames(graph, e);
  const namesIt = (e: GraphEntity, quote: string) => names(e).some((n) => namedIn(n, quote, 1));

  /** The date the quote states, if it is the one the model gave (same local day). */
  const statedDate = (quote: string, modelValue: string | null): string | undefined => {
    const stated = dateInQuote(quote, input.now, tz);
    const model = parseDueInZone(modelValue, tz);
    if (stated === undefined || model === null) return undefined;
    return localDate(Date.parse(stated), tz) === localDate(Date.parse(model), tz)
      ? stated
      : undefined;
  };

  /** Sets, proposes or refuses a deadline on an item. Returns true when it did something. */
  const setDeadline = (entity: GraphEntity, due: string, located: string): boolean => {
    if (entity.dueAt != null && entity.dueAt === due) return false;
    if (entity.dueAt != null && !CHANGE_CUE.test(located)) {
      // The owner set a different date earlier and did not say it changed: ask, never overwrite.
      if (input.em === undefined) {
        drop("deadline_conflict");
        return false;
      }
      const out = input.em.proposeFact({
        entityId: entity.id,
        attribute: "deadline",
        value: due,
        provenance: "agent",
        subjectKind: "owner_stated",
        sensitivity: "none",
        confidence: 0.8,
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
        drop("deadline_conflict");
        return false;
      }
      result.applied.push({
        kind: "proposed",
        entityId: entity.id,
        name: entity.name,
        attribute: "deadline",
        value: due,
      });
      return true;
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
    result.applied.push({ kind: "deadline", entityId: entity.id, name: entity.name, value: due });
    return true;
  };

  const suggest = (
    name: string,
    located: string,
    parentId: string | undefined,
    dueAt: string | null,
  ) => {
    const s = graph.suggest({
      kind: "assignment",
      entityIds: parentId === undefined ? [] : [parentId],
      name,
      reason: `You said: "${located.slice(0, 200)}"`,
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
    const match = findWork(graph, name);
    const entity = match.entity;
    if (entity === undefined) {
      // Not something the owner tracks (or two things do): a suggestion with their own words.
      if (!namedIn(name, located, 1)) {
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
        const to = statusFromQuote(located, value, names(entity));
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
        const due = statedDate(located, value);
        if (due === undefined) {
          drop("date_not_in_quote");
          continue;
        }
        setDeadline(entity, due, located);
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
    if (!namedIn(title, located, 1)) {
      drop("quote_not_naming_item");
      continue;
    }
    // A date counts only when the quote states it (and it is the model's date); else no date.
    const due = a.due === null ? null : (statedDate(located, a.due) ?? null);
    const parent = a.parent === null ? undefined : findWork(graph, a.parent, ["project"]).entity;
    const known = findWork(graph, title, ["assignment"]);
    try {
      if (known.ambiguous) {
        suggest(title, located, parent?.id, due);
        continue;
      }
      if (known.entity !== undefined) {
        // The owner restated something they already track: a stated date is a deadline update.
        if (due !== null) setDeadline(known.entity, due, located);
        continue;
      }
      if (findWork(graph, title, ["assignment"], "closed").entity !== undefined) {
        drop("already_finished");
        continue;
      }
      if (due === null) {
        suggest(title, located, parent?.id, null);
        continue;
      }
      const made = graph.createEntity({
        kind: "assignment",
        name: title,
        dueAt: due,
        source: "chat",
        ...(parent?.private === true ? { private: true } : {}),
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
