import type { DailyBrief } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { CardSection, ROW, WorkflowCardFrame } from "./shared.tsx";

export type DailyFollowupAction = "done" | "snooze" | "dismiss";

export interface DailyCardProps {
  brief: DailyBrief;
  focused?: boolean;
  /** Opens an item's link (a prep note, a mail thread, a task). */
  onOpen?: (link: string) => void;
  onFollowup?: (id: string, action: DailyFollowupAction) => void;
  /** Evening: snoozes the given follow-ups to tomorrow morning. */
  onCarryOver?: (ids: string[]) => void;
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
  return (
    <WorkflowCardFrame
      data-kind={`daily-${brief.kind}`}
      kind={t(`daily.kind.${brief.kind}`)}
      title={t(`daily.title.${brief.kind}`, { date: brief.date })}
      hero={focused}
      {...(className ? { className } : {})}
      footer={
        carry.length > 0 && onCarryOver ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => onCarryOver(carry)}>
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
          ) : s.items.length === 0 ? (
            <p className="text-callout text-label-secondary">{t("daily.section.empty")}</p>
          ) : (
            <ul className="flex flex-col">
              {s.items.map((item) => (
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
                          onClick={() => onFollowup(item.followupId as string, a)}
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
