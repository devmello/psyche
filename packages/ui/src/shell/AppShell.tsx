import { type ReactElement, type ReactNode, startTransition, useEffect, useState } from "react";
import { AgentHeader } from "../agent/AgentHeader.tsx";
import {
  AGENT_PANEL_MIN_CONTENT,
  AGENT_PANEL_WIDTH,
  AgentSheet,
  AgentSheetPanel,
  type AgentTab,
  agentSheetRoute,
  sheetTab,
} from "../agent/AgentSheet.tsx";
import { ChatThread } from "../chat/Thread.tsx";
import { useThread, useThreads } from "../data/index.ts";
import { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
import { CompactTopBar } from "./CompactTopBar.tsx";
import {
  PanePresence,
  ReflowColumn,
  RouteTransition,
  ShellMotion,
  SidebarPresence,
} from "./motion.tsx";
import { destinationFor, type RailItem, TabBar } from "./Rail.tsx";
import { ShortcutList } from "./ShortcutList.tsx";
import {
  ConnectedSidebar,
  clampSidebarWidth,
  SIDEBAR_WIDTH,
  type SidebarMode,
  SidebarToggle,
} from "./Sidebar.tsx";
import { type ShortcutId, useShortcuts } from "./shortcuts.ts";
import { ThreadList } from "./ThreadList.tsx";
import { ThreadsDrawer } from "./ThreadsDrawer.tsx";

function useCompact(): boolean {
  const query = "(max-width: 719px)";
  const [compact, setCompact] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const on = () => setCompact(mql.matches);
    mql.addEventListener("change", on);
    return () => mql.removeEventListener("change", on);
  }, []);
  return compact;
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const on = () => setWidth(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return width;
}

export interface AppShellProps {
  /** Current route (UI design §2.7); the shell owns routing. */
  route: string;
  onNavigate: (route: string) => void;
  /** Content for non-chat routes (Feed, Ideas, Goals, Library, Search, Settings, Inbox…). */
  children?: ReactNode;
  /** Pane area beside the chat (S11's panes). */
  panes?: ReactNode;
  /** Extra palette entries and shortcut handlers (panes, pop-outs, quick entry). */
  actions?: readonly PaletteAction[];
  shortcuts?: Partial<Record<ShortcutId, () => void>>;
  railBadges?: Partial<Record<RailItem, number>>;
  /** Starts with the sidebar collapsed (⌘B toggles it). */
  defaultSidebarOpen?: boolean;
  defaultSidebarWidth?: number;
  /** Starts as the full sidebar or the icon-only rail (⌥⌘B switches; #598). */
  defaultSidebarMode?: SidebarMode;
  /** Forces the compact layout (stories); otherwise it follows the window width. */
  compact?: boolean;
  /** Starts with the agent sheet open on this tab (stories). */
  defaultSheet?: AgentTab;
  now?: number;
}

/**
 * Main window layout (redesign §4, §5.1, §5.11): one 248 px sidebar (destinations, threads,
 * persona; resizable, ⌘B collapses it), the content column with the agent header, the pane
 * area and the agent sheet beside them (#625). Below 720 px: a 44 px top bar, a threads drawer and the glass tab bar. Routes and panes
 * stay with the shell; a change of destination crossfades the content column.
 */
export function AppShell({
  route,
  onNavigate,
  children,
  panes,
  actions,
  shortcuts,
  railBadges,
  defaultSidebarOpen = true,
  defaultSidebarWidth = SIDEBAR_WIDTH.default,
  defaultSidebarMode = "full",
  compact: forceCompact,
  defaultSheet,
  now,
}: AppShellProps): ReactElement {
  const narrow = useCompact();
  const compact = forceCompact ?? narrow;
  const windowWidth = useWindowWidth();
  const threads = useThreads();
  const [sidebarOpen, setSidebarOpen] = useState(defaultSidebarOpen);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(defaultSidebarMode);
  const [sidebarWidth, setSidebarWidth] = useState(clampSidebarWidth(defaultSidebarWidth));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; tab: AgentTab }>({
    open: defaultSheet !== undefined,
    tab: defaultSheet ?? "approvals",
  });

  const chatMatch = /^\/chat(?:\/([^/?]+))?/.exec(route);
  const threadId = chatMatch ? (chatMatch[1] ?? threads.main?.thread.id ?? null) : null;
  const thread = useThread(threadId);
  const agentTab = agentSheetRoute(route)?.tab;
  useEffect(() => {
    if (agentTab) setSheet({ open: true, tab: sheetTab(agentTab) });
  }, [agentTab]);

  const newSideChat = async () => {
    const created = await threads.create({ kind: "side" });
    onNavigate(`/chat/${created.id}`);
  };
  // A new destination crossfades the content column; a thread switch inside Chat doesn't.
  const go = (to: string) => {
    if (destinationFor(to) !== destinationFor(route)) startTransition(() => onNavigate(to));
    else onNavigate(to);
  };
  useShortcuts({
    palette: () => setPaletteOpen(true),
    newSideChat: () => void newSideChat(),
    toggleThreadList: () => (compact ? setDrawerOpen((o) => !o) : setSidebarOpen((o) => !o)),
    compactSidebar: () => {
      if (compact) return;
      setSidebarMode((m) => (m === "rail" ? "full" : "rail"));
      setSidebarOpen(true);
    },
    stop: () => {
      if (thread.running) void thread.cancel();
    },
    activity: () => setSheet({ open: true, tab: "approvals" }),
    approvals: () => setSheet({ open: true, tab: "approvals" }),
    shortcutList: () => setShortcutsOpen(true),
    cycleThreads: () => {
      const ids = threads.all.filter((t) => t.thread.archivedAt == null).map((t) => t.thread.id);
      const i = threadId ? ids.indexOf(threadId) : -1;
      const next = ids[(i + 1) % Math.max(1, ids.length)];
      if (next) onNavigate(`/chat/${next}`);
    },
    ...shortcuts,
  });

  const header = (
    <AgentHeader
      onOpenSheet={() => setSheet((s) => ({ ...s, open: true }))}
      onOpenTask={() => onNavigate("/overview#now")}
      {...(thread.thread ? { mode: thread.thread.thread.permissionMode } : {})}
      {...(thread.thread?.thread.modelRef ? { model: thread.thread.thread.modelRef } : {})}
      onOpenInbox={() => onNavigate("/inbox")}
      incognito={thread.thread?.thread.kind === "incognito"}
    />
  );

  // The toolbar's leading toggle (#598): in the sidebar's top row while it shows, at the content
  // column's start when it hides, so it stays in one place.
  const toggle = (
    <SidebarToggle
      open={sidebarOpen}
      onToggle={() => setSidebarOpen((o) => !o)}
      mode={sidebarMode}
      onModeChange={setSidebarMode}
    />
  );
  // The agent sheet sits beside the content when the content keeps its minimum next to it (#625);
  // narrower windows get the modal sheet.
  const contentWidth =
    windowWidth - (compact || !sidebarOpen ? 0 : sidebarMode === "rail" ? 64 : sidebarWidth);
  const docked = !compact && contentWidth - AGENT_PANEL_WIDTH >= AGENT_PANEL_MIN_CONTENT;
  const content =
    chatMatch && threadId ? (
      <ChatThread threadId={threadId} {...(now === undefined ? {} : { now })} />
    ) : (
      children
    );

  return (
    <ShellMotion>
      <div
        className="flex h-dvh min-h-[600px] w-full flex-col bg-canvas text-label-primary"
        data-compact={compact}
        data-testid="app-shell"
      >
        {compact ? (
          <CompactTopBar
            onOpenThreads={() => setDrawerOpen(true)}
            onOpenSearch={() => setPaletteOpen(true)}
            {...(thread.thread ? { mode: thread.thread.thread.permissionMode } : {})}
            {...(thread.thread?.thread.modelRef ? { model: thread.thread.thread.modelRef } : {})}
          />
        ) : null}
        <div className="flex min-h-0 flex-1">
          {compact ? null : (
            <SidebarPresence open={sidebarOpen} className="h-full shrink-0">
              <ConnectedSidebar
                route={route}
                onNavigate={go}
                activeThreadId={threadId}
                onOpenThread={(id) => go(`/chat/${id}`)}
                onNewSideChat={() => void newSideChat()}
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                mode={sidebarMode}
                onModeChange={setSidebarMode}
                header={toggle}
                {...(now === undefined ? {} : { now })}
              />
            </SidebarPresence>
          )}
          <ReflowColumn className="flex min-w-0 flex-1 flex-col bg-canvas">
            {/* Compact: the top bar carries the persona, mode and model (§5.11). */}
            {chatMatch && !compact ? (
              sidebarOpen ? (
                header
              ) : (
                // Collapsed: the toggle keeps its place at the window's start (redesign §4).
                <div className="relative [&>:last-child]:ps-16">
                  <span className="absolute top-3.5 start-2 z-10">{toggle}</span>
                  {header}
                </div>
              )
            ) : null}
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto">
                <RouteTransition>{content}</RouteTransition>
              </div>
            </div>
          </ReflowColumn>
          {compact ? null : (
            <PanePresence className="flex min-w-[360px]">{panes ?? null}</PanePresence>
          )}
          {/* The agent sheet beside the content (#625): the content column shrinks from the right. */}
          {docked ? (
            <PanePresence className="flex h-full shrink-0" style={{ width: AGENT_PANEL_WIDTH }}>
              {sheet.open ? (
                <AgentSheetPanel
                  tab={sheet.tab}
                  onTabChange={(tab) => setSheet((s) => ({ ...s, tab }))}
                  onClose={() => setSheet((s) => ({ ...s, open: false }))}
                  {...(now === undefined ? {} : { now })}
                />
              ) : null}
            </PanePresence>
          ) : null}
        </div>
        {compact ? (
          <TabBar active={destinationFor(route)} onNavigate={go} badges={railBadges ?? {}} />
        ) : null}
        <ThreadsDrawer open={compact && drawerOpen} onOpenChange={setDrawerOpen}>
          <ThreadList
            activeThreadId={threadId}
            onOpen={(id) => {
              setDrawerOpen(false);
              go(`/chat/${id}`);
            }}
            onNewSideChat={() => {
              setDrawerOpen(false);
              void newSideChat();
            }}
            {...(now === undefined ? {} : { now })}
          />
        </ThreadsDrawer>
        {/* Too narrow for both: the modal sheet (a bottom sheet when compact). */}
        <AgentSheet
          open={!docked && sheet.open}
          onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
          tab={sheet.tab}
          onTabChange={(tab) => setSheet((s) => ({ ...s, tab }))}
          side={compact ? "bottom" : "right"}
          {...(now === undefined ? {} : { now })}
        />
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onNavigate={go}
          {...(actions ? { actions } : {})}
        />
        <ShortcutList open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      </div>
    </ShellMotion>
  );
}
