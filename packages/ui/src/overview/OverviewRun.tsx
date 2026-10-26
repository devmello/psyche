import { ArrowLeft } from "lucide-react";
import type { ReactElement } from "react";
import { RunTimelineFor } from "../agent/ActivityPanel.tsx";
import { Button } from "../components/ui/button.tsx";
import { t } from "../i18n/core.ts";
import { usePersona } from "../slots.tsx";
import { overviewRunHref } from "./recent.ts";

export interface OverviewRunProps {
  runId: string;
  /** `?step=`: open on this step. */
  stepId?: string;
  /** "← {persona} & you": back to the Overview. */
  onBack: () => void;
  /** A helper run's own Timeline. */
  onOpenRun?: (runId: string) => void;
  now?: number;
}

/**
 * `/overview/run/<id>[?step=]` (agent-overview-2026 §3, §5.4): the run's Timeline replaces the
 * page body at the full width the waterfall needs, under a "← {persona} & you" back link.
 */
export function OverviewRun({
  runId,
  stepId,
  onBack,
  onOpenRun,
  now,
}: OverviewRunProps): ReactElement {
  const persona = usePersona();
  return (
    <div
      className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-3 px-4 py-3 md:px-6"
      data-testid="overview-run"
      data-run-id={runId}
    >
      <div>
        <Button variant="ghost" size="sm" className="-ms-2" onClick={onBack}>
          <ArrowLeft aria-hidden="true" className="rtl:rotate-180" />
          {t("overview.title", { name: persona.name })}
        </Button>
      </div>
      <RunTimelineFor
        key={runId}
        runId={runId}
        linkFor={(id, step) => overviewRunHref(id, step ? { stepId: step } : {})}
        {...(stepId ? { stepId } : {})}
        {...(onOpenRun ? { onOpenRun } : {})}
        {...(now === undefined ? {} : { now })}
      />
    </div>
  );
}
