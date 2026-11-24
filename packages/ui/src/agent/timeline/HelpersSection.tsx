import type { Run, RunSummary } from "@psyche/protocol";
import type { ReactElement } from "react";
import { StatusGlyph } from "../../components/status.tsx";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatTime } from "../../lib/format.ts";
import { tokens as formatTokens, usd } from "../../screens/settings/UsageSection.tsx";
import { runGlyph, runTitle, stateLabel } from "./RunHeader.tsx";

/**
 * The Helpers section of a run (run trace §3.3): the helper and specialist runs it spawned, one
 * row each with its title, kind, status word, spent against budget and deadline. A row opens that
 * run in the same Timeline. The section is hidden when the run has no helpers.
 */

/** Spent against the budget, in the dimension the budget limits (cost first, then tokens). */
function budgetText(run: RunSummary): string | null {
  const b = run.budget;
  if (!b) return null;
  if (b.limit.costUsd != null) {
    const spent = b.used.costUsd == null ? t("agent.timeline.unknown") : usd(b.used.costUsd);
    return t("agent.timeline.helpers.spent", { spent, budget: usd(b.limit.costUsd) });
  }
  if (b.limit.tokens != null) {
    return t("agent.timeline.helpers.spent", {
      spent: formatTokens(b.used.tokens),
      budget: formatTokens(b.limit.tokens),
    });
  }
  return null;
}

export interface HelpersSectionProps {
  helpers: readonly RunSummary[];
  /** The store's runs: a helper's live status (`run.updated`) reads from here. */
  runs: Readonly<Record<string, Run>>;
  error: string | null;
  onRetry: () => void;
  onOpen: (runId: string) => void;
}

export function HelpersSection({
  helpers,
  runs,
  error,
  onRetry,
  onOpen,
}: HelpersSectionProps): ReactElement | null {
  if (helpers.length === 0 && error === null) return null;
  return (
    <section
      aria-label={t("agent.timeline.helpers.title")}
      className="flex flex-col gap-1"
      data-testid="run-helpers"
    >
      <h3 className="px-2 text-callout font-medium text-label-secondary">
        {t("agent.timeline.helpers.title")}
      </h3>
      {error ? (
        <p role="alert" className="px-2 text-callout text-label-secondary">
          {t("agent.timeline.helpers.loadFailed", { reason: error })}{" "}
          <Button size="xs" variant="outline" onClick={onRetry}>
            {t("agent.activity.tryAgain")}
          </Button>
        </p>
      ) : null}
      <ul className="flex flex-col">
        {helpers.map((child) => {
          const status = runs[child.id]?.status ?? child.status;
          const spent = budgetText(child);
          const deadline = child.deadline
            ? t("agent.timeline.helpers.deadline", { time: formatTime(child.deadline) })
            : null;
          return (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => onOpen(child.id)}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-callout outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <StatusGlyph
                  status={runGlyph(status)}
                  label={stateLabel(status)}
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{runTitle(child)}</span>
                <span className="shrink-0 text-label-secondary">
                  {child.kind === "subagent"
                    ? t("agent.timeline.helpers.kind.subagent")
                    : t("agent.timeline.helpers.kind.other")}
                </span>
                <span className="shrink-0 text-label-secondary">{stateLabel(status)}</span>
                {spent ? (
                  <span className="shrink-0 text-label-secondary tabular-nums">{spent}</span>
                ) : null}
                {deadline ? (
                  <span className="shrink-0 text-label-secondary tabular-nums">{deadline}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
