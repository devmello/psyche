import type { DailyBrief } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { CardSection, ROW, WorkflowCardFrame } from "./shared.tsx";

export type DailyFollowupAction = "done" | "snooze" | "dismiss";

export interface DailyCardProps {
  brief: DailyBrief;
  focused?: boolean;
  /** Opens an item's link (a prep note, a mail thread, a task). */
  onOpen?: (link: string) => void;
  /** Resolves true when the Gateway took the change; the row then leaves the card. */
  onFollowup?: (id: string, action: DailyFollowupAction) => Promise<boolean>;
  /** Evening: snoozes the given follow-ups to tomorrow morning. Resolves true when done. */
  onCarryOver?: (ids: string[]) => Promise<boolean>;
  className?: string;
}

/**
 * The morning brief and evening wrap-up (a Feed card). Section titles come from the message
 * catalogue by section id, so they follow the app's language. A section whose connector is
 * missing says so instead of showing an empty list.
 */
export function DailyCard({
  brief,
  focused = false,
  onOpen,
  onFollowup,
  onCarryOver,
  className,
}: DailyCardProps): ReactElement {
  const carry = (brief.carryOver ?? []).flatMap((i) => (i.followupId ? [i.followupId] : []));
  // Follow-ups the owner acted on here: done, dismissed and snoozed rows leave the card.
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [carried, setCarried] = useState(false);
  const isHandled = (id: string | undefined) => id !== undefined && handled.has(id);
  const followup = (id: string, action: DailyFollowupAction) => {
    if (!onFollowup) return;
    void Promise.resolve(onFollowup(id, action)).then((ok) => {
      if (ok) setHandled((prev) => new Set(prev).add(id));
    });
  };
  const carryOver = (ids: string[]) => {
    if (!onCarryOver) return;
    void Promise.resolve(onCarryOver(ids)).then((ok) => {
      if (!ok) return;
      setCarried(true);
      setHandled((prev) => new Set([...prev, ...ids]));
    });
  };
  return (
    <WorkflowCardFrame
      data-kind={`daily-${brief.kind}`}
      kind={t(`daily.kind.${brief.kind}`)}
      title={t(`daily.title.${brief.kind}`, { date: brief.date })}
      hero={focused}
      {...(className ? { className } : {})}
      footer={
        carried ? (
          <p role="status" className="text-callout text-label-secondary">
            {t("daily.carryOver.done")}
          </p>
        ) : carry.length > 0 && onCarryOver ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => carryOver(carry.filter((id) => !isHandled(id)))}
          >
            {t("daily.carryOver", { count: carry.length })}
          </Button>
        ) : undefined
      }
    >
      {brief.summary ? <p className="text-body text-label-primary">{brief.summary}</p> : null}
      {brief.sections.map((s) => (
        <CardSection key={s.id} title={t(`daily.section.${s.id}`)}>
          {s.unavailable && s.items.length === 0 ? (
            <p className="text-callout text-label-secondary">{t("daily.section.unavailable")}</p>
          ) : s.items.filter((i) => !isHandled(i.followupId)).length === 0 ? (
            <p className="text-callout text-label-secondary">{t("daily.section.empty")}</p>
          ) : (
            <ul className="flex flex-col">
              {s.items
                .filter((i) => !isHandled(i.followupId))
                .map((item) => (
                  <li key={`${s.id}-${item.followupId ?? item.text}`} className={ROW}>
                    <span className="min-w-0 flex-1 text-body text-label-primary">
                      {item.link && onOpen ? (
                        <button
                          type="button"
                          onClick={() => onOpen(item.link as string)}
                          aria-label={t("daily.item.open", { item: item.text })}
                          className="cursor-default text-left text-accent-11 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {item.text}
                        </button>
                      ) : (
                        item.text
                      )}
                    </span>
                    {item.followupId && onFollowup ? (
                      <span className="flex shrink-0 gap-1">
                        {(["done", "snooze", "dismiss"] as const).map((a) => (
                          <Button
                            key={a}
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => followup(item.followupId as string, a)}
                          >
                            {t(`daily.followup.${a}`)}
                          </Button>
                        ))}
                      </span>
                    ) : null}
                  </li>
                ))}
            </ul>
          )}
        </CardSection>
      ))}
    </WorkflowCardFrame>
  );
}
