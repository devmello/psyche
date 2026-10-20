import { PsycheError } from "@psyche/protocol";
import { GatewayRequestError } from "../data/client.ts";
import { activeI18n, isMessageId } from "./core.ts";

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
  const detail = err instanceof Error ? err.message.trim() : typeof err === "string" ? err : "";
  if (i18n.messageLocale === "en" && detail) return detail;
  const id = code === null ? null : `errors.${code}`;
  return id !== null && isMessageId(id) ? i18n.t(id) : i18n.t("errors.unknown");
}

/** The catalogue sentence for an error's code, ignoring the Gateway's own message. */
export function errorSummary(err: unknown): string {
  const code = errorCode(err);
  const id = code === null ? null : `errors.${code}`;
  return id !== null && isMessageId(id) ? activeI18n().t(id) : activeI18n().t("errors.unknown");
}
