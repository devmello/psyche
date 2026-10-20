import type { ThreadListEntry } from "@psyche/protocol";
import { ChevronRight, Ellipsis, EyeOff, Pin, SquarePen } from "lucide-react";
import { type ReactElement, useState } from "react";
import { compactWithToast, ThreadContextDialog } from "../chat/context/connected.tsx";
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
import { compactThread, useStore, useThreads } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { formatRelative } from "../lib/format.ts";
import { useNow } from "../lib/use-now.ts";
import { cn } from "../lib/utils.ts";

function StatusDotFor({ entry }: { entry: ThreadListEntry }): ReactElement | null {
  const a = entry.activity;
  if (a.awaitingApproval + a.awaitingInput > 0) {
    return <span className="size-2 rounded-full bg-approval" title={t("shell.threads.needsYou")} />;
  }
  if (a.running > 0)
    return <span className="size-2 rounded-full bg-accent-9" title={t("shell.threads.running")} />;
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
  /** Opens this chat's context limits. */
  onContextLimits?: () => void;
  /** Compacts this chat's earlier turns now. */
  onCompact?: () => void;
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
  onContextLimits,
  onCompact,
}: ThreadRowProps): ReactElement {
  const th = entry.thread;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(th.title);
  const needs = entry.activity.awaitingApproval + entry.activity.awaitingInput;
  return (
    <li className={cn("group/row flex items-center gap-1 rounded-md pe-1", active && "bg-gray-4")}>
      {editing ? (
        <form
          className="flex-1 p-1"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (title.trim() && title !== th.title) onRename?.(title.trim());
          }}
        >
          <Input
            aria-label={t("shell.threads.titleField")}
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
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-gray-3"
          data-testid="thread-row"
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {th.kind === "incognito" ? (
              <EyeOff
                className="size-3.5 shrink-0 text-gray-11"
                aria-label={t("shell.threads.incognito")}
              />
            ) : null}
            {th.pinned ? (
              <Pin
                className="size-3.5 shrink-0 text-gray-11"
                aria-label={t("shell.threads.pinned")}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm">{th.title}</span>
            <StatusDotFor entry={entry} />
            {needs > 0 ? (
              <span className="sr-only">{t("shell.threads.srNeedsYou")}</span>
            ) : entry.activity.running > 0 ? (
              <span className="sr-only">{t("shell.threads.srRunning")}</span>
            ) : null}
            <span className="shrink-0 text-xs text-muted-foreground">
              {th.lastMessageAt ? formatRelative(th.lastMessageAt, now) : ""}
            </span>
          </span>
          {entry.lastMessage ? (
            <span className="w-full truncate text-xs text-muted-foreground">
              {entry.lastMessage.role === "user"
                ? t("shell.threads.youSaid", { text: entry.lastMessage.text })
                : entry.lastMessage.text}
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
              aria-label={t("shell.threads.moreFor", { title: th.title })}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename ? (
            <DropdownMenuItem onClick={() => setEditing(true)}>
              {t("shell.threads.rename")}
            </DropdownMenuItem>
          ) : null}
          {onPin ? (
            <DropdownMenuItem onClick={() => onPin(!th.pinned)}>
              {th.pinned ? t("shell.threads.unpin") : t("shell.threads.pin")}
            </DropdownMenuItem>
          ) : null}
          {onExport ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onExport("markdown")}>
                {t("agent.header.exportMarkdown")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("json")}>
                {t("agent.header.exportJson")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onExport("html")}>
                {t("agent.header.exportHtml")}
              </DropdownMenuItem>
            </>
          ) : null}
          {onContextLimits || onCompact ? (
            <>
              <DropdownMenuSeparator />
              {onContextLimits ? (
                <DropdownMenuItem onClick={onContextLimits}>
                  {t("context.limits.menu")}
                </DropdownMenuItem>
              ) : null}
              {onCompact ? (
                <DropdownMenuItem onClick={onCompact}>
                  {t("context.meter.compactNow")}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
          {th.kind !== "main" && (onArchive || onRestore) ? (
            <>
              <DropdownMenuSeparator />
              {th.archivedAt == null ? (
                <DropdownMenuItem onClick={onArchive}>
                  {t("shell.threads.archive")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={onRestore}>
                  {t("shell.threads.restore")}
                </DropdownMenuItem>
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
  const store = useStore();
  const [limitsFor, setLimitsFor] = useState<string | null>(null);
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
      {...(e.thread.archivedAt == null
        ? {
            onContextLimits: () => setLimitsFor(e.thread.id),
            onCompact: () => void compactWithToast(() => compactThread(store, e.thread.id)),
          }
        : {})}
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
      aria-label={t("shell.threads.region")}
      className="flex h-full w-[var(--thread-list-width)] flex-col border-e border-gray-6 bg-gray-1"
    >
      {/* 56 px, like the agent and pane headers, so their borders end on one line (§4.1). */}
      <div className="threads-header flex h-14 shrink-0 items-center gap-1 border-b border-gray-6 px-2">
        <Input
          aria-label={t("shell.threads.filter")}
          placeholder={t("shell.threads.search")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8"
        />
        {onNewSideChat ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onNewSideChat}
            aria-label={t("shell.threads.newSideChat")}
            aria-keyshortcuts="Meta+N"
          >
            <SquarePen aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {threads.loading && threads.all.length === 0 ? (
        <div
          className="flex flex-col gap-1 p-2"
          role="status"
          aria-label={t("shell.threads.loading")}
        >
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
          <Skeleton className="h-8" />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {threads.main && match(threads.main) ? (
            <ul aria-label={t("shell.threads.mainChat")}>{row(threads.main)}</ul>
          ) : null}
          <h2 className="text-label mt-2 px-2 text-muted-foreground">
            {t("shell.threads.sideChats")}
          </h2>
          {side.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">
              {filter ? t("shell.threads.noMatch") : t("shell.threads.noSideChats")}
            </p>
          ) : (
            <ul aria-label={t("shell.threads.sideChats")} className="flex flex-col">
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
                  className={cn("size-3.5", showArchived ? "rotate-90" : "rtl:rotate-180")}
                  aria-hidden="true"
                />
                {t("shell.threads.archivedCount", { n: threads.archived.length })}
              </button>
              {showArchived ? (
                <ul aria-label={t("shell.threads.archived")} className="flex flex-col">
                  {threads.archived.filter(match).map(row)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {limitsFor !== null ? (
        <ThreadContextDialog
          threadId={limitsFor}
          open
          onOpenChange={(open) => {
            if (!open) setLimitsFor(null);
          }}
        />
      ) : null}
    </aside>
  );
}
