import type {
  FeedbackReason,
  FeedbackScope,
  FeedbackTarget,
  MethodResult,
  Receipt,
} from "@psyche/protocol";
import { Ellipsis, ThumbsDown } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { t } from "../i18n/core.ts";
import { TeachForm } from "./FeedbackActions.tsx";
import { useTeaching } from "./hooks.ts";
import { STEP_REASONS } from "./StepFeedback.tsx";
import { TaughtLine } from "./TaughtLine.tsx";

/** What a receipt's feedback is about: its tool call, else the approval behind it. */
export function receiptTarget(receipt: Receipt): FeedbackTarget | null {
  if (receipt.toolCallId) return { type: "tool_call", id: receipt.toolCallId };
  if (receipt.approvalId) return { type: "approval", id: receipt.approvalId };
  return null;
}

/**
 * The receipt line's ⋯ menu with "Not like this" (teaching loop §5.1): wrong tool, wrong target,
 * should have asked. The menu floats over the line's end on hover or focus, so no line moves; the
 * Teach form opens under the line, then shows what Psyche will remember.
 */
export function ReceiptFeedback({ receipt }: { receipt: Receipt }): ReactElement | null {
  const teach = useTeaching();
  const [open, setOpen] = useState(false);
  const [given, setGiven] = useState<MethodResult<"feedback.give"> | null>(null);
  const target = receiptTarget(receipt);
  if (target === null) return null;
  const onTeach = async (input: {
    reason?: FeedbackReason;
    text?: string;
    scope: FeedbackScope;
  }) => {
    setGiven(
      await teach.give({
        target,
        kind: input.text === undefined ? "not_helpful" : "correction",
        ...input,
      }),
    );
    setOpen(false);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute end-0 top-0.5 bg-canvas opacity-0 group-hover/receipt:opacity-100 group-focus-within/receipt:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              aria-label={t("chat.receipt.more", { summary: receipt.summary })}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <ThumbsDown aria-hidden="true" /> {t("chat.teach.notLikeThis")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open ? (
        <div className="mt-1 mb-2 max-w-sm rounded-lg bg-surface-raised p-2.5 shadow-elevation-1">
          <TeachForm reasons={STEP_REASONS} onTeach={onTeach} onCancel={() => setOpen(false)} />
        </div>
      ) : given !== null ? (
        <TaughtLine
          feedbackId={given.event.id}
          lessonId={given.lesson?.id ?? null}
          statement={given.lesson?.statement ?? null}
        />
      ) : null}
    </>
  );
}
