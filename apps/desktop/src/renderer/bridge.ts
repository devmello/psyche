import type { GatewayEvent, GatewayStatus } from "@psyche/web/client";
import {
  type BrowserHostState,
  type BrowserNav,
  browserStorage,
  type DownloadNotice,
  type PermissionKind,
  type PermissionState,
  type ShellCommand,
  type ShellPlatform,
  type SystemDictationStatus,
  type TerminalOpenResult,
} from "@psyche/web/platform";
import type { PsycheBridge } from "../preload.ts";

declare global {
  interface Window {
    /** Exposed by src/preload.ts through contextBridge. */
    psyche: PsycheBridge;
  }
}

/** A Gateway error rebuilt in the renderer from the preload's envelope (code and details kept). */
export class GatewayCallError extends Error {
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

/** Unwraps the preload's `{ok, value} | {ok: false, error}` envelope. */
export async function unwrapCall(envelope: Promise<unknown>): Promise<unknown> {
  const res = (await envelope) as {
    ok?: boolean;
    value?: unknown;
    error?: { code: string; message: string; retryable?: boolean; details?: unknown };
  };
  if (res?.ok === true) return res.value;
  throw new GatewayCallError(res?.error ?? { code: "internal", message: "IPC failed" });
}

/** Adapts the preload bridge to the shell's `ShellPlatform` port. */
export function desktopPlatform(b: PsycheBridge = window.psyche): ShellPlatform {
  return {
    kind: "desktop",
    chrome: b.chrome,
    storage: browserStorage(),
    gateway: {
      getStatus: () => b.gateway.getStatus() as Promise<GatewayStatus>,
      onStatus: (cb) => b.gateway.onStatus((s) => cb(s as GatewayStatus)),
      call: (method, params) => unwrapCall(b.gateway.call(method, params)),
      onEvent: (cb) => b.gateway.onEvent((e) => cb(e as GatewayEvent)),
      onResync: (cb) => b.gateway.onResync(cb),
    },
    browser: {
      getState: () => b.browser.getState() as Promise<BrowserHostState>,
      onState: (cb) => b.browser.onState((s) => cb(s as BrowserHostState)),
      onDownload: (cb) => b.browser.onDownload((d) => cb(d as DownloadNotice)),
      setViewport: (rect) => b.browser.setViewport(rect),
      openTab: (url, profile) => b.browser.openTab(url, profile) as Promise<string>,
      closeTab: async (id) => void (await b.browser.closeTab(id)),
      activateTab: async (id) => void (await b.browser.activateTab(id)),
      navigate: async (id, action: BrowserNav) => void (await b.browser.navigate(id, action)),
      find: async (id, text, opts) => void (await b.browser.find(id, text, opts)),
      stopFind: async (id) => void (await b.browser.stopFind(id)),
      setControl: async (id, take) => void (await b.browser.setControl(id, take)),
      popOut: async (id, full) => void (await b.browser.popOut(id, full)),
      clearBrowsingData: async (profile) => void (await b.browser.clearBrowsingData(profile)),
      openRealChromeProfile: (profile) =>
        b.browser.openRealChromeProfile(profile) as Promise<{ path: string }>,
    },
    terminal: {
      open: (opts) =>
        b.terminal.open(opts) as Promise<TerminalOpenResult | { unavailable: string }>,
      write: (id, data) => b.terminal.write(id, data),
      resize: (id, cols, rows) => b.terminal.resize(id, cols, rows),
      close: (id) => b.terminal.close(id),
      onData: (cb) => b.terminal.onData((p) => cb(p.sessionId, p.data)),
      onExit: (cb) => b.terminal.onExit((p) => cb(p.sessionId, p.exitCode)),
    },
    windows: {
      popOutPane: async (route, title) => void (await b.windows.popOutPane(route, title)),
      closeWindow: () => b.windows.closeWindow(),
      onCommand: (cb) => b.windows.onCommand((c) => cb(c as ShellCommand)),
    },
    notify: { show: (n) => b.notify.show(n) },
    dialogs: {
      pickFolder: (opts) => b.dialogs.pickFolder(opts) as Promise<string | null>,
    },
    permissions: {
      status: () =>
        b.permissions.status() as Promise<Partial<Record<PermissionKind, PermissionState>>>,
      request: (kind) => b.permissions.request(kind) as Promise<PermissionState>,
    },
    dictation: {
      getStatus: () => b.dictation.getStatus() as Promise<SystemDictationStatus>,
      onStatus: (cb) => b.dictation.onStatus((s) => cb(s as SystemDictationStatus)),
      recheck: () => b.dictation.recheck() as Promise<SystemDictationStatus>,
      checkHotkey: (accelerator) =>
        b.dictation.checkHotkey(accelerator) as Promise<"ok" | "taken" | "invalid">,
      openAccessibilitySettings: () => b.dictation.openAccessibilitySettings(),
    },
  };
}
