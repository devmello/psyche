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
function chromeFromArgv(argv: readonly string[]): {
  titleBar: "inset" | "native";
  trafficLights?: { x: number; y: number };
  splash?: boolean;
} {
  const raw = argv.find((a) => a.startsWith("--psyche-chrome="))?.slice("--psyche-chrome=".length);
  try {
    const v = raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
    const t = v?.trafficLights as { x?: unknown; y?: unknown } | undefined;
    const splash = v?.splash === true ? { splash: true } : {};
    return v?.titleBar === "inset"
      ? {
          titleBar: "inset",
          ...(typeof t?.x === "number" && typeof t.y === "number"
            ? { trafficLights: { x: t.x, y: t.y } }
            : {}),
          ...splash,
        }
      : { titleBar: "native", ...splash };
  } catch {
    return { titleBar: "native" };
  }
}

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const bridge = {
  platform: process.platform,
  chrome: chromeFromArgv(process.argv),
  gateway: {
    getStatus: () => invoke(IPC.getStatus),
    deviceId: () => invoke(IPC.getDeviceId),
    onStatus: (cb: (s: unknown) => void) => listen(IPC.status, cb),
    /**
     * Resolves the raw `{ok, value} | {ok: false, error}` envelope: `contextBridge` copies only
     * an Error's message, so the renderer builds the error itself (`renderer/bridge.ts`) and
     * keeps `code` and `details` (e.g. `approval_required` → `{ approvalId }`).
     */
    call: (method: string, params: unknown) =>
      ipcRenderer.invoke(IPC.call, { method, params }) as Promise<Envelope>,
    onEvent: (cb: (e: unknown) => void) => listen(IPC.event, cb),
    onResync: (cb: () => void) => listen(IPC.resync, () => cb()),
    getRun: () => invoke(IPC.gatewayGetRun),
    onRun: (cb: (s: unknown) => void) => listen(IPC.gatewayRun, cb),
    showLogs: () => invoke(IPC.gatewayShowLogs),
    retry: () => invoke(IPC.gatewayRetry),
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
    openRealChromeProfile: (profile?: string) =>
      invoke(IPC.browserOpenRealChromeProfile, profile ?? "default"),
  },
  terminal: {
    open: (opts: unknown) => invoke(IPC.terminalOpen, opts),
    write: (sessionId: string, data: string) =>
      ipcRenderer.send(IPC.terminalWrite, { sessionId, data }),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.terminalResize, { sessionId, cols, rows }),
    close: (sessionId: string) => ipcRenderer.send(IPC.terminalClose, sessionId),
    onData: (cb: (p: { sessionId: string; data: string }) => void) => listen(IPC.terminalData, cb),
    onExit: (cb: (p: { sessionId: string; exitCode: number }) => void) =>
      listen(IPC.terminalExit, cb),
  },
  windows: {
    popOutPane: (route: string, title: string) => invoke(IPC.windowPopOut, { route, title }),
    closeWindow: () => ipcRenderer.send(IPC.windowClose),
    openSettings: (section?: string) => ipcRenderer.send(IPC.windowOpenSettings, section ?? null),
    onCommand: (cb: (c: unknown) => void) => listen(IPC.shellCommand, cb),
  },
  notify: {
    show: (n: { title: string; body: string; route?: string }) =>
      ipcRenderer.send(IPC.notifyShow, n),
  },
  dialogs: {
    pickFolder: (opts?: { title?: string }) => invoke(IPC.dialogPickFolder, opts ?? {}),
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
    checkHotkey: (accelerator: string) => invoke(IPC.dictationCheckHotkey, { accelerator }),
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
  },
  /** Copies text to the system clipboard (#507). */
  clipboard: {
    writeText: (text: string) => invoke(IPC.clipboardWrite, { text }),
  },
  /** Opens an https page in the default browser (a connector's sign-in, #505). */
  external: {
    open: (url: string) => invoke(IPC.openExternal, { url }),
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
