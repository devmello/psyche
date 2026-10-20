import { BrowserWindow, type IpcMainEvent, ipcMain, screen, type WebContents } from "electron";
import { checkAudioChunk, IPC } from "../../lib/ipc.ts";
import type { DictationCapture, DictationHud, HudState } from "./controller.ts";

/**
 * The floating dictation HUD (UI design §3.18): a small non-activating panel near the bottom of
 * the screen with the pointer. It never takes focus, so the app being dictated into keeps it. It
 * runs the app renderer at `/dictation-hud`, which captures the microphone (the media permission
 * handler allows it as an app renderer) and sends 16 kHz PCM chunks back here.
 */

export const HUD_ROUTE = "/dictation-hud";
const WIDTH = 420;
const HEIGHT = 64;
const STOP_ACK_MS = 800;

export interface HudWindowOptions {
  url: (route: string) => string;
  preloadPath: string;
  onAudio: (chunk: string) => void;
}

export class HudWindow implements DictationHud, DictationCapture {
  readonly #o: HudWindowOptions;
  #win: BrowserWindow | undefined;
  #ready: Promise<void> | undefined;
  #captured: ((r: { ok: boolean }) => void) | undefined;

  constructor(opts: HudWindowOptions) {
    this.#o = opts;
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
      const ok = (r as { ok?: unknown } | null)?.ok === true;
      this.#captured?.({ ok });
      this.#captured = undefined;
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
      }
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
    const win = this.#win;
    if (!win || win.isDestroyed()) return;
    win.webContents.send(IPC.dictationHudState, null);
    win.hide();
  }

  async start(): Promise<void> {
    await this.warm();
    const win = this.#win;
    if (!win || win.isDestroyed()) throw new Error("no HUD");
    const started = new Promise<{ ok: boolean }>((resolve) => {
      this.#captured = resolve;
    });
    win.webContents.send(IPC.dictationCapture, "start");
    const r = await Promise.race([
      started,
      new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: false }), 3_000)),
    ]);
    if (!r.ok) throw new Error("microphone unavailable");
  }

  async stop(): Promise<void> {
    const win = this.#win;
    if (!win || win.isDestroyed()) return;
    const stopped = new Promise<{ ok: boolean }>((resolve) => {
      this.#captured = resolve;
    });
    win.webContents.send(IPC.dictationCapture, "stop");
    await Promise.race([stopped, new Promise((r) => setTimeout(r, STOP_ACK_MS))]);
  }

  destroy(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = undefined;
  }
}
