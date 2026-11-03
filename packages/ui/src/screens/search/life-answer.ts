import type { LifeFactHit } from "@psyche/protocol";
import { useEffect, useState } from "react";
import { useGatewayQuery } from "../../data/hooks.ts";

/**
 * The logic behind the answer card (docs/roadmap/future-features.md §1): when a query reads like
 * a question, what to ask, and how to read `memory.life.answer` back into claims that each carry
 * the facts they rest on. Nothing here renders; the card is `LifeAnswerCard.tsx`.
 */

const WH = /^(who|whom|whose|what|what's|whats|when|where|why|how|which)\b/i;
const AUX = /^(did|do|does|is|are|was|were|can|could|should|will|would|has|have|had)\b/i;

/**
 * True when the text reads like a question about the owner's life: a question mark, or a leading
 * question word. Short queries are never questions ("sam", "how to"). English only for now.
 */
export function looksLikeQuestion(text: string): boolean {
  const q = text.trim();
  if (q.length < 6 || q.length > 500) return false;
  const words = q.split(/\s+/).length;
  if (words < 3) return false;
  if (q.endsWith("?")) return true;
  if (WH.test(q)) return true;
  return words >= 4 && AUX.test(q);
}

/** One claim of an answer and the facts it rests on, in the order they were cited. */
export interface AnswerClaim {
  text: string;
  facts: LifeFactHit[];
}

const MARKERS = /((?:\s*\[\d{1,2}\])+)/g;
const NUMBER = /\[(\d{1,2})\]/g;

/**
 * Splits an answer at its `[n]` markers (`n` counts `facts`; the first fact is `[1]`). A claim is
 * the text before a run of markers; text with no marker after it, and markers that name no fact,
 * are dropped: no citation, no claim. An empty list means the answer has nothing to show.
 */
export function groundedClaims(
  answer: string | null | undefined,
  facts: readonly LifeFactHit[],
): AnswerClaim[] {
  if (answer == null || facts.length === 0) return [];
  const claims: AnswerClaim[] = [];
  let last = 0;
  for (const m of answer.matchAll(MARKERS)) {
    const start = m.index ?? 0;
    const before = answer
      .slice(last, start)
      .replace(/^[\s.!?;,]+/, "")
      .trim();
    last = start + m[0].length;
    const cited = new Set<LifeFactHit>();
    for (const n of m[0].matchAll(NUMBER)) {
      const fact = facts[Number(n[1]) - 1];
      if (fact !== undefined) cited.add(fact);
    }
    if (before === "" || cited.size === 0) continue;
    const end = /^[.!?]/.exec(answer.slice(last))?.[0] ?? "";
    claims.push({ text: before + end, facts: [...cited] });
  }
  return claims;
}

const when = (f: LifeFactHit): number => {
  const t = Date.parse(f.learnedAt ?? f.observedAt ?? "");
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first (when Psyche learned it, else when the source was written); ties keep order. */
export function newestFirst(facts: readonly LifeFactHit[]): LifeFactHit[] {
  return facts
    .map((f, i) => ({ f, i }))
    .sort((a, b) => when(b.f) - when(a.f) || a.i - b.i)
    .map((x) => x.f);
}

/** True when two of the facts give the same person's same attribute different values. */
export function factsDisagree(facts: readonly LifeFactHit[]): boolean {
  const seen = new Map<string, string>();
  for (const f of facts) {
    const key = `${f.entity.id}\u0000${f.attribute}`;
    const value = f.value.trim().toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined && prior !== value) return true;
    seen.set(key, value);
  }
  return false;
}

/** Wait before a question is sent to the model: longer while it may still be typed. */
const ASK_AFTER_MS = 800;
const ASK_AFTER_QUESTION_MARK_MS = 250;

export type LifeAnswerPhase = "idle" | "loading" | "done" | "error";

/**
 * Asks `memory.life.answer` on its own for a settled query that reads like a question, after a
 * short wait so a half-typed question is not sent; for anything else the owner asks by button.
 * `question` is empty while the answer is not on offer (a filter is in the query).
 */
export function useLifeAnswer(question: string) {
  const offered = question.length >= 2;
  const auto = offered && looksLikeQuestion(question);
  const [asked, setAsked] = useState("");
  const [autoFor, setAutoFor] = useState("");
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(
      () => setAutoFor(question),
      question.endsWith("?") ? ASK_AFTER_QUESTION_MARK_MS : ASK_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [auto, question]);
  const active = offered && (asked === question || (auto && autoFor === question));
  const query = useGatewayQuery("memory.life.answer", { q: question }, { enabled: active });
  const phase: LifeAnswerPhase = !active
    ? auto
      ? "loading"
      : "idle"
    : query.error
      ? "error"
      : query.data
        ? "done"
        : "loading";
  return {
    offered,
    auto,
    phase,
    result: active ? query.data : undefined,
    ask: () => setAsked(question),
  };
}
