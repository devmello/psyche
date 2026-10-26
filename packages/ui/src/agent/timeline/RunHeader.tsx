import type { Run, RunStatus } from "@psyche/protocol";
import { Ellipsis, Pause, RotateCw, Share, Square } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { StatusGlyph, type StepStatusKind } from "../../components/status.tsx";
import { LiveDuration } from "../../components/steps/LiveDuration.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { t } from "../../i18n/core.ts";
import type { MessageId } from "../../i18n/index.ts";
import { formatTime } from "../../lib/format.ts";
import { tokens as formatTokens, usd } from "../../screens/settings/UsageSection.tsx";
import { ms, usageTokens } from "./model.ts";

/**
 * The Timeline's run header (docs/design/run-trace-2026.md §3.3): the state glyph and title, one
 * fact line (state · duration · steps · tokens · cost; "—" when unknown, never 0), the provenance
 * line, the Waterfall / List switch, and the actions for the run's state.
 */

export type TimelineMode = "waterfall" | "list";

export function runGlyph(status: RunStatus): StepStatusKind {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "waiting";
  }
}

function stateLabel(status: RunStatus): string {
  const key = status === "awaiting_approval" || status === "awaiting_input" ? "waiting" : status;
  return t(`agent.timeline.state.${key}` as MessageId);
}

/** The task's title; a chat task without one reads as its thread ("Lisbon trip"). */
export function runTitle(run: Run, threadTitle?: string | null): string {
  return run.title?.trim() || threadTitle?.trim() || t("agent.timeline.untitled");
}

export interface RunHeaderProps {
  run: Run;
  stepCount: number;
  now?: number;
  mode: TimelineMode;
  onModeChange: (mode: TimelineMode) => void;
  /** Where the run happened ("Main chat"). */
  threadTitle?: string;
  onStop?: () => void;
  onPause?: () => void;
  onRetry?: () => void;
  onExport?: (format: "psyche-trace+json" | "markdown", includeFrames?: boolean) => void;
  onCopyLink?: () => void;
  onDelete?: () => void;
  /** The leading control (Back to Activity). */
  leading?: ReactNode;
}

export function RunHeader({
  run,
  stepCount,
  now,
  mode,
  onModeChange,
  threadTitle,
  onStop,
  onPause,
  onRetry,
  onExport,
  onCopyLink,
  onDelete,
  leading,
}: RunHeaderProps): ReactElement {
  const running = run.status === "running";
  const start = ms(run.startedAt) ?? 0;
  const end = ms(run.endedAt) ?? undefined;
  const tokens = usageTokens(run.usage);
  const cost = run.usage.costUsd;
  const who = t(`agent.timeline.who.${run.origin ?? "owner"}` as MessageId);
  const facts: ReactNode[] = [
    stateLabel(run.status),
    <LiveDuration
      key="d"
      startedAt={start}
      endedAt={running ? undefined : (end ?? start)}
      {...(now === undefined ? {} : { now })}
    />,
    t("agent.timeline.steps", { n: stepCount }),
    tokens === null || tokens === 0
      ? t("agent.timeline.unknown")
      : t("agent.timeline.tokens", { tokens: formatTokens(tokens) }),
    cost === null || cost === undefined ? t("agent.timeline.unknown") : usd(cost),
  ];
  return (
    <div className="flex flex-col gap-1" data-testid="run-header">
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <StatusGlyph
          status={runGlyph(run.status)}
          label={stateLabel(run.status)}
          morph
          className="size-4 shrink-0"
        />
        <h2 className="min-w-0 flex-1 truncate text-title-3">{runTitle(run, threadTitle)}</h2>
        {/* biome-ignore lint/a11y/useSemanticElements: a segmented control of pressed buttons */}
        <div role="group" aria-label={t("agent.timeline.view")} className="flex shrink-0">
          {(["waterfall", "list"] as const).map((m) => (
            <Button
              key={m}
              size="xs"
              variant={mode === m ? "secondary" : "ghost"}
              aria-pressed={mode === m}
              onClick={() => onModeChange(m)}
            >
              {t(`agent.timeline.view.${m}` as MessageId)}
            </Button>
          ))}
        </div>
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-callout text-label-secondary tabular-nums">
        {facts.map((f, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of facts
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden="true">·</span> : null}
            {f}
          </span>
        ))}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-subheadline text-label-tertiary">
          {t("agent.timeline.startedBy", { time: formatTime(run.startedAt), who })}
          {threadTitle ? ` · ${threadTitle}` : ""}
          {` · ${t("agent.timeline.model", { model: run.modelRef.split("/").pop() ?? run.modelRef })}`}
          {run.note ? ` · ${run.note}` : ""}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {running && onPause ? (
            <Button size="xs" variant="ghost" onClick={onPause}>
              <Pause aria-hidden="true" /> {t("agent.timeline.pause")}
            </Button>
          ) : null}
          {running && onStop ? (
            <Button size="xs" variant="ghost" onClick={onStop}>
              <Square aria-hidden="true" /> {t("agent.timeline.stop")}
            </Button>
          ) : null}
          {!running && onRetry ? (
            <Button size="xs" variant="ghost" onClick={onRetry}>
              <RotateCw aria-hidden="true" /> {t("agent.timeline.retry")}
            </Button>
          ) : null}
          {onExport ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="xs" variant="ghost" />}>
                <Share aria-hidden="true" /> {t("agent.timeline.export")}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onExport("psyche-trace+json")}>
                  {t("agent.timeline.exportJson")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("psyche-trace+json", true)}>
                  {t("agent.timeline.exportFrames")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport("markdown")}>
                  {t("agent.timeline.exportMarkdown")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {onCopyLink || onDelete ? (
            <MoreMenu
              {...(onCopyLink ? { onCopyLink } : {})}
              {...(onDelete && !running ? { onDelete } : {})}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MoreMenu({
  onCopyLink,
  onDelete,
}: {
  onCopyLink?: () => void;
  onDelete?: () => void;
}): ReactElement {
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size="icon-xs" variant="ghost" aria-label={t("agent.timeline.more")} />}
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onCopyLink ? (
            <DropdownMenuItem onClick={onCopyLink}>{t("agent.timeline.copyLink")}</DropdownMenuItem>
          ) : null}
          {onDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger-text" onClick={() => setConfirm(true)}>
                {t("agent.timeline.delete")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {onDelete ? (
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("agent.timeline.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("agent.timeline.deleteBody")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirm(false);
                  onDelete();
                }}
              >
                {t("agent.timeline.deleteConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}
