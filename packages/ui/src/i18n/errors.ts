import { PsycheError } from "@psyche/protocol";
import { GatewayRequestError } from "../data/client.ts";
import { activeI18n, type I18n, isMessageId } from "./core.ts";

/** The Gateway's `details.reason` of an error, when it names one. */
function errorReason(err: unknown): string | null {
  if (!(err instanceof GatewayRequestError || err instanceof PsycheError)) return null;
  const details = err.details;
  if (typeof details !== "object" || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/**
 * The Gateway's per-device model budget (`details.reason: "model_budget"`, `retryAfterMs`): the
 * whole minutes to wait, at least one, or null for any other error.
 */
export function modelBudgetMinutes(err: unknown): number | null {
  const ms = modelBudgetRetryMs(err);
  return ms === null ? null : Math.max(1, Math.ceil(ms / 60_000));
}

/** The milliseconds until the model budget has room again (a minute when the Gateway gave none), or null. */
export function modelBudgetRetryMs(err: unknown): number | null {
  if (errorReason(err) !== "model_budget") return null;
  const details = (err as { details?: { retryAfterMs?: unknown } }).details;
  const ms = Number(details?.retryAfterMs);
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/** The error code of a Gateway error (a request error or a `PsycheError`), else null. */
export function errorCode(err: unknown): string | null {
  if (err instanceof GatewayRequestError || err instanceof PsycheError) return err.code;
  return null;
}

/**
 * What the UI says about an error, through the catalogue (`errors.<code>`).
 *
 * The Gateway writes its messages in English and often names the exact cause ("maxTokens is
 * above the model's window (200000)"). While the message locale is English that message is
 * shown as is; in any other language the code's catalogue sentence is shown instead. Errors
 * without a code (network, programming) say `errors.unknown` outside English.
 */
export function describeError(err: unknown): string {
  const i18n = activeI18n();
  const code = errorCode(err);
  // A device that used its model budget is told how long to wait, in every language (English
  // included: the number comes from the details, as in every other language).
  const minutes = modelBudgetMinutes(err);
  if (minutes !== null) return i18n.t("errors.reason.model_budget", { minutes });
  const detail = err instanceof Error ? err.message.trim() : typeof err === "string" ? err : "";
  if (i18n.messageLocale === "en" && detail) return detail;
  // A reason the catalogue has a sentence for says more than the code does ("updating").
  const reason = errorReason(err);
  const reasonId = reason === null ? null : `errors.reason.${reason}`;
  if (reasonId !== null && isMessageId(reasonId)) return i18n.t(reasonId);
  const id = code === null ? null : `errors.${code}`;
  return id !== null && isMessageId(id) ? i18n.t(id) : i18n.t("errors.unknown");
}

/** The catalogue sentence for an error's code, ignoring the Gateway's own message. */
export function errorSummary(err: unknown): string {
  const minutes = modelBudgetMinutes(err);
  if (minutes !== null) return activeI18n().t("errors.reason.model_budget", { minutes });
  const code = errorCode(err);
  const reason = errorReason(err);
  const reasonId = reason === null ? null : `errors.reason.${reason}`;
  if (reasonId !== null && isMessageId(reasonId)) return activeI18n().t(reasonId);
  const id = code === null ? null : `errors.${code}`;
  return id !== null && isMessageId(id) ? activeI18n().t(id) : activeI18n().t("errors.unknown");
}

/**
 * The catalogue sentence for a bare reason or code a record kept (a connector's
 * `lastSync.error` is `unavailable`, `timeout`, or a helper reason such as `automation_denied`),
 * reason first; null when the catalogue has neither, so the caller shows what it has.
 */
export function codeSentence(codeOrReason: string, i18n: I18n = activeI18n()): string | null {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(codeOrReason)) return null;
  for (const id of [`errors.reason.${codeOrReason}`, `errors.${codeOrReason}`]) {
    if (isMessageId(id)) return i18n.t(id);
  }
  return null;
}

/**
 * What a run step's error says: the sentence for its machine `details.reason` in the owner's
 * language, else the connector's own `message` (an older Gateway sends no reason, and a reason
 * the catalogue has no sentence for falls back too).
 */
export function stepErrorText(error: {
  code?: string;
  retryable?: boolean;
  message: string;
  details?: { reason?: string | undefined } | undefined;
}): string {
  const reason = error.details?.reason;
  return (reason === undefined ? null : codeSentence(reason)) ?? error.message;
}

/** A source status line's reason in words, else the Gateway's English `detail`. */
export function reasonText(reason: string | undefined, fallback: string): string {
  return (reason === undefined ? null : codeSentence(reason)) ?? fallback;
}
