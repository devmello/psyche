import type { DailyAutomationDraft, ScheduledItem } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { cn } from "../../lib/utils.ts";
import { AutomationDraftCard } from "./AutomationDraftCard.tsx";
import {
  absoluteWhen,
  approvalLines,
  itemDoes,
  itemName,
  itemSchedule,
  lastRunLine,
  nextRunLine,
} from "./format.ts";

export interface ScheduledRowProps {
  item: ScheduledItem;
  now: number;
  timezone: string;
  onPause: (item: ScheduledItem, paused: boolean) => void;
  onRunNow: (item: ScheduledItem) => void;
  /** Called after the owner confirms the delete. Never offered for Psyche's routines. */
  onDelete: (item: ScheduledItem) => void;
  /** `/settings/<section>` of a routine. */
  onOpenSettings?: (section: string) => void;
  /** Turns the owner's sentence into the draft the confirm card shows. */
  onParseEdit?: (
    item: ScheduledItem,
    text: string,
  ) => Promise<{ draft?: DailyAutomationDraft; error?: string }>;
  onSaveEdit?: (item: ScheduledItem, draft: DailyAutomationDraft) => Promise<void>;
  /** Linked runs and unusual kinds are changed in a chat. */
  onEditInChat?: (item: ScheduledItem) => void;
  /** The run history, shown when the owner opens it. */
  renderHistory?: (item: ScheduledItem) => ReactNode;
  className?: string;
}

type Mode = "idle" | "edit" | "delete";

/** One scheduled item: when, what, approvals, linked runs, and the actions that fit it. */
export function ScheduledRow({
  item,
  now,
  timezone,
  onPause,
  onRunNow,
  onDelete,
  onOpenSettings,
  onParseEdit,
  onSaveEdit,
  onEditInChat,
  renderHistory,
  className,
}: ScheduledRowProps): ReactElement {
  const titleId = useId();
  const name = itemName(item);
  const [mode, setMode] = useState<Mode>("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<DailyAutomationDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const owner = item.group === "owner";
  const sentenceEditable =
    owner && item.linked === undefined && ["cron", "interval"].includes(item.kind);
  const canEdit = owner && (sentenceEditable ? onParseEdit && onSaveEdit : onEditInChat);

  const startEdit = () => {
    if (!sentenceEditable) {
      onEditInChat?.(item);
      return;
    }
    setText(`${itemSchedule(item)}: ${item.prompt ?? item.summary}`.slice(0, 1000));
    setDraft(null);
    setProblem(null);
    setMode("edit");
  };

  const review = async () => {
    if (!onParseEdit) return;
    setBusy(true);
    setProblem(null);
    try {
      const r = await onParseEdit(item, text.trim());
      if (r.draft) setDraft(r.draft);
      else
        setProblem(
          r.error === "no_model" ? t("scheduled.edit.noModel") : t("scheduled.edit.parseFailed"),
        );
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft || !onSaveEdit) return;
    setBusy(true);
    try {
      await onSaveEdit(item, draft);
      setMode("idle");
      setDraft(null);
    } catch (err) {
      setProblem(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const approvals = approvalLines(item.approvals);

  return (
    <li
      aria-labelledby={titleId}
      className={cn(
        "flex flex-col gap-3 rounded-lg bg-surface-raised p-4 shadow-elevation-1",
        item.state !== "active" && "opacity-90",
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 id={titleId} className="text-headline text-label-primary">
          {name}
        </h3>
        {item.state === "paused" ? (
          <Badge variant="muted">{t("scheduled.state.paused")}</Badge>
        ) : item.state === "off" ? (
          <Badge variant="outline">{t("scheduled.state.off")}</Badge>
        ) : null}
        <span className="text-callout text-label-secondary">{itemSchedule(item)}</span>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-callout">
        <dt className="text-label-secondary">{t("scheduled.row.next")}</dt>
        <dd>{nextRunLine(item, now, timezone)}</dd>
        <dt className="text-label-secondary">{t("scheduled.row.last")}</dt>
        <dd className={item.lastStatus === "failed" ? "text-destructive" : undefined}>
          {lastRunLine(item, now)}
          {item.lastRunAt ? (
            <span className="text-label-secondary">
              {" "}
              · {absoluteWhen(item.lastRunAt, timezone)}
            </span>
          ) : null}
        </dd>
        <dt className="text-label-secondary">{t("scheduled.row.does")}</dt>
        <dd>{itemDoes(item)}</dd>
        <dt className="text-label-secondary">{t("scheduled.row.approvals")}</dt>
        <dd>
          {approvals.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </dd>
        {item.linked ? (
          <>
            <dt className="text-label-secondary">{t("scheduled.row.linked")}</dt>
            <dd>
              {item.linked.runs.map((r) => (
                <span key={r.id} className="block">
                  {t("scheduled.row.linkedRun", {
                    title: r.title,
                    when: r.nextRunAt
                      ? absoluteWhen(r.nextRunAt, timezone)
                      : itemSchedule({ kind: "cron", schedule: r.schedule }),
                  })}
                </span>
              ))}
            </dd>
          </>
        ) : null}
      </dl>

      {mode === "delete" ? (
        <fieldset className="flex min-w-0 flex-col gap-2 rounded-md border-0 bg-fill-quaternary p-3">
          <legend className="text-body text-label-primary">
            {t("scheduled.delete.title", { title: name })}
          </legend>
          <p className="text-callout text-label-secondary">{t("scheduled.delete.body")}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setMode("idle");
                onDelete(item);
              }}
            >
              {t("scheduled.delete.confirm")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
              {t("scheduled.delete.cancel")}
            </Button>
          </div>
        </fieldset>
      ) : null}

      {mode === "edit" ? (
        <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="sr-only">{t("scheduled.edit.title", { title: name })}</legend>
          {draft === null ? (
            <>
              <label htmlFor={`${titleId}-edit`} className="text-callout text-label-secondary">
                {t("scheduled.edit.label")}
              </label>
              <Textarea
                id={`${titleId}-edit`}
                value={text}
                rows={3}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={busy || text.trim() === ""}
                  onClick={() => void review()}
                >
                  {t("scheduled.edit.review")}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
                  {t("scheduled.edit.cancel")}
                </Button>
              </div>
            </>
          ) : (
            <AutomationDraftCard
              draft={draft}
              busy={busy}
              title={t("scheduled.edit.cardTitle")}
              confirmLabel={t("scheduled.edit.save")}
              onConfirm={() => void save()}
              onCancel={() => {
                setDraft(null);
                setMode("idle");
              }}
            />
          )}
          {problem ? (
            <p role="alert" className="text-callout text-destructive">
              {problem}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-1">
        {item.state === "off" ? (
          item.settings && onOpenSettings ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onOpenSettings(item.settings as string)}
            >
              {t("scheduled.action.turnOn")}
            </Button>
          ) : null
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={t(
              item.state === "active"
                ? "scheduled.action.pause.aria"
                : "scheduled.action.resume.aria",
              { title: name },
            )}
            onClick={() => onPause(item, item.state === "active")}
          >
            {t(item.state === "active" ? "scheduled.action.pause" : "scheduled.action.resume")}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label={t("scheduled.action.runNow.aria", { title: name })}
          onClick={() => onRunNow(item)}
        >
          {t("scheduled.action.runNow")}
        </Button>
        {canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("scheduled.action.edit.aria", { title: name })}
            onClick={startEdit}
          >
            {t("scheduled.action.edit")}
          </Button>
        ) : null}
        {item.deletable ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("scheduled.action.delete.aria", { title: name })}
            onClick={() => setMode("delete")}
          >
            {t("scheduled.action.delete")}
          </Button>
        ) : null}
        {item.settings && onOpenSettings && item.state !== "off" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("scheduled.action.settings.aria", { title: name })}
            onClick={() => onOpenSettings(item.settings as string)}
          >
            {t("scheduled.action.settings")}
          </Button>
        ) : null}
        {renderHistory ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-expanded={historyOpen}
            aria-label={t("scheduled.action.history.aria", { title: name })}
            onClick={() => setHistoryOpen((o) => !o)}
          >
            {t("scheduled.action.history")}
          </Button>
        ) : null}
      </div>

      {historyOpen && renderHistory ? renderHistory(item) : null}
    </li>
  );
}
