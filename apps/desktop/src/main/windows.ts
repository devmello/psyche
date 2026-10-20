import { join } from "node:path";
import { app, BaseWindow, type WebContents, WebContentsView } from "electron";

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
  popOut(route: string, title: string): void;
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
  onMainClosed?: () => void;
}

/**
 * The main window draws its own title bar (`hiddenInset`); the traffic lights sit at this
 * position, vertically centred in the shell's 52 px bar (`TITLEBAR_HEIGHT` in the web shell).
 */
export const TRAFFIC_LIGHTS = { x: 18, y: 19 } as const;

/** What the renderer needs to draw the window chrome (passed as a launch argument). */
export interface ChromeArg {
  titleBar: "inset" | "native";
  trafficLights?: { x: number; y: number };
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
  const views = new Map<WebContents, { win: BaseWindow; view: WebContentsView }>();

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
    void wc.loadURL(urlFor(route));
    return view;
  }

  function createMain(): BaseWindow {
    const win = new BaseWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 600,
      title: "Psyche",
      show: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { ...TRAFFIC_LIGHTS },
    });
    const view = makeView(
      win,
      "/chat",
      process.platform === "darwin"
        ? { titleBar: "inset", trafficLights: { ...TRAFFIC_LIGHTS } }
        : { titleBar: "native" },
    );
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
    return win;
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
      const win = new BaseWindow({ width: 900, height: 700, minWidth: 480, minHeight: 360, title });
      makeView(win, route);
      win.show();
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
