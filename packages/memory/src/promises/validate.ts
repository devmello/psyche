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
 *   shares a content word with the quote.
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

function shareWord(a: string, b: string): boolean {
  const wa = contentWords(a);
  const wb = contentWords(b);
  // Nothing to compare (all stopwords): the quote check already ties it to the snippet.
  if (wa.size === 0 || wb.size === 0) return true;
  for (const w of wa) if (wb.has(w)) return true;
  return false;
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
    if (!shareWord(what, quote)) {
      drop("what_not_in_quote");
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
