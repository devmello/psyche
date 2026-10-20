import type { LibraryItem, Task } from "@psyche/protocol";
import {
  Ellipsis,
  Eye,
  FileText,
  FolderOpen,
  FolderSearch,
  Image as ImageIcon,
  LayoutGrid,
  Library as LibraryIcon,
  List,
  ListChecks,
  MessageCircle,
  Package,
  PenLine,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { type ReactElement, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  EmptyState,
  ErrorState,
  LoadingCards,
  Page,
  PageHeader,
  useDelayedFlag,
} from "../../components/page.tsx";
import { Badge, badgeVariants } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.tsx";
import { useLibrary, useTasks } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatDate } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { usePersona, useSlots } from "../../slots.tsx";
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

/** One Library item: name, kind, size, Task chip, tags, Open and ⋯ (UI design §3.12). */
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
  const quickLook = onQuickLook && !system ? onQuickLook : undefined;
  const sendToChat = onSendToChat && !system ? onSendToChat : undefined;
  const hasMore = quickLook !== undefined || onReveal !== undefined || sendToChat !== undefined;
  const grid = layout === "grid";
  return (
    <article
      aria-labelledby={nameId}
      className={cn(
        "flex gap-3 text-sm",
        grid
          ? "h-full flex-col rounded-lg border border-gray-6 bg-gray-2 p-4 transition-colors hover:border-gray-7"
          : "flex-wrap items-center border-b border-gray-6 px-1 py-3",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 gap-3", grid ? "flex-col" : "items-center")}>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-md bg-gray-3 text-gray-11"
        >
          <ItemIcon item={item} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span id={nameId} className="min-w-0 truncate font-medium text-foreground">
              {item.name}
            </span>
            {quarantined ? (
              <Badge variant="approval">
                <ShieldAlert aria-hidden="true" />
                {t("screens.library.quarantined")}
              </Badge>
            ) : null}
            {isReadOnly(item) ? (
              <Badge variant="muted">{t("screens.library.readOnly")}</Badge>
            ) : null}
          </div>
          <p className="text-caption text-gray-11">
            {t("screens.library.meta", {
              kind: KIND_LABEL[item.kind],
              type: fileType(item),
              size: formatBytes(item.size),
              date: formatDate(item.createdAt),
            })}
          </p>
          {taskId !== null || item.tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {taskId !== null ? (
                <button
                  type="button"
                  onClick={() => onOpenTask?.(taskId)}
                  className={cn(
                    badgeVariants({ variant: "muted" }),
                    "max-w-full cursor-pointer hover:bg-gray-4 hover:text-gray-12",
                  )}
                >
                  <ListChecks aria-hidden="true" />
                  <span className="truncate">
                    {t("screens.library.task", {
                      title: taskTitle ?? t("screens.library.openActivity"),
                    })}
                  </span>
                </button>
              ) : null}
              {item.tags.map((tag) => (
                <Badge key={tag} variant="muted">
                  #{tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className={cn("flex items-center gap-1", grid ? "mt-auto pt-1" : "")}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={onOpen === undefined}
          onClick={() => onOpen?.(item)}
          aria-label={t("screens.library.openLabel", { name: item.name, editor: system })}
        >
          {system ? <PenLine aria-hidden="true" /> : <FolderOpen aria-hidden="true" />}
          {system ? t("screens.library.openInEditor") : t("screens.library.open")}
        </Button>
        {quarantined && onTrust ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onTrust(item)}>
            <ShieldCheck aria-hidden="true" />
            {t("screens.library.trust")}
          </Button>
        ) : null}
        {hasMore ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("screens.library.moreFor", { name: item.name })}
                  title={t("common.more")}
                  className="ms-auto text-gray-11"
                />
              }
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {quickLook ? (
                <DropdownMenuItem onClick={() => quickLook(item)}>
                  <Eye aria-hidden="true" />
                  {t("screens.library.quickLook")}
                </DropdownMenuItem>
              ) : null}
              {onReveal ? (
                <DropdownMenuItem onClick={() => onReveal(item)}>
                  <FolderSearch aria-hidden="true" />
                  {t("screens.library.reveal")}
                </DropdownMenuItem>
              ) : null}
              {sendToChat ? (
                <DropdownMenuItem onClick={() => sendToChat(item)}>
                  <MessageCircle aria-hidden="true" />
                  {t("screens.library.sendToChat")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
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
        label={t("screens.library.loading")}
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
        what={t("screens.library.loadFailed")}
        reason={error}
        did={t("screens.library.untouched")}
        {...(onRetry ? { retry: { onClick: onRetry } } : {})}
      />
    );
  } else if (shown.length === 0) {
    body = filtered ? (
      <EmptyState
        icon={LibraryIcon}
        action={{
          label: t("screens.library.clearFilters"),
          onClick: () => onFiltersChange?.(NO_FILTERS),
        }}
      >
        {t("screens.library.noMatch")}
      </EmptyState>
    ) : (
      <EmptyState
        icon={LibraryIcon}
        {...(onOpenChat && section !== "system" && section !== "downloads"
          ? {
              action: {
                label: t("screens.library.askToMake", { name: persona }),
                onClick: onOpenChat,
              },
            }
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

  const labelled = (id: string, label: string, control: ReactElement) => (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-caption text-gray-11">
        {label}
      </label>
      {control}
    </div>
  );

  return (
    <section aria-label={t("screens.library.title")}>
      <Page width="wide">
        <PageHeader
          title={t("screens.library.title")}
          meta={
            !loading && error === null
              ? t("screens.library.meta.count", { section: spec?.label ?? "", n: shown.length })
              : undefined
          }
          description={t("screens.library.description", { name: persona })}
          actions={
            <ToggleGroup
              aria-label={t("screens.library.layout")}
              value={[layout]}
              onValueChange={(v) => {
                const next = v[0];
                if (next === "grid" || next === "list") onLayoutChange?.(next);
              }}
            >
              <ToggleGroupItem value="grid" size="sm" aria-label={t("screens.library.grid")}>
                <LayoutGrid aria-hidden="true" />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" size="sm" aria-label={t("screens.library.list")}>
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
          className="gap-4"
        >
          <TabsList aria-label={t("screens.library.sections")} className="flex-wrap">
            {LIBRARY_SECTIONS.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={section} className="flex flex-col gap-4">
            <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-0 p-0">
              <legend className="sr-only">{t("screens.library.filters")}</legend>
              {labelled(
                ids.type,
                t("screens.library.typeFilter"),
                <NativeSelect
                  id={ids.type}
                  size="sm"
                  value={filters.type ?? ""}
                  onChange={(e) =>
                    setFilter({ type: e.target.value === "" ? null : e.target.value })
                  }
                >
                  <option value="">{t("screens.library.allTypes")}</option>
                  {types.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </NativeSelect>,
              )}
              {labelled(
                ids.task,
                t("screens.library.sourceTask"),
                <NativeSelect
                  id={ids.task}
                  size="sm"
                  className="max-w-56"
                  value={filters.taskId ?? ""}
                  onChange={(e) =>
                    setFilter({ taskId: e.target.value === "" ? null : e.target.value })
                  }
                >
                  <option value="">{t("screens.library.anyTask")}</option>
                  {taskIds.map((tid) => (
                    <option key={tid} value={tid}>
                      {taskTitles[tid] ?? tid}
                    </option>
                  ))}
                </NativeSelect>,
              )}
              {labelled(
                ids.date,
                t("screens.library.dateFilter"),
                <NativeSelect
                  id={ids.date}
                  size="sm"
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
                </NativeSelect>,
              )}
              {filtered ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onFiltersChange?.(NO_FILTERS)}
                >
                  <X aria-hidden="true" />
                  {t("screens.library.reset")}
                </Button>
              ) : null}
            </fieldset>
            {body}
          </TabsContent>
        </Tabs>
      </Page>
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
      () => toast(t("screens.library.trusted", { name: item.name })),
      (err: unknown) => {
        setTrusted((s) => {
          const next = new Set(s);
          next.delete(item.id);
          return next;
        });
        toast.error(
          t("screens.library.trustFailed", { name: item.name, reason: describeError(err) }),
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
