import type { FeedbackEvent, Lesson } from "@psyche/protocol";

/**
 * Confidence (docs/agent/teaching-loop-2026.md §3.3): simple, explainable, shown as words.
 *
 * | Evidence                                               | Confidence |
 * | ------------------------------------------------------ | ---------- |
 * | an explicit correction                                 | 0.9        |
 * | "Not like this" with a reason chip, or a redo          | 0.6        |
 * | one implicit signal (heavy edit, undo, dismissal)      | 0.3        |
 * | the same implicit signal 3 times in 30 days            | 0.5        |
 * | the owner accepts the lesson                           | 1.0        |
 *
 * A lesson is written at 0.6 or more, which only explicit feedback reaches; "helpful" never
 * creates a lesson (sycophancy), it only confirms one a correction taught.
 */

export const CONFIDENCE = {
  correction: 0.9,
  feedback: 0.6,
  implicit: 0.3,
  repeated: 0.5,
  confirmed: 1,
} as const;

/** Below this a lesson is evidence, never a write. */
export const WRITE_THRESHOLD = 0.6;
/** What "helpful" adds to a lesson it used (never past `confirmed`). */
export const HELPFUL_BOOST = 0.05;

const EXPLICIT = new Set(["correction", "not_helpful", "regenerated"]);

/** The confidence a lesson made from this one event would have. */
export function confidenceFor(
  event: Pick<FeedbackEvent, "kind" | "text" | "reason">,
): number | undefined {
  if (event.kind === "helpful") return undefined;
  const text = (event.text ?? "").trim();
  const reason = event.reason ?? null;
  if (event.kind === "correction" && text !== "") {
    return CONFIDENCE.correction;
  }
  if (event.kind === "not_helpful") {
    // "What should I do instead?" filled in counts as a correction.
    if (text !== "") return CONFIDENCE.correction;
    return reason !== null ? CONFIDENCE.feedback : undefined;
  }
  if (event.kind === "regenerated" && text !== "") {
    return CONFIDENCE.feedback;
  }
  if (event.kind === "correction") return undefined;
  return CONFIDENCE.implicit;
}

/** Explicit feedback the router may turn into a lesson; implicit kinds stay evidence. */
export function mayTeach(event: Pick<FeedbackEvent, "kind" | "text" | "reason">): boolean {
  if (!EXPLICIT.has(event.kind)) return false;
  return (confidenceFor(event) ?? 0) >= WRITE_THRESHOLD;
}

export type ConfidenceWords = "You told me" | "From your feedback" | "Noticed" | "You confirmed";

/** The provenance words a lesson is shown with (§8 "Provenance words"). */
export function confidenceWords(lesson: Pick<Lesson, "confidence" | "origin">): ConfidenceWords {
  if (lesson.confidence >= CONFIDENCE.confirmed) return "You confirmed";
  if (lesson.origin === "inferred") return "Noticed";
  if (lesson.confidence >= CONFIDENCE.correction) return "You told me";
  return "From your feedback";
}
