import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import { IPC } from "./lib/ipc.ts";

/**
 * Typed bridge (architecture §5). The renderer gets these functions and nothing else: no Node
 * APIs, no generic `invoke`/`send`, no secrets. Main validates every payload. Gateway calls go
 * through main, which holds the connection and the device key.
 */

interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; retryable?: boolean; details?: unknown };
}

class BridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(e: { code: string; message: string; retryable?: boolean; details?: unknown }) {
    super(e.message);
    this.name = "PsycheError";
    this.code = e.code;
    this.retryable = e.retryable ?? false;
    this.details = e.details;
  }
}

async function invoke(channel: string, arg?: unknown): Promise<unknown> {
  const res = (await ipcRenderer.invoke(channel, arg)) as Envelope;
  if (!res.ok) throw new BridgeError(res.error ?? { code: "internal", message: "IPC failed" });
  return res.value;
}

/**
 * The window chrome main chose for this view (`--psyche-chrome=` launch argument, see
 * `main/windows.ts`): the main window draws its own title bar under the traffic lights.
 */
export interface ChromeFromArgv {
  /**
   * `inset`: macOS, traffic lights at `trafficLights`. `overlay`: Windows, caption buttons drawn
   * by Windows on the right in a `titleBarOverlay.height` px Window Controls Overlay (lay out with
   * `env(titlebar-area-*)`), `material` behind what the page leaves unpainted.
   */
  titleBar: "inset" | "overlay" | "native";
  trafficLights?: { x: number; y: number };
  titleBarOverlay?: { height: number };
  material?: "mica" | "acrylic" | "none";
  splash?: boolean;
  remote?: { hostName: string };
  uninstall?: boolean;
}

export function chromeFromArgv(argv: readonly string[]): ChromeFromArgv {
  const raw = argv.find((a) => a.startsWith("--psyche-chrome="))?.slice("--psyche-chrome=".length);
  try {
    const v = raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
    const t = v?.trafficLights as { x?: unknown; y?: unknown } | undefined;
    const splash = v?.splash === true ? { splash: true } : {};
    const host = (v?.remote as { hostName?: unknown } | undefined)?.hostName;
    const remote =
      typeof host === "string" && host.length > 0 && host.length <= 64
        ? { remote: { hostName: host } }
        : {};
    const uninstall =
      v?.uninstall === true && remote.remote === undefined ? { uninstall: true } : {};
    const m = v?.material;
    const material: { material?: "mica" | "acrylic" | "none" } =
      m === "mica" || m === "acrylic" || m === "none" ? { material: m } : {};
    if (v?.titleBar === "overlay") {
      const h = (v.titleBarOverlay as { height?: unknown } | undefined)?.height;
      return {
        titleBar: "overlay",
        titleBarOverlay: {
          height: typeof h === "number" && Number.isFinite(h) && h >= 24 && h <= 96 ? h : 40,
        },
        ...material,
        ...splash,
        ...remote,
        ...uninstall,
      };
    }
    return v?.titleBar === "inset"
      ? {
          titleBar: "inset",
          ...(typeof t?.x === "number" && typeof t.y === "number"
            ? { trafficLights: { x: t.x, y: t.y } }
            : {}),
          ...splash,
          ...remote,
          ...uninstall,
        }
      : { titleBar: "native", ...material, ...splash, ...remote, ...uninstall };
  } catch {
    return { titleBar: "native" };
  }
}

/** `process.platform` as the page's CSS names it (`<html data-platform="windows">`). */
export function platformAttribute(platform: string): "macos" | "windows" | "linux" {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

/**
 * Marks the document before the page's own script runs, so platform CSS (the Windows caption
 * buttons' reserved strip, Mica's transparent regions) applies from the first paint:
 * `data-platform`, `data-titlebar` and, when there is one, `data-material`.
 */
function markDocument(chrome: ChromeFromArgv): void {
  if (typeof document === "undefined") return;
  const mark = () => {
    const root = document.documentElement;
    if (!root) return false;
    root.dataset.platform = platformAttribute(process.platform);
    root.dataset.titlebar = chrome.titleBar;
    if (chrome.material !== undefined) root.dataset.material = chrome.material;
    return true;
  };
  if (!mark()) document.addEventListener("DOMContentLoaded", mark, { once: true });
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const chrome = chromeFromArgv(process.argv);
markDocument(chrome);

const bridge = {
  platform: process.platform,
  chrome,
  gateway: {
    getStatus: () => invoke(IPC.getStatus),
    deviceId: () => invoke(IPC.getDeviceId),
    onStatus: (cb: (s: unknown) => void) => listen(IPC.status, cb),
    /**
     * Resolves the raw `{ok, value} | {ok: false, error}` envelope: `contextBridge` copies only
     * an Error's message, so the renderer builds the error itself (`renderer/bridge.ts`) and
     * keeps `code` and `details` (e.g. `approval_required` → `{ approvalId }`).
     */
    call: (method: string, params: unknown, idempotencyKey?: string) =>
      ipcRenderer.invoke(IPC.call, {
        method,
        params,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }) as Promise<Envelope>,
    onEvent: (cb: (e: unknown) => void) => listen(IPC.event, cb),
    onResync: (cb: () => void) => listen(IPC.resync, () => cb()),
    getRun: () => invoke(IPC.gatewayGetRun),
    onRun: (cb: (s: unknown) => void) => listen(IPC.gatewayRun, cb),
    showLogs: () => invoke(IPC.gatewayShowLogs),
    retry: () => invoke(IPC.gatewayRetry),
  },
  gateways: {
    list: () => invoke(IPC.gatewaysList),
    add: (address: string, name?: string) => invoke(IPC.gatewaysAdd, { address, name }),
    addLink: (link: string) => invoke(IPC.gatewaysAddLink, { link }),
    takePendingLink: () => invoke(IPC.gatewaysPendingLink),
    onPendingLink: (cb: () => void) => listen(IPC.gatewaysLinkOpened, () => cb()),
    discover: () => invoke(IPC.gatewaysDiscover),
    addDiscovered: (id: string) => invoke(IPC.gatewaysAddDiscovered, { id }),
    rename: (id: string, name: string) => invoke(IPC.gatewaysRename, { id, name }),
    remove: (id: string) => invoke(IPC.gatewaysRemove, { id }),
    switchTo: (id: string, opts?: { stopLocal?: boolean }) =>
      invoke(IPC.gatewaysSwitch, { id, stopLocal: opts?.stopLocal === true }),
    repair: (id: string) => invoke(IPC.gatewaysRepair, { id }),
  },
  browser: {
    getState: () => invoke(IPC.browserGetState),
    onState: (cb: (s: unknown) => void) => listen(IPC.browserState, cb),
    onDownload: (cb: (d: unknown) => void) => listen(IPC.browserDownload, cb),
    setViewport: (rect: unknown) => ipcRenderer.send(IPC.browserViewport, rect),
    openTab: (url: string, profile?: string) => invoke(IPC.browserOpen, { url, profile }),
    closeTab: (tabId: string) => invoke(IPC.browserClose, tabId),
    activateTab: (tabId: string) => invoke(IPC.browserActivate, tabId),
    navigate: (tabId: string, action: string) => invoke(IPC.browserNavigate, { tabId, action }),
    find: (tabId: string, text: string, opts?: { forward?: boolean }) =>
      invoke(IPC.browserFind, { tabId, text, forward: opts?.forward }),
    stopFind: (tabId: string) => invoke(IPC.browserStopFind, tabId),
    setControl: (tabId: string, take: boolean) => invoke(IPC.browserSetControl, { tabId, take }),
    popOut: (tabId: string, fullScreen?: boolean) =>
      invoke(IPC.browserPopOut, { tabId, fullScreen }),
    clearBrowsingData: (profile: string) => invoke(IPC.browserClearData, profile),
    answerPrompt: (promptId: string, action: string) =>
      invoke(IPC.browserPromptAnswer, { promptId, action }),
    listSignedInSites: () => invoke(IPC.browserSignedInList),
    forgetSignedInSite: (origin: string) => invoke(IPC.browserSignedInForget, origin),
    openRealChromeProfile: (profile?: string) =>
      invoke(IPC.browserOpenRealChromeProfile, profile ?? "default"),
    // Teach by showing: owner-only, from the pane's own buttons.
    teachStart: (tabId: string) => invoke(IPC.teachStart, { tabId }),
    teachStop: () => invoke(IPC.teachStop),
    teachCancel: () => invoke(IPC.teachCancel),
    teachKeep: (id: string, title: string, steps: unknown) =>
      invoke(IPC.teachKeep, { id, title, steps }),
    teachKept: () => invoke(IPC.teachKept),
    teachStorage: () => invoke(IPC.teachStorage),
    teachOpenKept: (id: string) => invoke(IPC.teachOpenKept, { id }),
    teachDeleteKept: (id: string) => invoke(IPC.teachDeleteKept, { id }),
    // Teach by showing in a Mac app: the owner picks a granted app and presses Record.
    teachAppApps: () => invoke(IPC.teachAppApps),
    teachAppStart: (bundleId: string) => invoke(IPC.teachAppStart, { bundleId }),
    teachAppStop: () => invoke(IPC.teachAppStop),
    teachAppCancel: () => invoke(IPC.teachAppCancel),
    teachAppStatus: () => invoke(IPC.teachAppStatus),
  },
  windows: {
    popOutPane: (route: string, title: string) => invoke(IPC.windowPopOut, { route, title }),
    focusPopOut: (route: string) => invoke(IPC.windowFocusPopOut, { route }),
    closeWindow: () => ipcRenderer.send(IPC.windowClose),
    openSettings: (section?: string) => ipcRenderer.send(IPC.windowOpenSettings, section ?? null),
    /** Fills the main window's composer and brings it forward; never sends (#677). */
    prefillComposer: (text: string) => ipcRenderer.send(IPC.windowPrefillComposer, { text }),
    /** From the Settings window: the main window comes forward and navigates to `route`. */
    openInMain: (route: string) => ipcRenderer.send(IPC.windowOpenInMain, { route }),
    onCommand: (cb: (c: unknown) => void) => listen(IPC.shellCommand, cb),
  },
  notify: {
    show: (n: { title: string; body: string; route?: string }) =>
      ipcRenderer.send(IPC.notifyShow, n),
  },
  dialogs: {
    pickFolder: (opts?: { title?: string }) => invoke(IPC.dialogPickFolder, opts ?? {}),
  },
  /**
   * Voice conversation (V-G): the voice key going down / up from any app, and `lock` / `suspend`
   * when the Mac locks or sleeps, so the audio terminal ends its conversation and frees the mic.
   */
  voice: {
    onKey: (cb: (e: unknown) => void) => listen(IPC.voiceKey, cb),
    onSystem: (cb: (e: unknown) => void) => listen(IPC.voiceSystem, cb),
  },
  /** The ask panel and its region overlay only (`ScreenAskBridge`); main ignores other senders. */
  screenAsk: {
    onOpen: (cb: (open: unknown) => void) => listen(IPC.screenAskOpen, cb),
    done: () => ipcRenderer.send(IPC.screenAskDone),
    openThread: (threadId: string) => ipcRenderer.send(IPC.screenAskOpenThread, { threadId }),
    resize: (height: number) => ipcRenderer.send(IPC.screenAskResize, { height }),
    selectArea: () => ipcRenderer.send(IPC.screenAskSelectArea),
    region: (rect: { x: number; y: number; width: number; height: number } | null) =>
      ipcRenderer.send(IPC.screenAskRegion, { rect }),
    /** Push-to-talk in the voice pop-up: the voice key going down / up from any app. */
    onVoiceKey: (cb: (down: boolean) => void) =>
      listen<{ down?: unknown } | null>(IPC.voiceKey, (e) => cb(e?.down === true)),
  },
  /** The dictation HUD window only; main ignores these from any other renderer. */
  dictation: {
    onState: (cb: (s: unknown) => void) => listen(IPC.dictationHudState, cb),
    onCapture: (cb: (command: unknown) => void) => listen(IPC.dictationCapture, cb),
    sendAudio: (chunk: string) => ipcRenderer.send(IPC.dictationAudio, chunk),
    /** Answers one capture command: `open` = a microphone track is still live afterwards. */
    captured: (ack: { id: number; ok: boolean; open: boolean }) =>
      ipcRenderer.send(IPC.dictationCaptured, ack),
    // Settings → Voice & dictation.
    getStatus: () => invoke(IPC.dictationGetStatus),
    onStatus: (cb: (s: unknown) => void) => listen(IPC.dictationStatus, cb),
    recheck: () => invoke(IPC.dictationRecheck),
    checkHotkey: (accelerator: string, purpose?: "dictation" | "screenAsk" | "quickEntry") =>
      invoke(IPC.dictationCheckHotkey, { accelerator, ...(purpose ? { purpose } : {}) }),
    openAccessibilitySettings: () => ipcRenderer.send(IPC.dictationOpenAccessibility),
  },
  /** macOS privacy permissions (onboarding, Settings): prompt or open the pane, and read status. */
  permissions: {
    status: () => invoke(IPC.permissionsStatus),
    request: (kind: string) => invoke(IPC.permissionsRequest, { kind }),
  },
  helper: {
    getState: () => invoke(IPC.helperGetState),
    onState: (cb: (s: unknown) => void) => listen(IPC.helperState, cb),
    /** Starts the bundled helper (an approval card's "Start Psyche Helper"); resolves to its state. */
    launch: () => invoke(IPC.helperLaunch),
    // Touch ID through the bundled helper: main and Settings windows only (main checks).
    touchIdIdentity: () => invoke(IPC.touchIdIdentity),
    // Register and approve resolve the raw envelope like `gateway.call`: the approval card reads
    // the error's `code` and `details.reason` (no key, helper offline) to offer the fix.
    touchIdRegister: () => ipcRenderer.invoke(IPC.touchIdRegister) as Promise<Envelope>,
    touchIdApprove: (p: { approvalId: string; answerToken: string }) =>
      ipcRenderer.invoke(IPC.touchIdApprove, p) as Promise<Envelope>,
  },
  /** Windows: the sandbox PC's one-time setup (elevated service install + guest image download). */
  sandboxPc: {
    getState: () => invoke(IPC.sandboxPcGetState),
    refresh: () => invoke(IPC.sandboxPcRefresh),
    turnOn: () => invoke(IPC.sandboxPcTurnOn),
    updateService: () => invoke(IPC.sandboxPcUpdateService),
    cancel: () => invoke(IPC.sandboxPcCancel),
    onState: (cb: (s: unknown) => void) => listen(IPC.sandboxPcState, cb),
  },
  /**
   * A passkey for the remote Gateway (remote windows only; main refuses it elsewhere). Resolves
   * the raw envelope: the card needs the error's `details.name` to tell a cancel from a failure.
   */
  passkeys: {
    create: (options: unknown) =>
      ipcRenderer.invoke(IPC.passkeyCreate, options) as Promise<Envelope>,
    get: (options: unknown) => ipcRenderer.invoke(IPC.passkeyGet, options) as Promise<Envelope>,
  },
  /** Copies text to the system clipboard (#507). */
  clipboard: {
    writeText: (text: string, opts?: { clearAfterMs?: number }) =>
      invoke(IPC.clipboardWrite, {
        text,
        ...(opts?.clearAfterMs === undefined ? {} : { clearAfterMs: opts.clearAfterMs }),
      }),
  },
  /** Opens an https page in the default browser (a connector's sign-in, #505). */
  external: {
    open: (url: string) => invoke(IPC.openExternal, { url }),
  },
  /**
   * Opens the original of a cited passage from its search document id (Mail for a message,
   * Finder for a file in a granted folder). Resolves the raw envelope like `gateway.call`; the
   * value is "mail" | "file" | "none". Main resolves the target itself: nothing else is sent.
   */
  sources: {
    open: (docId: string) => ipcRenderer.invoke(IPC.sourceOpen, { docId }) as Promise<Envelope>,
  },
  /** Settings → About (#610): versions, platform, the data folder and the Gateway's origin. */
  app: {
    info: () => invoke(IPC.appInfo),
    revealHome: () => invoke(IPC.appRevealHome),
    /** Uninstall Psyche (main refuses it in a remote window). Run resolves the raw envelope. */
    uninstallPlan: (p: { deleteData: boolean; removeKeychain?: boolean }) =>
      invoke(IPC.appUninstallPlan, p),
    uninstall: (p: {
      deleteData: boolean;
      removeKeychain?: boolean;
      confirm?: string;
      approvalId?: string;
    }) => ipcRenderer.invoke(IPC.appUninstall, p) as Promise<Envelope>,
  },
  /** macOS Reduce Transparency and Increase Contrast (redesign §3.4, §8). */
  systemAppearance: {
    get: () => invoke(IPC.systemAppearanceGet),
    on: (cb: (a: unknown) => void) => listen(IPC.systemAppearance, cb),
  },
  /** The macOS region format and preferred languages (A12). */
  locale: {
    get: () => invoke(IPC.localeGet),
  },
};

export type PsycheBridge = typeof bridge;

contextBridge.exposeInMainWorld("psyche", bridge);
