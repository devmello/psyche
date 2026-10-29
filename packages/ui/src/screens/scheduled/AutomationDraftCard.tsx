import type { DailyAutomationDraft } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";

export interface AutomationDraftCardProps {
  draft: Pick<DailyAutomationDraft, "title" | "humanSchedule" | "prompt">;
  busy?: boolean;
  /** The card's heading; default "Create this automation?". */
  title?: string;
  /** The confirm button; default "Create" (Settings → Daily). */
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation card for an automation the owner described in a sentence: what it is called,
 * when it runs, what it does. The same card confirms a new automation (Settings → Daily) and a
 * change to an existing one (Scheduled → Edit).
 */
export function AutomationDraftCard({
  draft,
  busy = false,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
}: AutomationDraftCardProps): ReactElement {
  return (
    <section
      aria-label={title ?? t("daily.automations.confirm.title")}
      className="flex flex-col gap-2 rounded-md bg-fill-quaternary p-3"
    >
      <h3 className="text-headline">{title ?? t("daily.automations.confirm.title")}</h3>
      <p className="text-body">{draft.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-callout">
        <dt className="text-label-secondary">{t("daily.automations.confirm.when")}</dt>
        <dd>{draft.humanSchedule}</dd>
        <dt className="text-label-secondary">{t("daily.automations.confirm.does")}</dt>
        <dd>{draft.prompt}</dd>
      </dl>
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={onConfirm}>
          {confirmLabel ?? t("daily.automations.confirm.cta")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("daily.automations.confirm.cancel")}
        </Button>
      </div>
    </section>
  );
}
