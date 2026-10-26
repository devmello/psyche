import type { MeetingActionItem, MeetingNotes } from "@psyche/protocol";
import { CircleAlert, Play } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { t } from "../../i18n/core.ts";
import { formatDate, formatDuration, formatTime } from "../../lib/format.ts";
import { cn } from "../../lib/utils.ts";
import { CardSection, CloudChip, ROW, TaintChip, WorkflowCardFrame } from "./shared.tsx";

/** "12:04" from a recording offset. */
export function offsetLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export interface MeetingNotesCardProps {
  notes: MeetingNotes;
  focused?: boolean;
  /** Where the owner's action items go (Settings → Mail & meetings → Meeting notes). */
  tasksApp?: "reminders" | "things";
  /** Seeks the recording in the Library viewer. */
  onSeek?: (atMs: number) => void;
  onOpenTranscript?: () => void;
  /** Ticks an action item (its loop, for others' items). */
  onToggleItem?: (item: MeetingActionItem, done: boolean) => void;
  /** "Add 2 to Reminders": the batch card opens inline (§7.2). Without it, `onAddItems`. */
  renderBatch?: (proposalId: string, close: () => void) => ReactNode;
  onAddItems?: (proposalId: string) => void;
  onDraftRecap?: () => void;
  onRetrySummary?: () => void;
  className?: string;
}

function Seek({ atMs, onSeek }: { atMs?: number; onSeek?: (ms: number) => void }) {
  if (atMs === undefined || onSeek === undefined) return null;
  const label = offsetLabel(atMs);
  return (
    <button
      type="button"
      onClick={() => onSeek(atMs)}
      aria-label={t("workflows.notes.seek", { time: label })}
      className="inline-flex shrink-0 cursor-default items-center gap-1 rounded-xs text-callout text-accent-11 tabular-nums hover:underline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Play className="size-3" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * Post-meeting notes (docs/workflows/mail-and-meetings-2026.md §7.1, §4.6), labelled AI-written:
 * the summary, decisions whose timestamps seek the audio, action items as checkable rows, open
 * questions, "Add 2 to Reminders" (a batch) and "Draft recap email". It says plainly that audio
 * and transcripts are never uploaded, reused or used for training (§3 rule 9).
 */
export function MeetingNotesCard({
  notes,
  focused = false,
  tasksApp = "reminders",
  onSeek,
  onOpenTranscript,
  onToggleItem,
  renderBatch,
  onAddItems,
  onDraftRecap,
  onRetrySummary,
  className,
}: MeetingNotesCardProps): ReactElement {
  const [done, setDone] = useState<ReadonlySet<number>>(new Set());
  const [batchOpen, setBatchOpen] = useState(false);
  const baseId = useId();
  const failed = notes.summary.length === 0 && notes.decisions.length === 0;
  const proposalId = notes.actionItems.find((a) => a.owner === "owner" && a.proposalId)?.proposalId;
  const mine = notes.actionItems.filter((a) => a.owner === "owner" && a.proposalId).length;
  const untrusted = notes.provenance === "untrusted";

  return (
    <WorkflowCardFrame
      data-kind="meeting_notes"
      kind={`${t("workflows.kind.meetingNotes")} · ${formatTime(notes.startedAt)} · ${t(
        "workflows.notes.length",
        { duration: formatDuration(notes.durationMs) },
      )}`}
      title={notes.title}
      chips={
        <>
          <span>{t("workflows.aiWritten")}</span>
          {untrusted ? <TaintChip /> : null}
          {notes.model.remote ? <CloudChip /> : null}
        </>
      }
      footer={
        <p>
          {notes.model.remote ? t("workflows.notes.privateCloud") : t("workflows.notes.private")}
        </p>
      }
      {...(className ? { className } : {})}
    >
      {failed ? (
        <div
          className="flex flex-wrap items-center gap-2 text-body text-label-primary"
          role="status"
        >
          <CircleAlert className="size-4 text-danger-text" aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("workflows.notes.summaryFailed")}</span>
          {onRetrySummary ? (
            <Button type="button" size="xs" variant="outline" onClick={onRetrySummary}>
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notes.summary.length > 0 ? (
        <CardSection title={t("workflows.notes.summary")}>
          <ul className="flex list-disc flex-col gap-1 ps-5 marker:text-label-tertiary">
            {notes.summary.map((s) => (
              <li key={s} className="text-reading text-label-primary">
                {s}
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {notes.decisions.length > 0 ? (
        <CardSection title={t("workflows.notes.decisions")}>
          <ul>
            {notes.decisions.map((d) => (
              <li key={d.text} className={cn(ROW, "items-baseline")}>
                <span className="min-w-0 flex-1 text-body text-label-primary">{d.text}</span>
                <Seek
                  {...(d.atMs === undefined ? {} : { atMs: d.atMs })}
                  {...(onSeek ? { onSeek } : {})}
                />
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}
      {!failed ? (
        <CardSection title={t("workflows.notes.actionItems")}>
          {notes.actionItems.length === 0 ? (
            <p className="text-body text-label-secondary">{t("workflows.notes.empty")}</p>
          ) : (
            <ul>
              {notes.actionItems.map((a, i) => {
                const id = `${baseId}-${i}`;
                const checked = done.has(i);
                const owner =
                  a.owner === "owner"
                    ? t("workflows.notes.ownerYou")
                    : (a.owner ?? t("workflows.notes.ownerNone"));
                const meta = [owner];
                if (a.dueAt) meta.push(t("workflows.notes.due", { date: formatDate(a.dueAt) }));
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the Gateway's list is fixed once posted
                  <li key={`${a.text}-${i}`} className={cn(ROW, "items-start")}>
                    <Checkbox
                      id={id}
                      className="mt-0.5"
                      checked={checked}
                      onCheckedChange={(v) => {
                        const on = v === true;
                        setDone((s) => {
                          const next = new Set(s);
                          if (on) next.add(i);
                          else next.delete(i);
                          return next;
                        });
                        onToggleItem?.(a, on);
                      }}
                    />
                    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={cn(
                          "text-body text-label-primary",
                          checked ? "text-label-tertiary line-through" : "",
                        )}
                      >
                        {a.text}
                      </span>
                      <span className="text-callout text-label-secondary">{meta.join(" · ")}</span>
                    </label>
                    <Seek
                      {...(a.atMs === undefined ? {} : { atMs: a.atMs })}
                      {...(onSeek ? { onSeek } : {})}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardSection>
      ) : null}
      {notes.openQuestions.length > 0 ? (
        <CardSection title={t("workflows.notes.openQuestions")}>
          <ul className="flex list-disc flex-col gap-1 ps-5 marker:text-label-tertiary">
            {notes.openQuestions.map((q) => (
              <li key={q} className="text-body text-label-primary">
                {q}
              </li>
            ))}
          </ul>
        </CardSection>
      ) : null}

      {batchOpen && proposalId && renderBatch
        ? renderBatch(proposalId, () => setBatchOpen(false))
        : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onOpenTranscript && notes.transcriptItemId ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="me-auto"
            onClick={onOpenTranscript}
          >
            {t("workflows.notes.transcript")}
          </Button>
        ) : null}
        {onDraftRecap && !failed ? (
          <Button type="button" size="sm" variant="outline" onClick={onDraftRecap}>
            {t("workflows.notes.recap")}
          </Button>
        ) : null}
        {proposalId && (renderBatch || onAddItems) ? (
          <Button
            type="button"
            size="sm"
            variant={focused ? "default" : "secondary"}
            aria-expanded={renderBatch ? batchOpen : undefined}
            onClick={() => (renderBatch ? setBatchOpen((v) => !v) : onAddItems?.(proposalId))}
          >
            {t("workflows.notes.addTo", { n: mine, app: tasksApp })}
          </Button>
        ) : null}
      </div>
    </WorkflowCardFrame>
  );
}
