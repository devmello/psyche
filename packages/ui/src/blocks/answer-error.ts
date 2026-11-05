import { t } from "../i18n/core.ts";
import { describeError, errorCode } from "../i18n/errors.ts";
import type { MessageId } from "../i18n/messages/index.ts";

/** What the card offers when Touch ID cannot confirm from this window (`touchIdFix` slot). */
export type TouchIdFix = "start_helper" | "open_devices";

/** `approvals.approveWithTouchId`'s `details.reason` when it cannot run. */
const TOUCH_ID_SETUP: Record<string, { id: MessageId; fix: TouchIdFix | null }> = {
  helper_offline: { id: "blocks.approval.touchId.helperOffline", fix: "start_helper" },
  helper_outdated: { id: "blocks.approval.touchId.helperOutdated", fix: null },
  // Registering a key happens in Settings → Devices, where the owner sees the key id first.
  no_presence_key: { id: "blocks.approval.touchId.noKey", fix: "open_devices" },
  presence_key_invalidated: { id: "blocks.approval.touchId.invalidated", fix: "open_devices" },
  presence_key_unavailable: { id: "blocks.approval.touchId.keyUnavailable", fix: null },
  // The helper's keychain key, found wrong or unusable (security §10).
  presence_key_untrusted: { id: "blocks.approval.touchId.keyUntrusted", fix: "open_devices" },
  presence_key_access_denied: { id: "blocks.approval.touchId.keyAccessDenied", fix: null },
  presence_key_changed: { id: "blocks.approval.touchId.keyChanged", fix: "start_helper" },
  presence_key_wrong_location: { id: "blocks.approval.touchId.keyWrongLocation", fix: null },
  presence_key_interaction_not_allowed: { id: "blocks.approval.touchId.keyLocked", fix: null },
  presence_key_acl_unavailable: { id: "blocks.approval.touchId.keyAclUnavailable", fix: null },
};

/** What went wrong answering a card, in the words the card shows. */
export type AnswerFailure =
  | { kind: "rate_limited"; retryAfterSec: number }
  | { kind: "presence_unavailable" }
  | { kind: "presence_failed"; reason: string | null }
  /** The window's Touch ID path is not ready: what is missing and the fix, when there is one. */
  | { kind: "touch_id_setup"; text: string; fix: TouchIdFix | null }
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
  const setup = code === "unavailable" ? TOUCH_ID_SETUP[String(details.reason)] : undefined;
  if (setup !== undefined) return { kind: "touch_id_setup", text: t(setup.id), fix: setup.fix };
  if (code === "cancelled") {
    return { kind: "presence_failed", reason: t("blocks.approval.touchId.cancelled") };
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
    case "touch_id_setup":
    case "other":
      return f.text;
  }
}
