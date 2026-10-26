import type { Message, Task } from "@psyche/protocol";
import { CornerUpLeft, Ellipsis, GitBranch, GraduationCap, Pencil } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { MessageBlocks } from "../blocks/MessageBlocks.tsx";
import { RegisteredBlock } from "../blocks/registry.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { t } from "../i18n/core.ts";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
import {
  FeedbackNote,
  TeachPanel,
  UsedLessons,
  useMessageFeedback,
} from "../teaching/FeedbackActions.tsx";
import { TaughtLine } from "../teaching/TaughtLine.tsx";
import { CompactionMessage } from "./context/connected.tsx";

/** First text of a message, for quotes and previews. */
export function messageText(message: Message): string {
  return message.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.md : ""))
    .join("\n")
    .trim();
}

export interface MessageViewProps {
  message: Message;
  streamingText?: string | null;
  /** Quoted message (reply-to), shown as a two-line quote with a jump link. */
  quoted?: Message | null;
  /** Out-of-turn message from a background task: "from task: <title>" divider (§3.2). */
  fromTask?: Pick<Task, "id" | "title"> | null;
  pinChecklist?: boolean;
  /** Show the avatar and name (first message of a run). */
  showHeader?: boolean;
  onReply?: (message: Message) => void;
  onFork?: (message: Message) => void;
  /** Edit a user message and resend it as a fork (E5): called with the edited text. */
  onEdit?: (message: Message, text: string) => void;
  onJumpTo?: (messageId: string) => void;
  onWrapUpAction?: (text: string) => void;
}

/**
 * Chat message anatomy (UI design §3.2). User: end-aligned light bubble (gray-3). Agent: no
 * bubble, 20 px avatar, name and time per run. System: centered, small, gray-11, Psyche's voice.
 */
export function MessageView({
  message,
  streamingText,
  quoted,
  fromTask,
  pinChecklist = false,
  showHeader = true,
  onReply,
  onFork,
  onEdit,
  onJumpTo,
  onWrapUpAction,
}: MessageViewProps): ReactElement {
  const persona = usePersona();
  const editId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const feedback = useMessageFeedback(message);
  const canEdit = onEdit !== undefined && message.role === "user";
  const time = formatTime(message.createdAt);
  const quote = quoted ? (
    <button
      type="button"
      onClick={() => onJumpTo?.(quoted.id)}
      className="mb-1 line-clamp-2 cursor-default border-s-2 border-separator-strong ps-2 text-start text-callout text-label-secondary hover:text-label-primary"
      aria-label={t("chat.message.jumpToQuote")}
    >
      {messageText(quoted)}
    </button>
  ) : null;

  if (message.role === "system") {
    return (
      <div className="mt-5 text-center text-callout text-label-secondary" data-role="system">
        {message.blocks.map((b, i) =>
          b.type === "text" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no ids and never reorder
            <p key={i}>{b.md}</p>
          ) : b.type === "compaction" ? (
            <CompactionMessage key={b.compactionId} message={message} block={b} />
          ) : b.type === "specialist_result" ? (
            // A specialist's result in the thread that spawned it (chat experience §4.5).
            <div key={b.taskId} className="mt-1 text-start">
              <RegisteredBlock block={b} ctx={{ message, pinChecklist: false, untrusted: false }} />
            </div>
          ) : b.type === "taught" ? (
            // The Gateway's note after teaching (teaching loop §5.1), quiet and start-aligned.
            <div key={b.feedbackId} className="ps-7 text-start">
              <TaughtLine feedbackId={b.feedbackId} lessonId={b.lessonId} statement={b.statement} />
            </div>
          ) : null,
        )}
      </div>
    );
  }

  // Teaching lives in the ⋯ menu (no thumbs): it saves a local lesson, never provider feedback.
  const canTeach = message.role === "agent" && !streamingText;
  const actions =
    onReply || onFork || canEdit || canTeach ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              aria-label={t("chat.message.actions")}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onReply ? (
            <DropdownMenuItem onClick={() => onReply(message)}>
              <CornerUpLeft className="rtl:-scale-x-100" aria-hidden="true" />{" "}
              {t("chat.message.reply")}
            </DropdownMenuItem>
          ) : null}
          {onFork ? (
            <DropdownMenuItem onClick={() => onFork(message)}>
              <GitBranch aria-hidden="true" /> {t("chat.message.fork")}
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            <DropdownMenuItem onClick={() => setEditing(messageText(message))}>
              <Pencil aria-hidden="true" /> {t("chat.message.editResend")}
            </DropdownMenuItem>
          ) : null}
          {canTeach ? (
            <DropdownMenuItem onClick={() => feedback.setOpen(true)}>
              <GraduationCap aria-hidden="true" /> {t("chat.teach.dialog")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  // Times show on hover or focus (redesign-2026 §5.2), never under every message; the article's
  // label carries the time for assistive tech.
  const hoverTime = (
    <time
      dateTime={message.createdAt}
      className="shrink-0 text-subheadline text-label-tertiary tabular-nums opacity-0 transition-opacity duration-(--duration-micro) ease-(--ease-standard) group-focus-within/message:opacity-100 group-hover/message:opacity-100 pointer-coarse:opacity-100"
      aria-hidden="true"
      data-testid="message-time"
    >
      {time}
    </time>
  );

  if (message.role === "user") {
    return (
      <article
        id={`message-${message.id}`}
        className="group/message mt-5 flex flex-col items-end"
        aria-label={t("chat.message.userLabel", { time })}
        data-role="user"
      >
        <div className="flex max-w-[80%] items-center gap-2">
          {hoverTime}
          {actions}
          {editing !== null && onEdit ? (
            <form
              className="flex w-full flex-col gap-2 rounded-xl bg-fill-secondary px-4 py-2.5"
              aria-label={t("chat.message.editResend")}
              onSubmit={(e) => {
                e.preventDefault();
                const text = editing.trim();
                if (text === "") return;
                setEditing(null);
                onEdit(message, text);
              }}
            >
              <label htmlFor={editId} className="text-callout text-label-secondary">
                {t("chat.message.editHint")}
              </label>
              <Textarea
                id={editId}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                rows={3}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" size="sm" disabled={editing.trim() === ""}>
                  {t("chat.message.resendAsSideChat")}
                </Button>
              </div>
            </form>
          ) : (
            <div className="rounded-xl bg-fill-secondary px-4 py-2.5 text-reading text-label-primary">
              {quote}
              <MessageBlocks message={message} />
            </div>
          )}
        </div>
      </article>
    );
  }

  return (
    <article
      id={`message-${message.id}`}
      className={cn("group/message relative", showHeader || fromTask ? "mt-5" : "mt-2")}
      aria-label={t("chat.message.agentLabel", { name: persona.name, time })}
      data-role="agent"
    >
      {fromTask ? (
        // Out-of-turn task messages: a hairline with the task's name (§5.2).
        <p className="mb-3 flex items-center gap-3 text-caption text-label-secondary">
          <span className="flex-1 border-t-[0.5px] border-separator-strong" aria-hidden="true" />
          {t("chat.message.fromTask", { title: fromTask.title })}
          <span className="flex-1 border-t-[0.5px] border-separator-strong" aria-hidden="true" />
        </p>
      ) : null}
      {!showHeader && actions ? (
        // Without a header row, ⋯ sits in the empty avatar gutter so it never covers the text.
        <span className="absolute start-0 top-0">{actions}</span>
      ) : null}
      {showHeader ? (
        <div className="mb-1 flex h-6 items-center gap-2">
          <Avatar
            name={persona.name}
            creature={persona.creature}
            {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
            size={20}
            decorative
          />
          <span className="text-headline text-label-primary">{persona.name}</span>
          {hoverTime}
          <span className="ms-auto flex items-center gap-0.5">{actions}</span>
        </div>
      ) : null}
      <div className="ps-7">
        {quote}
        <MessageBlocks
          message={message}
          streamingText={streamingText ?? null}
          pinChecklist={pinChecklist}
          {...(onWrapUpAction ? { onWrapUpAction } : {})}
        />
        {/* Teaching (§5.1): the note after Teach and "Used n lessons", only when there is one. */}
        <TeachPanel feedback={feedback} />
        <FeedbackNote feedback={feedback} />
        <UsedLessons message={message} />
      </div>
    </article>
  );
}
