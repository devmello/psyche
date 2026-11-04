import { APPLE_LLM_MAX_INPUT_CHARS, APPLE_ON_DEVICE_REF } from "@psyche/protocol";
import {
  EXTRACT_OWNER_WORK_ADDENDUM,
  EXTRACT_SYSTEM_PROMPT,
  EXTRACT_THIRD_PARTY_ABOUT_OTHERS_ADDENDUM,
  EXTRACT_THIRD_PARTY_PROMPT,
} from "./prompt.ts";

/**
 * Sizing for a model with a small context window (EM11: Apple's on-device model, about 4,096
 * tokens for the prompt and the answer together; docs/design/search-roadmap-2026.md §13). Pure.
 * The cloud path keeps its own larger limits; these apply only when a `ModelChoice` carries a
 * `window`. A batch that does not fit is split, and one item that cannot fit alone is skipped with
 * a recorded reason: text is never cut, and nothing is sent to another model instead.
 */

/** The reasons a window-limited call did nothing, as they appear in the run's drop counts. */
export type WindowSkipReason =
  | "item_too_long_for_window"
  | "model_unavailable"
  | "model_guardrail"
  | "model_too_long"
  | "model_failed";

export interface ModelWindow {
  /** Prompt and answer together. */
  contextTokens: number;
}

/** The ref the owner can pick as a per-source extraction model (EM11). */
export const isAppleOnDeviceRef = (ref: string | undefined): boolean => ref === APPLE_ON_DEVICE_REF;

/** Output reserved inside the window for the JSON answer. */
export const WINDOW_OUTPUT_TOKENS = 600;
/** Candidate list and per-call framing the prompt adds around the items. */
const FRAME_TOKENS = 200;
/** The estimate is four characters a token; dense text runs closer to three, so be careful. */
const CHARS_PER_TOKEN = 3;
/** Tokens a `<data …>` wrapper adds to one item. */
const ITEM_FRAME_TOKENS = 30;

/** Estimated window cost of one item's text, on the careful (three characters a token) scale. */
export const windowItemTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN) + ITEM_FRAME_TOKENS;

const systemTokens = (): number =>
  Math.ceil(
    Math.max(
      EXTRACT_SYSTEM_PROMPT.length + EXTRACT_OWNER_WORK_ADDENDUM.length,
      EXTRACT_THIRD_PARTY_PROMPT.length + EXTRACT_THIRD_PARTY_ABOUT_OTHERS_ADDENDUM.length,
    ) / CHARS_PER_TOKEN,
  );

export interface WindowPlan {
  /** Most item tokens one call may carry. */
  maxBatchTokens: number;
  /** The same limit for a single item: an item over it is skipped. */
  maxItemTokens: number;
  maxOutputTokens: number;
  /** Characters allowed in one prompt field (the helper refuses more). */
  maxPromptChars: number;
}

export function windowPlan(window: ModelWindow): WindowPlan {
  const room = window.contextTokens - systemTokens() - FRAME_TOKENS - WINDOW_OUTPUT_TOKENS;
  const byChars = Math.floor(APPLE_LLM_MAX_INPUT_CHARS / CHARS_PER_TOKEN) - FRAME_TOKENS;
  const maxBatchTokens = Math.max(0, Math.min(room, byChars));
  return {
    maxBatchTokens,
    maxItemTokens: maxBatchTokens,
    maxOutputTokens: WINDOW_OUTPUT_TOKENS,
    maxPromptChars: APPLE_LLM_MAX_INPUT_CHARS,
  };
}

/** What a helper or router refusal means for the batch: the job does nothing and records this. */
export function skipReasonFor(kind: string | undefined): WindowSkipReason {
  switch (kind) {
    case "model_not_found":
      return "model_unavailable";
    case "content_filter":
      return "model_guardrail";
    case "context_overflow":
      return "model_too_long";
    default:
      return "model_failed";
  }
}
