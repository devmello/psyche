import type { SpecialistJob } from "@psyche/protocol";
import { Ellipsis, MessageSquare, Pause, Play, Plus, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, type ReactElement, useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useSpecialistControls, useSpecialistRoles } from "../data/specialists.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import {
  formatTokenCount,
  formatUsd,
  isFinished,
  moreBudget,
  roleLabel,
  roleNoun,
} from "./model.ts";

/**
 * The owner's controls for a running specialist (docs/agent/specialists-2026.md §4.7): Steer (a
 * small composer, "Tell the shopper…"), and a menu with Pause or Resume, "Give it more" and Stop.
 * Give it more and Stop ask first; the rest act at once. Placed on the parent's spawn line and on
 * the job's Timeline header; nothing shows once the job has ended.
 */
export function SpecialistControls({ job }: { job: SpecialistJob }): ReactElement | null {
  const c = useSpecialistControls(job.taskId);
  const { roles } = useSpecialistRoles();
  const [confirm, setConfirm] = useState<"stop" | "more" | null>(null);
  const role = roles?.find((r) => r.role === job.role);
  const noun = roleNoun(roleLabel(job.role, roles));
  if (isFinished(job)) return null;
  const paused = c.task?.status === "paused";
  const fail = (err: unknown) =>
    toast.error(t("specialists.control.failed", { reason: describeError(err) }));
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(fail);
  const more = moreBudget(job.budget.limit, role?.caps);
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="specialist-controls">
      <SteerButton role={noun} title={job.title} onSteer={c.steer} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t("specialists.control.menu", { title: job.title })}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {paused ? (
            <DropdownMenuItem onClick={act(c.resume)}>
              <Play aria-hidden="true" /> {t("specialists.control.resume")}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={act(c.pause)}>
              <Pause aria-hidden="true" /> {t("specialists.control.pause")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setConfirm("more")}>
            <Plus aria-hidden="true" /> {t("specialists.control.giveMore")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-danger-text" onClick={() => setConfirm("stop")}>
            <Square aria-hidden="true" /> {t("specialists.control.stop")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={confirm === "more"}
        onOpenChange={(open) => setConfirm(open ? "more" : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("specialists.control.giveMoreTitle", { role: noun })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("specialists.control.giveMoreBody", { title: job.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <MoreLines job={job} more={more} />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!raises(job, more)}
              onClick={() => {
                setConfirm(null);
                c.giveMore(more).catch(fail);
              }}
            >
              {t("specialists.control.giveMoreConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirm === "stop"}
        onOpenChange={(open) => setConfirm(open ? "stop" : null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("specialists.control.stopTitle", { role: noun })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("specialists.control.stopBody", { title: job.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirm(null);
                c.cancel().catch(fail);
              }}
            >
              {t("specialists.control.stopConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type More = ReturnType<typeof moreBudget>;

/** Whether "Give it more" would raise anything (every limit may already be at its cap). */
function raises(job: SpecialistJob, more: More): boolean {
  const l = job.budget.limit;
  return (
    (more.tokens ?? 0) > (l.tokens ?? 0) ||
    (more.costUsd ?? 0) > (l.costUsd ?? 0) ||
    (more.minutes ?? 0) * 60_000 > (l.wallMs ?? 0)
  );
}

/** "Tokens: 400k → 600k", one line per limit the job has. */
function MoreLines({ job, more }: { job: SpecialistJob; more: More }): ReactElement {
  const l = job.budget.limit;
  const lines: string[] = [];
  if (l.tokens != null && more.tokens !== undefined) {
    lines.push(
      t("specialists.control.moreTokens", {
        from: formatTokenCount(l.tokens),
        to: formatTokenCount(more.tokens),
      }),
    );
  }
  if (l.costUsd != null && more.costUsd !== undefined) {
    lines.push(
      t("specialists.control.moreCost", {
        from: formatUsd(l.costUsd),
        to: formatUsd(more.costUsd),
      }),
    );
  }
  if (l.wallMs != null && more.minutes !== undefined) {
    lines.push(
      t("specialists.control.moreTime", {
        from: Math.round(l.wallMs / 60_000),
        to: more.minutes,
      }),
    );
  }
  return (
    <div className="flex flex-col gap-1 text-callout tabular-nums" data-testid="give-more-lines">
      {raises(job, more) ? (
        lines.map((line) => <p key={line}>{line}</p>)
      ) : (
        <p className="text-label-secondary">{t("specialists.control.atCap")}</p>
      )}
    </div>
  );
}

/** The steer composer: "Tell the shopper…". Return sends; Shift-Return adds a line. */
function SteerButton({
  role,
  title,
  onSteer,
}: {
  role: string;
  title: string;
  onSteer: (text: string) => Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (value === "" || busy) return;
    setBusy(true);
    try {
      await onSteer(value);
      setText("");
      setOpen(false);
      toast.success(t("specialists.control.steered", { role }));
    } catch (err) {
      toast.error(t("specialists.control.failed", { reason: describeError(err) }));
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t("specialists.control.steerLabel", { role, title })}
          />
        }
      >
        <MessageSquare aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form onSubmit={(e) => void send(e)} className="flex flex-col gap-2">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            maxLength={4000}
            placeholder={t("specialists.control.steerPlaceholder", { role })}
            aria-label={t("specialists.control.steerLabel", { role, title })}
            aria-describedby={hintId}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <p id={hintId} className="min-w-0 flex-1 text-subheadline text-label-tertiary">
              {t("specialists.control.steerHint")}
            </p>
            <Button type="submit" size="xs" disabled={text.trim() === "" || busy}>
              {t("specialists.control.send")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
