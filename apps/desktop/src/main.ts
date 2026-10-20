import { spawn } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ApprovalRequest,
  isMethodName,
  PsycheError,
  type Notification as PsycheNotification,
} from "@psyche/protocol";
import type { GatewayConnection } from "@psyche/web/client";
import type { ShellCommand } from "@psyche/web/platform";
import {
  app,
  dialog,
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  Notification,
  protocol,
  session,
  shell,
  type WebContents,
  webContents,
} from "electron";
import { createDesktopGateway, defaultGatewayOrigin, defaultPsycheHome } from "./gateway-client.ts";
import { APP_ORIGIN, APP_SCHEME, contentType, isSameApp, resolveAppPath } from "./lib/app-path.ts";
import { deepLinkFromArgv, parseDeepLink } from "./lib/deep-link.ts";
import { loadOrCreateDeviceKey } from "./lib/device-key.ts";
import {
  checkCallable,
  checkHttpUrl,
  checkRoute,
  checkViewport,
  IPC,
  num,
  rec,
  str,
} from "./lib/ipc.ts";
import { NotificationRelay } from "./lib/notify-relay.ts";
import { realChromeOpenCommand, realChromeProfileDir } from "./lib/real-chrome.ts";
import { ZoomController } from "./lib/zoom.ts";
import { BridgeClient } from "./main/bridge/bridge-client.ts";
import { createAttentionReporter } from "./main/browser/attention.ts";
import { BrowserHost } from "./main/browser/browser-host.ts";
import { SystemDictation } from "./main/dictation/controller.ts";
import { HudWindow } from "./main/dictation/hud.ts";
import { ACCESSIBILITY_SETTINGS_URL, DictationService } from "./main/dictation/service.ts";
import { buildAppMenu } from "./main/menu.ts";
import { chooseMode, GatewaySupervisor } from "./main/supervisor.ts";
import { TerminalHost } from "./main/terminal.ts";
import { PsycheTray } from "./main/tray.ts";
import { startUpdater } from "./main/updater.ts";
import { type AppWindows, createAppWindows, preloadPath } from "./main/windows.ts";

/**
 * Psyche desktop main process (S11; architecture §5). It holds the Gateway connection, the
 * device key and every native surface; renderers get typed IPC only, and every payload is
 * checked here before anything happens. No crash reporter, no telemetry (ADR-017).
 */

// The renderer is served from app://psyche (a standard, secure scheme) instead of file://.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);
app.enableSandbox();

// Tests and side-by-side dev profiles: a separate userData dir, never honoured by packaged builds.
if (!app.isPackaged && process.env.PSYCHE_USER_DATA)
  app.setPath("userData", process.env.PSYCHE_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

if (process.defaultApp) {
  // Dev: register the deep link with the Electron binary and the app path as arguments.
  app.setAsDefaultProtocolClient("psyche", process.execPath, [resolve(process.argv[1] ?? ".")]);
} else {
  app.setAsDefaultProtocolClient("psyche");
}

const home = defaultPsycheHome();
const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? `${APP_ORIGIN}/`;
const rendererRoot = join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME);

let windows: AppWindows | undefined;
let gateway: GatewayConnection | undefined;
/** Pause-when-unwatched (#272): the browser pane's visibility and owner input, for the Gateway. */
const attention = createAttentionReporter({
  send: (report) => gateway?.call("attention.report", report) ?? Promise.resolve(undefined),
});
let browser: BrowserHost | undefined;
let bridge: BridgeClient | undefined;
let terminal: TerminalHost | undefined;
let tray: PsycheTray | undefined;
let supervisor: GatewaySupervisor | undefined;
let hud: HudWindow | undefined;
let dictation: DictationService | undefined;
const relay = new NotificationRelay();
const zoom = new ZoomController({
  targets: () => windows?.appContents() ?? [],
  call: (method, params) => requireGateway().call(method, params),
  warn: (message) => console.warn(`[zoom] ${message}`),
});
const pendingCommands: ShellCommand[] = [];
let quittingEntirely = false;

function isAppUrl(url: string | undefined): boolean {
  return isSameApp(url, rendererUrl);
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of windows?.appContents() ?? []) wc.send(channel, payload);
}

/** Native → shell commands go to the main window only; queued until it has loaded. */
function command(c: ShellCommand): void {
  windows?.showMain();
  const target = windows?.mainContents();
  if (!target || target.isLoading()) {
    pendingCommands.push(c);
    return;
  }
  target.send(IPC.shellCommand, c);
}

function openDeepLink(route: string | null): void {
  if (route) command({ type: "navigate", route });
}

// Every renderer: no popups, no navigation away from the app, no <webview>. Agent browser
// tabs install their own handlers in BrowserHost (their session is an agent partition).
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  if (contents.session !== session.defaultSession) return;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-frame-navigate", (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
});

function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return windows?.isAppContents(event.sender) === true && isAppUrl(event.senderFrame?.url);
}

type Handler = (event: IpcMainInvokeEvent, arg: unknown) => unknown;

/** `invoke` handlers answer `{ok, value} | {ok: false, error}` so error codes survive IPC. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event, arg: unknown) => {
    if (!trusted(event))
      return { ok: false, error: { code: "forbidden", message: "untrusted sender" } };
    try {
      return { ok: true, value: await fn(event, arg) };
    } catch (err) {
      const e = PsycheError.from(err);
      const code =
        err instanceof Error && err.name === "IpcPayloadError" ? "invalid_params" : e.code;
      // Details carry what the renderer must act on, e.g. `approval_required` → `{ approvalId }`.
      return {
        ok: false,
        error: {
          code,
          message: e.message,
          retryable: e.retryable,
          ...(e.details === undefined ? {} : { details: e.details }),
        },
      };
    }
  });
}

function on(channel: string, fn: (event: IpcMainEvent, arg: unknown) => void): void {
  ipcMain.on(channel, (event, arg: unknown) => {
    if (!trusted(event)) return;
    try {
      fn(event, arg);
    } catch {
      // invalid payloads from the renderer are dropped
    }
  });
}

/** PTYs die with the renderer that opened them (crash, reload, window closed). */
const terminalOwners = new Map<string, WebContents>();
const watchedOwners = new WeakSet<WebContents>();

function ownTerminal(owner: WebContents, sessionId: string): void {
  terminalOwners.set(sessionId, owner);
  if (watchedOwners.has(owner)) return;
  watchedOwners.add(owner);
  const closeOwned = () => {
    for (const [id, wc] of terminalOwners) {
      if (wc !== owner) continue;
      terminal?.close(id);
      terminalOwners.delete(id);
    }
  };
  owner.on("destroyed", closeOwned);
  owner.on("render-process-gone", closeOwned);
  owner.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeOwned();
  });
}

/** The tray's "needs you" row: refetched on pairing and resync, then kept by events. */
async function refreshApprovals(): Promise<void> {
  const res = (await gateway?.call("approvals.list", {}).catch(() => undefined)) as
    | { approvals?: ApprovalRequest[] }
    | undefined;
  if (!res?.approvals) return;
  pending = res.approvals.filter((a) => a.status === "pending");
  tray?.update({
    pendingApprovals: pending.length,
    ...(pending[0] ? { firstApproval: pending[0].summary } : { firstApproval: undefined }),
  });
}

function requireGateway(): GatewayConnection {
  if (!gateway)
    throw new PsycheError("unavailable", "Gateway connection not ready", { retryable: true });
  return gateway;
}

function requireBrowser(): BrowserHost {
  if (!browser) throw new PsycheError("unavailable", "browser host not ready", { retryable: true });
  return browser;
}

function registerIpc(): void {
  handle(IPC.getStatus, () => gateway?.getStatus());
  handle(IPC.gatewayGetRun, () => supervisor?.getState() ?? { kind: "unknown" });
  handle(IPC.gatewayShowLogs, () => shell.openPath(join(home, "logs")));
  handle(IPC.call, (_e, arg) => {
    const r = rec(IPC.call, arg);
    const method = checkCallable(r.method, isMethodName);
    return requireGateway().call(method, r.params ?? {});
  });

  handle(IPC.browserGetState, () => requireBrowser().getState());
  on(IPC.browserViewport, (_e, arg) => browser?.setViewport(checkViewport(arg)));
  handle(IPC.browserOpen, (_e, arg) => {
    const r = rec(IPC.browserOpen, arg);
    const profile = r.profile === "clean" ? "clean" : "logged-in";
    return requireBrowser().openTab(checkHttpUrl(IPC.browserOpen, r.url), profile);
  });
  handle(IPC.browserClose, (_e, arg) =>
    requireBrowser().closeTab(str(IPC.browserClose, arg, "tabId", 128)),
  );
  handle(IPC.browserActivate, (_e, arg) =>
    requireBrowser().activateTab(str(IPC.browserActivate, arg, "tabId", 128)),
  );
  handle(IPC.browserNavigate, (_e, arg) => {
    const r = rec(IPC.browserNavigate, arg);
    const action = str(IPC.browserNavigate, r.action, "action", 16);
    const allowed = [
      "back",
      "forward",
      "reload",
      "stop",
      "zoomIn",
      "zoomOut",
      "zoomReset",
    ] as const;
    const nav = allowed.find((a) => a === action);
    if (!nav) throw new PsycheError("invalid_params", "unknown navigation");
    return requireBrowser().navigate(str(IPC.browserNavigate, r.tabId, "tabId", 128), nav);
  });
  handle(IPC.browserFind, (_e, arg) => {
    const r = rec(IPC.browserFind, arg);
    return requireBrowser().find(
      str(IPC.browserFind, r.tabId, "tabId", 128),
      str(IPC.browserFind, r.text, "text", 500),
      {
        forward: r.forward !== false,
      },
    );
  });
  handle(IPC.browserStopFind, (_e, arg) =>
    requireBrowser().stopFind(str(IPC.browserStopFind, arg, "tabId", 128)),
  );
  handle(IPC.browserSetControl, (_e, arg) => {
    const r = rec(IPC.browserSetControl, arg);
    return requireBrowser().setControl(
      str(IPC.browserSetControl, r.tabId, "tabId", 128),
      r.take === true,
    );
  });
  handle(IPC.browserPopOut, (_e, arg) => {
    const r = rec(IPC.browserPopOut, arg);
    return requireBrowser().popOut(
      str(IPC.browserPopOut, r.tabId, "tabId", 128),
      r.fullScreen === true,
    );
  });
  handle(IPC.browserOpenRealChromeProfile, async (_e, arg) => {
    const dir = realChromeProfileDir(
      home,
      str(IPC.browserOpenRealChromeProfile, arg, "profile", 64),
    );
    const cmd = realChromeOpenCommand(process.platform, dir);
    if (cmd === null) {
      throw new PsycheError(
        "unavailable",
        "Opening the Psyche Chrome profile needs macOS or Linux",
      );
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolveSpawn, reject) => {
      const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore" });
      child.once("error", (err) =>
        reject(
          new PsycheError("unavailable", `Google Chrome could not be opened (${err.message})`),
        ),
      );
      child.once("spawn", () => {
        child.unref();
        resolveSpawn();
      });
    });
    return { path: dir };
  });
  handle(IPC.browserClearData, (_e, arg) =>
    requireBrowser().clearBrowsingData(arg === "clean" ? "clean" : "logged-in"),
  );

  handle(IPC.terminalOpen, async (event, arg) => {
    const r = rec(IPC.terminalOpen, arg);
    if (!terminal) throw new PsycheError("unavailable", "terminal not ready");
    const opened = await terminal.open({
      cols: num(IPC.terminalOpen, r.cols, "cols", 1, 500),
      rows: num(IPC.terminalOpen, r.rows, "rows", 1, 200),
      ...(typeof r.threadId === "string"
        ? { threadId: str(IPC.terminalOpen, r.threadId, "threadId", 64) }
        : {}),
      ...(typeof r.cwd === "string" ? { cwd: str(IPC.terminalOpen, r.cwd, "cwd", 4096) } : {}),
    });
    if ("sessionId" in opened) ownTerminal(event.sender, opened.sessionId);
    return opened;
  });
  on(IPC.terminalWrite, (_e, arg) => {
    const r = rec(IPC.terminalWrite, arg);
    terminal?.write(
      str(IPC.terminalWrite, r.sessionId, "sessionId", 64),
      str(IPC.terminalWrite, r.data, "data", 65_536),
    );
  });
  on(IPC.terminalResize, (_e, arg) => {
    const r = rec(IPC.terminalResize, arg);
    terminal?.resize(
      str(IPC.terminalResize, r.sessionId, "sessionId", 64),
      num(IPC.terminalResize, r.cols, "cols", 1, 500),
      num(IPC.terminalResize, r.rows, "rows", 1, 200),
    );
  });
  on(IPC.terminalClose, (_e, arg) => {
    const id = str(IPC.terminalClose, arg, "sessionId", 64);
    terminal?.close(id);
    terminalOwners.delete(id);
  });

  handle(IPC.windowPopOut, (_e, arg) => {
    const r = rec(IPC.windowPopOut, arg);
    windows?.popOut(
      checkRoute(IPC.windowPopOut, r.route),
      str(IPC.windowPopOut, r.title, "title", 120),
    );
  });
  on(IPC.windowClose, (event) => windows?.closeFor(event.sender));
  handle(IPC.dictationGetStatus, () => dictation?.status);
  handle(IPC.dictationRecheck, async () => {
    await dictation?.recheck();
    return dictation?.status;
  });
  handle(IPC.dictationCheckHotkey, (_event, arg) => {
    const r = rec(IPC.dictationCheckHotkey, arg);
    const accelerator = str(IPC.dictationCheckHotkey, r.accelerator, "accelerator", 64);
    return dictation?.checkHotkey(accelerator) ?? "ok";
  });
  on(IPC.dictationOpenAccessibility, () => {
    void shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
  });
  handle(IPC.dialogPickFolder, async (event, arg) => {
    const r = rec(IPC.dialogPickFolder, arg);
    const title =
      typeof r.title === "string" ? str(IPC.dialogPickFolder, r.title, "title", 120) : undefined;
    const win = windows?.main();
    const opts = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      title: title ?? "Share a folder with Psyche",
      message: title ?? "Share a folder with Psyche",
      buttonLabel: "Share",
    };
    const res =
      win && windows?.isAppContents(event.sender)
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
    const picked = res.canceled ? undefined : res.filePaths[0];
    if (picked === undefined) return null;
    // The broker matches folder grants as text against real paths (no symlinks), so the grant
    // must name the real path: /private/tmp rather than /tmp on macOS.
    return realpath(picked);
  });
  on(IPC.notifyShow, (_e, arg) => {
    const r = rec(IPC.notifyShow, arg);
    showNotification(
      str(IPC.notifyShow, r.title, "title", 120),
      str(IPC.notifyShow, r.body, "body", 400),
      typeof r.route === "string" ? checkRoute(IPC.notifyShow, r.route) : "/inbox",
    );
  });
}

function showNotification(
  title: string,
  body: string,
  route: string,
  urgency: "normal" | "critical" | "low" = "normal",
): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: urgency === "low", urgency });
  n.on("click", () => command({ type: "navigate", route }));
  n.show();
}

let pending: ApprovalRequest[] = [];

function onGatewayEvent(e: {
  event: string;
  payload: unknown;
  seq: number;
  stateVersion: number;
}): void {
  broadcast(IPC.event, e);
  dictation?.onEvent(e.event, e.payload);
  const p = e.payload as Record<string, unknown>;
  if (e.event === "settings.changed") {
    zoom.onSettingsChanged((p.entries as { key: string; value: unknown }[] | undefined) ?? []);
  }
  if (e.event === "notification.created") {
    const d = relay.decide(p.notification as PsycheNotification);
    if (d.show && d.title && d.body && d.route)
      showNotification(d.title, d.body, d.route, d.urgency);
  }
  if (e.event === "approval.created" || e.event === "approval.updated") {
    const a = p.approval as ApprovalRequest;
    pending = pending.filter((x) => x.id !== a.id);
    if (a.status === "pending") pending.push(a);
    tray?.update({
      pendingApprovals: pending.length,
      ...(pending[0] ? { firstApproval: pending[0].summary } : {}),
    });
  }
  if (e.event === "node.updated") void refreshHelperPresence();
}

async function refreshHelperPresence(): Promise<void> {
  const res = (await gateway?.call("nodes.list", {}).catch(() => undefined)) as
    | { nodes?: { kind?: string; status?: string; capabilities?: { name?: string }[] }[] }
    | undefined;
  relay.helperOnline = (res?.nodes ?? []).some(
    (n) =>
      n.kind === "mac-helper" &&
      n.status === "online" &&
      (n.capabilities ?? []).some((c) => c.name?.startsWith("notify.")),
  );
}

async function serveAppProtocol(): Promise<void> {
  protocol.handle(APP_SCHEME, async (request) => {
    const file = resolveAppPath(rendererRoot, request.url);
    if (!file) return new Response("not found", { status: 404 });
    try {
      const body = await readFile(file);
      return new Response(body, {
        headers: { "content-type": contentType(file), "x-content-type-options": "nosniff" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function lockDownDefaultSession(): void {
  const ses = session.defaultSession;
  // Only the app's own renderers may use the microphone (dictation); nothing else is granted.
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const ok =
      permission === "media" &&
      (windows?.isAppContents(wc) === true || hud?.owns(wc) === true) &&
      isAppUrl(details.requestingUrl) &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") === true;
    callback(ok);
  });
  ses.setPermissionCheckHandler(
    (wc, permission, origin) =>
      permission === "media" &&
      wc !== null &&
      (windows?.isAppContents(wc) === true || hud?.owns(wc) === true) &&
      isAppUrl(origin),
  );
}

void app.whenReady().then(async () => {
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) await serveAppProtocol();
  lockDownDefaultSession();
  Menu.setApplicationMenu(
    buildAppMenu({
      newSideChat: () => command({ type: "newSideChat" }),
      palette: () => command({ type: "palette" }),
      closeThreadView: () => {
        const focused = webContents.getFocusedWebContents();
        const wc = focused && windows?.isAppContents(focused) ? focused : windows?.appContents()[0];
        if (wc) wc.send(IPC.shellCommand, { type: "closeThreadView" } satisfies ShellCommand);
      },
      quitEntirely,
      zoomIn: () => void zoom.zoomIn(),
      zoomOut: () => void zoom.zoomOut(),
      zoomReset: () => void zoom.reset(),
    }),
  );

  windows = createAppWindows({
    rendererUrl,
    preloadPath: preloadPath(),
    // The stored zoom wins over Electron's own per-origin memory on every load.
    onViewCreated: (wc) => wc.on("did-finish-load", () => zoom.applyTo(wc)),
    onMainCreated: (win, view) => {
      view.webContents.once("did-finish-load", () => {
        for (const c of pendingCommands.splice(0)) view.webContents.send(IPC.shellCommand, c);
      });
      browser?.dispose();
      browser = new BrowserHost({
        window: win,
        psycheHome: home,
        userData: app.getPath("userData"),
      });
      browser.on("state", (s) => broadcast(IPC.browserState, s));
      // Pause-when-unwatched (#272): pane visibility and owner input go to the Gateway.
      browser.on("paneVisible", (v) => attention.visible(v));
      browser.on("ownerInput", () => attention.input());
      const host = browser;
      for (const ev of ["show", "hide", "minimize", "restore"] as const) {
        win.on(ev as "show", () => host.refreshVisibility());
      }
      // Input in the app itself (chat, approvals) counts too; nothing synthesizes input there.
      view.webContents.on("before-input-event", (_e, input) => {
        if (input.type === "keyDown" || input.type === "rawKeyDown") attention.input();
      });
      view.webContents.on("input-event", (_e, ev) => {
        if (ev.type === "mouseDown") attention.input();
      });
      host.refreshVisibility();
      browser.on("download", (d) => broadcast(IPC.browserDownload, d.notice));
      if (bridge) {
        void bridge.stop();
      }
      bridge = new BridgeClient({
        socketPath:
          process.env.PSYCHE_BROWSER_BRIDGE_SOCKET ?? join(home, "run", "browser-bridge.sock"),
        psycheHome: home,
        desktopVersion: app.getVersion(),
        host: browser,
        log: (m) => console.warn(`[bridge] ${m}`),
      });
      const b = browser;
      bridge.onConnectedChange((connected) => b.setBridgeConnected(connected));
      bridge.start();
    },
  });

  const deviceKey = loadOrCreateDeviceKey(join(app.getPath("userData"), "device-key.json"));
  const origin = defaultGatewayOrigin();
  gateway = createDesktopGateway({
    deviceKey,
    httpOrigin: origin,
    psycheHome: home,
    onStatus: (s) => {
      broadcast(IPC.status, s);
      tray?.update({ status: s });
      if (s.phase === "paired") {
        attention.resend();
        void refreshHelperPresence();
        void refreshApprovals();
        void zoom.load();
        void dictation?.load();
      } else dictation?.onDisconnected();
    },
    onEvent: onGatewayEvent,
    onResync: () => {
      broadcast(IPC.resync, null);
      void refreshApprovals();
    },
  });
  // System-wide dictation (J9, Q2): hold-to-talk through the helper, the toggle hotkey here.
  hud = new HudWindow({
    url: (route) => new URL(route, rendererUrl).toString(),
    preloadPath: preloadPath(),
    onAudio: (chunk) => controller.onAudio(chunk),
  });
  const controller = new SystemDictation({
    call: (m, p) => requireGateway().call(m, p),
    hud,
    capture: hud,
    warn: (m) => console.warn(`[dictation] ${m}`),
  });
  dictation = new DictationService({
    dictation: controller,
    call: (m, p) => requireGateway().call(m, p),
    ...(!app.isPackaged && process.env.PSYCHE_DISABLE_GLOBAL_SHORTCUTS === "1"
      ? {}
      : { shortcuts: globalShortcut }),
    warn: (m) => console.warn(`[dictation] ${m}`),
    onStatus: (s) => broadcast(IPC.dictationStatus, s),
  });
  terminal = new TerminalHost({ call: (m, p) => requireGateway().call(m, p) });
  terminal.onData((sessionId, data) => broadcast(IPC.terminalData, { sessionId, data }));
  terminal.onExit((sessionId, exitCode) => broadcast(IPC.terminalExit, { sessionId, exitCode }));
  registerIpc();

  supervisor = new GatewaySupervisor({
    mode: chooseMode(process.env, app.isPackaged),
    psycheHome: home,
    healthUrl: new URL("/healthz", origin).toString(),
    gatewayDir: resolve(app.getAppPath(), "..", "gateway"),
    bundledProgram: join(process.resourcesPath, "psyched", "psyched"),
    bundledPlist: join(process.resourcesPath, "launchd", "com.psyche.gateway.plist"),
    onState: (run) => {
      tray?.update({ run });
      broadcast(IPC.gatewayRun, run);
    },
  });

  tray = new PsycheTray(
    {
      status: gateway.getStatus(),
      run: supervisor.getState(),
      pendingApprovals: 0,
      usagePercentRemaining: null,
    },
    {
      open: () => windows?.showMain(),
      newSideChat: () => command({ type: "newSideChat" }),
      quickEntry: () => windows?.toggleQuickEntry(),
      openApprovals: () => command({ type: "navigate", route: "/agent/approvals" }),
      closeWindow: () => windows?.main()?.close(),
      quitApp: () => app.quit(),
      quitEntirely,
    },
  );

  // ⌥Space by default (docs/06 §3.21); ⌃⌥Space when another utility owns it.
  const skipShortcuts = !app.isPackaged && process.env.PSYCHE_DISABLE_GLOBAL_SHORTCUTS === "1";
  if (!skipShortcuts && !globalShortcut.register("Alt+Space", () => windows?.toggleQuickEntry()))
    globalShortcut.register("Control+Alt+Space", () => windows?.toggleQuickEntry());

  windows.showMain();
  openDeepLink(deepLinkFromArgv(process.argv));
  void supervisor.ensureRunning().then(() => gateway?.start());
  void startUpdater({ stateFile: join(home, "run", "updater.json") });

  app.on("activate", () => windows?.showMain());
});

async function quitEntirely(): Promise<void> {
  quittingEntirely = true;
  await supervisor?.stopEverything().catch(() => undefined);
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  openDeepLink(parseDeepLink(url));
});

app.on("second-instance", (_e, argv) => {
  windows?.showMain();
  openDeepLink(deepLinkFromArgv(argv));
});

// Closing the window keeps the app (menu bar) and the Gateway running (feature A7).
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  dictation?.dispose();
  hud?.destroy();
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  windows?.setQuitting();
  terminal?.closeAll();
  void bridge?.stop();
  browser?.dispose();
  gateway?.stop();
  tray?.destroy();
  if (!quittingEntirely) void supervisor?.onAppQuit();
});
