import { ContextMenu } from "@base-ui/react/context-menu";
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
  ListFilter,
  MessageCircle,
  Package,
  PenLine,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useId,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { EmptyState, ErrorState, LoadingCards, useDelayedFlag } from "../../components/page.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.tsx";
import { useLibrary, useTasks } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { formatDate } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { cn } from "../../lib/utils.ts";
import { usePersona, useSlots } from "../../slots.tsx";
import { ScreenColumn, ScreenToolbar, ToolbarLabel } from "../feed/ScreenToolbar.tsx";
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
  /** Title of the task that produced it, for the source-task glyph. */
  taskTitle?: string | null;
  /** The item is selected (Finder: one click selects, a double click opens). */
  selected?: boolean;
  onSelect?: (item: LibraryItem) => void;
}

function ItemIcon({ item, className }: { item: LibraryItem; className?: string }): ReactElement {
  const cls = cn("shrink-0", className);
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

/** The actions one item offers, shared by its ⋯ menu and its context menu (§5.7). */
function itemActions(item: LibraryItem, a: LibraryItemActions) {
  const system = item.kind === "system";
  const list: { id: string; label: string; icon: ReactElement; run: () => void }[] = [];
  if (a.onOpen) {
    const open = a.onOpen;
    list.push({
      id: "open",
      label: system ? t("screens.library.openInEditor") : t("screens.library.open"),
      icon: system ? <PenLine aria-hidden="true" /> : <FolderOpen aria-hidden="true" />,
      run: () => open(item),
    });
  }
  if (a.onQuickLook && !system) {
    const ql = a.onQuickLook;
    list.push({
      id: "quick-look",
      label: t("screens.library.quickLook"),
      icon: <Eye aria-hidden="true" />,
      run: () => ql(item),
    });
  }
  if (a.onReveal) {
    const reveal = a.onReveal;
    list.push({
      id: "reveal",
      label: t("screens.library.reveal"),
      icon: <FolderSearch aria-hidden="true" />,
      run: () => reveal(item),
    });
  }
  if (a.onSendToChat && !system) {
    const send = a.onSendToChat;
    list.push({
      id: "send",
      label: t("screens.library.sendToChat"),
      icon: <MessageCircle aria-hidden="true" />,
      run: () => send(item),
    });
  }
  if (item.quarantined === true && a.onTrust) {
    const trust = a.onTrust;
    list.push({
      id: "trust",
      label: t("screens.library.trust"),
      icon: <ShieldCheck aria-hidden="true" />,
      run: () => trust(item),
    });
  }
  return list;
}

const MENU_POPUP =
  "z-50 min-w-48 origin-(--transform-origin) rounded-lg psy-popup material-glass p-1 text-body text-popover-foreground outline-none";
const MENU_ITEM =
  "flex min-h-7 cursor-default items-center gap-2 rounded-sm px-2 py-1 outline-hidden select-none focus:bg-fill-secondary data-highlighted:bg-fill-secondary [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-label-secondary";

/** Right-click (or the context-menu key) on an item opens its actions where the pointer is. */
function ItemContextMenu({
  item,
  actions,
  children,
}: {
  item: LibraryItem;
  actions: LibraryItemActions;
  children: ReactElement;
}): ReactElement {
  const entries = itemActions(item, actions);
  if (entries.length === 0) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="isolate z-50 outline-none">
          <ContextMenu.Popup className={MENU_POPUP}>
            {entries.map((e) => (
              <ContextMenu.Item key={e.id} className={MENU_ITEM} onClick={e.run}>
                {e.icon}
                {e.label}
              </ContextMenu.Item>
            ))}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The ⋯ button with the same actions, minus the primary Open. */
function MoreMenu({
  item,
  actions,
  className,
}: {
  item: LibraryItem;
  actions: LibraryItemActions;
  className?: string;
}): ReactElement | null {
  const entries = itemActions(item, actions).filter((e) => e.id !== "open" && e.id !== "trust");
  if (entries.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={t("screens.library.moreFor", { name: item.name })}
            title={t("common.more")}
            className={cn("text-label-secondary", className)}
          />
        }
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {entries.map((e) => (
          <DropdownMenuItem key={e.id} onClick={e.run}>
            {e.icon}
            {e.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A mouse click selects (a double click opens, like Finder); a click with no pointer behind it
 * (VoiceOver, Return, Space on the button) opens, so the "Open …" name always does what it says.
 */
function activate(
  item: LibraryItem,
  onSelect: ((item: LibraryItem) => void) | undefined,
  onOpen: ((item: LibraryItem) => void) | undefined,
) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    if (onSelect && e.detail >= 1) onSelect(item);
    else onOpen?.(item);
  };
}

/**
 * Finder's keys on a focused item: Return opens, Space shows Quick Look (desktop, through the
 * mac helper), the context-menu key or ⇧F10 opens the context menu (Base UI handles that).
 */
function itemKeys(item: LibraryItem, a: LibraryItemActions) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      a.onOpen?.(item);
    } else if (e.key === " " && a.onQuickLook && item.kind !== "system") {
      e.preventDefault();
      a.onQuickLook(item);
    }
  };
}

/**
 * One Library item (docs/design/redesign-2026.md §5.7). In the grid it is a Finder-like tile: a
 * 160 px thumbnail (radius-md) with the name under it (two lines at most), its facts, the
 * source-task glyph and an amber badge plus Trust for a quarantined download. In the list it is
 * a 32 px table row. One click selects, a double click or Return opens, Space is Quick Look, and
 * the actions sit in the context menu and under ⋯.
 */
export function LibraryItemView({
  item,
  layout = "list",
  taskTitle,
  selected = false,
  onSelect,
  ...actions
}: LibraryItemViewProps): ReactElement {
  const nameId = useId();
  const quarantined = item.quarantined === true;
  const system = item.kind === "system";
  const taskId = item.taskId ?? null;
  const { onOpen, onTrust, onOpenTask } = actions;
  const meta = t("screens.library.meta", {
    kind: KIND_LABEL[item.kind],
    type: fileType(item),
    size: formatBytes(item.size),
    date: formatDate(item.createdAt),
  });
  const openLabel = t("screens.library.openLabel", { name: item.name, editor: system });
  const taskButton =
    taskId !== null ? (
      <button
        type="button"
        onClick={() => onOpenTask?.(taskId)}
        aria-label={t("screens.library.task", {
          title: taskTitle ?? t("screens.library.openActivity"),
        })}
        title={t("screens.library.task", { title: taskTitle ?? t("screens.library.openActivity") })}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-label-secondary hover:bg-fill-tertiary hover:text-label-primary focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ListChecks className="size-3.5" aria-hidden="true" />
      </button>
    ) : null;
  const badges = (
    <>
      {quarantined ? (
        <Badge variant="approval">
          <ShieldAlert aria-hidden="true" />
          {t("screens.library.quarantined")}
        </Badge>
      ) : null}
      {isReadOnly(item) ? <Badge variant="muted">{t("screens.library.readOnly")}</Badge> : null}
    </>
  );
  const trust =
    quarantined && onTrust ? (
      <Button type="button" size="xs" variant="plain" onClick={() => onTrust(item)}>
        <ShieldCheck aria-hidden="true" />
        {t("screens.library.trust")}
      </Button>
    ) : null;

  if (layout === "grid") {
    return (
      <article
        aria-labelledby={nameId}
        data-selected={selected || undefined}
        className="group/tile flex flex-col items-center gap-1.5 text-center"
      >
        <ItemContextMenu item={item} actions={actions}>
          <button
            type="button"
            aria-label={openLabel}
            disabled={onOpen === undefined}
            onClick={activate(item, onSelect, onOpen)}
            onDoubleClick={() => onOpen?.(item)}
            onKeyDown={itemKeys(item, actions)}
            className={cn(
              "relative flex aspect-square w-full max-w-40 flex-col items-center justify-center gap-2 rounded-md bg-fill-quaternary text-label-secondary transition-colors outline-none",
              "hover:bg-fill-tertiary focus-visible:ring-3 focus-visible:ring-ring/50",
              selected ? "bg-selection ring-2 ring-accent-8" : "",
            )}
          >
            <ItemIcon item={item} className="size-10 stroke-[1.25]" />
            <span className="text-subheadline font-medium tracking-wide text-label-tertiary">
              {fileType(item)}
            </span>
          </button>
        </ItemContextMenu>
        <div className="flex w-full max-w-40 min-w-0 flex-col items-center gap-0.5">
          <span
            id={nameId}
            className={cn(
              "line-clamp-2 rounded-xs px-1 text-body break-words text-label-primary",
              selected ? "bg-accent-9 text-accent-contrast" : "",
            )}
          >
            {item.name}
          </span>
          <span className="w-full truncate text-subheadline text-label-secondary">{meta}</span>
          {item.tags.length > 0 ? (
            <span className="w-full truncate text-subheadline text-label-tertiary">
              {item.tags.map((tag) => (
                <span key={tag} className="me-1 last:me-0">
                  #{tag}
                </span>
              ))}
            </span>
          ) : null}
          <div className="flex min-h-5 flex-wrap items-center justify-center gap-1">
            {taskButton}
            {badges}
            <MoreMenu
              item={item}
              actions={actions}
              className="opacity-0 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 pointer-coarse:opacity-100"
            />
          </div>
          {trust}
        </div>
      </article>
    );
  }

  return (
    <ItemContextMenu item={item} actions={actions}>
      <tr
        aria-labelledby={nameId}
        aria-selected={onSelect ? selected : undefined}
        className={cn(
          "group/row h-8 text-body transition-colors",
          selected ? "bg-selection" : "hover:bg-fill-quaternary",
        )}
        onDoubleClick={() => onOpen?.(item)}
      >
        <th scope="row" className="rounded-s-sm ps-2 text-start font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <ItemIcon item={item} className="size-4 text-label-secondary" />
            <button
              type="button"
              aria-label={openLabel}
              disabled={onOpen === undefined}
              onClick={activate(item, onSelect, onOpen)}
              onKeyDown={itemKeys(item, actions)}
              className="min-w-0 truncate text-start text-label-primary outline-none focus-visible:underline"
            >
              <span id={nameId}>{item.name}</span>
            </button>
            {badges}
            {trust}
          </span>
        </th>
        <td className="px-2 text-callout text-label-secondary">{KIND_LABEL[item.kind]}</td>
        <td className="px-2 text-callout text-label-secondary tabular-nums">
          {formatBytes(item.size)}
        </td>
        <td className="px-2 text-callout text-label-secondary tabular-nums">
          {formatDate(item.createdAt)}
        </td>
        <td className="px-2">
          <span className="flex items-center gap-1">
            {taskButton}
            {item.tags.length > 0 ? (
              <span className="truncate text-callout text-label-tertiary">
                {item.tags.map((tag) => (
                  <span key={tag} className="me-1 last:me-0">
                    #{tag}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        </td>
        <td className="w-8 rounded-e-sm pe-1 text-end">
          <MoreMenu item={item} actions={actions} />
        </td>
      </tr>
    </ItemContextMenu>
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
  /** Task titles by id, for the source-task glyph and filter. */
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

/** Library (docs/design/redesign-2026.md §5.7). Presentational. */
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
  const [selected, setSelected] = useState<string | null>(null);
  const inSection = items.filter((i) => sectionOf(i) === section);
  const shown = applyFilters(inSection, filters, now);
  const types = [...new Set(inSection.map(fileType))].sort();
  const taskIds = [
    ...new Set(inSection.map((i) => i.taskId).filter((t): t is string => t != null)),
  ];
  const active =
    (filters.type !== null ? 1 : 0) +
    (filters.taskId !== null ? 1 : 0) +
    (filters.date !== "any" ? 1 : 0);
  const filtered = active > 0;
  const spec = LIBRARY_SECTIONS.find((s) => s.id === section) ?? LIBRARY_SECTIONS[0];
  const setFilter = (patch: Partial<LibraryFilters>) => onFiltersChange?.({ ...filters, ...patch });
  const select = (item: LibraryItem) => setSelected(item.id);

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
  } else if (layout === "grid") {
    body = (
      <ul
        aria-label={spec?.label}
        className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6"
      >
        {shown.map((item) => (
          <li key={item.id} className="flex justify-center">
            <LibraryItemView
              item={item}
              layout="grid"
              selected={selected === item.id}
              onSelect={select}
              taskTitle={item.taskId == null ? null : (taskTitles[item.taskId] ?? null)}
              {...actions}
            />
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <table
        aria-label={spec?.label}
        className="w-full table-fixed border-separate border-spacing-0"
      >
        <colgroup>
          <col />
          <col className="w-28" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-40" />
          <col className="w-8" />
        </colgroup>
        <thead>
          <tr className="h-7 text-start text-callout text-label-secondary">
            <th scope="col" className="ps-2 text-start font-normal">
              {t("screens.library.col.name")}
            </th>
            <th scope="col" className="px-2 text-start font-normal">
              {t("screens.library.col.kind")}
            </th>
            <th scope="col" className="px-2 text-start font-normal">
              {t("screens.library.col.size")}
            </th>
            <th scope="col" className="px-2 text-start font-normal">
              {t("screens.library.col.date")}
            </th>
            <th scope="col" className="px-2 text-start font-normal">
              {t("screens.library.col.source")}
            </th>
            <th scope="col">
              <span className="sr-only">{t("screens.library.col.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody className="[&>tr:nth-child(even):not([aria-selected=true])]:bg-fill-quaternary/60">
          {shown.map((item) => (
            <LibraryItemView
              key={item.id}
              item={item}
              layout="list"
              selected={selected === item.id}
              onSelect={select}
              taskTitle={item.taskId == null ? null : (taskTitles[item.taskId] ?? null)}
              {...actions}
            />
          ))}
        </tbody>
      </table>
    );
  }

  const labelled = (id: string, label: string, control: ReactElement) => (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
      <label htmlFor={id} className="text-body text-label-secondary">
        {label}
      </label>
      {control}
    </div>
  );

  const filterPopover = (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={filtered ? "secondary" : "ghost"}
            title={t("screens.library.filter")}
          />
        }
      >
        <ListFilter aria-hidden="true" />
        <ToolbarLabel>
          {filtered
            ? t("screens.library.filterActive", { n: active })
            : t("screens.library.filter")}
        </ToolbarLabel>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-headline text-label-primary">
            {t("screens.library.filters")}
          </legend>
          {labelled(
            ids.type,
            t("screens.library.typeFilter"),
            <NativeSelect
              id={ids.type}
              size="sm"
              value={filters.type ?? ""}
              onChange={(e) => setFilter({ type: e.target.value === "" ? null : e.target.value })}
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
              className="max-w-48"
              value={filters.taskId ?? ""}
              onChange={(e) => setFilter({ taskId: e.target.value === "" ? null : e.target.value })}
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
              variant="plain"
              className="self-end"
              onClick={() => onFiltersChange?.(NO_FILTERS)}
            >
              <X aria-hidden="true" />
              {t("screens.library.reset")}
            </Button>
          ) : null}
        </fieldset>
      </PopoverContent>
    </Popover>
  );

  return (
    <section aria-label={t("screens.library.title")}>
      <Tabs
        value={section}
        onValueChange={(v) => {
          const next = LIBRARY_SECTIONS.find((s) => s.id === v);
          if (next) {
            setSelected(null);
            onSectionChange?.(next.id);
          }
        }}
        className="gap-0"
      >
        <ScreenToolbar
          title={t("screens.library.title")}
          {...(!loading && error === null
            ? {
                meta: t("screens.library.meta.count", {
                  section: spec?.label ?? "",
                  n: shown.length,
                }),
              }
            : {})}
          center={
            // Sections are a segmented control in the toolbar (§5.7).
            <TabsList
              aria-label={t("screens.library.sections")}
              className="max-w-full overflow-x-auto"
            >
              {LIBRARY_SECTIONS.map((s) => (
                <TabsTrigger key={s.id} value={s.id}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
          }
          actions={
            <>
              {filterPopover}
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
            </>
          }
        />
        <TabsContent value={section}>
          <ScreenColumn width="wide">
            <p className="text-callout text-label-secondary">
              {t("screens.library.description", { name: persona })}
            </p>
            {body}
          </ScreenColumn>
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
