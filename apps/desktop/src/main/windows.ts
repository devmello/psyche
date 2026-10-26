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
  // Closing the app (quit) closes pop-outs too; that is not a pane to dock again.
  const popOuts = createPopOutRegistry((route) => {
    if (!quitting) opts.onPopOutClosed?.(route);
  });

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

  function createMain(): BaseWindow {
    const win = new BaseWindow({
      ...mainWindowOptions({
        anySize: opts.anySize === true,
        dark: nativeTheme.shouldUseDarkColors,
      }),
      ...opts.mainOptions,
    });
    const view = makeView(win, "/chat", {
      ...insetChrome(),
      ...(opts.splash?.() ? { splash: true } : {}),
    });
    view.setBackgroundColor(canvasColor(nativeTheme.shouldUseDarkColors));
    mainView = view;
    view.webContents.once("did-finish-load", () => win.show());
    // "Close window" hides it: the agent browser's tab views live in this window and keep
    // working (feature A7, I11). Only quitting destroys it.
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      win.hide();
    });
    win.on("closed", () => {
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
      const win = mainWin ?? createMain();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return win;
    },
    popOut(route, title) {
      if (popOuts.focus(route)) return;
      const win = new BaseWindow({ width: 900, height: 700, minWidth: 480, minHeight: 360, title });
      popOuts.add(route, win);
      makeView(win, route);
      win.show();
    },
    focusPopOut: (route) => popOuts.focus(route),
    showSettings(section) {
      if (settings && !settings.win.isDestroyed()) {
        if (section) void settings.view.webContents.loadURL(urlFor(settingsRoute(section)));
        settings.win.show();
        settings.win.focus();
        return;
      }
      settings = createSettings(section);
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
