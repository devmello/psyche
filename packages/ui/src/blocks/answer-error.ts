import { t } from "../i18n/core.ts";
import { describeError, errorCode } from "../i18n/errors.ts";

/** What went wrong answering a card, in the words the card shows. */
export type AnswerFailure =
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "presence_unavailable" }
  | { kind: "presence_failed"; reason: string | null }
  | { kind: "other"; text: string };

function detailsOf(err: unknown): Record<string, unknown> {
  const d = (err as { details?: unknown } | null)?.details;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

/** Classifies an `approvals.answer` failure; presence and rate-limit failures get their own UI. */
export function classifyAnswerError(err: unknown): AnswerFailure {
  const code = errorCode(err);
  const details = detailsOf(err);
  if (code === "rate_limited") {
    const n = Number(details.retryAfterSec);
    return { kind: "rate_limited", retryAfterSec: Number.isFinite(n) && n > 0 ? Math.ceil(n) : 60 };
  }
  if (code === "forbidden" && details.reason === "presence_required") {
    return { kind: "presence_unavailable" };
  }
  if (code === "forbidden" && details.reason === "presence_invalid") {
    return { kind: "presence_failed", reason: t("blocks.approval.touchIdInvalid") };
  }
  // The host's own presence step (Touch ID prompt) threw: cancelled, no key, no entitlement.
  const detail = err instanceof Error ? err.message.trim() : "";
  if ((err as { name?: unknown } | null)?.name === "PresenceError") {
    return { kind: "presence_failed", reason: detail === "" ? null : detail };
  }
  return { kind: "other", text: describeError(err) };
}

/** The sentence under the card for a failure (the countdown form of rate limits is separate). */
export function answerFailureText(f: AnswerFailure, secondsLeft?: number): string {
  switch (f.kind) {
    case "rate_limited":
      return t("blocks.approval.rateLimited", { seconds: secondsLeft ?? f.retryAfterSec });
    case "presence_unavailable":
      return t("settings.approval.presenceUnavailable");
    case "presence_failed":
      return f.reason === null
        ? t("blocks.approval.touchIdFailedNoReason")
        : t("blocks.approval.touchIdFailed", { reason: f.reason });
    case "other":
      return f.text;
  }
}
