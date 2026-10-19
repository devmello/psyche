import { PsycheError, Question } from "@psyche/protocol";
import { type Static, Type } from "@sinclair/typebox";

/**
 * `ask_user` input (feature C4; Claude `AskUserQuestion`): 1–4 questions, 2–4 options each,
 * header ≤ 12 characters, multi-select, optional previews. The UI always adds an "Other" row
 * for free text, so options must not include one. An option whose label ends with
 * "(Recommended)" is moved first.
 */
export const AskUserInput = Type.Object(
  { questions: Type.Array(Question, { minItems: 1, maxItems: 4 }) },
  { additionalProperties: false },
);
export type AskUserInput = Static<typeof AskUserInput>;

export type QuestionAnswer = Record<string, string | string[]>;

const RECOMMENDED = /\(recommended\)\s*$/i;
const UNSAFE_PREVIEW = /<\s*(script|style|iframe|object|embed)\b|<!doctype/i;
const PREVIEW_MAX = 8_000;

function invalid(message: string): never {
  throw new PsycheError("invalid_params", message);
}

/** Validate beyond the schema and put recommended options first. */
export function normalizeQuestions(input: AskUserInput): Question[] {
  const seen = new Set<string>();
  return input.questions.map((q) => {
    const key = q.question.trim();
    if (seen.has(key)) invalid(`duplicate question: ${key}`);
    seen.add(key);
    const labels = new Set<string>();
    for (const o of q.options) {
      const label = o.label.trim().toLowerCase();
      if (label === "other") invalid(`"${q.header}": the UI adds "Other" itself; remove that option`);
      if (labels.has(label)) invalid(`"${q.header}": duplicate option ${o.label}`);
      labels.add(label);
      if (o.preview !== undefined) {
        if (o.preview.length > PREVIEW_MAX) invalid(`"${q.header}": preview over ${PREVIEW_MAX} chars`);
        if (UNSAFE_PREVIEW.test(o.preview)) {
          invalid(`"${q.header}": previews may not contain scripts, styles, frames or a doctype`);
        }
      }
    }
    const recommended = q.options.filter((o) => RECOMMENDED.test(o.label));
    const rest = q.options.filter((o) => !RECOMMENDED.test(o.label));
    return { ...q, question: key, options: [...recommended, ...rest] };
  });
}

/**
 * Check an answer against the questions: keys are question texts, single-select answers are
 * strings, multi-select answers are string arrays. Any text is accepted (the "Other" row).
 */
export function validateAnswer(questions: readonly Question[], answer: QuestionAnswer): void {
  const byText = new Map(questions.map((q) => [q.question, q]));
  for (const key of Object.keys(answer)) {
    if (!byText.has(key)) invalid(`answer for an unknown question: ${key}`);
  }
  for (const q of questions) {
    const a = answer[q.question];
    if (a === undefined) invalid(`missing answer for: ${q.question}`);
    if (q.multiSelect) {
      if (!Array.isArray(a) || a.some((x) => typeof x !== "string")) {
        invalid(`"${q.header}" is multi-select: answer with a list`);
      }
    } else if (typeof a !== "string" || a.length === 0) {
      invalid(`"${q.header}" takes one answer`);
    }
  }
}
