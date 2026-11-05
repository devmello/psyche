import { t } from "@psyche/ui";
import type { GatewayEvent, GatewayStatus } from "@psyche/web/client";
import { hostTerminalPort } from "@psyche/web/host-terminal-port";
import {
  type BrowserHostState,
  type BrowserNav,
  type BundledHelperIdentity,
  browserStorage,
  type DiscoveredGatewayView,
  type DownloadNotice,
  type GatewayPort,
  type GatewayRunView,
  type HostAppInfo,
  type KeptRecordingView,
  type MacHelperState,
  type PermissionKind,
  type PermissionState,
  type SavedGatewayView,
  type ShellCommand,
  type ShellPlatform,
  type SignedInSiteView,
  type SystemAppearance,
  type SystemDictationStatus,
  type SystemLocale,
  type TeachCapture,
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
  const full = fullDesktopPlatform(b);
  return b.chrome.remote ? remoteClientPlatform(full, b) : full;
}

type PasskeyHostPort = NonNullable<ShellPlatform["passkeys"]>;

/**
 * Passkeys of a remote window: main runs each ceremony in a hidden window of the Gateway's own
 * origin, so this side only passes WebAuthn JSON through. A refusal keeps the DOMException's name
 * (`NotAllowedError` for a cancelled sheet) so the same error text as the web client applies.
 */
export function remotePasskeys(b: PsycheBridge): PasskeyHostPort {
  const run = async (envelope: Promise<unknown>): Promise<never> => {
    try {
      return (await unwrapCall(envelope)) as never;
    } catch (err) {
      const name = (err as { details?: { name?: unknown } } | null)?.details?.name;
      if (typeof name !== "string") throw err;
      const named = new Error((err as Error).message);
      named.name = name;
      throw named;
    }
  };
  return {
    deviceId: async () => {
      const id = (await b.gateway.deviceId()) as string | undefined;
      if (id === undefined)
        throw new GatewayCallError({ code: "unavailable", message: "Not connected" });
      return id;
    },
    authenticator: {
      create: (options) => run(b.passkeys.create(options)),
      get: (options) => run(b.passkeys.get(options)),
    },
  };
}

/**
 * The platform of a window that is a client of a Gateway on another computer (remote-gateway
 * design §4.2). What only works on the machine the Gateway runs on is left out, so the shell
 * hides it or says where it runs: the agent's browser, the folder picker (a path chosen here
 * means nothing there), the Mac helper and Touch ID (the Host's), system-wide dictation,
 * revealing a folder or the logs (they are the Host's), opening a cited source in this Mac's Mail
 * or Finder, and the local terminal: a shell is started here from what the Gateway answers, so a
 * Gateway on another computer must never be able to ask for one. Main refuses the same calls too
 * (`REMOTE_REFUSED` in main.ts), whatever this window sends. The terminal pane instead gets a
 * session on the Host's own shell over the Gateway connection (`hostTerminalPort`, R4): the
 * PTY runs there, this window only renders it, and nothing is ever spawned from Gateway data.
 */
export function remoteClientPlatform(full: ShellPlatform, b?: PsycheBridge): ShellPlatform {
  const hostName = full.chrome?.remote?.hostName;
  const {
    browser: _browser,
    dialogs: _dialogs,
    helper: _helper,
    dictation: _dictation,
    terminal: _terminal,
    sources: _sources,
    permissions: _permissions,
    ...rest
  } = full;
  const { showLogs: _showLogs, ...gateway } = full.gateway;
  return {
    ...rest,
    gateway,
    // Touch ID for risky approvals is a passkey for the Host's Gateway, not the Host's helper.
    ...(b === undefined ? {} : { passkeys: remotePasskeys(b) }),
    ...(hostName === undefined ? {} : { terminal: hostTerminalPort({ gateway, hostName }) }),
    ...(full.app ? { app: { info: () => full.app?.info() as Promise<HostAppInfo> } } : {}),
  };
}

function fullDesktopPlatform(b: PsycheBridge): ShellPlatform {
  const gateway: GatewayPort = {
    getStatus: () => b.gateway.getStatus() as Promise<GatewayStatus>,
    deviceId: () => b.gateway.deviceId() as Promise<string | undefined>,
    onStatus: (cb) => b.gateway.onStatus((s) => cb(s as GatewayStatus)),
    // A retry of the same call (the chat outbox) carries its key, so the Host runs it once.
    call: (method, params, options) =>
      unwrapCall(b.gateway.call(method, params, options?.idempotencyKey)),
    onEvent: (cb) => b.gateway.onEvent((e) => cb(e as GatewayEvent)),
    onResync: (cb) => b.gateway.onResync(cb),
    getRun: () => b.gateway.getRun() as Promise<GatewayRunView>,
    onRun: (cb) => b.gateway.onRun((s) => cb(s as GatewayRunView)),
    showLogs: async () => void (await b.gateway.showLogs()),
    retry: async () => void (await b.gateway.retry()),
  };
  return {
    kind: "desktop",
    chrome: b.chrome,
    storage: browserStorage(),
    gateway,
    gateways: {
      list: () => b.gateways.list() as Promise<SavedGatewayView[]>,
      add: (address, name) => b.gateways.add(address, name) as Promise<SavedGatewayView>,
      addLink: (link) => b.gateways.addLink(link) as Promise<SavedGatewayView>,
      takePendingLink: () => b.gateways.takePendingLink() as Promise<string | null>,
      onPendingLink: (cb) => b.gateways.onPendingLink(cb),
      discover: () => b.gateways.discover() as Promise<DiscoveredGatewayView[]>,
      addDiscovered: (id) => b.gateways.addDiscovered(id) as Promise<SavedGatewayView>,
      rename: async (id, name) => void (await b.gateways.rename(id, name)),
      remove: async (id) => void (await b.gateways.remove(id)),
      switchTo: async (id, opts) => void (await b.gateways.switchTo(id, opts)),
      repair: async (id) => void (await b.gateways.repair(id)),
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
      answerPrompt: async (id, action) => void (await b.browser.answerPrompt(id, action)),
      listSignedInSites: () => b.browser.listSignedInSites() as Promise<SignedInSiteView[]>,
      forgetSignedInSite: async (origin) => void (await b.browser.forgetSignedInSite(origin)),
      openRealChromeProfile: (profile) =>
        b.browser.openRealChromeProfile(profile) as Promise<{ path: string }>,
      teachStart: async (tabId) => void (await b.browser.teachStart(tabId)),
      teachStop: () => b.browser.teachStop() as Promise<TeachCapture>,
      teachCancel: async () => void (await b.browser.teachCancel()),
      teachKeep: (id, title, steps) =>
        b.browser.teachKeep(id, title, steps) as Promise<KeptRecordingView>,
      teachKept: () => b.browser.teachKept() as Promise<KeptRecordingView[]>,
      teachStorage: () => b.browser.teachStorage() as Promise<{ encrypted: boolean }>,
      teachOpenKept: (id) => b.browser.teachOpenKept(id) as Promise<KeptRecordingView>,
      teachDeleteKept: async (id) => void (await b.browser.teachDeleteKept(id)),
    },
    // The terminal pane is a session on the Host over this Gateway connection (R4): on This Mac
    // the Host is this Mac. Main starts nothing from what a Gateway answers.
    terminal: hostTerminalPort({ gateway, hostName: () => t("web.remote.thisMac") }),
    windows: {
      popOutPane: async (route, title) => void (await b.windows.popOutPane(route, title)),
      focusPopOut: async (route) => (await b.windows.focusPopOut(route)) === true,
      closeWindow: () => b.windows.closeWindow(),
      openSettings: (section) => b.windows.openSettings(section),
      prefillComposer: (text) => b.windows.prefillComposer(text),
      openInMain: (route) => b.windows.openInMain(route),
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
    helper: {
      getState: () => b.helper.getState() as Promise<MacHelperState>,
      onState: (cb) => b.helper.onState((s) => cb(s as MacHelperState)),
      launch: () => b.helper.launch() as Promise<MacHelperState>,
      touchId: {
        identity: () => b.helper.touchIdIdentity() as Promise<BundledHelperIdentity | null>,
        register: () => unwrapCall(b.helper.touchIdRegister()),
        approve: (p) => unwrapCall(b.helper.touchIdApprove(p)),
      },
    },
    clipboard: {
      writeText: async (text, opts) => {
        await b.clipboard.writeText(text, opts);
      },
    },
    external: {
      open: async (url) => {
        await b.external.open(url);
      },
    },
    sources: {
      open: async (docId) => (await unwrapCall(b.sources.open(docId))) as "mail" | "file" | "none",
    },
    locale: {
      get: () => b.locale.get() as Promise<SystemLocale>,
    },
    app: {
      info: () => b.app.info() as Promise<HostAppInfo>,
      revealHome: async () => void (await b.app.revealHome()),
    },
    systemAppearance: {
      get: () => b.systemAppearance.get() as Promise<SystemAppearance>,
      on: (cb) => b.systemAppearance.on((a) => cb(a as SystemAppearance)),
    },
    dictation: {
      getStatus: () => b.dictation.getStatus() as Promise<SystemDictationStatus>,
      onStatus: (cb) => b.dictation.onStatus((s) => cb(s as SystemDictationStatus)),
      recheck: () => b.dictation.recheck() as Promise<SystemDictationStatus>,
      checkHotkey: (accelerator, purpose) =>
        b.dictation.checkHotkey(accelerator, purpose) as Promise<"ok" | "taken" | "invalid">,
      openAccessibilitySettings: () => b.dictation.openAccessibilitySettings(),
    },
  };
}
