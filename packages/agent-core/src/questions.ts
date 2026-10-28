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

/** Keyed by question `header`, as on the wire (`questions.answer`); multi-select → array. */
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
    const header = q.header.trim();
    if (header === "") invalid("headers may not be blank");
    if (seen.has(header)) invalid(`duplicate header: ${header} (answers are keyed by header)`);
    seen.add(header);
    const labels = new Set<string>();
    for (const o of q.options) {
      const label = o.label.trim().toLowerCase();
      if (label === "other")
        invalid(`"${q.header}": the UI adds "Other" itself; remove that option`);
      if (labels.has(label)) invalid(`"${q.header}": duplicate option ${o.label}`);
      labels.add(label);
      if (o.preview !== undefined) {
        if (o.preview.length > PREVIEW_MAX)
          invalid(`"${q.header}": preview over ${PREVIEW_MAX} chars`);
        if (UNSAFE_PREVIEW.test(o.preview)) {
          invalid(`"${q.header}": previews may not contain scripts, styles, frames or a doctype`);
        }
      }
    }
    const recommended = q.options.filter((o) => RECOMMENDED.test(o.label));
    const rest = q.options.filter((o) => !RECOMMENDED.test(o.label));
    return { ...q, header, question: q.question.trim(), options: [...recommended, ...rest] };
  });
}

/**
 * Check an answer against the questions: keys are question headers, single-select answers are
 * strings, multi-select answers are string arrays. Any text is accepted (the "Other" row).
 */
export function validateAnswer(questions: readonly Question[], answer: QuestionAnswer): void {
  const byHeader = new Map(questions.map((q) => [q.header, q]));
  for (const key of Object.keys(answer)) {
    if (!byHeader.has(key)) invalid(`answer for an unknown question: ${key}`);
  }
  for (const q of questions) {
    const a = answer[q.header];
    if (a === undefined) invalid(`missing answer for: ${q.header}`);
    if (q.multiSelect) {
      if (!Array.isArray(a) || a.some((x) => typeof x !== "string")) {
        invalid(`"${q.header}" is multi-select: answer with a list`);
      }
    } else if (typeof a !== "string" || a.length === 0) {
      invalid(`"${q.header}" takes one answer`);
    }
  }
}

/**
 * The owner typed a message in the chat while the question was open: the typed text is the
 * answer, and `ask_user` hands it to the model as such (the turn goes on with it).
 */
export interface ChatReply {
  answeredInChat: true;
  text: string;
}

/** `invalidatedReason` of an approval the owner closed by replying in the chat (see the broker). */
export const OWNER_REPLIED_IN_CHAT = "owner_replied_in_chat";

/** What the model reads when a card was declined because the owner replied in the chat. */
export function declinedInChatNote(text: string): string {
  return `denied: the owner replied in chat instead of answering this card, so it was not approved. Their message, which is their new instruction: ${JSON.stringify(text)}`;
}
