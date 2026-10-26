import type { Lesson } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { formatDate } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { useSlots } from "../slots.tsx";
import { useLesson, useTeaching } from "./hooks.ts";

/**
 * "Learned from you · 25 Oct · Refined 3 times" (teaching loop §5.2): text plus a glyph, never
 * colour alone. Activating it opens the lesson: its statement, the feedback it came from, the
 * change against the previous value, and Keep, Edit and Forget.
 */
export function LessonMark({
  lesson,
  variant = "learned",
  className,
}: {
  lesson: Lesson;
  /** `automation`: "Changed from your feedback · date" on a parameter a lesson set. */
  variant?: "learned" | "automation";
  className?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const date = formatDate(lesson.createdAt);
  const n = lesson.refinedCount;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-sm text-start text-caption text-label-secondary outline-none hover:text-label-primary focus-visible:ring-3 focus-visible:ring-ring",
              className,
            )}
            aria-label={t("screens.lessons.markLabel", { date, n })}
            data-testid="lesson-mark"
          />
        }
      >
        <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
        <span className="truncate">
          {variant === "automation"
            ? t("screens.lessons.automation", { date })
            : t("screens.lessons.mark", { date })}
          {n > 0 ? ` · ${t("screens.lessons.refined", { n })}` : ""}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        {open ? <LessonDetails lessonId={lesson.id} onDone={() => setOpen(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

/** "- Explain first" → "- Short replies": the lesson's change as a unified diff of lines. */
export function ChangeLines({
  before,
  after,
}: {
  before?: string | null | undefined;
  after: string;
}): ReactElement {
  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className="text-caption text-label-secondary">
        {t("screens.lessons.change")}
      </figcaption>
      <div className="rounded-md bg-fill-quaternary p-2 font-mono text-mono">
        {before ? (
          <p className="text-danger-text">
            <span className="sr-only">{t("screens.lessons.before")}: </span>
            <span aria-hidden="true">− </span>
            {before}
          </p>
        ) : null}
        {after !== "" ? (
          <p className="text-success-text">
            <span className="sr-only">{t("screens.lessons.after")}: </span>
            <span aria-hidden="true">+ </span>
            {after}
          </p>
        ) : null}
      </div>
    </figure>
  );
}

/** The mark's popover: statement, sources, the change, and Keep / Edit / Forget. */
export function LessonDetails({
  lessonId,
  onDone,
}: {
  lessonId: string;
  onDone?: () => void;
}): ReactElement {
  const q = useLesson(lessonId);
  const teach = useTeaching();
  const { navigate } = useSlots();
  const editId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.data === undefined) {
    return q.error ? (
      <p className="text-callout text-danger-text" role="alert">
        {t("screens.lessons.loadFailed", { reason: q.error })}
      </p>
    ) : (
      <Skeleton className="h-24" />
    );
  }
  const { lesson, sources, diff } = q.data;
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      setNotice(done);
      setEditing(null);
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  const forgotten = lesson.status === "forgotten";
  return (
    <div className="flex flex-col gap-3" data-testid="lesson-details">
      <p className="text-body text-label-primary">{lesson.statement}</p>
      {sources.length > 0 ? (
        <section aria-label={t("screens.lessons.sources")} className="flex flex-col gap-1">
          <h3 className="text-caption text-label-secondary">{t("screens.lessons.sources")}</h3>
          <ul className="flex flex-col gap-1">
            {sources.map((e) => (
              <li key={e.id} className="flex items-baseline gap-2 text-callout">
                <span className="shrink-0 text-label-secondary tabular-nums">
                  {t("screens.lessons.sourceDate", { date: formatDate(e.createdAt) })}
                </span>
                <span className="min-w-0 flex-1 truncate text-label-primary">
                  {e.text ?? (e.reason ? t(`chat.teach.reason.${e.reason}`) : "")}
                </span>
                {e.target.threadId && navigate ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      navigate(`/chat/${e.target.threadId}`);
                      onDone?.();
                    }}
                  >
                    {t("screens.lessons.openThread")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ChangeLines before={diff.before} after={diff.after} />
      {editing !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const value = editing.trim();
            if (value === "") return;
            void run(() => teach.edit(lesson.id, value), t("screens.lessons.saved"));
          }}
        >
          <label htmlFor={editId} className="text-caption text-label-secondary">
            {t("screens.lessons.editLabel")}
          </label>
          <Textarea
            id={editId}
            rows={2}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            autoFocus
          />
          <span className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || editing.trim() === ""}>
              {t("common.save")}
            </Button>
          </span>
        </form>
      ) : forgotten ? null : (
        <span className="flex flex-wrap gap-2">
          {lesson.status !== "confirmed" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => teach.confirm(lesson.id), t("screens.lessons.kept"))}
            >
              {t("screens.lessons.keep")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setEditing(diff.after)}
          >
            {t("common.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger-text"
            disabled={busy}
            onClick={() => void run(() => teach.forget(lesson.id), t("screens.lessons.forgotten"))}
          >
            {t("screens.lessons.forget")}
          </Button>
        </span>
      )}
      {notice ? (
        <p className="text-callout text-label-secondary" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
