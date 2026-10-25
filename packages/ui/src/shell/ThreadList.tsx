import type { ThreadListEntry } from "@psyche/protocol";
import {
  Bot,
  ChevronRight,
  Clock,
  Ellipsis,
  EyeOff,
  type LucideIcon,
  Pin,
  Plus,
  Radio,
  Search,
} from "lucide-react";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
import { SelectionPill } from "./motion.tsx";

/**
 * How the current row is marked. Inside the sidebar a shared pill moves between rows
 * (`layoutId`); `instant` places it without movement after a keyboard choice (motion.md §4.4).
 * Elsewhere (the compact drawer) the row is filled in place.
 */
export const SelectionContext = createContext<{ pill: boolean; instant: boolean }>({
  pill: false,
  instant: false,
});

/** The fill or the moving pill behind the current row. */
export function CurrentMark({ active }: { active: boolean }): ReactElement | null {
  const { pill, instant } = useContext(SelectionContext);
  if (!active) return null;
  return pill ? (
    <SelectionPill instant={instant} />
  ) : (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 inset-x-1 rounded-sm bg-selection"
    />
  );
}

/** A leading glyph for threads that aren't plain chats: incognito, a channel, an automation. */
const KIND_GLYPH: Partial<Record<ThreadListEntry["thread"]["kind"], LucideIcon>> = {
  incognito: EyeOff,
  channel: Radio,
  automation: Clock,
  subagent: Bot,
};

function kindLabel(kind: ThreadListEntry["thread"]["kind"]): string | null {
  switch (kind) {
    case "incognito":
      return t("shell.threads.incognito");
    case "channel":
      return t("shell.sidebar.channel");
    case "automation":
      return t("shell.sidebar.automation");
    case "subagent":
      return t("shell.sidebar.subagent");
    default:
      return null;
  }
}

/** The trailing status glyph: waiting on the owner beats running (one glyph per state, §3.6). */
function StatusGlyph({ entry }: { entry: ThreadListEntry }): ReactElement | null {
  const a = entry.activity;
  if (a.awaitingApproval + a.awaitingInput > 0) {
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-approval"
        title={t("shell.threads.needsYou")}
        data-testid="thread-status"
        data-status="needs-you"
      />
    );
  }
  if (a.running > 0)
    return (
      <span
        className="size-2 shrink-0 rounded-full bg-accent-9"
        title={t("shell.threads.running")}
        data-testid="thread-status"
        data-status="running"
      />
    );
  return null;
}

/** A thread's title as the sidebar shows it: the main chat by name, others by title. */
export function threadTitle(entry: ThreadListEntry): string {
  return entry.thread.kind === "main"
    ? t("shell.threads.mainChat")
    : entry.thread.title || t("shell.sidebar.untitled");
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

/**
 * One 28 px source-list row (redesign §5.1): a leading kind glyph, the title, then the status
 * glyph while work runs or waits, else the time of the last message. The last line is the row's
 * tooltip; ⋯ holds rename, pin, export, context and archive.
 */
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
  const Glyph = KIND_GLYPH[th.kind];
  const glyphLabel = kindLabel(th.kind);
  const status = <StatusGlyph entry={entry} />;
  const lastLine = entry.lastMessage
    ? entry.lastMessage.role === "user"
      ? t("shell.threads.youSaid", { text: entry.lastMessage.text })
      : entry.lastMessage.text
    : undefined;
  return (
    <li className="group/row relative flex h-7 items-center" data-thread-kind={th.kind}>
      <CurrentMark active={active} />
      {editing ? (
        <form
          className="relative flex-1 px-1"
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
            className="h-6"
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-current={active ? "page" : undefined}
          title={lastLine}
          className="relative flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-3 text-start text-body text-label-primary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="thread-row"
          data-sidebar-item=""
        >
          {Glyph ? (
            <Glyph
              className="size-3.5 shrink-0 text-label-secondary"
              strokeWidth={1.75}
              role="img"
              aria-label={glyphLabel ?? undefined}
            />
          ) : null}
          {th.pinned ? (
            <Pin
              className="size-3.5 shrink-0 text-label-secondary"
              strokeWidth={1.75}
              role="img"
              aria-label={t("shell.threads.pinned")}
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{threadTitle(entry)}</span>
          {needs > 0 ? (
            <span className="sr-only">{t("shell.threads.srNeedsYou")}</span>
          ) : entry.activity.running > 0 ? (
            <span className="sr-only">{t("shell.threads.srRunning")}</span>
          ) : null}
          {needs > 0 || entry.activity.running > 0 ? (
            status
          ) : th.lastMessageAt ? (
            <time
              dateTime={th.lastMessageAt}
              className="shrink-0 text-callout text-label-tertiary tabular-nums group-hover/row:invisible group-focus-within/row:invisible"
            >
              {formatPast(th.lastMessageAt, now)}
            </time>
          ) : null}
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute end-2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              aria-label={t("shell.threads.moreFor", { title: threadTitle(entry) })}
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename && th.kind !== "main" ? (
            <DropdownMenuItem onClick={() => setEditing(true)}>
              {t("shell.threads.rename")}
            </DropdownMenuItem>
          ) : null}
          {onPin && th.kind !== "main" ? (
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

/** A last-message time is never in the future: clock skew or a stale tick reads "just now". */
export function formatPast(iso: string, now: number): string {
  return formatRelative(new Date(Math.min(Date.parse(iso), now)).toISOString(), now);
}

export interface ThreadGroupProps {
  activeThreadId: string | null;
  onOpen: (threadId: string) => void;
  onNewSideChat?: () => void;
  onExport?: (threadId: string, format: "markdown" | "json" | "html") => void;
  now?: number;
  /** Opens the filter field (⌘F inside the sidebar); bumps reveal it again. */
  filterToken?: number;
}

/**
 * The sidebar's "Threads" group (redesign §5.1, UI design §2.2): a sentence-case header with a
 * filter toggle and `+` (new side chat, ⌘N); the main chat first, then side chats by activity
 * (pinned first); "Archived (n)" as a disclosure. The filter matches titles and last lines.
 */
export function ThreadGroup({
  activeThreadId,
  onOpen,
  onNewSideChat,
  onExport,
  now: fixedNow,
  filterToken = 0,
}: ThreadGroupProps): ReactElement {
  // The minute tick only re-renders; the clock is read at render (#555). A hidden window throttles
  // the timer, so a new message re-rendered the list against a minutes-old `now` ("in 4 min").
  const tick = useNow(60_000, fixedNow);
  const now = fixedNow ?? Math.max(tick, Date.now());
  const threads = useThreads();
  const store = useStore();
  const [limitsFor, setLimitsFor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (filterToken === 0) return;
    setFiltering(true);
    requestAnimationFrame(() => filterRef.current?.focus());
  }, [filterToken]);
  // Matches the title or the last line (§2.2).
  const match = (e: ThreadListEntry) =>
    `${threadTitle(e)} ${e.lastMessage?.text ?? ""}`
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
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col" data-testid="thread-group">
      <div className="group/head flex h-7 items-center gap-0.5 ps-3 pe-1">
        <h2 id={headingId} className="min-w-0 flex-1 text-caption text-label-tertiary">
          {t("shell.threads.region")}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("shell.sidebar.filterToggle")}
          aria-pressed={filtering}
          aria-keyshortcuts="Meta+F"
          onClick={() => {
            setFiltering((f) => !f);
            if (filtering) setFilter("");
            else requestAnimationFrame(() => filterRef.current?.focus());
          }}
          className="text-label-secondary"
        >
          <Search aria-hidden="true" />
        </Button>
        {onNewSideChat ? (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onNewSideChat}
            aria-label={t("shell.threads.newSideChat")}
            aria-keyshortcuts="Meta+N"
            className="text-label-secondary"
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {filtering ? (
        <div className="px-2 pb-1">
          <Input
            ref={filterRef}
            type="search"
            aria-label={t("shell.threads.filter")}
            placeholder={t("shell.threads.search")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setFilter("");
                setFiltering(false);
              }
            }}
            className="h-7"
          />
        </div>
      ) : null}
      {threads.loading && threads.all.length === 0 ? (
        <div
          className="flex flex-col gap-1 px-2"
          role="status"
          aria-label={t("shell.threads.loading")}
        >
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
          <Skeleton className="h-7" />
        </div>
      ) : (
        <>
          <ul aria-label={t("shell.threads.region")} className="flex flex-col">
            {threads.main && match(threads.main) ? row(threads.main) : null}
            {side.map(row)}
          </ul>
          {side.length === 0 && filter ? (
            <p className="px-3 py-1 text-callout text-label-tertiary">
              {t("shell.threads.noMatch")}
            </p>
          ) : null}
          {threads.archived.length > 0 ? (
            <div>
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1 rounded-sm px-3 text-start text-body text-label-secondary outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((s) => !s)}
                data-sidebar-item=""
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-(--duration-micro)",
                    showArchived ? "rotate-90" : "rtl:rotate-180",
                  )}
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
        </>
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
    </section>
  );
}

export interface ThreadListProps extends ThreadGroupProps {
  /** Extra content above the group (the compact drawer's title). */
  header?: ReactNode;
}

/**
 * The Threads group on its own (the compact threads drawer, §5.11): a scrolling column on the
 * sidebar material.
 */
export function ThreadList({ header, ...props }: ThreadListProps): ReactElement {
  return (
    <aside
      aria-label={t("shell.threads.region")}
      className="flex h-full min-h-0 flex-col overflow-y-auto material-sidebar py-2"
    >
      {header}
      <ThreadGroup {...props} />
    </aside>
  );
}
