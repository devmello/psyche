import type { FeedbackReason, FeedbackScope, MethodResult, RunStep } from "@psyche/protocol";
import { ThumbsDown } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { TeachForm } from "./FeedbackActions.tsx";
import { useTeaching } from "./hooks.ts";
import { TaughtLine } from "./TaughtLine.tsx";

/** What can be wrong with a step: the wrong tool or target, or it should have asked first. */
export const STEP_REASONS: readonly FeedbackReason[] = [
  "not_what_i_asked",
  "wrong_facts",
  "should_have_asked",
];

/**
 * "Not like this" on a finished tool step (teaching loop §5.1), revealed with the row on hover or
 * focus. The feedback targets the step's tool call; the popover then shows what Psyche will
 * remember, with Undo and Change.
 */
export function StepFeedback({
  step,
  floating = false,
}: {
  step: RunStep;
  /** Over the row's end on hover or focus, taking no width (rows without detail). */
  floating?: boolean;
}): ReactElement | null {
  const teach = useTeaching();
  const [open, setOpen] = useState(false);
  const [given, setGiven] = useState<MethodResult<"feedback.give"> | null>(null);
  if (step.kind !== "tool" || !step.toolCallId) return null;
  const toolCallId = step.toolCallId;
  const onTeach = async (input: {
    reason?: FeedbackReason;
    text?: string;
    scope: FeedbackScope;
  }) => {
    setGiven(
      await teach.give({
        target: { type: "tool_call", id: toolCallId },
        kind: input.text === undefined ? "not_helpful" : "correction",
        ...input,
      }),
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "opacity-0 group-hover/step:opacity-100 group-focus-within/step:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100",
              floating && "absolute end-0 top-0.5 bg-canvas",
            )}
            aria-label={t("chat.teach.notLikeThisStep", { step: step.label })}
          />
        }
      >
        <ThumbsDown aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {given === null ? (
          <TeachForm reasons={STEP_REASONS} onTeach={onTeach} onCancel={() => setOpen(false)} />
        ) : (
          <TaughtLine
            feedbackId={given.event.id}
            lessonId={given.lesson?.id ?? null}
            statement={given.lesson?.statement ?? null}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
