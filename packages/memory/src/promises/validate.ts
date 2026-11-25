import { detectSensitive, looksLikeInstruction } from "../filters.ts";
import { hasHiddenChars } from "../graph/normalize.ts";
import { contentWords } from "./dedupe.ts";
import { type ParsedDue, resolveDue } from "./due-text.ts";
import type { BuiltPrompt, LaneSnippet, OpenPromise } from "./prompt.ts";
import type { PromiseLaneItem, PromiseLaneOutput } from "./schema.ts";
import { STORE_MIN_CONFIDENCE } from "./thresholds.ts";

/**
 * Stage 3 of the promise lane (design 3.3 "Validator"). The model's output is untrusted data and
 * this code decides what any of it means. An item is dropped, not repaired, when any check fails:
 *
 * - the snippet handle must be one this call showed;
 * - `quote` must be an exact substring of the text the model saw for that snippet;
 * - `promiser` must be the snippet's author. Other people's words never create a promise by the
 *   owner ("you promised to wire the money"), and the owner's own words may report what someone
 *   else promised only in chat and meeting notes;
 * - `same_as` must be a handle this call gave, **to the same counterpart group**, and the promiser
 *   must be the side that made that promise;
 * - `what` is at most 120 characters, one line, plain, not instruction-shaped, not sensitive, and
 *   at least 60% of its content words are in the quote (a quote with none never passes).
 *
 * Whatever passes still goes through `PromiseStore.add`, which makes anything from another person
 * `suggested`. Nothing here calls a model, a tool or the network.
 */

export const MAX_WHAT_CHARS = 120;
export const MAX_PROMISE_QUOTE_CHARS = 200;

export interface AcceptedItem {
  snippet: LaneSnippet;
  kind: PromiseLaneItem["kind"];
  /** The open promise this mention belongs to or updates. */
  sameAs?: { loopId: string; promise: OpenPromise };
  promiser: "owner" | "counterpart";
  what: string;
  action: PromiseLaneItem["action"];
  quote: string;
  due: ParsedDue & { text: string | null };
  update: { type: NonNullable<PromiseLaneItem["update"]["type"]>; newDue: string | null } | null;
  confidence: number;
}

export interface ValidationResult {
  accepted: AcceptedItem[];
  dropped: Record<string, number>;
}

/** A `what` that is safe to store and show, or the reason it is not. */
export function whatProblem(what: string): string | undefined {
  if (what === "") return "what_empty";
  if (what.length > MAX_WHAT_CHARS) return "what_too_long";
  if (/[\r\n\u2028\u2029]/.test(what)) return "what_multiline";
  if (/[<>{}`]/.test(what)) return "what_markup";
  if (hasHiddenChars(what)) return "what_hidden_chars";
  if (looksLikeInstruction(what)) return "what_instruction";
  if (detectSensitive(what).some((k) => k !== "health")) return "what_sensitive";
  return undefined;
}

/** Light folding so "sending", "sends" and "send" meet. CJK bigrams are left alone. */
function stem(w: string): string {
  if (w.length <= 4 || /[^\p{Script=Latin}\p{N}]/u.test(w)) return w;
  return w.replace(/(?:ing|ed|es|s)$/u, "");
}

/** A negation in the text. It is a content word here: "do not send" is not "send". */
const NEGATION =
  /(?<![\p{L}\p{N}])(?:not|no|never|cannot|(?:don|doesn|won|can|isn|aren|didn)['’]?t)(?![\p{L}\p{N}])/iu;
const NEG = "\u0000neg";

const stems = (text: string): Set<string> => {
  const out = new Set([...contentWords(text)].map(stem));
  if (NEGATION.test(text.normalize("NFKC"))) out.add(NEG);
  return out;
};

/** Share of `what`'s content words that must also be in the quote. */
export const MIN_WHAT_COVERAGE = 0.6;
/** Content words of `what` that may be missing from the quote. */
export const MAX_UNCOVERED_WORDS = 1;

/**
 * What the promise says must come from the quote. A quote with no content words ("I'll", "to the")
 * supports nothing, so it never passes. Otherwise at least 60% of `what`'s content words must be
 * in the quote: a model steered by other text cannot swap a different promise in under the
 * owner's innocent sentence.
 */
function coverageProblem(what: string, quote: string): string | undefined {
  const q = stems(quote);
  if (q.size === 0) return "quote_no_content";
  const w = stems(what);
  if (w.size === 0) return "what_no_content";
  // A promise the quote does not negate cannot be a negated one.
  if (w.has(NEG) && !q.has(NEG)) return "what_negation";
  let hit = 0;
  for (const word of w) if (q.has(word)) hit += 1;
  // At most one word may come from somewhere other than the quote ("the Q3 deck"), and no more
  // than 40% overall.
  if (w.size - hit > MAX_UNCOVERED_WORDS) return "what_not_in_quote";
  return hit / w.size >= MIN_WHAT_COVERAGE ? undefined : "what_not_in_quote";
}

export function validateLaneOutput(
  output: PromiseLaneOutput,
  prompt: BuiltPrompt,
  options: { timeZone: string },
): ValidationResult {
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const accepted: AcceptedItem[] = [];
  for (const item of output.items) {
    const snippet = prompt.snippets.get(item.snippet);
    const shown = prompt.shown.get(item.snippet);
    const group = prompt.groupOf.get(item.snippet);
    if (snippet === undefined || shown === undefined || group === undefined) {
      drop("unknown_snippet");
      continue;
    }
    if (item.confidence < STORE_MIN_CONFIDENCE) {
      drop("low_confidence");
      continue;
    }
    const quote = item.quote.replace(/\s+/g, " ").trim();
    if (quote.length < 3 || quote.length > MAX_PROMISE_QUOTE_CHARS) {
      drop("quote_length");
      continue;
    }
    if (!shown.includes(quote)) {
      drop("quote_not_in_snippet");
      continue;
    }
    if (looksLikeInstruction(quote)) {
      drop("quote_instruction");
      continue;
    }
    if (item.promiser === item.promisee) {
      // A promise to oneself, or to someone who is not in the conversation: the form has no slot
      // for a third person, so the model marks it this way when it cannot name who is owed.
      drop("promisee_not_in_conversation");
      continue;
    }
    const reported =
      snippet.author === "owner" && snippet.reportsOthers && item.promiser === "counterpart";
    if (item.promiser !== snippet.author && !reported) {
      drop("promiser_not_author");
      continue;
    }
    // Only spaces and tabs are collapsed: a line break in `what` is itself a reason to drop it.
    const what = item.what.trim().replace(/[ \t]+/g, " ");
    const problem = whatProblem(what);
    if (problem !== undefined) {
      drop(problem);
      continue;
    }
    const coverage = coverageProblem(what, quote);
    if (coverage !== undefined) {
      drop(coverage);
      continue;
    }

    let sameAs: AcceptedItem["sameAs"];
    if (item.kind === "new") {
      if (item.same_as !== null || item.update.type !== null) {
        drop("shape_new");
        continue;
      }
    } else {
      const known = item.same_as === null ? undefined : prompt.promises.get(item.same_as);
      if (known === undefined) {
        drop("unknown_same_as");
        continue;
      }
      if (known.group !== group) {
        drop("same_as_other_group");
        continue;
      }
      if (known.promise.promiser !== item.promiser) {
        drop("same_as_wrong_side");
        continue;
      }
      sameAs = { loopId: known.promise.id, promise: known.promise };
      if (item.kind === "same_as" && item.update.type !== null) {
        drop("shape_same_as");
        continue;
      }
      if (item.kind === "update" && item.update.type === null) {
        drop("shape_update");
        continue;
      }
    }
    let update: AcceptedItem["update"] = null;
    if (item.update.type !== null) {
      const needsDue =
        item.update.type === "renegotiate_proposed" || item.update.type === "renegotiate_agreed";
      if (needsDue && item.update.new_due === null) {
        drop("update_no_date");
        continue;
      }
      update = { type: item.update.type, newDue: item.update.new_due };
    }
    const sentAt = Date.parse(snippet.sentAt);
    const due = resolveDue(item.due, Number.isNaN(sentAt) ? Date.now() : sentAt, options.timeZone);
    accepted.push({
      snippet,
      kind: item.kind,
      ...(sameAs === undefined ? {} : { sameAs }),
      promiser: item.promiser,
      what,
      action: item.action,
      quote,
      due,
      update,
      confidence: item.confidence,
    });
  }
  return { accepted, dropped };
}
