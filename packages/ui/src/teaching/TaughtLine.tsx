import type { LearnedFact } from "@psyche/protocol";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useCall } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { useLesson, useTeaching } from "./hooks.ts";

/**
 * The quiet line after teaching (teaching loop §5.1): "Psyche will remember: *Replies to Jane are
 * short.*" with Undo (`memory.lessons.forget`, or `feedback.delete` when there is no lesson) and
 * Change (`memory.lessons.edit`). With no lesson it reads "Thanks. Psyche noted it."
 */
export function TaughtLine({
  feedbackId,
  lessonId: givenLessonId,
  statement: givenStatement,
}: {
  feedbackId: string;
  lessonId?: string | null | undefined;
  statement?: string | null | undefined;
}): ReactElement {
  const lessonId = givenLessonId ?? null;
  const statement = givenStatement ?? null;
  const teach = useTeaching();
  const editId = useId();
  const [state, setState] = useState<"shown" | "editing" | "undone">("shown");
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lesson = useLesson(state === "editing" && lessonId !== null ? lessonId : null);
  const value = draft ?? lesson.data?.lesson.value ?? "";
  const act = async (action: () => Promise<unknown>, next: typeof state): Promise<boolean> => {
    try {
      await action();
      setError(null);
      setState(next);
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };

  if (state === "undone") {
    return (
      <p className="my-1 text-callout text-label-secondary" role="status">
        {t("chat.teach.undone")}
      </p>
    );
  }
  return (
    <div
      className="my-1 flex flex-col gap-1.5 text-callout text-label-secondary"
      data-testid="taught"
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        {lessonId !== null && statement !== null ? (
          <span>
            {t("chat.teach.willRemember")} <em className="text-label-primary">{statement}</em>
          </span>
        ) : (
          <span>{t("chat.teach.noted")}</span>
        )}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void act(
              () => (lessonId !== null ? teach.forget(lessonId) : teach.deleteFeedback(feedbackId)),
              "undone",
            )
          }
        >
          {t("chat.teach.undo")}
        </Button>
        {lessonId !== null && state === "shown" ? (
          <Button size="xs" variant="ghost" onClick={() => setState("editing")}>
            {t("chat.teach.change")}
          </Button>
        ) : null}
      </p>
      {state === "editing" && lessonId !== null ? (
        <form
          className="flex max-w-md flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim() === "") return;
            void act(() => teach.edit(lessonId, value.trim()), "shown").then((ok) => {
              if (ok) setDraft(null);
            });
          }}
        >
          <label htmlFor={editId} className="text-caption">
            {t("chat.teach.changeLabel")}
          </label>
          <Textarea
            id={editId}
            rows={2}
            value={value}
            disabled={lesson.data === undefined && draft === null}
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setState("shown");
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={value.trim() === ""}>
              {t("common.save")}
            </Button>
          </span>
        </form>
      ) : null}
      {error ? (
        <p className="text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The `learned` block (#509): "Learned: *Has a sister named Maya.*" with Undo per fact. */
export function LearnedLine({ items }: { items: readonly LearnedFact[] }): ReactElement {
  const call = useCall();
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  return (
    <ul
      className="my-1 flex flex-col gap-0.5 text-callout text-label-secondary"
      data-testid="learned"
    >
      {items.map((f) =>
        removed.has(f.factId) ? (
          <li key={f.factId} role="status">
            {t("chat.learned.undone")}
          </li>
        ) : (
          <li key={f.factId} className="flex flex-wrap items-baseline gap-x-2">
            <span>
              {t("chat.learned.label")} <em className="text-label-primary">{f.text}</em>
            </span>
            <Button
              size="xs"
              variant="ghost"
              aria-label={t("chat.learned.undo", { text: f.text })}
              onClick={async () => {
                try {
                  await call("memory.forgetLearned", { factId: f.factId });
                  setRemoved((s) => new Set([...s, f.factId]));
                  setError(null);
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            >
              {t("chat.teach.undo")}
            </Button>
          </li>
        ),
      )}
      {error ? (
        <li className="text-danger-text" role="alert">
          {error}
        </li>
      ) : null}
    </ul>
  );
}
