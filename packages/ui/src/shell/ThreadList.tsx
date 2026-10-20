import type { ThreadListEntry } from "@psyche/protocol";
import { ChevronRight, Ellipsis, EyeOff, Pin, SquarePen } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { useThreads } from "../data/index.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";

function StatusDotFor({ entry }: { entry: ThreadListEntry }): ReactElement | null {
  const a = entry.activity;
  if (a.awaitingApproval + a.awaitingInput > 0) {
    return <span className="size-2 rounded-full bg-approval" title="Needs you" />;
  }
  if (a.running > 0) return <span className="size-2 rounded-full bg-accent-9" title="Running" />;
  return null;
}

export interface ThreadRowProps {
  entry: ThreadListEntry;
  active: boolean;
  now: number;
  onOpen: () => void;
  onRename?: (title: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  onPin?: (pinned: boolean) => void;
  onExport?: (format: "markdown" | "json" | "html") => void;
}

/** Row: title, time, a status dot for running or waiting work, channel / incognito icon (§2.2). */
export function ThreadRow({
  entry,
  active,
  now,
  onOpen,
  onRename,
  onArchive,
  onRestore,
  onPin,
  onExport,
}: ThreadRowProps): ReactElement {
  const t = entry.thread;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const needs = entry.activity.awaitingApproval + entry.activity.awaitingInput;
  return (
    <li className={cn("group/row flex items-center gap-1 rounded-md pr-1", active && "bg-gray-4")}>
      {editing ? (
        <form
          className="flex-1 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (title.trim() && title !== t.title) onRename?.(title.trim());
          }}
        >
          <Input
            aria-label="Thread title"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setEditing(false)}
            className="h-7"
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-current={active ? "page" : undefined}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-gray-3"
          data-testid="thread-row"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {t.kind === "incognito" ? (
              <EyeOff className="size-3.5 shrink-0 text-gray-11" aria-label="Incognito" />
            ) : null}
            {t.pinned ? (
              <Pin className="size-3.5 shrink-0 text-gray-11" aria-label="Pinned" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
            <StatusDotFor entry={entry} />
            {needs > 0 ? (
              <span className="sr-only">, needs you</span>
            ) : entry.activity.running > 0 ? (
              <span className="sr-only">, running</span>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground">
              {t.lastMessageAt ? formatRelative(t.lastMessageAt, now) : ""}
            </span>
          </span>
          {entry.lastMessage ? (
            <span className="w-full truncate text-xs text-muted-foreground">
              {entry.lastMessage.role === "user" ? "You: " : ""}
              {entry.lastMessage.text}
            </span>
          ) : null}
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              aria-label={`More for ${t.title}`}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename ? (
            <DropdownMenuItem onClick={() => setEditing(true)}>Rename</DropdownMenuItem>
          ) : null}
          {onPin ? (
            <DropdownMenuItem onClick={() => onPin(!t.pinned)}>
              {t.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
          ) : null}
          {onExport ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onExport("markdown")}>
                Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")}>Export as JSON</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("html")}>Export as HTML</DropdownMenuItem>
            </>
          ) : null}
          {t.kind !== "main" && (onArchive || onRestore) ? (
            <>
              <DropdownMenuSeparator />
              {t.archivedAt == null ? (
                <DropdownMenuItem onClick={onArchive}>Archive</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={onRestore}>Restore</DropdownMenuItem>
              )}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export interface ThreadListProps {
  activeThreadId: string | null;
  onOpen: (threadId: string) => void;
  onNewSideChat?: () => void;
  onExport?: (threadId: string, format: "markdown" | "json" | "html") => void;
  now?: number;
}

/**
 * Thread list (UI design §2.2): one persistent main chat plus side chats; search filter, new side
 * chat (⌘N), rename, pin, archive / restore (the main chat cannot be archived), "Archived (n)".
 */
export function ThreadList({
  activeThreadId,
  onOpen,
  onNewSideChat,
  onExport,
  now: fixedNow,
}: ThreadListProps): ReactElement {
  const now = useNow(60_000, fixedNow);
  const threads = useThreads();
  const [filter, setFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Matches the title or the last line (§2.2).
  const match = (e: ThreadListEntry) =>
    `${e.thread.title} ${e.lastMessage?.text ?? ""}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase());
  const row = (e: ThreadListEntry) => (
    <ThreadRow
      key={e.thread.id}
      entry={e}
      active={e.thread.id === activeThreadId}
      now={now}
      onOpen={() => onOpen(e.thread.id)}
      onRename={(title) => void threads.rename(e.thread.id, title)}
      onPin={(p) => void threads.pin(e.thread.id, p)}
      onArchive={() => void threads.archive(e.thread.id)}
      onRestore={() => void threads.restore(e.thread.id)}
      {...(onExport
        ? { onExport: (f: "markdown" | "json" | "html") => onExport(e.thread.id, f) }
        : {})}
    />
  );
  const side = threads.active
    .filter(match)
    .sort((a, b) => Number(b.thread.pinned) - Number(a.thread.pinned));
  return (
    <aside
      aria-label="Threads"
      className="flex h-full w-[var(--thread-list-width)] flex-col border-r border-gray-6 bg-gray-1"
    >
      {/* 56 px, like the agent and pane headers, so their borders end on one line (§4.1). */}
      <div className="threads-header flex h-14 shrink-0 items-center gap-1 border-b border-gray-6 px-2">
        <Input
          aria-label="Filter threads"
          placeholder="Search threads"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8"
        />
        {onNewSideChat ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNewSideChat}
            aria-label="New side chat"
            aria-keyshortcuts="Meta+N"
          >
            <SquarePen aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {threads.loading && threads.all.length === 0 ? (
        <div className="flex flex-col gap-1 p-2" role="status" aria-label="Loading threads">
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {threads.main && match(threads.main) ? (
            <ul aria-label="Main chat">{row(threads.main)}</ul>
          ) : null}
          <h2 className="text-label mt-2 px-2 text-muted-foreground">Side chats</h2>
          {side.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              {filter ? "No threads match." : "No side chats yet."}
            </p>
          ) : (
            <ul aria-label="Side chats" className="flex flex-col">
              {side.map(row)}
            </ul>
          )}
          {threads.archived.length > 0 ? (
            <div>
              <button
                type="button"
                className="flex items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((s) => !s)}
              >
                <ChevronRight
                  className={cn("size-3.5", showArchived && "rotate-90")}
                  aria-hidden="true"
                />
                Archived ({threads.archived.length})
              </button>
              {showArchived ? (
                <ul aria-label="Archived" className="flex flex-col">
                  {threads.archived.filter(match).map(row)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
