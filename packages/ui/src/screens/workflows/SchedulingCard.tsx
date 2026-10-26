import { CalendarCheck } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { activeI18n, t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { ROW, TaintChip, WorkflowCardFrame } from "./shared.tsx";
import type { SchedulingView, SlotView } from "./types.ts";

/** "Tue, Oct 28, 10:00 – 10:30 AM" in one time zone. */
export function slotLabel(slot: SlotView, timeZone: string): string {
  const day = activeI18n().date(slot.start, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  });
  const from = activeI18n().time(slot.start, { hour: "numeric", minute: "2-digit", timeZone });
  const to = activeI18n().time(slot.end, { hour: "numeric", minute: "2-digit", timeZone });
  return `${day}, ${from} – ${to}`;
}

export interface SchedulingCardProps {
  view: SchedulingView;
  focused?: boolean;
  /** Holds the picked slots on the owner's calendar (a batch proposal). */
  onHold?: (slots: number[]) => void;
  /** Drafts the reply offering the picked slots. */
  onDraftReply?: (slots: number[]) => void;
  /** The confirm batch: create the event and release the other holds. */
  onConfirm?: () => void;
  className?: string;
}

/**
 * Scheduling over email (docs/workflows/mail-and-meetings-2026.md §7.1, §4.4): up to three free
 * slots as selectable rows in both time zones, then Hold these times and Draft reply. Once they
 * pick one, the card shows it and "Create event · Release 2 holds" as one batch.
 */
export function SchedulingCard({
  view,
  focused = false,
  onHold,
  onDraftReply,
  onConfirm,
  className,
}: SchedulingCardProps): ReactElement {
  const [picked, setPicked] = useState<readonly number[]>(() => view.slots.map((_, i) => i));
  const groupId = useId();
  const other =
    view.theirTimeZone !== undefined && view.theirTimeZone !== view.timeZone
      ? view.theirTimeZone
      : null;
  const toggle = (i: number, on: boolean) =>
    setPicked((p) => (on ? [...p, i].sort((a, b) => a - b) : p.filter((x) => x !== i)));
  const choice =
    view.state === "picked" && view.picked !== undefined ? view.slots[view.picked] : undefined;

  return (
    <WorkflowCardFrame
      data-kind="scheduling"
      kind={t("workflows.kind.scheduling")}
      title={t("workflows.scheduling.title", { subject: view.subject })}
      chips={view.taintFrom !== undefined ? <TaintChip from={view.taintFrom} /> : null}
      {...(className ? { className } : {})}
    >
      {choice ? (
        <>
          <p className="inline-flex items-center gap-2 text-body text-label-primary">
            <CalendarCheck className="size-4 text-success-text" aria-hidden="true" />
            {t("workflows.scheduling.picked", { slot: slotLabel(choice, view.timeZone) })}
          </p>
          {onConfirm ? (
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant={focused ? "default" : "secondary"}
                onClick={onConfirm}
              >
                {t("workflows.scheduling.confirm", { n: view.holds ?? 0 })}
              </Button>
            </div>
          ) : null}
        </>
      ) : view.slots.length === 0 ? (
        <p className="text-body text-label-secondary">{t("workflows.scheduling.empty")}</p>
      ) : (
        <>
          <fieldset className="m-0 min-w-0 border-0 p-0" aria-describedby={groupId}>
            <legend id={groupId} className="mb-1 text-subheadline font-medium text-label-secondary">
              {t("workflows.scheduling.slots")}
            </legend>
            <ul>
              {view.slots.map((slot, i) => {
                const id = `${groupId}-${i}`;
                const on = picked.includes(i);
                return (
                  <li key={slot.start} className={cn(ROW, "items-center")}>
                    {view.state === "proposed" ? (
                      <Checkbox
                        id={id}
                        checked={on}
                        onCheckedChange={(v) => toggle(i, v === true)}
                      />
                    ) : null}
                    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body text-label-primary tabular-nums">
                        {slotLabel(slot, view.timeZone)}
                      </span>
                      {other ? (
                        <span className="text-callout text-label-secondary tabular-nums">
                          {t("workflows.scheduling.theirs", { time: slotLabel(slot, other) })}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {view.state === "held" ? (
            <p className="text-callout text-label-secondary">
              {t("workflows.scheduling.held", { n: view.holds ?? view.slots.length })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {view.schedulingLink ? (
              <span className="me-auto text-callout text-label-secondary">
                {t("workflows.scheduling.link")}
              </span>
            ) : null}
            {view.state === "proposed" && onHold ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={picked.length === 0}
                onClick={() => onHold([...picked])}
              >
                {t("workflows.scheduling.hold")}
              </Button>
            ) : null}
            {onDraftReply ? (
              <Button
                type="button"
                size="sm"
                variant={focused ? "default" : "secondary"}
                disabled={picked.length === 0}
                onClick={() => onDraftReply([...picked])}
              >
                {t("workflows.scheduling.draftReply")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </WorkflowCardFrame>
  );
}
