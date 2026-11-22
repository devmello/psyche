import type { ReactElement } from "react";
import { LiveDuration } from "../components/steps/LiveDuration.tsx";
import { t } from "../i18n/core.ts";

/**
 * The look of a row that is blocked on the owner, wherever it appears (the run rail, the traced
 * run, the transcript's approval pointer and tool rows): an amber surface with a ring. Colour is
 * never the only signal: the row also carries the "Needs you" tag and the wait time.
 */
export const NEEDS_YOU_ROW = "rounded-md bg-approval-surface ring-1 ring-approval-border";

/** "Needs you" in amber, with how long it has waited when the start time is known (epoch ms). */
export function NeedsYouTag({
  since,
  now,
}: {
  since?: number | undefined;
  now?: number | undefined;
}): ReactElement {
  return (
    <>
      <span
        className="shrink-0 text-callout font-medium text-approval-text"
        data-testid="needs-you"
      >
        {t("chat.steps.needsYou")}
      </span>
      {since !== undefined && Number.isFinite(since) ? (
        <LiveDuration
          startedAt={since}
          {...(now === undefined ? {} : { now })}
          className="text-callout text-label-secondary"
        />
      ) : null}
    </>
  );
}
