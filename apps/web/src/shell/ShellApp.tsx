import type { Thread } from "@psyche/protocol";
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatView, PERMISSION_MODES, QuickEntry } from "./components/Chat.tsx";
import {
  GatewayPill,
  OfflineBanner,
  Rail,
  SectionPlaceholder,
  ThreadList,
  Toasts,
} from "./components/Chrome.tsx";
import {
  CommandPalette,
  ModelPicker,
  type PaletteAction,
  ShortcutSheet,
} from "./components/Overlays.tsx";
import { PaneArea } from "./components/Panes.tsx";
import { hasInsetTitleBar, TitleBar } from "./components/TitleBar.tsx";
import { ShellProvider, useShell, useShellState } from "./context.tsx";
import { matchShortcut, type ShortcutAction } from "./keyboard.ts";
import {
  BREAKPOINT_MEDIUM,
  createLayoutStore,
  type LayoutAction,
  type LayoutEnv,
  type LayoutStore,
  randomIds,
  toViewLayout,
} from "./layout/index.ts";
import type { ShellPlatform } from "./platform.ts";
import { ShellStore } from "./store.ts";
import "./shell.css";

/**
 * The shared shell (docs/06 §3.1): rail, thread list, chat column and pane area, with the
 * keyboard map, palette, offline banner and `view.*` handling. Hosts pass a `ShellPlatform`.
 */

/** The title bar's label for a non-chat route (`/settings/files` → "Settings"). */
export function sectionTitle(route: string): string {
  const head = route.split("/")[1] ?? "";
  return head === "" ? "Psyche" : head.charAt(0).toUpperCase() + head.slice(1);
}

function initialRoute(): string {
  const p = globalThis.location?.pathname ?? "/chat";
  return p === "/" || p.endsWith("index.html") ? "/chat" : p;
}

function useWindowWidth(): number {
  const [w, setW] = useState(() => globalThis.innerWidth ?? 1280);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return (
    !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable === true)
  );
}

/**
 * Optional content from the host's composition root (INT-1): the UI kit's chat column for a
 * thread, and screens for routes the shell has no view of its own for. Absent slots keep the
 * shell's built-in views.
 */
export interface ShellSlots {
  chat?: (threadId: string, ctx: ChatSlotContext) => ReactNode;
  section?: (route: string, navigate: (to: string) => void) => ReactNode | null;
  /** The left rail, or the bottom tab bar when `compact` (docs/06 §2.1, §3.24). */
  rail?: (props: { route: string; compact: boolean; navigate: (to: string) => void }) => ReactNode;
  /** The thread list beside the chat (§2.2); its first child is a 56 px `.threads-header`. */
  threadList?: (props: {
    threadId: string | null;
    onOpen: (threadId: string) => void;
    onNew: () => void;
  }) => ReactNode;
}

/** What the chat slot needs from the shell to drive the agent header (§3.1). */
export interface ChatSlotContext {
  thread: Thread | null;
  navigate: (to: string) => void;
  setPermissionMode: (mode: Thread["permissionMode"]) => void;
  openModelPicker: () => void;
}

export function ShellApp({
  platform,
  slots,
}: {
  platform: ShellPlatform;
  slots?: ShellSlots;
}): ReactElement {
  const store = useMemo(() => new ShellStore(platform.gateway), [platform]);
  const layout = useMemo(() => createLayoutStore(platform.storage), [platform]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const mac =
    /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "") || platform.kind === "desktop";
  return (
    <ShellProvider platform={platform} store={store} mac={mac}>
      <Shell layout={layout} slots={slots ?? {}} />
    </ShellProvider>
  );
}

type Overlay = "palette" | "shortcuts" | "model" | null;

function Shell({ layout, slots }: { layout: LayoutStore; slots: ShellSlots }): ReactElement {
  const { platform, store, mac } = useShell();
  const status = useShellState((s) => s.status);
  const threads = useShellState((s) => s.threads);
  const [route, setRoute] = useState(initialRoute);
  const [listHidden, setListHidden] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [focusToken, setFocusToken] = useState(0);
  const width = useWindowWidth();
  const compact = width < BREAKPOINT_MEDIUM;
  const newId = useRef(randomIds()).current;
  const createdMain = useRef(false);

  const mainThread: Thread | undefined = threads.find((t) => t.thread.kind === "main")?.thread;
  const routeThreadId = /^\/chat\/([^/]+)/.exec(route)?.[1];
  const threadId = routeThreadId ?? mainThread?.id ?? null;
  const thread = threads.find((t) => t.thread.id === threadId)?.thread ?? null;
  const popOutPane = /^\/chat\/[^/]+\/pane\/([^/]+)$/.exec(route)?.[1];

  const env = useCallback(
    (): LayoutEnv => ({
      width,
      contentWidth: Math.max(0, width - (compact ? 0 : 56) - (listHidden || compact ? 0 : 260)),
      now: () => new Date().toISOString(),
      newId,
    }),
    [width, compact, listHidden, newId],
  );

  const navigate = useCallback((to: string) => {
    setRoute(to);
    try {
      globalThis.history?.pushState(null, "", to);
    } catch {
      // app:// and file:// hosts may refuse; the in-memory route still changes
    }
  }, []);

  const dispatch = useCallback(
    (action: LayoutAction) => {
      if (threadId) layout.dispatch(threadId, action, env());
    },
    [layout, threadId, env],
  );

  // The main chat always exists (docs/06 §4.13); create it once if the Gateway has none yet.
  useEffect(() => {
    if (status.phase !== "paired" || mainThread || createdMain.current || threads.length > 0)
      return;
    const t = setTimeout(() => {
      if (createdMain.current) return;
      createdMain.current = true;
      void store
        .call("threads.create", { kind: "main" })
        .then(() => store.refresh())
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [status.phase, mainThread, threads.length, store]);

  // Re-fit layouts when the window narrows or widens.
  useEffect(() => {
    if (threadId) layout.dispatch(threadId, { type: "fitToWidth" }, env());
  }, [layout, threadId, env]);

  // view.* RPC from the Gateway (the agent opening, closing and focusing panes), then report.
  useEffect(() => {
    // Only the main window applies view.* and reports the layout; pop-outs and quick entry
    // receive the same events and must not act on them twice.
    if (platform.kind !== "desktop" || popOutPane || route === "/quick") return;
    const offCmd = store.tap((e) => {
      if (e.event !== "view.command" || !threadId) return;
      const out = layout.applyViewCommand(e.payload, threadId, env());
      if (!out.ok)
        store.toast(`The agent asked for a pane Psyche couldn't open (${out.error.code}).`, "warn");
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offLayout = layout.subscribe((changed) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void store
          .call("view.report", {
            layout: toViewLayout(layout.forThread(changed), () => new Date().toISOString()),
          })
          .catch(() => undefined);
      }, 100);
    });
    return () => {
      offCmd();
      offLayout();
      clearTimeout(timer);
    };
  }, [platform.kind, store, layout, threadId, env, popOutPane, route]);

  const newSideChat = useCallback(() => {
    void store
      .call<{ thread: Thread }>("threads.create", { kind: "side" })
      .then((r) => {
        if (r?.thread) {
          void store.refresh();
          navigate(`/chat/${r.thread.id}`);
        }
      })
      .catch(() => store.toast("Psyche couldn't create a side chat.", "error"));
  }, [store, navigate]);

  const setPermissionMode = useCallback(
    (permissionMode: Thread["permissionMode"]) => {
      if (!thread) return;
      void store
        .call("threads.update", { threadId: thread.id, permissionMode })
        .then((r) => {
          if (r === undefined)
            store.toast("Changing the permission mode needs a newer Gateway.", "warn");
          else void store.refresh();
        })
        .catch(() => store.toast("Changing the permission mode needs a newer Gateway.", "warn"));
    },
    [thread, store],
  );

  const cycleMode = useCallback(() => {
    if (!thread) return;
    const i = PERMISSION_MODES.indexOf(thread.permissionMode);
    const next = PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
    if (next) setPermissionMode(next);
  }, [thread, setPermissionMode]);

  useEffect(
    () =>
      platform.windows?.onCommand((c) => {
        if (c.type === "navigate") navigate(c.route);
        if (c.type === "newSideChat") newSideChat();
        if (c.type === "palette") setOverlay("palette");
        if (c.type === "closeThreadView") {
          if (popOutPane || route === "/quick") platform.windows?.closeWindow();
          else if (routeThreadId && routeThreadId !== mainThread?.id) navigate("/chat");
        }
      }),
    [platform.windows, navigate, newSideChat, popOutPane, route, routeThreadId, mainThread?.id],
  );

  const run = useCallback(
    (a: ShortcutAction): boolean => {
      switch (a) {
        case "palette":
          setOverlay((o) => (o === "palette" ? null : "palette"));
          return true;
        case "shortcutList":
          setOverlay((o) => (o === "shortcuts" ? null : "shortcuts"));
          return true;
        case "newSideChat":
          newSideChat();
          return true;
        case "toggleThreadList":
          setListHidden((h) => !h);
          return true;
        case "openBrowserPane":
          dispatch({ type: "open", pane: "browser" });
          return true;
        case "openDiffPane":
          dispatch({ type: "open", pane: "diff" });
          return true;
        case "toggleTerminalPane": {
          const has = threadId
            ? layout.forThread(threadId).panes.some((p) => p.pane === "terminal")
            : false;
          dispatch(has ? { type: "close", pane: "terminal" } : { type: "open", pane: "terminal" });
          return true;
        }
        case "closePane":
          dispatch({ type: "closeFocused" });
          return true;
        case "permissionMode":
          cycleMode();
          return true;
        case "modelPicker":
          setOverlay("model");
          return true;
        case "agentActivity":
          navigate("/agent/activity");
          return true;
        case "agentApprovals":
          navigate("/agent/approvals");
          return true;
        case "cycleThreads": {
          if (threads.length === 0) return true;
          const i = threads.findIndex((t) => t.thread.id === threadId);
          const next = threads[(i + 1) % threads.length];
          if (next) navigate(`/chat/${next.thread.id}`);
          return true;
        }
        case "stop":
          if (overlay) {
            setOverlay(null);
            return true;
          }
          if (thread?.activeWriterRunId) void store.call("chat.cancel", { threadId: thread.id });
          return true;
        case "approve":
        case "deny": {
          const btn = document.querySelector<HTMLButtonElement>(
            `[data-testid="approval-dock"] button[data-action="${a}"]`,
          );
          if (btn && !btn.disabled) {
            btn.click();
            return true;
          }
          return false;
        }
        default:
          return false;
      }
    },
    [newSideChat, dispatch, threadId, layout, cycleMode, navigate, threads, overlay, thread, store],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e, { mac, inText: isTextTarget(e.target) });
      if (action && run(action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mac, run]);

  const actions: PaletteAction[] = [
    { id: "new", label: "New side chat", run: newSideChat },
    {
      id: "browser",
      label: "Open browser pane",
      run: () => dispatch({ type: "open", pane: "browser" }),
    },
    {
      id: "terminal",
      label: "Open terminal pane",
      run: () => dispatch({ type: "open", pane: "terminal" }),
    },
    { id: "tasks", label: "Open tasks pane", run: () => dispatch({ type: "open", pane: "tasks" }) },
    { id: "model", label: "/model", run: () => setOverlay("model") },
    { id: "mode", label: "Switch permission mode", run: cycleMode },
    { id: "settings", label: "Settings", run: () => navigate("/settings/general") },
    { id: "shortcuts", label: "Keyboard shortcuts", run: () => setOverlay("shortcuts") },
  ];

  if (route === "/quick") {
    return (
      <div className="shell" style={{ gridTemplateColumns: "1fr" }} data-testid="quick-entry">
        <QuickEntry thread={mainThread ?? null} onDone={() => platform.windows?.closeWindow()} />
      </div>
    );
  }

  if (popOutPane && threadId) {
    return (
      <div className="shell" style={{ gridTemplateColumns: "1fr" }} data-testid="popout">
        <PaneArea
          layout={layout}
          threadId={threadId}
          width={width}
          covered={overlay !== null}
          dispatch={dispatch}
        />
        <Toasts />
      </div>
    );
  }

  const onChat = route.startsWith("/chat");
  const inset = hasInsetTitleBar(platform.chrome);
  const barTitle = onChat
    ? thread?.kind === "main" || thread === null
      ? "Main chat"
      : thread.title || "Side chat"
    : sectionTitle(route);
  return (
    <div className="app-frame" data-testid="app-frame">
      <TitleBar chrome={platform.chrome}>
        <span className="title">{barTitle}</span>
        {/* Connected is the quiet default; only other states earn a chip (docs/06 §3.0). */}
        {status.phase === "paired" ? null : (
          <span data-no-drag="">
            <GatewayPill status={status} />
          </span>
        )}
      </TitleBar>
      <div className="shell" data-compact={compact} data-testid="shell">
        {slots.rail ? (
          <div className="rail-slot" data-testid="rail">
            {slots.rail({ route, compact, navigate })}
          </div>
        ) : (
          <Rail
            route={route}
            compact={compact}
            onNavigate={navigate}
            {...(inset ? {} : { footer: <GatewayPill status={status} /> })}
          />
        )}
        {onChat && !compact && slots.threadList ? (
          <div className="threads-slot" hidden={listHidden} data-testid="thread-list">
            {slots.threadList({
              threadId,
              onOpen: (id) => navigate(`/chat/${id}`),
              onNew: newSideChat,
            })}
          </div>
        ) : onChat && !compact ? (
          <ThreadList
            hidden={listHidden}
            currentThreadId={threadId}
            onOpen={(id) => navigate(`/chat/${id}`)}
            onNew={newSideChat}
          />
        ) : (
          <span />
        )}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <OfflineBanner status={status} />
          {onChat && slots.chat && threadId ? (
            slots.chat(threadId, {
              thread,
              navigate,
              setPermissionMode,
              openModelPicker: () => setOverlay("model"),
            })
          ) : onChat ? (
            <ChatView
              thread={thread}
              onModeCycle={cycleMode}
              onModelPicker={() => setOverlay("model")}
              focusToken={focusToken}
            />
          ) : (
            (slots.section?.(route, navigate) ?? <SectionPlaceholder route={route} />)
          )}
        </div>
        {onChat && threadId ? (
          <PaneArea
            layout={layout}
            threadId={threadId}
            width={width}
            covered={overlay !== null}
            dispatch={dispatch}
          />
        ) : (
          <span />
        )}
        {overlay === "palette" ? (
          <CommandPalette
            actions={actions}
            onClose={() => setOverlay(null)}
            onNavigate={navigate}
          />
        ) : null}
        {overlay === "shortcuts" ? <ShortcutSheet onClose={() => setOverlay(null)} /> : null}
        {overlay === "model" ? (
          <ModelPicker
            current={thread?.modelRef ?? null}
            onClose={() => {
              setOverlay(null);
              setFocusToken((n) => n + 1);
            }}
            onPick={(modelRef) => {
              if (!thread) return;
              void store
                .call("threads.update", { threadId: thread.id, modelRef })
                .then(
                  (r) =>
                    r === undefined &&
                    store.toast("Picking a model needs a newer Gateway.", "warn"),
                )
                .catch(() => store.toast("Picking a model needs a newer Gateway.", "warn"));
            }}
          />
        ) : null}
        <Toasts />
      </div>
    </div>
  );
}
