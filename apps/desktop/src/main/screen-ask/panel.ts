import { BrowserWindow, type IpcMainEvent, ipcMain, screen, type WebContents } from "electron";
import { IPC } from "../../lib/ipc.ts";

/**
 * Ask about my screen (docs/design/screen-ask-2026.md §2, §4): the ask panel, a small floating
 * panel near the top of the screen with the pointer that runs the app renderer at `/screen-ask`.
 * Main only shows it and says what to capture (`screenAskOpen {mode, rect?}`); the renderer calls
 * `screen.capture` itself, so the capture happens on the trigger and never in the background.
 *
 * The panel takes keyboard focus (you type into it) but is a non-activating panel, so the app you
 * were looking at stays frontmost and is what the helper captures. Pressing the shortcut again
 * while it is open (or its Select area button) opens the region overlay: a dimmed full-display
 * window at `/screen-ask-region` where you drag a box. Psyche's windows are never captured.
 *
 * The same panel is the voice pop-up (`trigger("voice")`, no capture). So the window exists while
 * either Ask about screen or Talk with Psyche is on (`setEnabled(on, source)`); the window
 * capture, region overlay and menu items follow Ask about screen only.
 */

/** What keeps the panel window: the screen shortcut, or the voice key. */
export type PanelSource = "screen" | "voice";

export const SCREEN_ASK_ROUTE = "/screen-ask";
export const SCREEN_ASK_REGION_ROUTE = "/screen-ask-region";
export const SCREEN_ASK_WIDTH = 480;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 360;
const TOP = 12;

/** What the panel's renderer is told to capture. */
export type ScreenAskOpen =
  | { mode: "window" }
  /** Voice pop-up: the same panel with no screen context; dictation starts at once. */
  | { mode: "voice" }
  | { mode: "region"; rect: { x: number; y: number; width: number; height: number } };

type Rect = { x: number; y: number; width: number; height: number };

/** Top-centre of the work area, like the voice HUD. */
export function panelBounds(workArea: Rect, height: number): Rect {
  const h = clampHeight(height);
  return {
    x: Math.round(workArea.x + (workArea.width - SCREEN_ASK_WIDTH) / 2),
    y: Math.round(workArea.y + TOP),
    width: SCREEN_ASK_WIDTH,
    height: h,
  };
}

export function clampHeight(h: unknown): number {
  const n = typeof h === "number" && Number.isFinite(h) ? Math.round(h) : MIN_HEIGHT;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, n));
}

/**
 * The overlay's dragged box (CSS px inside the overlay, which covers `display` exactly) as a box
 * in global screen points, or null for a bad payload or a box too small to read.
 */
export function regionRect(arg: unknown, display: Rect): Rect | null {
  const r = (arg as { rect?: Partial<Rect> | null } | null)?.rect;
  if (!r) return null;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const left = Math.max(0, Math.min(x as number, (x as number) + (width as number)));
  const top = Math.max(0, Math.min(y as number, (y as number) + (height as number)));
  const right = Math.min(display.width, Math.max(x as number, (x as number) + (width as number)));
  const bottom = Math.min(
    display.height,
    Math.max(y as number, (y as number) + (height as number)),
  );
  if (right - left < 8 || bottom - top < 8) return null;
  return {
    x: Math.round(display.x + left),
    y: Math.round(display.y + top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/** The thread to open from the panel, or undefined for a bad payload. */
export function parseThread(arg: unknown): string | undefined {
  const id = (arg as { threadId?: unknown } | null)?.threadId;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

export interface ScreenAskWindowOptions {
  url: (route: string) => string;
  preloadPath: string;
  /** "Open in Psyche": show the main window on this thread. */
  onOpenThread: (threadId: string) => void;
}

const webPreferences = (preload: string) => ({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: true,
  preload,
  backgroundThrottling: false,
});

export class ScreenAskWindow {
  readonly #o: ScreenAskWindowOptions;
  #win: BrowserWindow | undefined;
  #overlay: BrowserWindow | undefined;
  #overlayDisplay: Rect | undefined;
  readonly #sources = new Set<PanelSource>();
  #suspended = false;
  /** An open sent before the renderer loaded, delivered on did-finish-load. */
  #pending: ScreenAskOpen | undefined;

  constructor(opts: ScreenAskWindowOptions) {
    this.#o = opts;
    ipcMain.on(IPC.screenAskDone, (e: IpcMainEvent) => {
      if (this.owns(e.sender)) this.hide();
    });
    ipcMain.on(IPC.screenAskOpenThread, (e: IpcMainEvent, arg: unknown) => {
      if (!this.owns(e.sender)) return;
      const threadId = parseThread(arg);
      if (threadId === undefined) return;
      this.hide();
      this.#o.onOpenThread(threadId);
    });
    ipcMain.on(IPC.screenAskResize, (e: IpcMainEvent, arg: unknown) => {
      if (!this.owns(e.sender) || !this.#win || this.#win.isDestroyed()) return;
      const b = this.#win.getBounds();
      this.#win.setBounds({ ...b, height: clampHeight((arg as { height?: unknown })?.height) });
    });
    ipcMain.on(IPC.screenAskSelectArea, (e: IpcMainEvent) => {
      if (this.owns(e.sender)) this.selectArea();
    });
    ipcMain.on(IPC.screenAskRegion, (e: IpcMainEvent, arg: unknown) => {
      if (!this.ownsOverlay(e.sender)) return;
      const display = this.#overlayDisplay;
      this.#closeOverlay();
      const rect = display ? regionRect(arg, display) : null;
      // Esc or a click without a drag keeps the window capture.
      if (rect) this.#send({ mode: "region", rect });
      this.#win?.focus();
    });
  }

  /** The panel's renderer (trusted like the app's own windows). */
  owns(wc: WebContents | null | undefined): boolean {
    return (
      wc != null &&
      this.#win !== undefined &&
      !this.#win.isDestroyed() &&
      wc === this.#win.webContents
    );
  }

  ownsOverlay(wc: WebContents | null | undefined): boolean {
    return (
      wc != null &&
      this.#overlay !== undefined &&
      !this.#overlay.isDestroyed() &&
      wc === this.#overlay.webContents
    );
  }

  contents(): WebContents | undefined {
    const win = this.#win;
    return win && !win.isDestroyed() ? win.webContents : undefined;
  }

  isOpen(): boolean {
    return this.#win !== undefined && !this.#win.isDestroyed() && this.#win.isVisible();
  }

  /** Turns one source on or off; the window is warm while any source is on. */
  setEnabled(on: boolean, source: PanelSource = "screen"): void {
    if (on) this.#sources.add(source);
    else this.#sources.delete(source);
    if (this.#sources.size > 0) this.#warm();
    else this.destroy();
  }

  /** Whether `source` is on now. */
  enabled(source: PanelSource): boolean {
    return this.#sources.has(source);
  }

  /**
   * The shortcut or the menu item: open with a window capture, or go to region mode if open.
   * The voice key: open in voice mode (or just focus the open panel; its renderer dictates).
   */
  trigger(mode: "window" | "voice" = "window"): void {
    if (!this.#sources.has(mode === "voice" ? "voice" : "screen")) return;
    if (this.isOpen()) {
      if (mode === "window") this.selectArea();
      else this.contents()?.focus();
      return;
    }
    const win = this.#warm();
    if (!win) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(panelBounds(display.workArea, MIN_HEIGHT));
    this.#send({ mode });
    win.show();
    win.focus();
  }

  /** Opens the region overlay on the display with the pointer. */
  selectArea(): void {
    if (!this.#sources.has("screen") || this.#suspended) return;
    this.#closeOverlay();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const b = display.bounds;
    const overlay = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      type: "panel",
      title: "Select area",
      webPreferences: webPreferences(this.#o.preloadPath),
    });
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    overlay.on("closed", () => {
      if (this.#overlay === overlay) this.#overlay = undefined;
    });
    // Losing focus (another app, Mission Control) cancels the drag.
    overlay.on("blur", () => {
      if (this.#overlay === overlay) this.#closeOverlay();
    });
    this.#overlay = overlay;
    this.#overlayDisplay = { x: b.x, y: b.y, width: b.width, height: b.height };
    overlay.once("ready-to-show", () => {
      if (overlay.isDestroyed()) return;
      overlay.show();
      overlay.focus();
    });
    void overlay.loadURL(this.#o.url(SCREEN_ASK_REGION_ROUTE)).catch(() => undefined);
  }

  hide(): void {
    this.#closeOverlay();
    if (this.#win && !this.#win.isDestroyed()) this.#win.hide();
  }

  suspend(): void {
    this.#suspended = true;
    this.destroy();
  }

  resume(): void {
    this.#suspended = false;
    this.#warm();
  }

  destroy(): void {
    this.#closeOverlay();
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = undefined;
  }

  #closeOverlay(): void {
    const o = this.#overlay;
    this.#overlay = undefined;
    this.#overlayDisplay = undefined;
    if (o && !o.isDestroyed()) o.destroy();
  }

  #send(open: ScreenAskOpen): void {
    const wc = this.contents();
    if (!wc || wc.isLoading()) {
      this.#pending = open;
      return;
    }
    wc.send(IPC.screenAskOpen, open);
  }

  #warm(): BrowserWindow | undefined {
    if (this.#sources.size === 0 || this.#suspended) return undefined;
    if (this.#win && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      width: SCREEN_ASK_WIDTH,
      height: MIN_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      hasShadow: true,
      type: "panel",
      title: "Ask about screen",
      webPreferences: webPreferences(this.#o.preloadPath),
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    win.on("closed", () => {
      if (this.#win === win) this.#win = undefined;
    });
    win.webContents.on("did-finish-load", () => {
      const open = this.#pending;
      this.#pending = undefined;
      if (open && this.#win === win) win.webContents.send(IPC.screenAskOpen, open);
    });
    win.webContents.on("render-process-gone", () => {
      if (this.#win !== win) return;
      this.destroy();
      this.#warm();
    });
    this.#win = win;
    void win.loadURL(this.#o.url(SCREEN_ASK_ROUTE)).catch(() => undefined);
    return win;
  }
}
