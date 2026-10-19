import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { GatewayConnection } from "@psyche/web/client";
import { app, BaseWindow, ipcMain, session, type WebContents, WebContentsView } from "electron";
import { createDesktopGateway } from "./gateway-client.ts";
import { loadOrCreateDeviceKey } from "./lib/device-key.ts";
import { IPC } from "./lib/ipc.ts";

/**
 * Psyche desktop shell, bootstrap hello window (S00; S11 owns it from here).
 * One BaseWindow hosting the React app in a WebContentsView (architecture §5).
 */

// Sandbox every renderer, including any created later.
app.enableSandbox();
// No crash reporting and no telemetry (ADR-017): crashReporter is never started.

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BaseWindow | undefined;
let appView: WebContentsView | undefined;
let gateway: GatewayConnection | undefined;

function rendererEntry(): string {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const file = join(app.getAppPath(), ".vite", "renderer", MAIN_WINDOW_VITE_NAME, "index.html");
  return pathToFileURL(file).toString();
}

function isAppUrl(url: string): boolean {
  const entry = new URL(rendererEntry());
  const target = new URL(url);
  if (entry.protocol === "file:")
    return target.protocol === "file:" && target.pathname === entry.pathname;
  return target.origin === entry.origin;
}

function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

function createWindow(): void {
  const win = new BaseWindow({ width: 960, height: 640, title: "Psyche", show: false });
  const view = new WebContentsView({
    webPreferences: {
      preload: join(app.getAppPath(), ".vite", "build", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.contentView.addChildView(view);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on("resize", layout);
  win.on("closed", () => {
    mainWindow = undefined;
    appView = undefined;
  });
  view.webContents.once("did-finish-load", () => win.show());
  void view.webContents.loadURL(rendererEntry());
  mainWindow = win;
  appView = view;
}

function isTrustedSender(frameUrl: string | undefined): boolean {
  return frameUrl !== undefined && isAppUrl(frameUrl);
}

app.on("web-contents-created", (_event, contents) => hardenContents(contents));

void app.whenReady().then(() => {
  // Deny every permission request (camera, notifications, ...) until S11 adds explicit handling.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  const deviceKey = loadOrCreateDeviceKey(join(app.getPath("userData"), "device-key.json"));
  gateway = createDesktopGateway({
    deviceKey,
    onStatus: (status) => appView?.webContents.send(IPC.status, status),
  });

  ipcMain.handle(IPC.getStatus, (event) => {
    if (!isTrustedSender(event.senderFrame?.url)) throw new Error("untrusted sender");
    return gateway?.getStatus();
  });

  createWindow();
  gateway.start();

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("second-instance", () => mainWindow?.focus());

app.on("window-all-closed", () => {
  // Hello window: quit everywhere. S11 adds the menu-bar item and "close window keeps running".
  app.quit();
});

app.on("before-quit", () => gateway?.stop());
