import type { InputRequest } from "@psyche/protocol";

/**
 * Answers for `ask_user` questions a live model may raise mid-scenario (the scripted model never
 * asks). The scenario format has no field for them (tests/scenarios/schema.json forbids extra
 * `harness.live` keys), so they live here per scenario until S18 adds one. A rule matches a
 * question by its header or by a pattern on its text; the first matching rule answers it.
 *
 * Default when no rule matches: the first option (for a multi-select, a list with the first
 * option). The owner profile says Avery is decisive; the scenarios never hinge on the choice.
 */

export interface LiveAnswerRule {
  /** Exact question header (1–12 chars), as the model chose it. */
  header?: string;
  /** Pattern on the question text. */
  question?: RegExp;
  /** The option label(s) to answer with; a string for single-choice, a list for multi-select. */
  answer: string | string[];
}

export const LIVE_ANSWERS: Record<string, LiveAnswerRule[]> = {
  "v1-inbox-triage": [
    // "Maya asks two things; what should I tell her?": confirm the launch date, as the fixture
    // reply does (tests/scenarios/v1-inbox-triage/scenario.json, c_v1_draft_maya).
    { question: /launch|roadmap|maya/i, answer: "Confirm" },
  ],
  "v2-calendar-planning": [],
  "v7-research-brief": [],
};

export type QuestionAnswer = Record<string, string | string[]>;

/** Pick an option label that exists; a rule naming an unknown label falls back to the first. */
function optionLabel(q: InputRequest["questions"][number], wanted: string): string {
  const labels = q.options.map((o) => o.label);
  const hit =
    labels.find((l) => l === wanted) ??
    labels.find((l) => l.toLowerCase().includes(wanted.toLowerCase()));
  return hit ?? (labels[0] as string);
}

/** The answer for one input request and where it came from, per question. */
export function answerFor(
  scenario: string,
  request: Pick<InputRequest, "questions">,
  rules: LiveAnswerRule[] = LIVE_ANSWERS[scenario] ?? [],
): { answer: QuestionAnswer; sources: Record<string, "rule" | "default"> } {
  const answer: QuestionAnswer = {};
  const sources: Record<string, "rule" | "default"> = {};
  for (const q of request.questions) {
    const rule = rules.find(
      (r) =>
        (r.header !== undefined && r.header === q.header) || r.question?.test(q.question) === true,
    );
    const wanted = rule === undefined ? undefined : rule.answer;
    if (q.multiSelect) {
      const list = wanted === undefined ? [] : Array.isArray(wanted) ? wanted : [wanted];
      const labels = list.map((w) => optionLabel(q, w));
      answer[q.header] = labels.length > 0 ? [...new Set(labels)] : [q.options[0]?.label ?? ""];
    } else {
      const one = wanted === undefined ? undefined : Array.isArray(wanted) ? wanted[0] : wanted;
      answer[q.header] = one === undefined ? (q.options[0]?.label ?? "") : optionLabel(q, one);
    }
    sources[q.header] = rule === undefined ? "default" : "rule";
  }
  return { answer, sources };
}
