import type { Run } from "@psyche/protocol";
import { ChevronRight } from "lucide-react";
import * as m from "motion/react-m";
import { type ReactElement, useMemo, useState } from "react";
import { StatusGlyph } from "../../components/status.tsx";
import { formatStepDuration, LiveDuration } from "../../components/steps/LiveDuration.tsx";
import { useRun, useStoreState } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { fade, motionSpring, Presence, spring } from "../../motion/index.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { activeStep, lastEventAt, STALL_MS, summarizeRun, timelineRoute } from "./model.ts";
import { StepAnnouncer, StepList } from "./StepList.tsx";

const LIVE: readonly Run["status"][] = ["running", "awaiting_approval", "awaiting_input"];

/** True when the store knows steps for this run (the run-trace Gateway, #709). */
export function useHasTrace(runId: string | null): boolean {
  return useStoreState((s) => runId !== null && (s.runSteps[runId]?.length ?? 0) > 0);
}

/**
 * A run's steps in the chat (docs/design/run-trace-2026.md §3.2), at the run's anchor between
 * the owner's message and the reply. While it works: "Working · 0:42", the step list (the last
 * five, failures and waits always) and the stalled hint. When it ends it condenses in place into
 * one summary row ("Worked for 1 min 12 s · sent 1 email · 9 steps", or the failed / cancelled /
 * incognito form) that opens to the same rows, with "Timeline ›" to the agent sheet.
 */
export function RunTrace({
  runId,
  now: fixedNow,
  incognito = false,
  onStop,
  defaultOpen = false,
}: {
  runId: string;
  now?: number;
  incognito?: boolean;
  onStop?: () => void;
  /** Open the summary on its rows (stories). */
  defaultOpen?: boolean;
}): ReactElement | null {
  const persona = usePersona();
  const { navigate } = useSlots();
  const { run, steps } = useRun(runId);
  const top = useMemo(() => steps.filter((s) => s.parentStepId === undefined), [steps]);
  const receipts = useStoreState((s) => s.receipts);
  const live = run !== null && LIVE.includes(run.status);
  const now = useNow(1000, live ? fixedNow : (fixedNow ?? 0));
  const [open, setOpen] = useState(defaultOpen);
  if (run === null || top.length === 0) return null;

  const listLabel = t("chat.steps.label");
  const active = activeStep(top);
  const quiet = now - lastEventAt(run, top);
  const stalled = live && quiet >= STALL_MS && active?.status !== "waiting";

  if (live)
    return (
      <m.section
        layout
        transition={motionSpring(spring.smooth)}
        aria-label={listLabel}
        className="mt-3 ps-7"
        data-testid="run-trace"
        data-state="live"
      >
        <div className="flex min-h-7 items-center gap-2 text-callout text-label-secondary">
          <span className="text-headline text-label-primary">{persona.name}</span>
          <span aria-hidden="true">·</span>
          <span>{t("chat.steps.working")}</span>
          <span aria-hidden="true">·</span>
          <LiveDuration
            startedAt={Date.parse(run.startedAt)}
            {...(fixedNow === undefined ? {} : { now: fixedNow })}
          />
          {onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-keyshortcuts="Escape"
              className="ms-auto h-6 cursor-default rounded-sm px-2 text-callout text-label-secondary outline-none hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("chat.steps.stop")}
            </button>
          ) : null}
        </div>
        <StepList runId={runId} steps={top} now={fixedNow} label={listLabel} />
        {stalled ? (
          <p className="ms-8 text-callout text-label-secondary" data-testid="trace-stalled">
            {t("chat.steps.stalled", { duration: formatStepDuration(quiet) })}
          </p>
        ) : null}
        <StepAnnouncer steps={top} />
      </m.section>
    );

  const linked = top.flatMap((s) => (s.receiptId ? [receipts[s.receiptId]] : []));
  const summary = summarizeRun(
    run,
    top,
    linked.filter((r): r is NonNullable<typeof r> => r !== undefined),
    { incognito },
  );
  // A failed run is never folded: it opens on its rows.
  const expanded = open || summary.tone === "failed";
  return (
    <m.section
      layout
      transition={motionSpring(spring.smooth)}
      aria-label={listLabel}
      className="mt-3 ps-7"
      data-testid="run-trace"
      data-state="done"
    >
      <div className="flex min-h-7 items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          disabled={summary.tone === "failed"}
          className={cn(
            "-ms-1 flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-sm px-1 text-start text-body outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent",
            summary.tone === "failed" ? "text-danger-text" : "text-label-secondary",
          )}
          data-testid="run-summary"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-label-tertiary transition-transform duration-(--spring-snappy-duration) ease-(--spring-snappy)",
              expanded ? "rotate-90" : "rtl:rotate-180",
            )}
          />
          <StatusGlyph
            status={
              summary.tone === "failed"
                ? "failed"
                : summary.tone === "cancelled"
                  ? "cancelled"
                  : "done"
            }
            className="[&_svg]:size-3.5"
          />
          <span className="min-w-0 truncate">{summary.text}</span>
        </button>
        {incognito ? null : (
          <button
            type="button"
            onClick={() => navigate?.(timelineRoute(run.id))}
            className="h-6 shrink-0 cursor-default rounded-sm px-1.5 text-callout text-accent-11 outline-none hover:bg-fill-tertiary focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("chat.steps.timeline")} <span aria-hidden="true">›</span>
          </button>
        )}
      </div>
      <Presence initial={false}>
        {expanded ? (
          <m.div key="rows" {...fade}>
            <StepList
              runId={runId}
              steps={top}
              folding={summary.tone === "failed"}
              label={listLabel}
            />
          </m.div>
        ) : null}
      </Presence>
    </m.section>
  );
}
