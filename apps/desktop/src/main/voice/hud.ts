import { BrowserWindow, type IpcMainEvent, ipcMain, screen, type WebContents } from "electron";
import { IPC } from "../../lib/ipc.ts";

/**
 * The voice HUD (docs/voice/voice-mode-2026.md §6.2): a small non-activating panel at the top of
 * the screen with the pointer, for a voice conversation started from any app. It runs the app
 * renderer at `/voice-hud[?thread=]`, which is its own audio terminal: it hears the voice key as
 * the Gateway's `dictation.key` event (role `voice`), captures and plays audio, and calls
 * `voiceHud.done()` 4 s after the last reply or `voiceHud.openThread()` when clicked.
 *
 * The window is kept warm (loaded, hidden, microphone closed) while voice conversation is on, so
 * the first key press reaches it. Every ending destroys the window, which ends its renderer and
 * with it every stream it held (as for dictation, #611), then a fresh one is warmed.
 */

export const VOICE_HUD_ROUTE = "/voice-hud";
const WIDTH = 380;
const HEIGHT = 96;
const TOP = 12;

/** The HUD's route: the main thread, or the side chat it talks on. */
export function voiceHudRoute(threadId: string | null = null): string {
  return threadId === null
    ? VOICE_HUD_ROUTE
    : `${VOICE_HUD_ROUTE}?thread=${encodeURIComponent(threadId)}`;
}

/** The thread to open from the HUD (null: the main chat), or undefined for a bad payload. */
export function parseOpenThread(arg: unknown): string | null | undefined {
  const id = (arg as { threadId?: unknown } | null)?.threadId;
  if (id === null) return null;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

/** Where the main window goes when the HUD is clicked. */
export function threadRoute(threadId: string | null): string {
  return threadId === null ? "/chat" : `/chat/${threadId}`;
}

export interface VoiceHudWindowOptions {
  url: (route: string) => string;
  preloadPath: string;
  /** The HUD was clicked: show the main window on this thread (null: the main chat). */
  onOpenThread: (threadId: string | null) => void;
}

export class VoiceHudWindow {
  readonly #o: VoiceHudWindowOptions;
  #win: BrowserWindow | undefined;
  #enabled = false;
  #suspended = false;

  constructor(opts: VoiceHudWindowOptions) {
    this.#o = opts;
    ipcMain.on(IPC.voiceHudDone, (e: IpcMainEvent) => {
      if (this.owns(e.sender)) this.#recycle();
    });
    ipcMain.on(IPC.voiceHudOpenThread, (e: IpcMainEvent, arg: unknown) => {
      if (!this.owns(e.sender)) return;
      const threadId = parseOpenThread(arg);
      if (threadId === undefined) return;
      this.#recycle();
      this.#o.onOpenThread(threadId);
    });
  }

  owns(wc: WebContents | null | undefined): boolean {
    return (
      wc != null &&
      this.#win !== undefined &&
      !this.#win.isDestroyed() &&
      wc === this.#win.webContents
    );
  }

  /** The HUD's renderer, for main's event fan-out (none while there is no window). */
  contents(): WebContents | undefined {
    const win = this.#win;
    return win && !win.isDestroyed() ? win.webContents : undefined;
  }

  /** Voice conversation was turned on or off (the voice key is armed or not). */
  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (on) this.#warm();
    else this.destroy();
  }

  /** The voice key went down: show the panel. The renderer starts the conversation itself. */
  show(): void {
    const win = this.#warm();
    if (!win || win.isVisible()) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width } = display.workArea;
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + TOP),
      width: WIDTH,
      height: HEIGHT,
    });
    win.showInactive();
  }

  /** The Mac locked or went to sleep: end any conversation and keep no window until it's back. */
  suspend(): void {
    this.#suspended = true;
    this.destroy();
  }

  resume(): void {
    this.#suspended = false;
    this.#warm();
  }

  destroy(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = undefined;
  }

  /** Ends the conversation's window (and its microphone) and warms a fresh one. */
  #recycle(): void {
    this.destroy();
    this.#warm();
  }

  #warm(): BrowserWindow | undefined {
    if (!this.#enabled || this.#suspended) return undefined;
    if (this.#win && !this.#win.isDestroyed()) return this.#win;
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: true,
      type: "panel",
      title: "Voice",
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        preload: this.#o.preloadPath,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Unlike the dictation HUD it takes clicks (open the thread, end, mute), but never focus.
    win.on("closed", () => {
      if (this.#win === win) this.#win = undefined;
    });
    // A crashed renderer holds no streams any more; the next key needs a live one.
    win.webContents.on("render-process-gone", () => {
      if (this.#win === win) this.#recycle();
    });
    this.#win = win;
    void win.loadURL(this.#o.url(voiceHudRoute())).catch(() => undefined);
    return win;
  }
}
