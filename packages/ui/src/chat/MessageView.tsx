import type { Message, Task } from "@psyche/protocol";
import { CornerUpLeft, Ellipsis, GitBranch, Pencil } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { MessageBlocks } from "../blocks/MessageBlocks.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { formatTime } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
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
 * Chat message anatomy (UI design §3.2). User: right-aligned light bubble (gray-3). Agent: no
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
  const canEdit = onEdit !== undefined && message.role === "user";
  const time = formatTime(message.createdAt);
  const quote = quoted ? (
    <button
      type="button"
      onClick={() => onJumpTo?.(quoted.id)}
      className="mb-1 line-clamp-2 border-l-2 border-gray-7 pl-2 text-left text-sm text-muted-foreground hover:text-foreground"
      aria-label="Jump to the quoted message"
    >
      {messageText(quoted)}
    </button>
  ) : null;

  if (message.role === "system") {
    return (
      <div className="my-2 text-center text-xs text-gray-11" data-role="system">
        {message.blocks.map((b, i) =>
          b.type === "text" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no ids and never reorder
            <p key={i}>{b.md}</p>
          ) : b.type === "compaction" ? (
            <CompactionMessage key={b.compactionId} message={message} block={b} />
          ) : null,
        )}
      </div>
    );
  }

  const actions =
    onReply || onFork || canEdit ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
              aria-label="Message actions"
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onReply ? (
            <DropdownMenuItem onClick={() => onReply(message)}>
              <CornerUpLeft aria-hidden="true" /> Reply
            </DropdownMenuItem>
          ) : null}
          {onFork ? (
            <DropdownMenuItem onClick={() => onFork(message)}>
              <GitBranch aria-hidden="true" /> Continue in a side chat
            </DropdownMenuItem>
          ) : null}
          {canEdit ? (
            <DropdownMenuItem onClick={() => setEditing(messageText(message))}>
              <Pencil aria-hidden="true" /> Edit and resend
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  if (message.role === "user") {
    return (
      <article
        id={`message-${message.id}`}
        className="group/message my-2 flex flex-col items-end"
        aria-label={`You, ${time}`}
        data-role="user"
      >
        <div className="flex max-w-[80%] items-start gap-1">
          {actions}
          {editing !== null && onEdit ? (
            <form
              className="flex w-full flex-col gap-2 rounded-2xl bg-gray-3 px-3.5 py-2"
              aria-label="Edit and resend"
              onSubmit={(e) => {
                e.preventDefault();
                const text = editing.trim();
                if (text === "") return;
                setEditing(null);
                onEdit(message, text);
              }}
            >
              <label htmlFor={editId} className="text-xs text-muted-foreground">
                Edits are sent in a side chat forked from here; this chat keeps the original.
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
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={editing.trim() === ""}>
                  Resend as a side chat
                </Button>
              </div>
            </form>
          ) : (
            <div className="rounded-2xl bg-gray-3 px-3.5 py-2 text-base text-foreground">
              {quote}
              <MessageBlocks message={message} />
            </div>
          )}
        </div>
        <span className="mt-0.5 text-xs text-muted-foreground">{time}</span>
      </article>
    );
  }

  return (
    <article
      id={`message-${message.id}`}
      className="group/message my-2"
      aria-label={`${persona.name}, ${time}`}
      data-role="agent"
    >
      {fromTask ? (
        <p className="my-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-gray-5" aria-hidden="true" />
          from task: {fromTask.title}
          <span className="h-px flex-1 bg-gray-5" aria-hidden="true" />
        </p>
      ) : null}
      {showHeader ? (
        <div className="mb-1 flex items-center gap-2">
          <Avatar
            name={persona.name}
            creature={persona.creature}
            {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
            size={20}
            decorative
          />
          <span className="text-sm font-semibold">{persona.name}</span>
          <span className="text-xs text-muted-foreground">{time}</span>
          <span className="ml-auto">{actions}</span>
        </div>
      ) : null}
      <div className={cn("pl-7", message.provenance === "untrusted" && "text-foreground")}>
        {quote}
        <MessageBlocks
          message={message}
          streamingText={streamingText ?? null}
          pinChecklist={pinChecklist}
          {...(onWrapUpAction ? { onWrapUpAction } : {})}
        />
      </div>
    </article>
  );
}
