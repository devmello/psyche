import type { QuarantineReason } from "@psyche/protocol";
import { looksLikeInstruction } from "../filters.ts";
import { hasHiddenChars, normalizeName } from "../graph/normalize.ts";
import { nextWorkStatus } from "../graph/work.ts";
import { parseDueInZone } from "../graph/zoned-date.ts";
import type { WorkLaneOutput } from "./schema.ts";
import { screenItem } from "./screen.ts";
import type { ExtractionSink } from "./sink.ts";
import {
  type BatchItem,
  citation,
  locateQuote,
  MAX_QUOTE_CHARS,
  quoteProblem,
  valueProblem,
} from "./validate.ts";

/**
 * Stage 3 for the work lane (docs/design/memory-everything-2026.md §3.3, §7.1, §7.2). The items
 * are third-party text from a sender the owner opted in; the model only listed assignments, and
 * this code decides what any of it means. The outcomes, whatever the model said:
 *
 * - `new`              a **suggestion** (`sink.suggest`): the owner's Track creates the item (W1, W2);
 * - `deadline_change`  a **pending** `deadline` fact on the matching to-do, through `proposeFact`;
 *                      against a deadline the owner set it lands as a conflict for Review (EM §4.5);
 * - `submitted`        an **ask** at most ("Canvas says it was handed in. Mark it?"), never a status (W1);
 * - `graded`, `other`  nothing is stored (a grade is never stored).
 *
 * There is no person, relation or identifier in this form (W5), the sender never becomes a person,
 * a `parent_hint` only binds to an existing, visible project or course by exact name or code, and
 * the limits (W10) quarantine a flood whole. Nothing here calls a model, a tool or the network;
 * the only way out is the `ExtractionSink`.
 */

export const MAX_WORK_TITLE_CHARS = 120;
export const MAX_PARENT_HINT_CHARS = 60;
/** At most this many assignment claims from one item; more is a flood (`too_many_claims`). */
export const MAX_WORK_CLAIMS_PER_ITEM = 10;
export const MAX_WORK_SUGGESTIONS_PER_SENDER_PER_NIGHT = 10;
export const MAX_WORK_SUGGESTIONS_PER_NIGHT = 30;
export const MAX_DEADLINE_CHANGES_PER_ITEM_PER_NIGHT = 1;

/** Dates further than this from now are read as junk, not as a due date. */
const MAX_DUE_FUTURE_DAYS = 3 * 366;
const MAX_DUE_PAST_DAYS = 400;

export interface WorkLaneBatchItem extends BatchItem {
  /** The owner chose "Use for work" for this sender (`memory_trusted_senders.lane = work`). */
  senderOptedIn: boolean;
  /** Stable key of the sender for the per-night limit (an address hash or entity id). */
  senderKey: string;
  /** Who it is from, for the suggestion's reason ("Canvas"). Plain text from the owner's own setting. */
  senderLabel: string;
}

export interface WorkParent {
  entityId: string;
  /** The name, aliases and course codes the project is known by. */
  names: string[];
  private: boolean;
}

export interface WorkTarget {
  entityId: string;
  /** The name and aliases of an open to-do. */
  names: string[];
  private: boolean;
  /** An owner or rule set its deadline. */
  hasDeadline: boolean;
  /** The names of the project or course it belongs to, to tell two same-named to-dos apart. */
  parentNames?: string[];
}

export interface WorkLaneLimits {
  perSender: Map<string, number>;
  total: number;
  /** `entityId` of to-dos that already got a deadline proposal tonight. */
  deadlineChanges: Set<string>;
}

export const newWorkLaneLimits = (): WorkLaneLimits => ({
  perSender: new Map(),
  total: 0,
  deadlineChanges: new Set(),
});

export interface WorkLaneAsk {
  entityId: string;
  claims: "submitted";
  /** Verbatim from the item, for the ask's citation. */
  quote: string;
  sourceRef: string;
}

export interface WorkLaneReport {
  suggested: number;
  /** Pending deadline proposals, including those that conflict with an owner-set date. */
  deadlinesProposed: number;
  conflicts: number;
  asks: WorkLaneAsk[];
  /** Graded notices seen: the timeline shows them, nothing is stored. */
  graded: number;
  dropped: Record<string, number>;
  /** `source:sourceRef` of items sent to quarantine. */
  quarantined: string[];
}

export interface ValidateWorkLaneInput {
  output: WorkLaneOutput;
  items: WorkLaneBatchItem[];
  parents: WorkParent[];
  targets: WorkTarget[];
  sink: ExtractionSink;
  limits?: WorkLaneLimits;
  now?: number;
  /** The owner's zone: a date with no zone is local, a bare date is 23:59 local. */
  timeZone?: string;
}

/** A title that talks to the reader or asks for money, a login or a transfer is phishing, not work. */
const PHISHING_TITLE =
  /\b(pass(?:word|code)|log\s?in|sign\s?in|verify|confirm your|gift\s?cards?|wire|bank|ssn|social security|bitcoin|crypto|pay(?:ment)?|invoice|click|download|urgent|immediately|your account)\b/i;
/** Markdown or HTML that would render as a link, emphasis or a heading in a card. */
const MARKUP = /[[\]()*_#|~]|^\s*[-+>]/;

function titleProblem(title: string): string | undefined {
  if (title === "") return "empty_title";
  if (title.length > MAX_WORK_TITLE_CHARS) return "title_too_long";
  const vp = valueProblem(title);
  if (vp !== undefined) return vp;
  if (looksLikeInstruction(title)) return "instruction_like";
  if (PHISHING_TITLE.test(title)) return "phishing_title";
  if (MARKUP.test(title)) return "markup_in_title";
  // Zero-width, bidi, tag and variation characters can hide text; a title never has them.
  if (hasHiddenChars(title)) return "hidden_chars";
  return undefined;
}

/** A due date as ISO UTC in the owner's zone, or null for none, junk, impossible or out of range. */
export function readDue(due: string | null, now: number, timeZone = "UTC"): string | null {
  const iso = parseDueInZone(due, timeZone);
  if (iso === null) return null;
  const t = Date.parse(iso);
  if (t > now + MAX_DUE_FUTURE_DAYS * 86_400_000) return null;
  if (t < now - MAX_DUE_PAST_DAYS * 86_400_000) return null;
  return iso;
}

/** Words of a text, split on letters and digits, so `Homework 1` is not inside `Homework 10`. */
const wordsOf = (text: string): string[] => normalizeName(text).match(/\p{L}+|\p{N}+/gu) ?? [];
/** Every word of `title` appears in `text` as a run, on word boundaries. */
function containsWords(text: string, title: string): boolean {
  const t = wordsOf(title);
  const h = wordsOf(text);
  if (t.length === 0) return false;
  for (let i = 0; i + t.length <= h.length; i++) {
    if (t.every((w, k) => h[i + k] === w)) return true;
  }
  return false;
}

const exactly = (names: readonly string[], text: string): boolean => {
  const want = normalizeName(text);
  return want !== "" && names.some((n) => normalizeName(n) === want);
};

/**
 * The suggestion's reason, built by code. The sender's words are shown as quoted data, and only
 * when they pass the same checks as a value (no link, address, number or instruction); otherwise
 * the reason says the text was withheld. At most 120 characters of it.
 */
function reasonFor(senderLabel: string, quote: string): string {
  const who =
    hasHiddenChars(senderLabel) || valueProblem(senderLabel) !== undefined
      ? "a work sender"
      : senderLabel;
  const q = quote.replace(/\s+/g, " ").replace(/["“”]/g, "'").trim().slice(0, 120);
  // Dates and times are what these notices are for; they must not read as phone numbers.
  const probe = q.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/g, "date");
  const safe = q !== "" && valueProblem(probe) === undefined && !hasHiddenChars(q);
  return safe ? `New from ${who}: "${q}"` : `New from ${who} (quoted text withheld)`;
}

export function validateWorkLane(input: ValidateWorkLaneInput): WorkLaneReport {
  const limits = input.limits ?? newWorkLaneLimits();
  const now = input.now ?? Date.now();
  const report: WorkLaneReport = {
    suggested: 0,
    deadlinesProposed: 0,
    conflicts: 0,
    asks: [],
    graded: 0,
    dropped: {},
    quarantined: [],
  };
  const drop = (reason: string, n = 1) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + n;
  };
  const items = new Map(input.items.map((i) => [i.handle, i]));
  const claimsBy = new Map<string, WorkLaneOutput["items"][number]["assignments"]>();
  const flagged = new Set<string>();
  for (const o of input.output.items) {
    const item = items.get(o.item);
    if (item === undefined) {
      drop("unknown_item", Math.max(1, o.assignments.length));
      continue;
    }
    claimsBy.set(item.handle, [...(claimsBy.get(item.handle) ?? []), ...o.assignments]);
    if (o.flags.instruction_like) flagged.add(item.handle);
  }

  for (const item of input.items) {
    const claims = claimsBy.get(item.handle) ?? [];
    // The lane is closed to senders the owner did not opt in: nothing is read as work, nothing
    // is stored, not even as a suggestion (W1, §3.3 "off by default, one sender at a time").
    if (!item.senderOptedIn) {
      if (claims.length > 0) drop("sender_not_opted_in", claims.length);
      continue;
    }
    const reasons = new Set<QuarantineReason>(item.screenReasons ?? []);
    for (const r of screenItem({
      text: item.text,
      trust: "untrusted",
      ...(item.hiddenRemoved === undefined ? {} : { hiddenRemoved: item.hiddenRemoved }),
      ...(item.rawLength === undefined ? {} : { rawLength: item.rawLength }),
      ...(item.visibleLength === undefined ? {} : { visibleLength: item.visibleLength }),
      ...(item.fields === undefined ? {} : { fields: item.fields }),
    }).reasons) {
      reasons.add(r);
    }
    if (flagged.has(item.handle)) reasons.add("instruction_like");
    if (claims.length > MAX_WORK_CLAIMS_PER_ITEM) reasons.add("too_many_claims");
    const used = limits.perSender.get(item.senderKey) ?? 0;
    const wantsSuggestions = claims.filter((c) => c.kind === "new").length;
    if (
      used + wantsSuggestions > MAX_WORK_SUGGESTIONS_PER_SENDER_PER_NIGHT ||
      limits.total + wantsSuggestions > MAX_WORK_SUGGESTIONS_PER_NIGHT
    ) {
      reasons.add("too_many_claims");
    }
    if (reasons.size > 0) {
      input.sink.quarantine({
        source: item.source,
        sourceRef: item.sourceRef,
        senderEntityId: null,
        reasons: [...reasons],
        excerpt: item.text.slice(0, 300),
      });
      report.quarantined.push(`${item.source}:${item.sourceRef}`);
      if (claims.length > 0) drop("item_quarantined", claims.length);
      continue;
    }

    for (const c of claims) {
      const title = c.title.replace(/\s+/g, " ").trim();
      const tp = titleProblem(title);
      if (tp !== undefined) {
        drop(tp);
        continue;
      }
      const qp = quoteProblem(c.quote);
      if (qp !== undefined) {
        drop(qp);
        continue;
      }
      const span = locateQuote(item.text, c.quote);
      if (span === undefined) {
        drop("quote_not_found");
        continue;
      }
      const located = item.text.slice(span[0], span[1]);
      if (located.length > MAX_QUOTE_CHARS) {
        drop("quote_too_long");
        continue;
      }
      // The title must be what the quote says (every word of it appears there).
      if (!containsWords(located, title)) {
        drop("title_not_in_quote");
        continue;
      }
      const due = readDue(c.due, now, input.timeZone ?? "UTC");
      const hint0 = (c.parent_hint ?? "").replace(/\s+/g, " ").trim();
      const matches = input.targets.filter((t) => !t.private && exactly(t.names, title));
      // Two to-dos with one name: the parent hint tells them apart, else none is guessed.
      const byHint =
        matches.length > 1 && hint0 !== ""
          ? matches.filter((t) => (t.parentNames ?? []).some((n) => exactly([n], hint0)))
          : matches;
      const ambiguous = byHint.length > 1;
      const target = byHint.length === 1 ? byHint[0] : undefined;
      const cite = citation(item, span, located, null, now);

      if (c.kind === "new") {
        if (target !== undefined || ambiguous) {
          drop("already_tracked");
          continue;
        }
        const hint = (c.parent_hint ?? "").replace(/\s+/g, " ").trim();
        // A hint binds only to an existing, visible project or course, by exact name or code.
        const parent =
          hint === "" || hint.length > MAX_PARENT_HINT_CHARS
            ? undefined
            : input.parents.find((p) => !p.private && exactly(p.names, hint));
        const out = input.sink.suggest({
          kind: "assignment",
          ...(parent === undefined ? {} : { parentId: parent.entityId }),
          name: title,
          reason: reasonFor(item.senderLabel, located),
          dueAt: due,
        });
        if (out.status === "refused") drop(`store:${out.reason}`);
        else if (out.status === "duplicate") drop("duplicate_suggestion");
        else {
          report.suggested++;
          limits.total++;
          limits.perSender.set(item.senderKey, (limits.perSender.get(item.senderKey) ?? 0) + 1);
        }
        continue;
      }

      if (ambiguous) {
        drop(`${c.kind}_ambiguous_item`);
        continue;
      }
      if (target === undefined) {
        drop(`${c.kind}_no_such_item`);
        continue;
      }
      if (c.kind === "deadline_change") {
        if (due === null) {
          drop("deadline_no_date");
          continue;
        }
        if (limits.deadlineChanges.has(target.entityId)) {
          drop("deadline_limit");
          continue;
        }
        limits.deadlineChanges.add(target.entityId);
        const out = input.sink.proposeFact({
          entityId: target.entityId,
          attribute: "deadline",
          value: due,
          provenance: "untrusted",
          subjectKind: "about_other",
          sensitivity: "none",
          confidence: 0.6,
          citations: [cite],
        });
        if (out.status === "refused") drop(`store:${out.reason}`);
        else {
          report.deadlinesProposed++;
          if (out.status === "conflict") report.conflicts++;
        }
        continue;
      }
      if (c.kind === "submitted") {
        // Never a status (W1): the state machine says what it would take, and the answer is an ask.
        const would = nextWorkStatus("in_progress", {
          type: "untrusted_text",
          claims: "submitted",
        });
        if (would.ask !== undefined) {
          if (!report.asks.some((a) => a.entityId === target.entityId)) {
            report.asks.push({
              entityId: target.entityId,
              claims: "submitted",
              quote: located,
              sourceRef: item.sourceRef,
            });
          }
        }
        continue;
      }
      if (c.kind === "graded") {
        report.graded++;
        continue;
      }
      drop("other_kind");
    }
  }
  return report;
}
