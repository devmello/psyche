import { PanelLeft, Settings } from "lucide-react";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  useMemo,
  useRef,
  useState,
} from "react";
import { Avatar } from "../avatar/Avatar.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { useGoals, useIdeas } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
import { destinationFor, RAIL_ITEMS, type RailItem } from "./Rail.tsx";
import { CurrentMark, SelectionContext, ThreadGroup } from "./ThreadList.tsx";

/** Sidebar widths (redesign §5.1): 248 px by default, resizable 220–320, persisted by the host. */
export const SIDEBAR_WIDTH = { min: 220, default: 248, max: 320 } as const;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

export interface SidebarProps {
  route: string;
  onNavigate: (route: string) => void;
  /** The thread the chat shows; its row carries the selection on chat routes. */
  activeThreadId: string | null;
  onOpenThread: (threadId: string) => void;
  onNewSideChat?: () => void;
  onExport?: (threadId: string, format: "markdown" | "json" | "html") => void;
  /** Trailing counts on destinations (new ideas, suggested goals…). */
  counts?: Partial<Record<RailItem, number>>;
  width?: number;
  /** Called while the owner drags or arrow-keys the edge; the host persists it. */
  onWidthChange?: (width: number) => void;
  /** The gear's Settings item (⌘,); defaults to the `/settings/model` route. */
  onOpenSettings?: () => void;
  /** Reveals and focuses the thread filter (⌘F inside the sidebar). */
  filterToken?: number;
  now?: number;
}

/** Moves focus between the sidebar's rows with ↑ ↓ Home End (a source list, not a menu). */
function moveFocus(e: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const target = e.target as HTMLElement;
  if (!target.matches("[data-sidebar-item]")) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-sidebar-item]")];
  const i = items.indexOf(target);
  const next =
    e.key === "Home"
      ? items[0]
      : e.key === "End"
        ? items[items.length - 1]
        : items[i + (e.key === "ArrowDown" ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/** The draggable, keyboard-operable edge between the sidebar and the content. */
function ResizeEdge({
  width,
  onWidthChange,
}: {
  width: number;
  onWidthChange: (width: number) => void;
}): ReactElement {
  const start = useRef<{ x: number; width: number } | null>(null);
  const dir = activeI18n().dir === "rtl" ? -1 : 1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    start.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onWidthChange(clampSidebarWidth(s.width + (e.clientX - s.x) * dir));
  };
  const onPointerUp = () => {
    start.current = null;
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("shell.sidebar.resize")}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      data-testid="sidebar-resize"
      className="absolute inset-y-0 -end-[3px] z-10 w-1.5 cursor-col-resize outline-none focus-visible:bg-ring/40 hover:bg-separator"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onWidthChange(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = width - 8 * dir;
        else if (e.key === "ArrowRight") next = width + 8 * dir;
        else if (e.key === "Home") next = SIDEBAR_WIDTH.min;
        else if (e.key === "End") next = SIDEBAR_WIDTH.max;
        if (next === null) return;
        e.preventDefault();
        onWidthChange(clampSidebarWidth(next));
      }}
    />
  );
}

/**
 * The 2026 sidebar (redesign §5.1): one macOS source list replacing the rail and the thread list.
 * Destinations (Chat, Search, Feed, Ideas, Goals, Library with counts), the Threads group, and a
 * footer with the persona and a settings gear. The current row sits on a pill that moves between
 * rows; it is accent-tinted while the window is key and gray when it isn't. ↑ ↓ move focus
 * between rows. The host owns collapse (⌘B) and persists the width.
 */
export function Sidebar({
  route,
  onNavigate,
  activeThreadId,
  onOpenThread,
  onNewSideChat,
  onExport,
  counts = {},
  width = SIDEBAR_WIDTH.default,
  onWidthChange,
  onOpenSettings,
  filterToken,
  now,
}: SidebarProps): ReactElement {
  const persona = usePersona();
  const [instant, setInstant] = useState(false);
  // ⌘F with focus in the sidebar opens the thread filter (redesign §5.1).
  const [filterBump, setFilterBump] = useState(0);
  const destination = destinationFor(route);
  const onChat = destination === "chat";
  const selection = useMemo(() => ({ pill: true, instant }), [instant]);
  const settings = onOpenSettings ?? (() => onNavigate("/settings/model"));
  return (
    <SelectionContext.Provider value={selection}>
      <nav
        aria-label={t("shell.sidebar.label")}
        className="relative flex h-full min-h-0 flex-col material-sidebar text-label-primary"
        style={{ width }}
        data-testid="sidebar"
        // A keyboard choice moves the pill instantly; a click lets it travel (motion.md §4.4).
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" || e.key === " ") setInstant(true);
        }}
        onPointerDownCapture={() => setInstant(false)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            setFilterBump((n) => n + 1);
            return;
          }
          moveFocus(e);
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2">
          <ul aria-label={t("shell.sidebar.destinations")} className="flex flex-col">
            {RAIL_ITEMS.map((item) => {
              const Icon = item.icon;
              const count = counts[item.id] ?? 0;
              // On chat routes the thread row carries the selection; Chat stays marked current.
              const selected = item.id === destination && !(onChat && activeThreadId !== null);
              const current = item.id === destination;
              return (
                <li key={item.id} className="relative flex h-7 items-center">
                  <CurrentMark active={selected} />
                  <button
                    type="button"
                    onClick={() => onNavigate(item.route)}
                    aria-current={selected ? "page" : current ? "true" : undefined}
                    aria-label={
                      count > 0 ? t("shell.rail.badge", { label: item.label, n: count }) : undefined
                    }
                    className="relative flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-3 text-start text-body outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="sidebar-destination"
                    data-destination={item.id}
                    data-sidebar-item=""
                  >
                    <Icon
                      aria-hidden="true"
                      strokeWidth={1.5}
                      className={cn(
                        "size-4 shrink-0",
                        current
                          ? "text-accent-11 [:root[data-window-active=false]_&]:text-label-secondary"
                          : "text-label-secondary",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {count > 0 ? (
                      <span
                        aria-hidden="true"
                        className="shrink-0 text-callout text-label-tertiary tabular-nums"
                      >
                        {activeI18n().number(count)}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <ThreadGroup
            activeThreadId={onChat ? activeThreadId : null}
            onOpen={onOpenThread}
            {...(onNewSideChat ? { onNewSideChat } : {})}
            {...(onExport ? { onExport } : {})}
            {...(now === undefined ? {} : { now })}
            filterToken={(filterToken ?? 0) + filterBump}
          />
        </div>
        <div
          className="flex h-11 shrink-0 items-center gap-2 ps-3 pe-1"
          data-testid="sidebar-footer"
        >
          <Avatar
            name={persona.name}
            creature={persona.creature}
            {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
            size={20}
            decorative
          />
          <span className="min-w-0 flex-1 truncate text-headline">{persona.name}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("shell.sidebar.settingsMenu")}
                  className="text-label-secondary"
                />
              }
            >
              <Settings aria-hidden="true" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end">
              <DropdownMenuItem onClick={settings}>
                {t("shell.rail.settings")}
                <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onNavigate("/settings/usage")}>
                {t("shell.rail.usage")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onNavigate("/settings/about")}>
                {t("shell.rail.help")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {onWidthChange ? <ResizeEdge width={width} onWidthChange={onWidthChange} /> : null}
      </nav>
    </SelectionContext.Provider>
  );
}

/** Shows the collapsed sidebar again (⌘B does the same); the toolbar hosts it (redesign §4). */
export function SidebarToggle({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t("shell.sidebar.show")}
      aria-keyshortcuts="Meta+B"
      onClick={onClick}
      className={cn("text-label-secondary", className)}
      data-no-drag=""
    >
      <PanelLeft aria-hidden="true" strokeWidth={1.75} />
    </Button>
  );
}

/** New ideas and suggested goals: the counts beside Ideas and Goals. */
export function useSidebarCounts(): Partial<Record<RailItem, number>> {
  const ideas = useIdeas();
  const goals = useGoals();
  return useMemo(
    () => ({ ideas: ideas.proposed.length, goals: goals.candidates.length }),
    [ideas.proposed.length, goals.candidates.length],
  );
}

/** The sidebar with its counts from the Gateway. */
export function ConnectedSidebar(props: Omit<SidebarProps, "counts">): ReactElement {
  const counts = useSidebarCounts();
  return <Sidebar {...props} counts={counts} />;
}
