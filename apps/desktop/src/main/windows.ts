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
  let quick: { win: BaseWindow; view: WebContentsView } | undefined;
  const views = new Map<WebContents, { win: BaseWindow; view: WebContentsView }>();

  const urlFor = (route: string) => new URL(route, opts.rendererUrl).toString();

  function makeView(win: BaseWindow, route: string, fill = true): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { ...APP_PREFS, preload: opts.preloadPath },
    });
    win.contentView.addChildView(view, 0); // index 0: agent tab views stay above the app view
    const layout = () => {
      const { width, height } = win.getContentBounds();
      if (fill) view.setBounds({ x: 0, y: 0, width, height });
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
    });
    const view = makeView(win, "/chat");
    view.webContents.once("did-finish-load", () => win.show());
    win.on("closed", () => {
      mainWin = undefined;
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
