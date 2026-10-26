import type { DigestLoop } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatDate } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { SegmentedRadio } from "../settings/SegmentedRadio.tsx";
import type { DigestLoopAction } from "./DigestCard.tsx";
import { daysBetween, REVEAL, ROW, WorkflowCardFrame } from "./shared.tsx";

export type FollowUpSegment = "waiting" | "owe" | "stale";

/**
 * Which segment a loop is in: overdue loops, and ones a digest already showed twice, are stale;
 * the rest split by direction (spec §4.2, §8.3).
 */
export function followUpSegment(loop: DigestLoop, now: number): FollowUpSegment {
  const due = loop.loop.dueAt;
  if ((due != null && Date.parse(due) < now) || loop.shownCount >= 2) return "stale";
  return loop.loop.direction === "i_owe" ? "owe" : "waiting";
}

export interface FollowUpsCardProps {
  /** Open and snoozed loops (`memory.loops.list`), with the counterpart's name resolved. */
  loops: readonly DigestLoop[];
  now?: number;
  defaultSegment?: FollowUpSegment;
  onLoop?: (loop: DigestLoop, action: DigestLoopAction) => void;
  className?: string;
}

/**
 * Follow-ups (docs/workflows/mail-and-meetings-2026.md §7.1, §4.2): one segmented control over
 * Waiting on, You owe and Stale, and grouped rows (redesign-2026 §5.8) with Draft a nudge, Snooze
 * and Done. The rows are the memory graph's loops; nothing here is a second store (§8.3).
 */
export function FollowUpsCard({
  loops,
  now = Date.now(),
  defaultSegment = "waiting",
  onLoop,
  className,
}: FollowUpsCardProps): ReactElement {
  const [segment, setSegment] = useState<FollowUpSegment>(defaultSegment);
  const shown = loops.filter((l) => followUpSegment(l, now) === segment);
  const options = (["waiting", "owe", "stale"] as const).map((value) => ({
    value,
    label: t(`workflows.followUps.segment.${value}`),
  }));

  return (
    <WorkflowCardFrame
      data-kind="follow_ups"
      kind={t("workflows.kind.followUps")}
      title={t("workflows.followUps.title")}
      {...(className ? { className } : {})}
    >
      <SegmentedRadio
        label={t("workflows.followUps.segments")}
        options={options}
        value={segment}
        onChange={setSegment}
        className="self-start"
      />
      {shown.length === 0 ? (
        <p className="py-2 text-body text-label-secondary">
          {t(`workflows.followUps.empty.${segment}`)}
        </p>
      ) : (
        <ul>
          {shown.map((l) => {
            const age = t("workflows.followUps.age", {
              days: t("time.days", { n: daysBetween(l.thread?.at ?? l.loop.createdAt, now) }),
            });
            const meta = [l.counterpart, age];
            if (l.loop.dueAt)
              meta.push(t("workflows.followUps.due", { date: formatDate(l.loop.dueAt) }));
            return (
              <li key={l.loop.id} className={cn(ROW, "flex-wrap items-center")}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="text-body text-label-primary">{l.loop.text}</p>
                  <p className="text-callout text-label-secondary">
                    {meta.filter(Boolean).join(" · ")}
                  </p>
                  {l.shownCount >= 2 ? (
                    <p className="text-callout text-label-tertiary">
                      {t("workflows.followUps.shownTwice")}
                    </p>
                  ) : null}
                </div>
                {onLoop ? (
                  <div className={cn("flex gap-1", REVEAL)}>
                    {l.loop.direction === "waiting_on" ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() => onLoop(l, "nudge")}
                      >
                        {t("workflows.digest.nudge")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => onLoop(l, "snooze")}
                    >
                      {t("workflows.digest.snooze")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => onLoop(l, "done")}
                    >
                      {t("workflows.digest.done")}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </WorkflowCardFrame>
  );
}
