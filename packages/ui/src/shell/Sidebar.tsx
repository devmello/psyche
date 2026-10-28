import { ChevronDown, Globe, PanelLeft, Settings } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { useGoals, useIdeas } from "../data/index.ts";
import { activeI18n, t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { usePersona } from "../slots.tsx";
import { destinationFor, RAIL_ITEMS, type RailItem } from "./Rail.tsx";
import { CurrentMark, SelectionContext, ThreadGroup } from "./ThreadList.tsx";
import { ConnectedUsageFooter } from "./UsageFooter.tsx";

/** Sidebar widths (redesign §5.1): 248 px by default, resizable 220–320, persisted by the host. */
export const SIDEBAR_WIDTH = { min: 220, default: 248, max: 320 } as const;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

/** The compact, icon-only rail (#598): 64 px; dragging the edge below 180 px snaps to it. */
export const SIDEBAR_RAIL = { width: 64, snapBelow: 180 } as const;

/** The full sidebar or the icon-only rail. */
export type SidebarMode = "full" | "rail";

/**
 * Where a drag or arrow key on the edge lands: under the snap threshold it is the rail,
 * otherwise the full sidebar at a clamped width.
 */
export function sidebarResize(raw: number): { mode: SidebarMode; width: number } {
  if (Number.isFinite(raw) && raw < SIDEBAR_RAIL.snapBelow) {
    return { mode: "rail", width: SIDEBAR_RAIL.width };
  }
  return { mode: "full", width: clampSidebarWidth(raw) };
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
  /** Full sidebar or the icon-only rail (#598). */
  mode?: SidebarMode;
  /** The edge was dragged past the snap threshold (or arrow-keyed across it). */
  onModeChange?: (mode: SidebarMode) => void;
  /** A row above the destinations (the web client's sidebar toggle). */
  header?: ReactNode;
  /** Usage under the persona's name (#599): the full footer's second line or the rail's graphic. */
  renderUsage?: (variant: "full" | "rail", name: string) => ReactNode;
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
  mode,
  onResize,
}: {
  width: number;
  mode: SidebarMode;
  /** The raw width asked for; the sidebar decides between the rail and a clamped width. */
  onResize: (width: number) => void;
}): ReactElement {
  const shown = mode === "rail" ? SIDEBAR_RAIL.width : width;
  const start = useRef<{ x: number; width: number } | null>(null);
  const dir = activeI18n().dir === "rtl" ? -1 : 1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    start.current = { x: e.clientX, width: shown };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onResize(s.width + (e.clientX - s.x) * dir);
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
      aria-valuenow={shown}
      aria-valuemin={SIDEBAR_RAIL.width}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      data-testid="sidebar-resize"
      className="absolute inset-y-0 -end-[3px] z-10 w-1.5 cursor-col-resize outline-none focus-visible:bg-ring/40 hover:bg-separator"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        // From the rail, a step outward opens the full sidebar at its narrowest; from the
        // narrowest full width, a step inward snaps to the rail.
        const step = (delta: number) =>
          mode === "rail"
            ? delta > 0
              ? SIDEBAR_WIDTH.min
              : SIDEBAR_RAIL.width
            : width === SIDEBAR_WIDTH.min && delta < 0
              ? SIDEBAR_RAIL.width
              : width + delta;
        let next: number | null = null;
        if (e.key === "ArrowLeft") next = step(-8 * dir);
        else if (e.key === "ArrowRight") next = step(8 * dir);
        else if (e.key === "Home") next = SIDEBAR_RAIL.width;
        else if (e.key === "End") next = SIDEBAR_WIDTH.max;
        if (next === null) return;
        e.preventDefault();
        onResize(next);
      }}
    />
  );
}

/** The gear's items: Settings (⌘,), Usage, Help. */
function SettingsMenuItems({
  onSettings,
  onNavigate,
}: {
  onSettings: () => void;
  onNavigate: (route: string) => void;
}): ReactElement {
  return (
    <>
      <DropdownMenuItem onClick={() => onNavigate("/can-do")}>
        {t("capabilities.open")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={onSettings}>
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
    </>
  );
}

/**
 * The 2026 sidebar (redesign §5.1): one macOS source list replacing the rail and the thread list.
 * Destinations (Chat, Search, Feed, Ideas, Goals, Library with counts), the Threads group, and a
 * footer with the persona and a settings gear. The current row sits on a pill that moves between
 * rows; it is accent-tinted while the window is key and gray when it isn't. ↑ ↓ move focus
 * between rows. In the compact rail (#598) it is 64 px of destination icons with tooltips, the
 * threads hidden and the avatar opening the settings menu. The host owns collapse (⌘B), the mode
 * (⌥⌘B) and persists both with the width.
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
  mode = "full",
  onModeChange,
  header,
  renderUsage,
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
  const rail = mode === "rail";
  const selection = useMemo(() => ({ pill: true, instant }), [instant]);
  const settings = onOpenSettings ?? (() => onNavigate("/settings/model"));
  const resize = (raw: number) => {
    const next = sidebarResize(raw);
    if (next.mode !== mode) onModeChange?.(next.mode);
    if (next.mode === "full") onWidthChange?.(next.width);
  };
  return (
    <SelectionContext.Provider value={selection}>
      <nav
        aria-label={t("shell.sidebar.label")}
        className="relative flex h-full min-h-0 flex-col material-sidebar text-label-primary"
        style={{ width: rail ? SIDEBAR_RAIL.width : width }}
        data-testid="sidebar"
        data-mode={mode}
        // A keyboard choice moves the pill instantly; a click lets it travel (motion.md §4.4).
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" || e.key === " ") setInstant(true);
        }}
        onPointerDownCapture={() => setInstant(false)}
        onKeyDown={(e) => {
          if (!rail && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
            e.preventDefault();
            setFilterBump((n) => n + 1);
            return;
          }
          moveFocus(e);
        }}
      >
        {header ? (
          <div
            className={cn("flex h-14 shrink-0 items-center", rail ? "justify-center" : "px-2")}
            data-testid="sidebar-header"
          >
            {header}
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto",
            header ? "pb-2" : "py-2",
          )}
        >
          <ul aria-label={t("shell.sidebar.destinations")} className="flex flex-col">
            {RAIL_ITEMS.map((item) => {
              const Icon = item.icon;
              const count = counts[item.id] ?? 0;
              // On chat routes the thread row carries the selection; Chat stays marked current.
              // The rail has no thread rows, so Chat itself carries it there.
              const selected =
                item.id === destination && (rail || !(onChat && activeThreadId !== null));
              const current = item.id === destination;
              const name =
                count > 0 ? t("shell.rail.badge", { label: item.label, n: count }) : item.label;
              const icon = (
                <Icon
                  aria-hidden="true"
                  strokeWidth={rail ? 1.75 : 1.5}
                  className={cn(
                    rail ? "size-5 shrink-0" : "size-4 shrink-0",
                    current
                      ? "text-accent-11 [:root[data-window-active=false]_&]:text-label-secondary"
                      : "text-label-secondary",
                  )}
                />
              );
              if (rail) {
                return (
                  <li key={item.id} className="relative flex h-10 items-center justify-center">
                    <CurrentMark active={selected} />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={() => onNavigate(item.route)}
                            aria-current={selected ? "page" : current ? "true" : undefined}
                            aria-label={name}
                            className="relative flex size-10 items-center justify-center rounded-sm outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                            data-testid="sidebar-destination"
                            data-destination={item.id}
                            data-sidebar-item=""
                          />
                        }
                      >
                        {icon}
                        {count > 0 ? (
                          <span
                            aria-hidden="true"
                            className="absolute top-1.5 end-1.5 size-1.5 rounded-full bg-accent-9"
                          />
                        ) : null}
                      </TooltipTrigger>
                      <TooltipContent side="right">{name}</TooltipContent>
                    </Tooltip>
                  </li>
                );
              }
              return (
                <li key={item.id} className="relative flex h-7 items-center">
                  <CurrentMark active={selected} />
                  <button
                    type="button"
                    onClick={() => onNavigate(item.route)}
                    aria-current={selected ? "page" : current ? "true" : undefined}
                    aria-label={count > 0 ? name : undefined}
                    className="relative flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm px-3 text-start text-body outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="sidebar-destination"
                    data-destination={item.id}
                    data-sidebar-item=""
                  >
                    {icon}
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
          {rail ? null : (
            <ThreadGroup
              activeThreadId={onChat ? activeThreadId : null}
              onOpen={onOpenThread}
              {...(onNewSideChat ? { onNewSideChat } : {})}
              {...(onExport ? { onExport } : {})}
              {...(now === undefined ? {} : { now })}
              filterToken={(filterToken ?? 0) + filterBump}
            />
          )}
        </div>
        {rail ? (
          <div
            className="flex h-14 shrink-0 items-center justify-center gap-0.5"
            data-testid="sidebar-footer"
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("shell.sidebar.settingsMenu")}
                    className={cn(
                      "flex items-center justify-center rounded-full outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring",
                      renderUsage ? "size-8" : "size-10",
                    )}
                  />
                }
              >
                <Avatar
                  name={persona.name}
                  creature={persona.creature}
                  {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
                  size={renderUsage ? 20 : 28}
                  decorative
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end">
                <SettingsMenuItems onSettings={settings} onNavigate={onNavigate} />
              </DropdownMenuContent>
            </DropdownMenu>
            {renderUsage?.("rail", persona.name)}
          </div>
        ) : (
          <div
            className="flex h-11 shrink-0 items-center gap-2 ps-3 pe-1"
            data-testid="sidebar-footer"
          >
            {/* The avatar opens the Overview, "{persona} & you" (agent-overview-2026 §8.8). */}
            <button
              type="button"
              onClick={() => onNavigate("/overview")}
              aria-label={t("shell.sidebar.openOverview")}
              className="flex shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="sidebar-avatar"
            >
              <Avatar
                name={persona.name}
                creature={persona.creature}
                {...(persona.imageSrc ? { imageSrc: persona.imageSrc } : {})}
                size={20}
                decorative
              />
            </button>
            <div className="flex min-w-0 flex-1 flex-col">
              {renderUsage ? (
                renderUsage("full", persona.name)
              ) : (
                <span className="min-w-0 truncate text-headline">{persona.name}</span>
              )}
            </div>
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
                <SettingsMenuItems onSettings={settings} onNavigate={onNavigate} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {onWidthChange ? <ResizeEdge width={width} mode={mode} onResize={resize} /> : null}
      </nav>
    </SelectionContext.Provider>
  );
}

export interface SidebarToggleProps {
  /** The sidebar is showing (full or rail). */
  open: boolean;
  /** Click or ⌘B: hide or show the sidebar. */
  onToggle: () => void;
  mode?: SidebarMode;
  /** ⌥-click, ⌥⌘B or the menu: switch between the full sidebar and the rail. */
  onModeChange?: (mode: SidebarMode) => void;
  className?: string;
}

/**
 * The sidebar toggle in the toolbar's leading place (redesign §4, #598): the `sidebar.left`
 * glyph; a click hides or shows the sidebar (⌘B), ⌥-click switches to the compact rail (⌥⌘B), and
 * the small menu beside it offers the three states. It stays where it is when the sidebar hides.
 */
export function SidebarToggle({
  open,
  onToggle,
  mode = "full",
  onModeChange,
  className,
}: SidebarToggleProps): ReactElement {
  const label = open ? t("shell.sidebar.hide") : t("shell.sidebar.show");
  const onClick = (e: MouseEvent) => {
    if (e.altKey && onModeChange) {
      onModeChange(mode === "rail" ? "full" : "rail");
      if (!open) onToggle();
      return;
    }
    onToggle();
  };
  const state = open ? mode : "hidden";
  return (
    <span className={cn("inline-flex items-center", className)} data-no-drag="">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-expanded={open}
              aria-keyshortcuts="Meta+B"
              onClick={onClick}
              className="text-label-secondary"
              data-testid="sidebar-toggle"
            />
          }
        >
          <PanelLeft aria-hidden="true" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {label}
          {/* i18n-ignore: a key chord */}
          <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
        </TooltipContent>
      </Tooltip>
      {onModeChange ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("shell.sidebar.options")}
                className="-ms-1 w-4 text-label-tertiary"
              />
            }
          >
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {/* Picking a state closes the menu, as a native mode picker does (Base UI radio items
                stay open by default). */}
            <DropdownMenuRadioGroup
              value={state}
              onValueChange={(v) => {
                if (v === "hidden") {
                  if (open) onToggle();
                  return;
                }
                onModeChange(v as SidebarMode);
                if (!open) onToggle();
              }}
            >
              <DropdownMenuRadioItem value="full" closeOnClick>
                {t("shell.sidebar.full")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="rail" closeOnClick>
                {t("shell.sidebar.compact")}
                {/* i18n-ignore: a key chord */}
                <DropdownMenuShortcut>⌥⌘B</DropdownMenuShortcut>
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="hidden" closeOnClick>
                {t("shell.sidebar.hidden")}
                {/* i18n-ignore: a key chord */}
                <DropdownMenuShortcut>⌘B</DropdownMenuShortcut>
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </span>
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

/** The sidebar with its counts and usage from the Gateway. */
export function ConnectedSidebar(props: Omit<SidebarProps, "counts">): ReactElement {
  const counts = useSidebarCounts();
  const { onNavigate } = props;
  const renderUsage = useCallback(
    (variant: "full" | "rail", name: string) => (
      <ConnectedUsageFooter
        variant={variant}
        name={name}
        onOpenUsage={() => onNavigate("/settings/usage")}
      />
    ),
    [onNavigate],
  );
  return <Sidebar renderUsage={renderUsage} {...props} counts={counts} />;
}

export interface BrowserToggleProps {
  /** Click or ⌘⇧B: show the built-in browser, docking it again when it was popped out. */
  onOpen: () => void;
  className?: string;
}

/**
 * The built-in browser's entry in the toolbar, beside the sidebar toggle. It always shows the
 * browser (opens the pane, raises its window or docks it again); it never hides it, since
 * closing is the pane's own control.
 */
export function BrowserToggle({ onOpen, className }: BrowserToggleProps): ReactElement {
  const label = t("shell.browser.open");
  return (
    <span className={cn("inline-flex items-center", className)} data-no-drag="">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-keyshortcuts="Meta+Shift+B"
              onClick={onOpen}
              className="text-label-secondary"
              data-testid="browser-toggle"
            />
          }
        >
          <Globe aria-hidden="true" strokeWidth={1.75} />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {label}
          {/* i18n-ignore: a key chord */}
          <DropdownMenuShortcut>⌘⇧B</DropdownMenuShortcut>
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
