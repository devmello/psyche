import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { AgentHeader } from "../agent/AgentHeader.tsx";
import { AgentSheet, type AgentTab } from "../agent/AgentSheet.tsx";
import { ChatThread } from "../chat/Thread.tsx";
import { useThread, useThreads } from "../data/index.ts";
import { CommandPalette, type PaletteAction } from "./CommandPalette.tsx";
import { Rail, type RailItem } from "./Rail.tsx";
import { ShortcutList } from "./ShortcutList.tsx";
import { type ShortcutId, useShortcuts } from "./shortcuts.ts";
import { ThreadList } from "./ThreadList.tsx";

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
  now?: number;
}

function railItemFor(route: string): RailItem | null {
  const first = route.split(/[/?]/)[1] ?? "";
  return (
    (["chat", "search", "feed", "ideas", "goals", "library"] as const).find((r) => r === first) ??
    null
  );
}

/**
 * Main window layout (UI design §3.1, §3.24): rail (56 px), thread list (260 px, ⌘B), chat column
 * with the agent header, pane area; below 720 px the rail becomes a bottom tab bar and the thread
 * list a drawer. Routes and panes stay with the shell.
 */
export function AppShell({
  route,
  onNavigate,
  children,
  panes,
  actions,
  shortcuts,
  railBadges,
  now,
}: AppShellProps): ReactElement {
  const compact = useCompact();
  const threads = useThreads();
  const [threadListOpen, setThreadListOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [sheet, setSheet] = useState<{ open: boolean; tab: AgentTab; taskId?: string }>({
    open: false,
    tab: "activity",
  });

  const chatMatch = /^\/chat(?:\/([^/?]+))?/.exec(route);
  const threadId = chatMatch ? (chatMatch[1] ?? threads.main?.thread.id ?? null) : null;
  const thread = useThread(threadId);
  const agentMatch = /^\/agent\/(activity|approvals|upcoming|soul)(?:\/([^/?]+))?/.exec(route);
  const agentTab = agentMatch?.[1] as AgentTab | undefined;
  const agentTask = agentMatch?.[2];
  useEffect(() => {
    if (agentTab)
      setSheet({ open: true, tab: agentTab, ...(agentTask ? { taskId: agentTask } : {}) });
  }, [agentTab, agentTask]);

  const newSideChat = async () => {
    const t = await threads.create({ kind: "side" });
    onNavigate(`/chat/${t.id}`);
  };
  useShortcuts({
    palette: () => setPaletteOpen(true),
    newSideChat: () => void newSideChat(),
    toggleThreadList: () => setThreadListOpen((o) => !o),
    stop: () => {
      if (thread.running) void thread.cancel();
    },
    activity: () => setSheet({ open: true, tab: "activity" }),
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
      onOpenTask={(taskId) => setSheet({ open: true, tab: "activity", taskId })}
      {...(thread.thread ? { mode: thread.thread.thread.permissionMode } : {})}
      {...(thread.thread?.thread.modelRef ? { model: thread.thread.thread.modelRef } : {})}
      onOpenInbox={() => onNavigate("/inbox")}
      incognito={thread.thread?.thread.kind === "incognito"}
    />
  );

  return (
    <div className="flex h-dvh min-h-[600px] w-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {compact ? null : (
          <Rail active={railItemFor(route)} onNavigate={onNavigate} badges={railBadges ?? {}} />
        )}
        {chatMatch && threadListOpen && !compact ? (
          <ThreadList
            activeThreadId={threadId}
            onOpen={(id) => onNavigate(`/chat/${id}`)}
            onNewSideChat={() => void newSideChat()}
            {...(now === undefined ? {} : { now })}
          />
        ) : null}
        <main className="flex min-w-0 flex-1 flex-col">
          {header}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1 overflow-y-auto">
              {chatMatch && threadId ? (
                <ChatThread threadId={threadId} {...(now === undefined ? {} : { now })} />
              ) : (
                children
              )}
            </div>
            {panes && !compact ? (
              <div className="flex min-w-[360px] border-s border-gray-6">{panes}</div>
            ) : null}
          </div>
        </main>
      </div>
      {compact ? (
        <Rail
          compact
          active={railItemFor(route)}
          onNavigate={onNavigate}
          badges={railBadges ?? {}}
        />
      ) : null}
      <AgentSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
        tab={sheet.tab}
        onTabChange={(tab) => setSheet((s) => ({ ...s, tab }))}
        side={compact ? "bottom" : "right"}
        {...(sheet.taskId ? { taskId: sheet.taskId } : {})}
        {...(now === undefined ? {} : { now })}
      />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onNavigate={onNavigate}
        {...(actions ? { actions } : {})}
      />
      <ShortcutList open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
