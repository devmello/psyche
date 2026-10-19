import { readFile } from "node:fs/promises";
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
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  Notification,
  protocol,
  session,
  webContents,
} from "electron";
import { createDesktopGateway, defaultGatewayOrigin, defaultPsycheHome } from "./gateway-client.ts";
import { APP_ORIGIN, APP_SCHEME, contentType, resolveAppPath } from "./lib/app-path.ts";
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
import { BridgeClient } from "./main/bridge/bridge-client.ts";
import { BrowserHost } from "./main/browser/browser-host.ts";
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
if (!app.isPackaged && process.env.PSYCHE_USER_DATA) app.setPath("userData", process.env.PSYCHE_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

if (process.defaultApp) {
  // Dev: register the deep link with the Electron binary and the app path as arguments.
  app.setAsDefaultProtocolClient("psyche", process.execPath, [resolve(process.argv[1] ?? ".")]);
} else {
  app.setAsDefaultProtocolClient("psyche");
}

const home = defaultPsycheHome();
const rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL ?? `${APP_ORIGIN}/`;
const rendererOrigin = new URL(rendererUrl).origin;
const rendererRoot = join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME);

let windows: AppWindows | undefined;
let gateway: GatewayConnection | undefined;
let browser: BrowserHost | undefined;
let bridge: BridgeClient | undefined;
let terminal: TerminalHost | undefined;
let tray: PsycheTray | undefined;
let supervisor: GatewaySupervisor | undefined;
const relay = new NotificationRelay();
const pendingCommands: ShellCommand[] = [];
let quittingEntirely = false;

function isAppUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === rendererOrigin;
  } catch {
    return false;
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of windows?.appContents() ?? []) wc.send(channel, payload);
}

/** Native → shell commands; queued until a window exists to receive them. */
function command(c: ShellCommand): void {
  const targets = windows?.appContents() ?? [];
  if (targets.length === 0) {
    pendingCommands.push(c);
    windows?.showMain();
    return;
  }
  windows?.showMain();
  broadcast(IPC.shellCommand, c);
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
      return { ok: false, error: { code, message: e.message, retryable: e.retryable } };
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
  handle(IPC.browserClearData, (_e, arg) =>
    requireBrowser().clearBrowsingData(arg === "clean" ? "clean" : "logged-in"),
  );

  handle(IPC.terminalOpen, (_e, arg) => {
    const r = rec(IPC.terminalOpen, arg);
    if (!terminal) throw new PsycheError("unavailable", "terminal not ready");
    return terminal.open({
      cols: num(IPC.terminalOpen, r.cols, "cols", 1, 500),
      rows: num(IPC.terminalOpen, r.rows, "rows", 1, 200),
      ...(typeof r.threadId === "string"
        ? { threadId: str(IPC.terminalOpen, r.threadId, "threadId", 64) }
        : {}),
      ...(typeof r.cwd === "string" ? { cwd: str(IPC.terminalOpen, r.cwd, "cwd", 4096) } : {}),
    });
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
  on(IPC.terminalClose, (_e, arg) => terminal?.close(str(IPC.terminalClose, arg, "sessionId", 64)));

  handle(IPC.windowPopOut, (_e, arg) => {
    const r = rec(IPC.windowPopOut, arg);
    windows?.popOut(
      checkRoute(IPC.windowPopOut, r.route),
      str(IPC.windowPopOut, r.title, "title", 120),
    );
  });
  on(IPC.windowClose, (event) => windows?.closeFor(event.sender));
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
  const p = e.payload as Record<string, unknown>;
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
      windows?.isAppContents(wc) === true &&
      isAppUrl(details.requestingUrl) &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") === true;
    callback(ok);
  });
  ses.setPermissionCheckHandler(
    (wc, permission, origin) =>
      permission === "media" &&
      wc !== null &&
      windows?.isAppContents(wc) === true &&
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
    }),
  );

  windows = createAppWindows({
    rendererUrl,
    preloadPath: preloadPath(),
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
      if (s.phase === "paired") void refreshHelperPresence();
    },
    onEvent: onGatewayEvent,
    onResync: () => broadcast(IPC.resync, null),
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
    onState: (run) => tray?.update({ run }),
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
  if (!globalShortcut.register("Alt+Space", () => windows?.toggleQuickEntry()))
    globalShortcut.register("Control+Alt+Space", () => windows?.toggleQuickEntry());

  windows.showMain();
  openDeepLink(deepLinkFromArgv(process.argv));
  void supervisor.ensureRunning().then(() => gateway?.start());
  void startUpdater();

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
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  terminal?.closeAll();
  void bridge?.stop();
  browser?.dispose();
  gateway?.stop();
  tray?.destroy();
  if (!quittingEntirely) void supervisor?.onAppQuit();
});
