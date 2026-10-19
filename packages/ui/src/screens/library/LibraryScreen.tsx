import type { LibraryItem, Task } from "@psyche/protocol";
import {
  Eye,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LayoutGrid,
  List,
  ListChecks,
  MessageCircle,
  Package,
  Settings2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.tsx";
import { useLibrary, useTasks } from "../../data/hooks.ts";
import { formatDate } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  ScreenHeader,
  useDelayedFlag,
} from "../feed/states.tsx";
import {
  applyFilters,
  DATE_FILTERS,
  type DateFilter,
  fileType,
  formatBytes,
  isReadOnly,
  KIND_LABEL,
  LIBRARY_SECTIONS,
  type LibraryFilters,
  type LibrarySection,
  NO_FILTERS,
  sectionOf,
  workspacePath,
} from "./library-items.ts";

export interface LibraryItemActions {
  onOpen?: (item: LibraryItem) => void;
  onReveal?: (item: LibraryItem) => void;
  onQuickLook?: (item: LibraryItem) => void;
  onSendToChat?: (item: LibraryItem) => void;
  onTrust?: (item: LibraryItem) => void;
  onOpenTask?: (taskId: string) => void;
}

export interface LibraryItemViewProps extends LibraryItemActions {
  item: LibraryItem;
  layout?: "grid" | "list";
  /** Title of the task that produced it, for the Task chip. */
  taskTitle?: string | null;
}

function ItemIcon({ item }: { item: LibraryItem }): ReactElement {
  const cls = "size-4 shrink-0 text-gray-11";
  switch (item.kind) {
    case "image":
      return <ImageIcon className={cls} aria-hidden="true" />;
    case "artifact":
      return <Package className={cls} aria-hidden="true" />;
    case "system":
      return <Settings2 className={cls} aria-hidden="true" />;
    default:
      return <FileText className={cls} aria-hidden="true" />;
  }
}

/** One Library item: name, kind, size, Task chip, tags and actions (UI design §3.12). */
export function LibraryItemView({
  item,
  layout = "list",
  taskTitle,
  onOpen,
  onReveal,
  onQuickLook,
  onSendToChat,
  onTrust,
  onOpenTask,
}: LibraryItemViewProps): ReactElement {
  const nameId = useId();
  const quarantined = item.quarantined === true;
  const system = item.kind === "system";
  const taskId = item.taskId ?? null;
  return (
    <article
      aria-labelledby={nameId}
      className={cn(
        "flex gap-3 text-sm",
        layout === "grid"
          ? "h-full flex-col rounded-lg border border-gray-6 bg-gray-2 p-3"
          : "flex-wrap items-center border-b border-gray-6 px-1 py-2",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <ItemIcon item={item} />
          <span id={nameId} className="min-w-0 truncate font-medium">
            {item.name}
          </span>
          {quarantined ? (
            <Badge variant="outline" className="border-approval-border text-approval-text">
              <ShieldAlert aria-hidden="true" />
              Quarantined
            </Badge>
          ) : null}
          {isReadOnly(item) ? <Badge variant="outline">Read-only</Badge> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {KIND_LABEL[item.kind]} · {fileType(item)} · {formatBytes(item.size)} ·{" "}
          {formatDate(item.createdAt)}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {taskId !== null ? (
            <button
              type="button"
              onClick={() => onOpenTask?.(taskId)}
              className="inline-flex items-center gap-1 rounded-full border border-gray-6 px-2 py-0.5 text-xs text-gray-11 hover:bg-gray-3 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ListChecks className="size-3" aria-hidden="true" />
              Task: {taskTitle ?? "open activity"}
            </button>
          ) : null}
          {item.tags.map((t) => (
            <Badge key={t} variant="secondary">
              #{t}
            </Badge>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={onOpen === undefined}
          onClick={() => onOpen?.(item)}
          aria-label={`Open ${item.name}${system ? " in the editor" : ""}`}
        >
          <FolderOpen aria-hidden="true" />
          {system ? "Open in editor" : "Open"}
        </Button>
        {quarantined && onTrust ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onTrust(item)}>
            <ShieldCheck aria-hidden="true" />
            Trust this file
          </Button>
        ) : null}
        {onQuickLook && !system ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Quick Look ${item.name}`}
            onClick={() => onQuickLook(item)}
          >
            <Eye aria-hidden="true" />
          </Button>
        ) : null}
        {onReveal ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Reveal ${item.name} in Finder`}
            onClick={() => onReveal(item)}
          >
            Reveal
          </Button>
        ) : null}
        {onSendToChat && !system ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={`Send ${item.name} to chat`}
            onClick={() => onSendToChat(item)}
          >
            <MessageCircle aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export interface LibraryViewProps extends LibraryItemActions {
  items: readonly LibraryItem[];
  section: LibrarySection;
  onSectionChange?: (section: LibrarySection) => void;
  layout?: "grid" | "list";
  onLayoutChange?: (layout: "grid" | "list") => void;
  filters?: LibraryFilters;
  onFiltersChange?: (filters: LibraryFilters) => void;
  /** Task titles by id, for chips and the source-task filter. */
  taskTitles?: Readonly<Record<string, string>>;
  loading?: boolean;
  loadingDelayMs?: number;
  error?: string | null;
  onRetry?: () => void;
  persona?: string;
  /** The empty state's one action. */
  onOpenChat?: () => void;
  now: number;
}

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";

/** Library (UI design §3.12). Presentational. */
export function LibraryView({
  items,
  section,
  onSectionChange,
  layout = "grid",
  onLayoutChange,
  filters = NO_FILTERS,
  onFiltersChange,
  taskTitles = {},
  loading = false,
  loadingDelayMs = 0,
  error = null,
  onRetry,
  persona = "Wren",
  onOpenChat,
  now,
  ...actions
}: LibraryViewProps): ReactElement {
  const ids = { type: useId(), task: useId(), date: useId() };
  const showSkeleton = useDelayedFlag(loading, loadingDelayMs);
  const inSection = items.filter((i) => sectionOf(i) === section);
  const shown = applyFilters(inSection, filters, now);
  const types = [...new Set(inSection.map(fileType))].sort();
  const taskIds = [
    ...new Set(inSection.map((i) => i.taskId).filter((t): t is string => t != null)),
  ];
  const filtered = filters.type !== null || filters.taskId !== null || filters.date !== "any";
  const spec = LIBRARY_SECTIONS.find((s) => s.id === section) ?? LIBRARY_SECTIONS[0];
  const setFilter = (patch: Partial<LibraryFilters>) => onFiltersChange?.({ ...filters, ...patch });

  let body: ReactElement;
  if (loading) {
    body = showSkeleton ? (
      <LoadingCards
        label="Loading the Library"
        count={6}
        lines={2}
        layout={layout === "grid" ? "grid" : "rows"}
      />
    ) : (
      <div aria-busy="true" className="min-h-24" />
    );
  } else if (error !== null) {
    body = (
      <ErrorState
        what="Psyche couldn't load the Library"
        reason={error}
        did="Your files are untouched."
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (shown.length === 0) {
    body = filtered ? (
      <EmptyState action={{ label: "Clear filters", onClick: () => onFiltersChange?.(NO_FILTERS) }}>
        No files match these filters.
      </EmptyState>
    ) : (
      <EmptyState
        {...(onOpenChat && section !== "system" && section !== "downloads"
          ? { action: { label: `Ask ${persona} to make one`, onClick: onOpenChat } }
          : {})}
      >
        {spec?.empty}
      </EmptyState>
    );
  } else {
    body = (
      <ul
        aria-label={spec?.label}
        className={cn(
          layout === "grid"
            ? "grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3"
            : "flex flex-col",
        )}
      >
        {shown.map((item) => (
          <li key={item.id}>
            <LibraryItemView
              item={item}
              layout={layout}
              taskTitle={item.taskId == null ? null : (taskTitles[item.taskId] ?? null)}
              {...actions}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section aria-label="Library" className="flex flex-col gap-4 p-4">
      <ScreenHeader
        title="Library"
        actions={
          <ToggleGroup
            aria-label="Layout"
            value={[layout]}
            onValueChange={(v) => {
              const next = v[0];
              if (next === "grid" || next === "list") onLayoutChange?.(next);
            }}
          >
            <ToggleGroupItem value="grid" size="sm" aria-label="Grid">
              <LayoutGrid aria-hidden="true" />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" size="sm" aria-label="List">
              <List aria-hidden="true" />
            </ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <Tabs
        value={section}
        onValueChange={(v) => {
          const next = LIBRARY_SECTIONS.find((s) => s.id === v);
          if (next) onSectionChange?.(next.id);
        }}
      >
        <TabsList aria-label="Library sections" className="flex-wrap">
          {LIBRARY_SECTIONS.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={section} className="flex flex-col gap-4 pt-2">
          <fieldset className="m-0 flex flex-wrap items-end gap-3 border-0 p-0">
            <legend className="sr-only">Filters</legend>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.type} className="text-xs text-muted-foreground">
                Type
              </label>
              <select
                id={ids.type}
                className={selectClass}
                value={filters.type ?? ""}
                onChange={(e) => setFilter({ type: e.target.value === "" ? null : e.target.value })}
              >
                <option value="">All types</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.task} className="text-xs text-muted-foreground">
                Source task
              </label>
              <select
                id={ids.task}
                className={selectClass}
                value={filters.taskId ?? ""}
                onChange={(e) =>
                  setFilter({ taskId: e.target.value === "" ? null : e.target.value })
                }
              >
                <option value="">Any task</option>
                {taskIds.map((t) => (
                  <option key={t} value={t}>
                    {taskTitles[t] ?? t}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.date} className="text-xs text-muted-foreground">
                Date
              </label>
              <select
                id={ids.date}
                className={selectClass}
                value={filters.date}
                onChange={(e) => {
                  const d = DATE_FILTERS.find((x) => x.id === e.target.value);
                  setFilter({ date: (d?.id ?? "any") as DateFilter });
                }}
              >
                {DATE_FILTERS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </fieldset>
          {body}
        </TabsContent>
      </Tabs>
    </section>
  );
}

export interface LibraryScreenProps {
  /** Controlled section (from `/library/:section`); uncontrolled when omitted. */
  section?: LibrarySection;
  onSectionChange?: (section: LibrarySection) => void;
  /** Reveal in Finder (mac helper). */
  onReveal?: (item: LibraryItem) => void;
  /** Quick Look (mac helper). */
  onQuickLook?: (item: LibraryItem) => void;
  onSendToChat?: (item: LibraryItem) => void;
  /** Clears the quarantine badge; the protocol has no method for it yet. */
  onTrust?: (item: LibraryItem) => Promise<unknown> | undefined;
  /** Fixed clock (stories, tests) for the date filter. */
  now?: number;
}

/** Connected Library: `library.list`, task titles from `tasks.list`. */
export function LibraryScreen({
  section: controlled,
  onSectionChange,
  onReveal,
  onQuickLook,
  onSendToChat,
  onTrust,
  now: fixedNow,
}: LibraryScreenProps): ReactElement {
  const { navigate, openLibraryItem } = useSlots();
  const persona = usePersona();
  const library = useLibrary();
  const tasks = useTasks();
  const now = useNow(60_000, fixedNow);
  const [own, setOwn] = useState<LibrarySection>("documents");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [trusted, setTrusted] = useState<ReadonlySet<string>>(new Set());
  const section = controlled ?? own;

  const taskTitles = useMemo(
    () => Object.fromEntries(tasks.all.map((t: Task) => [t.id, t.title])),
    [tasks.all],
  );
  const items = useMemo(
    () =>
      library.items.map((i) =>
        trusted.has(i.id) && i.quarantined === true ? { ...i, quarantined: false } : i,
      ),
    [library.items, trusted],
  );

  const open = (item: LibraryItem) => {
    if (item.kind === "system") {
      navigate?.(`/agent/soul?file=${encodeURIComponent(workspacePath(item))}`);
      return;
    }
    openLibraryItem?.(item);
  };

  const trust = (item: LibraryItem) => {
    setTrusted((s) => new Set(s).add(item.id));
    Promise.resolve(onTrust?.(item)).then(
      () => toast(`Trusted ${item.name}.`),
      (err: unknown) => {
        setTrusted((s) => {
          const next = new Set(s);
          next.delete(item.id);
          return next;
        });
        toast.error(
          `Psyche couldn't trust ${item.name} (${err instanceof Error ? err.message : String(err)}). It stays quarantined.`,
        );
      },
    );
  };

  return (
    <LibraryView
      items={items}
      section={section}
      onSectionChange={(s) => {
        setOwn(s);
        setFilters(NO_FILTERS);
        onSectionChange?.(s);
      }}
      layout={layout}
      onLayoutChange={setLayout}
      filters={filters}
      onFiltersChange={setFilters}
      taskTitles={taskTitles}
      loading={library.loading && library.items.length === 0}
      loadingDelayMs={150}
      error={library.items.length === 0 ? library.error : null}
      onRetry={library.reload}
      persona={persona.name}
      onOpenChat={() => navigate?.("/chat")}
      now={now}
      onOpen={open}
      onOpenTask={(id) => navigate?.(`/agent/activity/${id}`)}
      {...(onTrust ? { onTrust: trust } : {})}
      {...(onReveal ? { onReveal } : {})}
      {...(onQuickLook ? { onQuickLook } : {})}
      {...(onSendToChat ? { onSendToChat } : {})}
    />
  );
}
