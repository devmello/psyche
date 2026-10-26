import type { RunStep } from "@psyche/protocol";
import { CircleAlert } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { stepLabel } from "./model.ts";

/**
 * The diagnosis under a failed run's header (docs/design/run-trace-2026.md §3.3, voice.md rule 4):
 * what happened, what Psyche did, what you can do. Built from the failed step's error; an
 * authorisation error offers Reconnect when the shell can open the account.
 */

const AUTH_CODES = /^(auth|unauthori[sz]ed|forbidden|401|403|token_expired|reauth)/i;

export function isAuthError(step: RunStep): boolean {
  const e = step.error;
  return e !== undefined && (AUTH_CODES.test(e.code) || /\b40[13]\b/.test(e.message));
}

export interface FailureBannerProps {
  step: RunStep;
  onRetry?: () => void;
  /** Opens the connector behind an authorisation failure. */
  onReconnect?: () => void;
  onShowStep?: () => void;
}

export function FailureBanner({
  step,
  onRetry,
  onReconnect,
  onShowStep,
}: FailureBannerProps): ReactElement {
  const tries = (step.attempts?.length ?? 0) + 1;
  const auth = isAuthError(step) && onReconnect !== undefined;
  const label = step.label;
  return (
    <section
      aria-label={t("agent.timeline.failure.label")}
      className="flex gap-2.5 rounded-lg bg-danger-surface px-3 py-2.5 text-callout"
      data-testid="failure-banner"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
      <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-label-secondary">{t("agent.timeline.failure.happened")}</dt>
        <dd className="min-w-0 text-label-primary">
          {onShowStep ? (
            <button
              type="button"
              className="text-start underline-offset-2 hover:underline"
              onClick={onShowStep}
            >
              {t("agent.timeline.failure.message", {
                step: label,
                message: step.error?.message ?? stepLabel(step),
              })}
            </button>
          ) : (
            t("agent.timeline.failure.message", {
              step: label,
              message: step.error?.message ?? stepLabel(step),
            })
          )}
        </dd>
        <dt className="text-label-secondary">{t("agent.timeline.failure.did")}</dt>
        <dd className="text-label-primary">
          {tries > 1
            ? t("agent.timeline.failure.retried", { n: tries })
            : t("agent.timeline.failure.stopped")}
        </dd>
        <dt className="text-label-secondary">{t("agent.timeline.failure.can")}</dt>
        <dd className="flex flex-wrap items-center gap-2 text-label-primary">
          <span>
            {auth ? t("agent.timeline.failure.canReconnect") : t("agent.timeline.failure.canRetry")}
          </span>
          {auth ? (
            <Button size="xs" variant="outline" onClick={onReconnect}>
              {t("agent.timeline.failure.reconnect")}
            </Button>
          ) : null}
          {onRetry ? (
            <Button size="xs" variant={auth ? "ghost" : "outline"} onClick={onRetry}>
              {t("agent.timeline.retry")}
            </Button>
          ) : null}
        </dd>
      </dl>
    </section>
  );
}
