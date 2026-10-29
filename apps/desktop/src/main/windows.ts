import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BaseWindow,
  type BaseWindowConstructorOptions,
  nativeTheme,
  screen,
  type WebContents,
  WebContentsView,
} from "electron";
import type { DockPolicy } from "./dock-policy.ts";
import { createPopOutRegistry } from "./pop-outs.ts";
import {
  canvasColor,
  mainWindowOptions,
  SETTINGS_WINDOW_MIN,
  SETTINGS_WINDOW_SIZE,
  settingsWindowOptions,
  TRAFFIC_LIGHTS,
} from "./window-options.ts";
import { type Rect, settingsWindowBounds } from "./window-placement.ts";

/**
 * Windows hosting the shell (architecture §5): one main `BaseWindow` with the app in a
 * `WebContentsView` (agent browser tabs are sibling views the BrowserHost lays over the pane),
 * pop-out windows for panes, and the frameless quick-entry window. Every app view runs the same
 * sandboxed renderer and preload; only the route differs.
 */

export interface AppWindows {
  main(): BaseWindow | undefined;
  /** The main window's app renderer: native commands and view.* go only here. */
  mainContents(): WebContents | undefined;
  /** After this, closing the main window really closes it (quit). */
  setQuitting(): void;
  /** Shows the main window, creating it when it was closed. */
  showMain(): BaseWindow;
  /** Opens a pane in its own window, or raises the one already open for the route. */
  popOut(route: string, title: string): void;
  /** Raises the pop-out for `route`; false when it is gone (the pane should dock again). */
  focusPopOut(route: string): boolean;
  /** Opens (or focuses) the Settings window on a section (⌘,; redesign §4). */
  showSettings(section?: string): void;
  /** The windows with app chrome (main, Settings) and their app views, for the canvas colour. */
  chromeWindows(): { win: BaseWindow; view: WebContentsView }[];
  toggleQuickEntry(): void;
  hideQuickEntry(): void;
  /** Every live app renderer (main, pop-outs, quick entry), for broadcasting. */
  appContents(): WebContents[];
  isAppContents(wc: WebContents): boolean;
  closeFor(wc: WebContents): void;
}

export interface WindowOptions {
  /** Base URL of the renderer (Vite dev server or app://psyche). */
  rendererUrl: string;
  preloadPath: string;
  onMainCreated?: (win: BaseWindow, view: WebContentsView) => void;
  /** Extra main-window options (the Liquid Glass spike's transparent window). */
  mainOptions?: Partial<BaseWindowConstructorOptions>;
  onMainClosed?: () => void;
  /** Every app renderer as it is made (main, pop-outs, quick entry): zoom and the like. */
  onViewCreated?: (wc: WebContents) => void;
  /** Whether the main window opens on the startup splash (#539). */
  splash?: () => boolean;
  /** The layout e2e sizes the window past CI's small screen (#561). */
  anySize?: boolean;
  /** A chrome window (main, Settings) was made: the native theme and the like. */
  onChromeWindowCreated?: (win: BaseWindow, view: WebContentsView) => void;
  /** A pane's pop-out window closed: the main window docks the pane again. */
  onPopOutClosed?: (route: string) => void;
  /** Where the Settings window's bounds are remembered (#596); unset, it always opens centred. */
  settingsBoundsFile?: string;
  /**
   * Frees the main window's app renderer after it has been hidden this long (the menu bar, owner
   * decision 2026-10-26; docs/design/lightweight-2026.md item 2). The window and the agent's tab
   * views stay; showing it again makes a new app view on the route it left, shown at once over
   * the page's static skeleton. Unset keeps the renderer forever.
   */
  releaseHiddenAfterMs?: number;
  /** Asked before a release; false keeps the renderer (unsent text) and tries again later. */
  canRelease?: (wc: WebContents) => Promise<boolean>;
  /** Every main app view, the first and each one made after a release: per-page wiring. */
  onMainViewCreated?: (win: BaseWindow, view: WebContentsView) => void;
  /**
   * Keeps Psyche out of the Dock and ⌘-Tab while no window is open (main, Settings, pop-outs; the
   * quick-entry bar and the panels are not counted). Unset leaves the activation policy alone.
   */
  dock?: Pick<DockPolicy, "beforeShow" | "afterShow" | "windowsChanged">;
}

/** Settings section ids are short slugs (`model`, `computer-use`). */
export function settingsRoute(section: string | undefined): string {
  const id = section && /^[a-z][a-z-]{0,39}$/.test(section) ? section : "model";
  return `/window/settings/${id}`;
}

export { TRAFFIC_LIGHTS };

/** What the renderer needs to draw the window chrome (passed as a launch argument). */
export interface ChromeArg {
  titleBar: "inset" | "native";
  trafficLights?: { x: number; y: number };
  /** The main window opens on the startup splash (#539). */
  splash?: boolean;
}

export const CHROME_ARG_PREFIX = "--psyche-chrome=";

const APP_PREFS = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  spellcheck: true,
} as const;

export function createAppWindows(opts: WindowOptions): AppWindows {
  let mainWin: BaseWindow | undefined;
  let mainView: WebContentsView | undefined;
  let quitting = false;
  let quick: { win: BaseWindow; view: WebContentsView } | undefined;
  let settings: { win: BaseWindow; view: WebContentsView } | undefined;
  const views = new Map<WebContents, { win: BaseWindow; view: WebContentsView }>();
  const popOutWins = new Set<BaseWindow>();
  // Closing the app (quit) closes pop-outs too; that is not a pane to dock again.
  const popOuts = createPopOutRegistry((route) => {
    if (!quitting) opts.onPopOutClosed?.(route);
  });

  // The windows that keep Psyche in the Dock and ⌘-Tab: main, Settings and the pop-outs. The
  // decision rests on whether a window exists, never on its visibility or focus: a minimized,
  // unfocused, occluded or other-Space window is still open (it lives in the Dock), and Electron's
  // "hide"/"blur" fire for plenty of reasons that are not the owner closing it (⌘H, a Space
  // switch, occlusion). Settings and pop-outs close for good, so they count while they exist
  // (counting from creation keeps a window that closes meanwhile from flashing the icon off). The
  // main window is only hidden by "Close window"; that close, and only that, marks it closed
  // until it is shown again. The quick-entry bar and the panels do not count.
  let mainClosed = false;
  const syncDock = () => {
    if (quitting) return;
    const live = (w: BaseWindow | undefined) => w !== undefined && !w.isDestroyed();
    const open = [
      live(mainWin) && !mainClosed,
      live(settings?.win),
      ...[...popOutWins].map(live),
    ].filter(Boolean).length;
    opts.dock?.windowsChanged(open);
  };
  const trackDock = (win: BaseWindow) => {
    win.on("show", syncDock);
    win.on("closed", syncDock);
  };
  /** Runs `show` with the app a regular one (⌘-Tab), then takes the focus the switch cost. */
  const showCounted = (show: () => void) => {
    const switched = opts.dock?.beforeShow() ?? false;
    show();
    opts.dock?.afterShow(switched);
  };

  const urlFor = (route: string) => {
    const url = new URL(route, opts.rendererUrl);
    const base = new URL(opts.rendererUrl);
    // Routes are app paths; anything that would leave the renderer's scheme/host is refused.
    if (url.protocol !== base.protocol || url.host !== base.host)
      throw new Error("route leaves the app");
    return url.toString();
  };

  function makeView(
    win: BaseWindow,
    route: string,
    chrome: ChromeArg = { titleBar: "native" },
  ): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        ...APP_PREFS,
        preload: opts.preloadPath,
        additionalArguments: [`${CHROME_ARG_PREFIX}${JSON.stringify(chrome)}`],
      },
    });
    win.contentView.addChildView(view, 0); // index 0: agent tab views stay above the app view
    const layout = () => {
      if (view.webContents.isDestroyed()) {
        win.off("resize", layout); // a released main view
        return;
      }
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    win.on("resize", layout);
    const wc = view.webContents;
    views.set(wc, { win, view });
    win.on("closed", () => {
      views.delete(wc);
      if (!wc.isDestroyed()) wc.close();
    });
    opts.onViewCreated?.(wc);
    void wc.loadURL(urlFor(route));
    return view;
  }

  function makeMainView(win: BaseWindow, route: string, chrome: ChromeArg): WebContentsView {
    const view = makeView(win, route, chrome);
    view.setBackgroundColor(canvasColor(nativeTheme.shouldUseDarkColors));
    mainView = view;
    opts.onMainViewCreated?.(win, view);
    return view;
  }

  // The main renderer's release while hidden (`releaseHiddenAfterMs`).
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let releasedRoute: string | undefined;
  const disarmRelease = () => {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    releaseTimer = undefined;
  };
  const armRelease = () => {
    disarmRelease();
    const ms = opts.releaseHiddenAfterMs;
    if (ms === undefined || ms <= 0) return;
    releaseTimer = setTimeout(() => void releaseMain(), ms);
  };
  async function releaseMain(): Promise<void> {
    releaseTimer = undefined;
    const win = mainWin;
    const view = mainView;
    if (quitting || !win || win.isDestroyed() || win.isVisible() || !view) return;
    const wc = view.webContents;
    if (wc.isDestroyed()) return;
    const ok = (await opts.canRelease?.(wc).catch(() => false)) ?? true;
    // Shown again, or released already, while the renderer was asked.
    if (win.isDestroyed() || win.isVisible() || mainView !== view || wc.isDestroyed()) return;
    if (!ok) {
      armRelease();
      return;
    }
    releasedRoute = routeOf(wc.getURL());
    mainView = undefined;
    win.contentView.removeChildView(view);
    views.delete(wc);
    wc.close();
  }
  /** The app route of a renderer URL (path, query, hash), or undefined when it is not the app's. */
  const routeOf = (url: string): string | undefined => {
    try {
      const u = new URL(url);
      const base = new URL(opts.rendererUrl);
      if (u.protocol !== base.protocol || u.host !== base.host) return undefined;
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return undefined;
    }
  };

  function createMain(): BaseWindow {
    mainClosed = false;
    const win = new BaseWindow({
      ...mainWindowOptions({
        anySize: opts.anySize === true,
        dark: nativeTheme.shouldUseDarkColors,
      }),
      ...opts.mainOptions,
    });
    const view = makeMainView(win, "/chat", {
      ...insetChrome(),
      ...(opts.splash?.() ? { splash: true } : {}),
    });
    view.webContents.once("did-finish-load", () => win.show());
    win.on("hide", armRelease);
    win.on("show", disarmRelease);
    win.on("show", () => {
      mainClosed = false;
    });
    trackDock(win);
    // "Close window" hides it: the agent browser's tab views live in this window and keep
    // working (feature A7, I11). Only quitting destroys it.
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      mainClosed = true;
      win.hide();
      syncDock();
    });
    win.on("closed", () => {
      disarmRelease();
      mainWin = undefined;
      mainView = undefined;
      opts.onMainClosed?.();
    });
    mainWin = win;
    opts.onMainCreated?.(win, view);
    opts.onChromeWindowCreated?.(win, view);
    return win;
  }

  const insetChrome = (): ChromeArg =>
    process.platform === "darwin"
      ? { titleBar: "inset", trafficLights: { ...TRAFFIC_LIGHTS } }
      : { titleBar: "native" };

  function createSettings(section?: string): { win: BaseWindow; view: WebContentsView } {
    const main = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() ? mainWin : undefined;
    const bounds = settingsWindowBounds({
      saved: readBounds(opts.settingsBoundsFile),
      main: main?.getBounds(),
      workAreas: [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea),
      size: SETTINGS_WINDOW_SIZE,
      min: SETTINGS_WINDOW_MIN,
    });
    const win = new BaseWindow({
      ...settingsWindowOptions({ dark: nativeTheme.shouldUseDarkColors }),
      ...bounds,
    });
    const view = makeView(win, settingsRoute(section), insetChrome());
    // Remembered on close, so it reopens where the owner left it (#596).
    win.on("close", () => writeBounds(opts.settingsBoundsFile, win.getNormalBounds()));
    view.setBackgroundColor(canvasColor(nativeTheme.shouldUseDarkColors));
    view.webContents.once("did-finish-load", () => win.show());
    win.on("closed", () => {
      settings = undefined;
    });
    trackDock(win);
    opts.onChromeWindowCreated?.(win, view);
    return { win, view };
  }

  function createQuick(): { win: BaseWindow; view: WebContentsView } {
    const win = new BaseWindow({
      width: 640,
      height: 160,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: "Quick entry",
    });
    const view = makeView(win, "/quick");
    win.on("blur", () => win.hide());
    win.on("closed", () => {
      quick = undefined;
    });
    return { win, view };
  }

  return {
    main: () => mainWin,
    mainContents: () =>
      mainView && !mainView.webContents.isDestroyed() ? mainView.webContents : undefined,
    setQuitting() {
      quitting = true;
    },
    showMain() {
      const switched = opts.dock?.beforeShow() ?? false;
      const win = mainWin ?? createMain();
      if (mainView === undefined) {
        // Released while hidden: a new app view on the route it left. The window shows at once,
        // over the canvas colour and index.html's skeleton, while the app loads (no splash: the
        // Gateway is already up).
        const view = makeMainView(win, releasedRoute ?? "/chat", insetChrome());
        releasedRoute = undefined;
        opts.onChromeWindowCreated?.(win, view);
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      opts.dock?.afterShow(switched);
      return win;
    },
    popOut(route, title) {
      if (popOuts.focus(route)) return;
      showCounted(() => {
        const win = new BaseWindow({
          width: 900,
          height: 700,
          minWidth: 480,
          minHeight: 360,
          title,
        });
        popOuts.add(route, win);
        popOutWins.add(win);
        win.on("closed", () => popOutWins.delete(win));
        trackDock(win);
        makeView(win, route);
        win.show();
      });
    },
    focusPopOut: (route) => {
      const found = popOuts.has(route);
      if (found) showCounted(() => popOuts.focus(route));
      return found;
    },
    showSettings(section) {
      showCounted(() => {
        if (settings && !settings.win.isDestroyed()) {
          if (section) void settings.view.webContents.loadURL(urlFor(settingsRoute(section)));
          settings.win.show();
          settings.win.focus();
          return;
        }
        settings = createSettings(section);
      });
    },
    chromeWindows() {
      const out: { win: BaseWindow; view: WebContentsView }[] = [];
      if (mainWin && mainView && !mainWin.isDestroyed()) out.push({ win: mainWin, view: mainView });
      if (settings && !settings.win.isDestroyed()) out.push(settings);
      return out;
    },
    toggleQuickEntry() {
      quick ??= createQuick();
      if (quick.win.isVisible()) {
        quick.win.hide();
        return;
      }
      quick.win.center();
      quick.win.show();
      quick.win.focus();
      quick.view.webContents.focus();
    },
    hideQuickEntry() {
      quick?.win.hide();
    },
    appContents: () => [...views.keys()].filter((wc) => !wc.isDestroyed()),
    isAppContents: (wc) => views.has(wc),
    closeFor(wc) {
      const entry = views.get(wc);
      if (!entry) return;
      if (entry.win === quick?.win) entry.win.hide();
      else entry.win.close();
    },
  };
}

export function preloadPath(): string {
  return join(app.getAppPath(), ".vite", "build", "preload.cjs");
}

function readBounds(file: string | undefined): unknown {
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined; // first run, or an unreadable file: open centred
  }
}

function writeBounds(file: string | undefined, bounds: Rect): void {
  if (!file) return;
  try {
    writeFileSync(file, `${JSON.stringify(bounds)}\n`);
  } catch (err) {
    console.warn(`[windows] could not remember the Settings window: ${String(err)}`);
  }
}
