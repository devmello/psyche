import { BrowserWindow, type IpcMainEvent, ipcMain, screen, type WebContents } from "electron";
import { checkAudioChunk, IPC } from "../../lib/ipc.ts";
import { CaptureLink, parseCaptureAck } from "./capture-link.ts";
import type { DictationCapture, DictationHud, HudState } from "./controller.ts";

/**
 * The floating dictation HUD (UI design §3.18): a small non-activating panel near the bottom of
 * the screen with the pointer. It never takes focus, so the app being dictated into keeps it. It
 * runs the app renderer at `/dictation-hud`, which captures the microphone (the media permission
 * handler allows it as an app renderer) and sends 16 kHz PCM chunks back here. The microphone is
 * opened per session and released on every exit; `CaptureLink` destroys the window when the HUD
 * cannot prove it let go (issue #611).
 */

export const HUD_ROUTE = "/dictation-hud";
const WIDTH = 420;
const HEIGHT = 64;

export interface HudWindowOptions {
  url: (route: string) => string;
  preloadPath: string;
  onAudio: (chunk: string) => void;
  warn?: (message: string) => void;
}

export class HudWindow implements DictationHud, DictationCapture {
  readonly #o: HudWindowOptions;
  #win: BrowserWindow | undefined;
  #ready: Promise<void> | undefined;
  readonly #link: CaptureLink;

  constructor(opts: HudWindowOptions) {
    this.#o = opts;
    this.#link = new CaptureLink({
      send: (command) => {
        const win = this.#win;
        if (!win || win.isDestroyed()) return false;
        win.webContents.send(IPC.dictationCapture, command);
        return true;
      },
      // Destroying the window ends its renderer and with it every stream it held.
      forceRelease: () => this.destroy(),
      ...(opts.warn ? { warn: opts.warn } : {}),
    });
    ipcMain.on(IPC.dictationAudio, (e: IpcMainEvent, chunk: unknown) => {
      if (!this.owns(e.sender)) return;
      try {
        this.#o.onAudio(checkAudioChunk(chunk));
      } catch {
        // malformed chunk: dropped
      }
    });
    ipcMain.on(IPC.dictationCaptured, (e: IpcMainEvent, r: unknown) => {
      if (!this.owns(e.sender)) return;
      const ack = parseCaptureAck(r);
      if (ack) this.#link.onAck(ack);
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

  /** Creates the hidden window ahead of time so the first hold starts listening at once. */
  warm(): Promise<void> {
    if (this.#win && !this.#win.isDestroyed() && this.#ready) return this.#ready;
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
      title: "Dictation",
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
    win.setIgnoreMouseEvents(true);
    win.on("closed", () => {
      if (this.#win === win) {
        this.#win = undefined;
        this.#ready = undefined;
        this.#link.reset();
      }
    });
    // A crashed or killed renderer holds no streams any more.
    win.webContents.on("render-process-gone", () => {
      if (this.#win === win) this.#link.reset();
    });
    this.#win = win;
    this.#ready = win.loadURL(this.#o.url(HUD_ROUTE)).catch(() => undefined);
    return this.#ready;
  }

  show(state: HudState): void {
    void this.warm().then(() => {
      const win = this.#win;
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.dictationHudState, state);
      if (!win.isVisible()) {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const { x, y, width, height } = display.workArea;
        win.setBounds({
          x: Math.round(x + (width - WIDTH) / 2),
          y: Math.round(y + height - HEIGHT - 48),
          width: WIDTH,
          height: HEIGHT,
        });
        win.showInactive();
      }
    });
  }

  hide(): void {
    // A hidden HUD never keeps the microphone (the controller stops first; this is the backstop).
    if (this.#link.capturing) void this.#link.stop();
    const win = this.#win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.dictationHudState, null);
    win.hide();
  }

  async start(): Promise<void> {
    await this.warm();
    await this.#link.start();
  }

  stop(): Promise<void> {
    return this.#link.stop();
  }

  destroy(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = undefined;
    this.#ready = undefined;
    this.#link.reset();
  }
}
