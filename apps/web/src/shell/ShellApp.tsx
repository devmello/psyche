import type { Thread } from "@psyche/protocol";
import {
  AGENT_PANEL_MIN_CONTENT,
  AGENT_PANEL_WIDTH,
  CompactTopBar,
  clampSidebarWidth,
  destinationFor,
  PanePresence,
  ReflowColumn,
  RouteTransition,
  ShellMotion,
  SIDEBAR_RAIL,
  SIDEBAR_WIDTH,
  type SidebarMode,
  SidebarPresence,
  SidebarToggle,
  TabBar,
  ThreadCrossfade,
  ThreadsDrawer,
  t,
  type UiSlots,
  UiSlotsProvider,
  useStore,
} from "@psyche/ui";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChatView, PERMISSION_MODES, QuickEntry } from "./components/Chat.tsx";
import {
  GatewayPill,
  OfflineBanner,
  SectionPlaceholder,
  ShellSidebar,
  ThreadList,
  Toasts,
} from "./components/Chrome.tsx";
import {
  CommandPalette,
  ModelPicker,
  type PaletteAction,
  ShortcutSheet,
} from "./components/Overlays.tsx";
import { PaneArea, type PaneRenderer } from "./components/Panes.tsx";
import { hasInsetTitleBar, TitleBar, titleBarInset } from "./components/TitleBar.tsx";
import { ShellProvider, useShell, useShellState } from "./context.tsx";
import { matchShortcut, type ShortcutAction } from "./keyboard.ts";
import {
  BREAKPOINT_MEDIUM,
  createLayoutStore,
  type LayoutAction,
  type LayoutEnv,
  type LayoutStore,
  type PaneInstance,
  randomIds,
  toViewLayout,
} from "./layout/index.ts";
import type { GatewayRunView, ShellPlatform, WindowChrome } from "./platform.ts";
import { ShellStore } from "./store.ts";
import "./shell.css";
import "./layout/shell-layout.css";
import type { GatewayStatus } from "../client/status.ts";

/**
 * The shared shell (docs/06 §3.1, redesign §4–§5.1): the sidebar, the content column and the
 * pane area, with the keyboard map, palette, offline banner and `view.*` handling. Below 720 px:
 * the compact top bar, a threads drawer and the tab bar (§5.11). Hosts pass a `ShellPlatform`.
 */

/** The title bar's label for a non-chat route (`/settings/files` → "Settings"). */
export function sectionTitle(route: string): string {
  const head = route.split("/")[1] ?? "";
  if (head === "") return "Psyche"; // i18n-ignore: the product name as a brand
  return t("web.section.title", {
    section: head,
    fallback: head.charAt(0).toUpperCase() + head.slice(1),
  });
}

/** Routes that show the chat column: `/chat…`, and `/agent/*` with the agent sheet over it. */
export function isChatRoute(route: string): boolean {
  return /^\/(chat|agent)(\/|$|\?)/.test(route);
}

/** The agent sheet's routes (redesign §5.7): `/agent/<tab>[/<task>][?file=]`. */
export function isAgentRoute(route: string): boolean {
  return /^\/agent(\/|$|\?)/.test(route);
}

/**
 * The route under the agent sheet (#614): the current route, or under `/agent/*` the section the
 * sheet opened over (`last`), so the sheet opens over whatever screen the owner is on.
 */
export function underlyingRoute(route: string, last: string): string {
  return isAgentRoute(route) ? last : route;
}

/**
 * Whether the agent sheet sits beside the content (#625) or opens as the modal overlay: beside
 * when the window is wider than the compact breakpoint and the content column keeps at least
 * `AGENT_PANEL_MIN_CONTENT` next to the sheet. Panes beside the chat (Files, Browser) already
 * share the row, so with one open the sheet stays the overlay.
 */
export function agentSheetDocked(opts: {
  compact: boolean;
  contentWidth: number;
  panesOpen?: boolean;
}): boolean {
  return (
    !opts.compact &&
    !opts.panesOpen &&
    opts.contentWidth - AGENT_PANEL_WIDTH >= AGENT_PANEL_MIN_CONTENT
  );
}

/** The bar's width over a collapsed sidebar: the traffic lights plus the show-sidebar button. */
const COLLAPSED_CHROME_LEAD = 128;
/** The sidebar toggle in the title bar (a 32 px icon button) and the gap after it. */
const TITLEBAR_TOGGLE_ROOM = 42;
/** The gap between the traffic-light zone and a toolbar's first control. */
const TOOLBAR_LEAD_GAP = 4;

/**
 * The desktop's hidden-title-bar layout (#597, #624): `lead` is how far the title-bar strip runs
 * from the window's left edge (the traffic lights, then the sidebar toggle); `toolbar` is the
 * left padding a screen's toolbar needs to stay clear of that strip, or null when the full
 * sidebar already covers it. The compact rail (64 px) is narrower than the lights' zone, so its
 * toolbars keep part of the inset; with the sidebar hidden they keep all of it.
 */
export function chromeLead(opts: {
  chrome: WindowChrome | undefined;
  sidebarOpen: boolean;
  mode: SidebarMode;
  sidebarWidth: number;
}): { lead: number; toolbar: number | null } {
  const lights = Math.max(COLLAPSED_CHROME_LEAD, titleBarInset(opts.chrome) + TITLEBAR_TOGGLE_ROOM);
  const visible = !opts.sidebarOpen
    ? 0
    : opts.mode === "rail"
      ? SIDEBAR_RAIL.width
      : opts.sidebarWidth;
  if (visible >= lights) return { lead: visible, toolbar: null };
  return { lead: lights, toolbar: lights - visible + TOOLBAR_LEAD_GAP };
}

/** The Settings window's routes (`/window/settings/:section`), opened by the desktop main. */
export const SETTINGS_WINDOW_PREFIX = "/window/settings";

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
  /**
   * The agent sheet for `/agent/*` over whatever section is underneath (#614), chat included.
   * `inline` (#625): a column beside the content on windows wide enough for both, which the
   * shell slides in and out; render the panel only while `route` is set. `overlay`: the modal
   * sheet on narrower windows; `route` is null once it closed (keep the last one while the sheet
   * animates out). `onClose` returns to the section underneath.
   */
  agentSheet?: (props: {
    route: string | null;
    presentation: "inline" | "overlay";
    navigate: (to: string) => void;
    onClose: () => void;
  }) => ReactNode;
  /** The sidebar (redesign §5.1): destinations, threads and the persona footer. */
  sidebar?: (props: SidebarSlotProps) => ReactNode;
  /** The threads alone, for the compact drawer (§5.11). */
  threadList?: (props: {
    threadId: string | null;
    onOpen: (threadId: string) => void;
    onNew: () => void;
  }) => ReactNode;
  /** ⌘K (§5.5); absent keeps the shell's own palette. */
  palette?: (props: PaletteSlotProps) => ReactNode;
  /**
   * A pane's body (docs/06 §2.4), e.g. the Files pane with the viewers (§3.7); `null` or
   * `undefined` keeps the shell's own view for that pane.
   */
  pane?: PaneRenderer;
}

export interface SidebarSlotProps {
  route: string;
  navigate: (to: string) => void;
  threadId: string | null;
  onOpenThread: (threadId: string) => void;
  onNew: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  /** Full sidebar or the icon-only rail (#598). */
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  /** A row above the destinations: the sidebar toggle where there is no title bar (web). */
  header?: ReactNode;
}

export interface PaletteSlotProps {
  open: boolean;
  onClose: () => void;
  navigate: (to: string) => void;
  /** The shell's commands: new side chat, panes, /model, mode, shortcuts. */
  actions: PaletteAction[];
}

/** Persisted sidebar state (redesign §5.1: the width is remembered; ⌘B too). */
const SIDEBAR_WIDTH_KEY = "shell.sidebar.width";
const SIDEBAR_OPEN_KEY = "shell.sidebar.open";
const SIDEBAR_MODE_KEY = "shell.sidebar.mode";

/** What the chat slot needs from the shell to drive the agent header (§3.1). */
export interface ChatSlotContext {
  thread: Thread | null;
  /** The current route; `/agent/*` opens the agent sheet over the chat (redesign §5.7). */
  route: string;
  navigate: (to: string) => void;
  setPermissionMode: (mode: Thread["permissionMode"]) => void;
  openModelPicker: () => void;
  /** Opens a pane beside the chat, e.g. the Files pane on a Library item (§2.4). */
  openPane: (pane: PaneInstance["pane"], target?: string | null) => void;
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

/** Desktop only: the supervised Gateway process, for the connection banner. */
function useGatewayRun(platform: ShellPlatform): GatewayRunView | undefined {
  const [run, setRun] = useState<GatewayRunView>();
  useEffect(() => {
    const { getRun, onRun } = platform.gateway;
    if (!getRun || !onRun) return;
    let live = true;
    void getRun.call(platform.gateway).then(
      (r) => live && setRun(r),
      () => undefined,
    );
    const off = onRun.call(platform.gateway, setRun);
    return () => {
      live = false;
      off();
    };
  }, [platform]);
  return run;
}

/** How long a desktop `pending` reads as a reconnect before the pairing code shows (#539). */
export const PAIRING_GRACE_MS = 3_000;
/** Longer for a window that was already paired this session (a restart or a network blip). */
export const PAIRING_GRACE_AFTER_PAIRED_MS = 10_000;

/**
 * Desktop only: whether a `pending` handshake is still the reconnect window rather than a real
 * pairing request. This device is the bootstrapped admin; the Gateway answers `paired` within
 * milliseconds, so a pending that persists is the only one worth showing a pairing code for.
 */
export function usePairingGrace(status: GatewayStatus, desktop: boolean): boolean {
  const [grace, setGrace] = useState(true);
  const everPaired = useRef(false);
  if (status.phase === "paired") everPaired.current = true;
  const pending = status.phase === "pending";
  useEffect(() => {
    if (!desktop || !pending) {
      setGrace(true);
      return;
    }
    const timer = setTimeout(
      () => setGrace(false),
      everPaired.current ? PAIRING_GRACE_AFTER_PAIRED_MS : PAIRING_GRACE_MS,
    );
    return () => clearTimeout(timer);
  }, [desktop, pending]);
  return desktop && grace;
}

function Shell({ layout, slots }: { layout: LayoutStore; slots: ShellSlots }): ReactElement {
  const { platform, store, mac } = useShell();
  const status = useShellState((s) => s.status);
  const threads = useShellState((s) => s.threads);
  const gatewayRun = useGatewayRun(platform);
  const pairingGrace = usePairingGrace(status, platform.kind === "desktop");
  const [route, setRoute] = useState(initialRoute);
  // The section under the agent sheet (#614): the last route outside `/agent/*`. Feed, Goals, …
  // stay mounted beneath the sheet and closing it returns there; a cold `/agent/*` sits on Chat.
  const baseRef = useRef(isAgentRoute(route) ? "/chat" : route);
  if (!isAgentRoute(route)) baseRef.current = route;
  const base = baseRef.current;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => platform.storage.get(SIDEBAR_OPEN_KEY) !== "false",
  );
  const [sidebarMode, setSidebarModeState] = useState<SidebarMode>(() =>
    platform.storage.get(SIDEBAR_MODE_KEY) === "rail" ? "rail" : "full",
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(platform.storage.get(SIDEBAR_WIDTH_KEY));
    return stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_WIDTH.default;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [focusToken, setFocusToken] = useState(0);
  const width = useWindowWidth();
  const compact = width < BREAKPOINT_MEDIUM;
  const newId = useRef(randomIds()).current;
  const createdMain = useRef(false);

  const mainThread: Thread | undefined = threads.find((x) => x.thread.kind === "main")?.thread;
  const routeThreadId = /^\/chat\/([^/]+)/.exec(base)?.[1];
  const threadId = routeThreadId ?? mainThread?.id ?? null;
  const thread = threads.find((x) => x.thread.id === threadId)?.thread ?? null;
  const popOutPane = /^\/chat\/[^/]+\/pane\/([^/]+)$/.exec(route)?.[1];
  // Panes beside the chat take the room the docked agent sheet would need (#625).
  const subscribePanes = useCallback(
    (cb: () => void) => (threadId ? layout.subscribeThread(threadId, cb) : () => {}),
    [layout, threadId],
  );
  const panesOpen = useSyncExternalStore(subscribePanes, () =>
    threadId ? layout.forThread(threadId).panes.length > 0 : false,
  );

  const env = useCallback(
    (): LayoutEnv => ({
      width,
      contentWidth: Math.max(
        0,
        width -
          (!sidebarOpen || compact
            ? 0
            : sidebarMode === "rail"
              ? SIDEBAR_RAIL.width
              : sidebarWidth),
      ),
      now: () => new Date().toISOString(),
      newId,
    }),
    [width, compact, sidebarOpen, sidebarMode, sidebarWidth, newId],
  );

  // Desktop: Settings live in their own window (⌘,; docs/design/redesign-2026.md §4, §5.8).
  const settingsWindow = useRef(initialRoute().startsWith(SETTINGS_WINDOW_PREFIX)).current;
  const openSettings = platform.windows?.openSettings;
  const routeRef = useRef(route);
  routeRef.current = route;
  const navigate = useCallback(
    (target: string) => {
      let to = target;
      if (to.startsWith("/settings")) {
        if (settingsWindow) to = `/window${to}`;
        else if (openSettings) {
          openSettings(to.split("/")[2]);
          return;
        }
      } else if (settingsWindow) return;
      // A new destination crossfades the content column (motion.md §4.5); a thread switch inside
      // Chat, or anything on the same screen, changes in place. The agent sheet opening or
      // closing over a section keeps that section where it is (#614).
      const crossfade =
        destinationFor(underlyingRoute(to, baseRef.current)) !==
        destinationFor(underlyingRoute(routeRef.current, baseRef.current));
      if (crossfade) startTransition(() => setRoute(to));
      else setRoute(to);
      try {
        globalThis.history?.pushState(null, "", to);
      } catch {
        // app:// and file:// hosts may refuse; the in-memory route still changes
      }
    },
    [settingsWindow, openSettings],
  );

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      platform.storage.set(SIDEBAR_OPEN_KEY, String(!open));
      return !open;
    });
  }, [platform]);
  const setSidebarMode = useCallback(
    (mode: SidebarMode) => {
      setSidebarModeState(mode);
      platform.storage.set(SIDEBAR_MODE_KEY, mode);
    },
    [platform],
  );
  // ⌥⌘B: the rail and the full sidebar, showing it if it was hidden (#598).
  const toggleSidebarMode = useCallback(() => {
    setSidebarMode(sidebarMode === "rail" ? "full" : "rail");
    if (!sidebarOpen) toggleSidebar();
  }, [setSidebarMode, sidebarMode, sidebarOpen, toggleSidebar]);
  const resizeSidebar = useCallback(
    (w: number) => {
      const next = clampSidebarWidth(w);
      setSidebarWidth(next);
      platform.storage.set(SIDEBAR_WIDTH_KEY, String(next));
    },
    [platform],
  );

  // The kit's own links (Goals' Add a goal, a failed run's Settings → Models) use the shell's route.
  // Settings → Connectors "Try it" (#677): the text waits in the kit's store until the chat's
  // composer takes it, and the chat shows (the current thread when one is open). From the
  // desktop's Settings window, main brings the main window forward and does the same there.
  // Never sends.
  const kitStore = useStore();
  const prefillWindow = settingsWindow ? platform.windows?.prefillComposer : undefined;
  const prefillComposer = useCallback(
    (text: string) => {
      if (prefillWindow) {
        prefillWindow.call(platform.windows, text);
        return;
      }
      kitStore.update((s) => ({ ...s, composerPrefill: text }));
      if (!/^\/chat(\/|$|\?)/.test(routeRef.current)) navigate("/chat");
    },
    [prefillWindow, platform.windows, kitStore, navigate],
  );
  const kitSlots = useMemo<UiSlots>(
    () => ({ navigate, prefillComposer }),
    [navigate, prefillComposer],
  );

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
    const timer = setTimeout(() => {
      if (createdMain.current) return;
      createdMain.current = true;
      void store
        .call("threads.create", { kind: "main" })
        .then(() => store.refresh())
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
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
      if (!out.ok) store.toast(t("web.toast.paneFailed", { code: out.error.code }), "warn");
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

  const newChat = useCallback(
    (kind: "side" | "incognito") => {
      void store
        .call<{ thread: Thread }>("threads.create", { kind })
        .then((r) => {
          if (r?.thread) {
            void store.refresh();
            navigate(`/chat/${r.thread.id}`);
          }
        })
        .catch(() =>
          store.toast(
            kind === "incognito" ? t("web.toast.incognitoFailed") : t("web.toast.sideChatFailed"),
            "error",
          ),
        );
    },
    [store, navigate],
  );
  const newSideChat = useCallback(() => newChat("side"), [newChat]);
  const newIncognitoChat = useCallback(() => newChat("incognito"), [newChat]);

  const setPermissionMode = useCallback(
    (permissionMode: Thread["permissionMode"]) => {
      if (!thread) return;
      void store
        .call("threads.update", { threadId: thread.id, permissionMode })
        .then((r) => {
          if (r === undefined) store.toast(t("web.toast.permissionModeUnsupported"), "warn");
          else void store.refresh();
        })
        .catch(() => store.toast(t("web.toast.permissionModeUnsupported"), "warn"));
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
        if (c.type === "prefillComposer") prefillComposer(c.text);
        if (c.type === "closeThreadView") {
          if (popOutPane || route === "/quick") platform.windows?.closeWindow();
          else if (routeThreadId && routeThreadId !== mainThread?.id) navigate("/chat");
        }
      }),
    [
      platform.windows,
      navigate,
      newSideChat,
      prefillComposer,
      popOutPane,
      route,
      routeThreadId,
      mainThread?.id,
    ],
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
          // ⌘B: the sidebar, or the threads drawer when compact (redesign §4).
          if (compact) setDrawerOpen((o) => !o);
          else toggleSidebar();
          return true;
        case "toggleCompactSidebar":
          if (!compact) toggleSidebarMode();
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
          if (thread?.activeWriterRunId) {
            void store.call("chat.cancel", { threadId: thread.id });
            return true;
          }
          // Nothing to stop: Escape goes on to the focused field or menu (the sidebar's filter).
          return false;
        case "approve":
        case "deny": {
          // The kit card owns ⌘Return / ⌘D (arming delay, Deny preselected); hand it the key.
          const card = document.querySelector<HTMLElement>(
            '[data-testid="approval-dock"] [data-approval-id]',
          );
          if (!card) return false;
          card.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: a === "approve" ? "Enter" : "d",
              metaKey: true,
              bubbles: true,
            }),
          );
          return true;
        }
        default:
          return false;
      }
    },
    [
      newSideChat,
      dispatch,
      threadId,
      layout,
      cycleMode,
      navigate,
      threads,
      overlay,
      thread,
      store,
      compact,
      toggleSidebar,
      toggleSidebarMode,
    ],
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
    { id: "new", label: t("web.palette.newSideChat"), run: newSideChat },
    { id: "incognito", label: t("web.palette.newIncognito"), run: newIncognitoChat },
    {
      id: "browser",
      label: t("web.palette.openBrowser"),
      run: () => dispatch({ type: "open", pane: "browser" }),
    },
    {
      id: "terminal",
      label: t("web.palette.openTerminal"),
      run: () => dispatch({ type: "open", pane: "terminal" }),
    },
    {
      id: "tasks",
      label: t("web.palette.openTasks"),
      run: () => dispatch({ type: "open", pane: "tasks" }),
    },
    {
      id: "files",
      label: t("web.palette.openFiles"),
      run: () => dispatch({ type: "open", pane: "files" }),
    },
    // i18n-ignore: the composer command, typed as is in every language
    { id: "model", label: "/model", run: () => setOverlay("model") },
    { id: "mode", label: t("web.palette.switchMode"), run: cycleMode },
    { id: "settings", label: t("web.rail.settings"), run: () => navigate("/settings/model") },
    { id: "shortcuts", label: t("web.shortcuts.title"), run: () => setOverlay("shortcuts") },
  ];

  if (settingsWindow) {
    const section = route.slice("/window".length) || "/settings/model";
    return (
      <UiSlotsProvider value={kitSlots}>
        <div className="app-frame" data-testid="settings-window">
          <TitleBar chrome={platform.chrome}>
            <span className="title">{sectionTitle(section)}</span>
          </TitleBar>
          <div className="settings-window-body">
            {slots.section?.(section, navigate) ?? <SectionPlaceholder route={section} />}
          </div>
          <Toasts />
        </div>
      </UiSlotsProvider>
    );
  }

  if (route === "/quick") {
    return (
      <div className="shell" style={{ gridTemplateColumns: "1fr" }} data-testid="quick-entry">
        <QuickEntry thread={mainThread ?? null} onDone={() => platform.windows?.closeWindow()} />
      </div>
    );
  }

  if (popOutPane && threadId) {
    return (
      <UiSlotsProvider value={kitSlots}>
        <div className="shell" style={{ gridTemplateColumns: "1fr" }} data-testid="popout">
          <PaneArea
            layout={layout}
            threadId={threadId}
            width={width}
            covered={overlay !== null}
            dispatch={dispatch}
            {...(slots.pane ? { renderPane: slots.pane, navigate } : {})}
          />
          <Toasts />
        </div>
      </UiSlotsProvider>
    );
  }

  // The agent sheet opens over the current section (redesign §5.7, #614): `/agent/*` keeps what
  // was showing mounted underneath. Over the chat, the chat slot opens the sheet for the route;
  // over any other section the `agentSheet` slot does.
  const onChat = isChatRoute(base);
  const inset = hasInsetTitleBar(platform.chrome);
  const barTitle = onChat
    ? thread?.kind === "main" || thread === null
      ? t("web.threads.mainChat")
      : thread.title || t("web.threads.sideChat")
    : sectionTitle(base);
  const parent =
    onChat && thread?.parentThreadId
      ? threads.find((x) => x.thread.id === thread.parentThreadId)?.thread
      : undefined;
  const forkedFrom = parent
    ? parent.kind === "main"
      ? t("web.threads.mainChat")
      : parent.title || t("web.threads.sideChat")
    : null;
  // The toolbar's leading toggle (redesign §4, #598): click hides or shows the sidebar (⌘B),
  // ⌥-click or its menu switches to the compact rail (⌥⌘B). On the desktop it sits in the title
  // bar after the traffic lights, in both states.
  const sidebarToggle = (
    <SidebarToggle
      open={sidebarOpen}
      onToggle={toggleSidebar}
      mode={sidebarMode}
      onModeChange={setSidebarMode}
      className="shell-sidebar-toggle"
    />
  );
  const openThread = (id: string) => navigate(`/chat/${id}`);
  const threadsFor = (onOpen: (id: string) => void) =>
    slots.threadList ? (
      slots.threadList({ threadId, onOpen, onNew: newSideChat })
    ) : (
      <ThreadList currentThreadId={threadId} onOpen={onOpen} onNew={newSideChat} />
    );
  const sidebar = slots.sidebar ? (
    slots.sidebar({
      route: base,
      navigate,
      threadId,
      onOpenThread: openThread,
      onNew: newSideChat,
      width: sidebarWidth,
      onWidthChange: resizeSidebar,
      mode: sidebarMode,
      onModeChange: setSidebarMode,
      ...(inset ? {} : { header: sidebarToggle }),
    })
  ) : (
    <ShellSidebar
      route={base}
      onNavigate={navigate}
      width={sidebarMode === "rail" ? SIDEBAR_RAIL.width : sidebarWidth}
      rail={sidebarMode === "rail"}
      {...(inset ? {} : { header: sidebarToggle })}
      {...(onChat && sidebarMode !== "rail" ? { threads: threadsFor(openThread) } : {})}
      {...(inset ? {} : { footer: <GatewayPill status={status} /> })}
    />
  );
  // Without a title bar (web) the toggle shows only while the sidebar is hidden; in the sidebar's
  // own top row otherwise, at the same spot.
  const showSidebarButton = !compact && !sidebarOpen ? sidebarToggle : null;
  const lead = chromeLead({
    chrome: platform.chrome,
    sidebarOpen,
    mode: sidebarMode,
    sidebarWidth,
  });
  const content =
    onChat && slots.chat && threadId ? (
      slots.chat(threadId, {
        thread,
        route,
        navigate,
        setPermissionMode,
        openModelPicker: () => setOverlay("model"),
        openPane: (pane, target) => dispatch({ type: "open", pane, target: target ?? null }),
      })
    ) : onChat ? (
      <ChatView
        thread={thread}
        onModeCycle={cycleMode}
        onModelPicker={() => setOverlay("model")}
        focusToken={focusToken}
      />
    ) : (
      (slots.section?.(base, navigate) ?? <SectionPlaceholder route={base} />)
    );
  // The agent sheet (#614, #625): beside the content when the window has room for both, the
  // content column shrinking from the right; the modal overlay otherwise. Closing returns to the
  // section underneath (the chat's thread on Chat).
  const sheetRoute = isAgentRoute(route) ? route : null;
  const docked = agentSheetDocked({
    compact,
    contentWidth: env().contentWidth ?? width,
    panesOpen: onChat && panesOpen,
  });
  const closeSheet = () => navigate(onChat && threadId ? `/chat/${threadId}` : baseRef.current);
  const sheetFor = (presentation: "inline" | "overlay") =>
    slots.agentSheet?.({ route: sheetRoute, presentation, navigate, onClose: closeSheet }) ?? null;
  return (
    <UiSlotsProvider value={kitSlots}>
      <ShellMotion>
        <div
          className="app-frame"
          data-testid="app-frame"
          // Unified chrome on the desktop (#597; redesign §4): the bar is a drag strip over the
          // sidebar only (the traffic lights sit in its material) and each screen's toolbar is
          // the drag region over the canvas.
          data-chrome={inset && !compact ? "inset" : undefined}
          // A hidden sidebar or the narrow rail leaves the traffic lights over the toolbars,
          // which then start after them (#624).
          data-toolbar-lead={lead.toolbar === null ? undefined : ""}
          style={
            {
              "--chrome-lead": `${lead.lead}px`,
              ...(lead.toolbar === null ? {} : { "--toolbar-lead": `${lead.toolbar}px` }),
            } as CSSProperties
          }
        >
          <a className="skip-link" href="#main">
            {t("web.shell.skipToContent")}
          </a>
          <TitleBar chrome={platform.chrome}>
            {inset && !compact ? sidebarToggle : null}
            {/* A side chat names where it came from (redesign §5.4). */}
            {forkedFrom ? (
              <span
                className="title-fork"
                role="img"
                aria-label={t("shell.sidebar.forkedFrom", { parent: forkedFrom })}
                title={t("shell.sidebar.forkedFrom", { parent: forkedFrom })}
              >
                ↳
              </span>
            ) : null}
            <span className="title">{barTitle}</span>
            {/* Connected is the quiet default; only other states earn a chip (docs/06 §3.0). */}
            {status.phase === "paired" ? null : (
              <span data-no-drag="">
                <GatewayPill status={status} />
              </span>
            )}
          </TitleBar>
          {compact ? (
            <CompactTopBar
              onOpenThreads={() => setDrawerOpen(true)}
              onOpenSearch={() => setOverlay("palette")}
              {...(onChat ? {} : { title: barTitle })}
              {...(onChat && thread
                ? {
                    mode: thread.permissionMode,
                    onModeChange: setPermissionMode,
                    model: thread.modelRef,
                    onOpenModelPicker: () => setOverlay("model"),
                  }
                : {})}
            />
          ) : null}
          <div
            className="shell shell-sidebar-layout"
            data-compact={compact}
            data-sidebar={compact ? "drawer" : sidebarOpen ? "open" : "collapsed"}
            data-sidebar-mode={sidebarMode}
            data-testid="shell"
          >
            {compact ? null : (
              // `rail-slot` is what the native-glass spike (desktop main/glass.ts) makes clear.
              <SidebarPresence
                open={sidebarOpen}
                className="sidebar-slot rail-slot"
                testId="sidebar-slot"
              >
                {sidebar}
              </SidebarPresence>
            )}
            <ReflowColumn
              id="main"
              tabIndex={-1}
              aria-label={barTitle}
              className="shell-content"
              data-testid="content"
            >
              {inset ? null : showSidebarButton}
              {/* The chat has no visible page title (docs/a11y-audit.md L2). */}
              {onChat ? <h1 className="sr-only">{barTitle}</h1> : null}
              <OfflineBanner
                status={status}
                pairingGrace={pairingGrace}
                {...(gatewayRun ? { run: gatewayRun } : {})}
                {...(platform.gateway.showLogs
                  ? { onShowLogs: () => void platform.gateway.showLogs?.() }
                  : {})}
              />
              <RouteTransition>
                {onChat ? (
                  // Keyed by the route's thread: `/chat` stays one view while the main chat loads.
                  <ThreadCrossfade threadId={routeThreadId ?? "main"} className="shell-route">
                    {content}
                  </ThreadCrossfade>
                ) : (
                  <div className="shell-route">{content}</div>
                )}
              </RouteTransition>
              {docked ? null : sheetFor("overlay")}
            </ReflowColumn>
            {onChat && threadId ? (
              <PaneArea
                layout={layout}
                threadId={threadId}
                width={width}
                covered={overlay !== null}
                dispatch={dispatch}
                {...(slots.pane ? { renderPane: slots.pane, navigate } : {})}
              />
            ) : null}
            {docked ? (
              <PanePresence
                className="agent-sheet-presence"
                style={{ width: AGENT_PANEL_WIDTH }}
                testId="agent-sheet-column"
              >
                {sheetRoute === null ? null : sheetFor("inline")}
              </PanePresence>
            ) : null}
            {compact ? (
              <div className="tab-bar-slot" data-testid="rail">
                <TabBar active={destinationFor(base)} onNavigate={navigate} />
              </div>
            ) : null}
            {slots.palette ? (
              slots.palette({
                open: overlay === "palette",
                onClose: () => setOverlay(null),
                navigate,
                actions,
              })
            ) : overlay === "palette" ? (
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
                        r === undefined && store.toast(t("web.toast.modelUnsupported"), "warn"),
                    )
                    .catch(() => store.toast(t("web.toast.modelUnsupported"), "warn"));
                }}
              />
            ) : null}
            <Toasts />
          </div>
          <ThreadsDrawer open={compact && drawerOpen} onOpenChange={setDrawerOpen}>
            {threadsFor((id) => {
              setDrawerOpen(false);
              openThread(id);
            })}
          </ThreadsDrawer>
        </div>
      </ShellMotion>
    </UiSlotsProvider>
  );
}
