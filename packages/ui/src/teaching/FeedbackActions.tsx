import type {
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  Message,
  MethodResult,
} from "@psyche/protocol";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { useStore, useStoreState } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { cn } from "../lib/utils.ts";
import { useTeaching } from "./hooks.ts";
import { TaughtLine } from "./TaughtLine.tsx";

export const FEEDBACK_REASONS: readonly FeedbackReason[] = [
  "too_long",
  "wrong_tone",
  "wrong_facts",
  "not_what_i_asked",
  "should_have_asked",
];

/** A one-tap chip: pressed or not (reasons, scopes). */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-callout outline-none transition-colors duration-(--duration-micro) ease-(--ease-standard) focus-visible:ring-3 focus-visible:ring-ring",
        pressed
          ? "border-transparent bg-primary text-primary-foreground"
          : "border-separator-strong text-label-primary hover:bg-fill-tertiary",
      )}
    >
      {children}
    </button>
  );
}

type Given = MethodResult<"feedback.give">;

/**
 * The popover under "Not like this" (teaching loop §5.1): reason chips, "What should I do
 * instead?", scope chips defaulting to the narrowest that makes a lesson, Teach and Cancel.
 */
export function TeachForm({
  person,
  onTeach,
  onCancel,
}: {
  /** Offers "For {person}" when the answer was for someone. */
  person?: string | null;
  onTeach: (input: {
    reason?: FeedbackReason;
    text?: string;
    scope: FeedbackScope;
  }) => Promise<void>;
  onCancel: () => void;
}): ReactElement {
  const textId = useId();
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<FeedbackScope>(person ? "person" : "task_kind");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scopes: { id: FeedbackScope; label: string }[] = [
    { id: "once", label: t("chat.teach.scope.once") },
    ...(person ? [{ id: "person" as const, label: t("chat.teach.scope.person", { person }) }] : []),
    { id: "task_kind", label: t("chat.teach.scope.taskKind") },
    { id: "always", label: t("chat.teach.scope.always") },
  ];
  const canTeach = reason !== null || text.trim() !== "";
  return (
    <form
      className="flex flex-col gap-3"
      aria-label={t("chat.teach.dialog")}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canTeach) return;
        setBusy(true);
        try {
          await onTeach({
            scope,
            ...(reason === null ? {} : { reason }),
            ...(text.trim() === "" ? {} : { text: text.trim() }),
          });
        } catch (err) {
          setError(t("chat.teach.failed", { reason: describeError(err) }));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-caption text-label-secondary">
          {t("chat.teach.reasons")}
        </legend>
        {FEEDBACK_REASONS.map((r) => (
          <Chip key={r} pressed={reason === r} onClick={() => setReason(reason === r ? null : r)}>
            {t(`chat.teach.reason.${r}`)}
          </Chip>
        ))}
      </fieldset>
      <span className="flex flex-col gap-1">
        <label htmlFor={textId} className="text-caption text-label-secondary">
          {t("chat.teach.instead")}
        </label>
        <Textarea
          id={textId}
          rows={2}
          maxLength={500}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </span>
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
        <legend className="mb-1.5 text-caption text-label-secondary">
          {t("chat.teach.scopes")}
        </legend>
        {scopes.map((s) => (
          <Chip key={s.id} pressed={scope === s.id} onClick={() => setScope(s.id)}>
            {s.label}
          </Chip>
        ))}
      </fieldset>
      {error ? (
        <p className="text-callout text-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <span className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!canTeach || busy}>
          {t("chat.teach.teach")}
        </Button>
      </span>
    </form>
  );
}

/** One message's feedback state: Helpful, the popover, and what teaching returned. */
export function useMessageFeedback(message: Message) {
  const store = useStore();
  const teach = useTeaching();
  const [open, setOpen] = useState(false);
  const [helpful, setHelpful] = useState<string | null>(null);
  const [given, setGiven] = useState<Given | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target: FeedbackTarget = { type: "message", id: message.id, threadId: message.threadId };
  const eventId = given?.event.id ?? null;
  // The Gateway notes the feedback in the thread as a `taught` block; then that note shows.
  const noted = useStoreState((s) =>
    eventId === null
      ? false
      : (s.messages[message.threadId] ?? []).some((m) =>
          m.blocks.some((b) => b.type === "taught" && b.feedbackId === eventId),
        ),
  );
  const onHelpful = async () => {
    try {
      if (helpful !== null) {
        await teach.deleteFeedback(helpful);
        setHelpful(null);
      } else {
        const r = await teach.give({ target, kind: "helpful" });
        setHelpful(r.event.id);
      }
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };
  const onTeach = async (input: {
    reason?: FeedbackReason;
    text?: string;
    scope: FeedbackScope;
  }) => {
    const r = await teach.give({
      target,
      kind: input.text === undefined ? "not_helpful" : "correction",
      ...input,
    });
    // "Just this time" fixes the answer: a redo with the instruction, and no lesson.
    if (input.scope === "once") {
      const instruction =
        input.text ?? t(`chat.teach.reason.${input.reason ?? "not_what_i_asked"}`);
      await store.call("chat.send", {
        threadId: message.threadId,
        content: instruction,
        redo: { messageId: message.id, instruction },
      });
    }
    setGiven(r);
    setOpen(false);
  };
  return { open, setOpen, helpful, onHelpful, onTeach, given, noted, error };
}

export type MessageFeedback = ReturnType<typeof useMessageFeedback>;

/**
 * Helpful and Not like this on an agent message (teaching loop §5.1), revealed on hover or focus
 * like the Feed's actions and always shown on touch. Helpful never makes a lesson.
 */
export function FeedbackButtons({
  feedback: f,
  person,
  className,
}: {
  feedback: MessageFeedback;
  person?: string | null;
  className?: string;
}): ReactElement {
  const reveal =
    "opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 aria-expanded:opacity-100 aria-pressed:opacity-100 pointer-coarse:opacity-100";
  return (
    <span className={cn("flex items-center gap-0.5", className)}>
      <Button
        variant="ghost"
        size="icon-xs"
        className={reveal}
        aria-label={t("chat.teach.helpful")}
        aria-pressed={f.helpful !== null}
        onClick={() => void f.onHelpful()}
      >
        <ThumbsUp aria-hidden="true" className={f.helpful !== null ? "fill-current" : undefined} />
      </Button>
      <Popover open={f.open} onOpenChange={f.setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className={reveal}
              aria-label={t("chat.teach.notLikeThis")}
            />
          }
        >
          <ThumbsDown aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <TeachForm
            {...(person === undefined ? {} : { person })}
            onTeach={f.onTeach}
            onCancel={() => f.setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** Under the message after Teach: the quiet line, until the Gateway's own `taught` note shows. */
export function FeedbackNote({ feedback: f }: { feedback: MessageFeedback }): ReactElement | null {
  if (f.error) {
    return (
      <p className="text-callout text-danger-text" role="alert">
        {f.error}
      </p>
    );
  }
  if (f.given === null || f.noted) return null;
  return (
    <TaughtLine
      feedbackId={f.given.event.id}
      lessonId={f.given.lesson?.id ?? null}
      statement={f.given.lesson?.statement ?? null}
    />
  );
}

/** Buttons and note together, for surfaces with room for both (cards, stories). */
export function FeedbackActions({
  message,
  person,
}: {
  message: Message;
  person?: string | null;
}): ReactElement {
  const feedback = useMessageFeedback(message);
  return (
    <div className="group/message flex flex-col">
      <FeedbackButtons feedback={feedback} {...(person === undefined ? {} : { person })} />
      <FeedbackNote feedback={feedback} />
    </div>
  );
}

/** "Used 2 lessons" in an answer's footer; expands to the lessons and Redo without lessons. */
export function UsedLessons({ message }: { message: Message }): ReactElement | null {
  const store = useStore();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = message.lessonsApplied ?? [];
  if (refs.length === 0) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="rounded-full px-1.5 text-caption text-label-secondary outline-none hover:bg-fill-tertiary hover:text-label-primary focus-visible:ring-3 focus-visible:ring-ring"
            data-testid="used-lessons"
          />
        }
      >
        {t("chat.teach.usedLessons", { count: refs.length })}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <section aria-label={t("chat.teach.usedLessonsList")} className="flex flex-col gap-2">
          <h3 className="text-caption text-label-secondary">{t("chat.teach.usedLessonsList")}</h3>
          <ul className="flex flex-col gap-1">
            {refs.map((r) => (
              <li key={r.lessonId} className="text-callout text-label-primary">
                {r.statement}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={async () => {
              try {
                await store.call("chat.send", {
                  threadId: message.threadId,
                  content: t("chat.teach.redoWithout"),
                  redo: { messageId: message.id, withoutLessons: true },
                });
                setOpen(false);
              } catch (err) {
                setError(describeError(err));
              }
            }}
          >
            {t("chat.teach.redoWithout")}
          </Button>
          {error ? (
            <p className="text-callout text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </PopoverContent>
    </Popover>
  );
}
