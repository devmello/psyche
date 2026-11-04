import type { LifeAnswerPassage, LifeFactHit, MethodResult } from "@psyche/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";

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

/** One claim of an answer and the facts and passages it rests on, in the order they were cited. */
export interface AnswerClaim {
  text: string;
  facts: LifeFactHit[];
  passages: LifeAnswerPassage[];
}

const MARKERS = /((?:\s*\[(?:P\d{1,2}|\d{1,2})\])+)/g;
const NUMBER = /\[(P)?(\d{1,2})\]/g;

/**
 * Splits an answer at its markers (`[n]` is the nth fact, `[Pn]` the nth passage; the first of
 * each is 1). A claim is the text before a run of markers; text with no marker after it, and
 * markers that name nothing returned, are dropped: no citation, no claim. An empty list means the
 * answer has nothing to show.
 */
export function groundedClaims(
  answer: string | null | undefined,
  facts: readonly LifeFactHit[],
  passages: readonly LifeAnswerPassage[] = [],
): AnswerClaim[] {
  if (answer == null || facts.length + passages.length === 0) return [];
  const claims: AnswerClaim[] = [];
  let last = 0;
  for (const m of answer.matchAll(MARKERS)) {
    const start = m.index ?? 0;
    const before = answer
      .slice(last, start)
      .replace(/^[\s.!?;,]+/, "")
      .trim();
    last = start + m[0].length;
    const citedFacts = new Set<LifeFactHit>();
    const citedPassages = new Set<LifeAnswerPassage>();
    for (const n of m[0].matchAll(NUMBER)) {
      if (n[1] === "P") {
        const passage = passages[Number(n[2]) - 1];
        if (passage !== undefined) citedPassages.add(passage);
      } else {
        const fact = facts[Number(n[2]) - 1];
        if (fact !== undefined) citedFacts.add(fact);
      }
    }
    if (before === "" || citedFacts.size + citedPassages.size === 0) continue;
    const end = /^[.!?]/.exec(answer.slice(last))?.[0] ?? "";
    claims.push({ text: before + end, facts: [...citedFacts], passages: [...citedPassages] });
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

export type LifeAnswerResult = MethodResult<"memory.life.answer">;

/** A follow-up question under the answer, with its own answer. */
export interface FollowUpTurn {
  id: number;
  question: string;
  phase: LifeAnswerPhase;
  result?: LifeAnswerResult;
}

/** The most turns kept under one answer; the card is a panel, not a chat. */
export const MAX_FOLLOW_UPS = 5;

/**
 * Asks `memory.life.answer` on its own for a settled query that reads like a question, after a
 * short wait so a half-typed question is not sent; for anything else the owner asks by button.
 * `question` is empty while the answer is not on offer (a filter is in the query). A follow-up
 * sends the turn before it (question, answer and the ids it cited) so the Gateway reads those
 * again under this connection's rules; the answers themselves are never trusted as sources.
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
  // Typing never sends raw mail, messages or files to a model: the automatic answer reads
  // reviewed facts only. Passages go with an explicit "Answer from my mail, messages and files".
  const [deep, setDeep] = useState(false);
  const query = useGatewayQuery(
    "memory.life.answer",
    deep ? { q: question, passages: true } : { q: question },
    { enabled: active },
  );
  const phase: LifeAnswerPhase = !active
    ? auto
      ? "loading"
      : "idle"
    : query.error
      ? "error"
      : query.data
        ? "done"
        : "loading";
  const result = active ? query.data : undefined;

  const call = useCall();
  const [turns, setTurns] = useState<FollowUpTurn[]>([]);
  const next = useRef(1);
  // A new question starts a new conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the question only
  useEffect(() => {
    setTurns([]);
    setDeep(false);
  }, [question]);
  const followUp = useCallback(
    (text: string) => {
      const q = text.trim().slice(0, 500);
      const before = [...turns].reverse().find((x) => x.result?.answer != null);
      const base =
        before === undefined
          ? { q: question, result }
          : { q: before.question, result: before.result };
      if (q === "" || base.result?.answer == null || turns.length >= MAX_FOLLOW_UPS) return;
      const previous = {
        q: base.q.slice(0, 500),
        answer: base.result.answer,
        factIds: base.result.facts.map((f) => f.factId).slice(0, 12),
        passageIds: (base.result.passages ?? []).map((p) => p.id).slice(0, 8),
      };
      const id = next.current++;
      setTurns((all) => [...all, { id, question: q, phase: "loading" }]);
      const settle = (patch: Partial<FollowUpTurn>) =>
        setTurns((all) => all.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      call("memory.life.answer", { q, ...(deep ? { passages: true } : {}), previous }).then(
        (r) => settle({ phase: "done", result: r }),
        () => settle({ phase: "error" }),
      );
    },
    [call, deep, question, result, turns],
  );
  return {
    offered,
    auto,
    phase,
    result,
    ask: () => setAsked(question),
    turns,
    followUp,
    withPassages: deep,
    askPassages: () => setDeep(true),
  };
}
