import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type ApprovalRequest,
  isMethodName,
  PsycheError,
  type Notification as PsycheNotification,
} from "@psyche/protocol";
import { hostWords } from "@psyche/protocol/host-words";
import type { GatewayConnection } from "@psyche/web/client";
import type { ShellCommand } from "@psyche/web/platform";
import {
  app,
  BaseWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
  type WebContents,
  webContents,
} from "electron";
import { createDesktopGateway, defaultPsycheHome, isLocalGatewayOrigin } from "./gateway-client.ts";
import { appInfo } from "./lib/app-info.ts";
import { APP_ORIGIN, APP_SCHEME, contentType, isSameApp, resolveAppPath } from "./lib/app-path.ts";
import { deepLinkFromArgv, isAppRoute, parseDeepLink } from "./lib/deep-link.ts";
import { loadOrCreateDeviceKey } from "./lib/device-key.ts";
import { createGatewayVerifier, readLocalGatewayKey } from "./lib/gateway-identity.ts";
import {
  EMPTY_GATEWAYS,
  gatewaysFilePath,
  loadGatewaysStrict,
  resolveTarget,
  setupTokenAnswered,
} from "./lib/gateways.ts";
import {
  checkCallable,
  checkClipboardClearAfter,
  checkClipboardText,
  checkComposerText,
  checkExternalUrl,
  checkHttpUrl,
  checkIdempotencyKey,
  checkMainRoute,
  checkNotifyRoute,
  checkPasskeyOptions,
  checkRoute,
  checkTeachApp,
  checkTeachId,
  checkTeachKeep,
  checkUninstall,
  checkViewport,
  IPC,
  REMOTE_ONLY_CHANNELS,
  REMOTE_REFUSED_CHANNELS,
  rec,
  str,
} from "./lib/ipc.ts";
import { LanDiscovery } from "./lib/lan-discovery.ts";
import { createPinnedFetch, createPinnedWebSocket, PinnedChannel } from "./lib/lan-tls.ts";
import { NotificationRelay } from "./lib/notify-relay.ts";
import { createPairLinkInbox, isPairLinkUrl, PAIR_LINK_SCHEME } from "./lib/pair-link.ts";
import { pairingEdge } from "./lib/pairing-edge.ts";
import {
  appPathKeys,
  findLinuxChromium,
  findWindowsChromium,
  parseRegDefault,
  realChromeOpenCommand,
  realChromeProfileDir,
} from "./lib/real-chrome.ts";
import { checkSourceOpen, openSource } from "./lib/source-open.ts";
import { WindowTheme } from "./lib/window-theme.ts";
import { ZoomController } from "./lib/zoom.ts";
import { bootstrapAdminIfNeeded } from "./main/bootstrap-admin.ts";
import { BridgeClient, bridgeSocketPath } from "./main/bridge/bridge-client.ts";
import { passwordApprove } from "./main/bridge/password-approve.ts";
import { createAttentionReporter } from "./main/browser/attention.ts";
import { BrowserHost } from "./main/browser/browser-host.ts";
import {
  bundleFingerprint,
  checkBundleIntegrity,
  integrityText,
  pidsOfExecutable,
} from "./main/bundle-integrity.ts";
import { SystemDictation } from "./main/dictation/controller.ts";
import { HudWindow } from "./main/dictation/hud.ts";
import { DictationService, dictationSettingsUrl } from "./main/dictation/service.ts";
import { DockPolicy } from "./main/dock-policy.ts";
import { type GatewayConfirm, GatewayManager } from "./main/gateway-manager.ts";
import {
  attachNativeGlass,
  GLASS_PROBE_ENV,
  glassMode,
  glassWindowOptions,
  runGlassProbe,
} from "./main/glass.ts";
import {
  askHelperNotificationsIfUndetermined,
  type HelperIdentity,
  HelperLauncher,
  helperCanHoldKeychain,
  helperPathFor,
  isHostHelperKind,
  readAltGrLayout,
  readHelperIdentity,
} from "./main/helper-launcher.ts";
import { LoginItem, squirrelLayout } from "./main/login-item.ts";
import { buildAppMenu } from "./main/menu.ts";
import { PasskeyHost } from "./main/passkey-host.ts";
import { createPasskeyWindow } from "./main/passkey-window.ts";
import { perfHold, perfProbeFile, startProbe, watchFirstPaint } from "./main/perf-probe.ts";
import {
  createPermissions,
  notificationStateOf,
  PERMISSION_KINDS,
  type PermissionKind,
} from "./main/permissions/permissions.ts";
import { HAS_UNSENT_TEXT, releaseHiddenAfterMs } from "./main/release.ts";
import { confirmReplaceKey } from "./main/replace-key-dialog.ts";
import { guardRestoredByHand } from "./main/restore-check.ts";
import { createSandboxPc, serviceUpdateNotice } from "./main/sandbox-pc/wire.ts";
import { captureScreenFrame, wantsFallback } from "./main/screen-ask/capture-fallback.ts";
import { ScreenAskWindow } from "./main/screen-ask/panel.ts";
import { ScreenAskShortcut } from "./main/screen-ask/settings.ts";
import { voicePopup } from "./main/screen-ask/voice-key.ts";
import { QuickEntryShortcut } from "./main/shortcuts.ts";
import { shouldShowSplash } from "./main/splash.ts";
import { APP_AUMID, handleSquirrelEvent } from "./main/squirrel-events.ts";
import { startShell } from "./main/startup.ts";
import {
  chooseMode,
  createSupervisor,
  desktopVaultKeyFile,
  execRunner,
  launchAgentPath,
  launchctl,
  plistProgram,
  readBundledBuild,
  type Supervisor,
} from "./main/supervisor.ts";
import { bundledGatewayPaths } from "./main/supervisor-windows.ts";
import { firstCloseToTray, jumpListTasks, type TaskbarTask, taskFromArgv } from "./main/taskbar.ts";
import { threadRoute } from "./main/thread-route.ts";
import { PsycheTray } from "./main/tray.ts";
import { PERSONALIZE_KEY, taskbarIsDark, transparencyEffects } from "./main/tray-icon.ts";
import {
  DELETE_CONFIRM_WORD,
  planUninstall,
  psycheHomeFromPlist,
  runUninstall,
  UNINSTALL_MANUAL_STEPS,
  type UninstallDeps,
  UninstallError,
} from "./main/uninstall.ts";
import {
  confirmDetailWindows,
  planUninstallWindows,
  runUninstallWindows,
  UNINSTALL_MANUAL_STEPS_WINDOWS,
} from "./main/uninstall-windows.ts";
import { windowsUninstallDeps } from "./main/uninstall-windows-host.ts";
import {
  bundleOfExecutable,
  parsePinnedRequirement,
  readBundledPinned,
} from "./main/update-gate.ts";
import { startUpdater, stopUpdater } from "./main/updater.ts";
import {
  canvasColor,
  chromeViewBackground,
  titleBarOverlayColors,
  wantsAnyWindowSize,
} from "./main/window-options.ts";
import { type AppWindows, createAppWindows, preloadPath } from "./main/windows.ts";
import { autostartPath } from "./platform/autostart.ts";
import {
  hostPlatform,
  isLinux,
  LINUX_DESKTOP_NAME,
  quitsOnLastWindowClosed,
} from "./platform/index.ts";
import {
  linuxAutostartExec,
  linuxGatewayLaunch,
  linuxInstallKind,
  linuxPackageManager,
} from "./platform/install-kind.ts";
import { Linger } from "./platform/linger.ts";
import { guardSafeStorage } from "./platform/secrets.ts";
import { systemctlUser } from "./platform/systemd-supervisor.ts";
import { GATEWAY_UNIT, userUnitDir } from "./platform/systemd-unit.ts";
import { statusNotifierAvailable } from "./platform/tray-support.ts";
import {
  confirmTextLinux,
  type LinuxUninstallDeps,
  linuxUnitOwner,
  planUninstallLinux,
  psycheHomeFromUnit,
  runUninstallLinux,
  UNINSTALL_MANUAL_STEPS_LINUX,
} from "./platform/uninstall-linux.ts";

/**
 * Psyche desktop main process (S11; architecture §5). It holds the Gateway connection, the
 * device key and every native surface; renderers get typed IPC only, and every payload is
 * checked here before anything happens. No crash reporter, no telemetry (ADR-017).
 */

// Squirrel.Windows install/update/uninstall events: shortcuts and cleanup, then exit before
// anything else starts (src/main/squirrel-events.ts).
if (handleSquirrelEvent({ app, shell })) process.exit(0);

const windows32 = process.platform === "win32";

// Linux: the shell (GNOME's shortcut portal, the launcher) knows the app by its .desktop file; a
// mismatch makes GNOME silently deny every global shortcut (design §10.4).
if (isLinux()) app.setDesktopName(LINUX_DESKTOP_NAME);

// Windows groups the taskbar button, the jump list and every toast under the AppUserModelID (the
// one the installer's shortcuts carry); it must be set before any window or notification.
// Unpackaged runs use Electron's own path, the id Windows already knows for that binary, so dev
// toasts show too.
if (windows32) app.setAppUserModelId(app.isPackaged ? APP_AUMID : process.execPath);

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

/**
 * Which Gateway this launch connects to (remote-gateway design §1.3): `PSYCHE_GATEWAY_ORIGIN`
 * (dev and tests), the active saved Gateway, or This Mac. A saved remote Gateway runs out of its
 * own data directory: its device key, renderer storage, caches and window state live there, so
 * nothing from another Gateway can show in it. The base directory keeps `gateways.json` and
 * This Mac's data exactly where they were. Switching restarts the app, so every module starts
 * over on the new Gateway.
 */
const baseUserData = app.getPath("userData");
/**
 * A saved-Gateways file that exists but cannot be understood is not an empty list (that would
 * read as "nothing pinned" and be written back over the pins): the app starts on This Mac, says
 * so in a dialog once it is ready, and nothing writes the file while it stays unreadable
 * (`GatewayManager` reads it strictly too).
 */
let gatewaysFileProblem: string | undefined;
const savedGateways = (() => {
  try {
    return loadGatewaysStrict(gatewaysFilePath(baseUserData));
  } catch (err) {
    gatewaysFileProblem = err instanceof Error ? err.message : "unreadable";
    return { ...EMPTY_GATEWAYS, gateways: [] };
  }
})();
const gatewayTarget = resolveTarget({
  userData: baseUserData,
  env: process.env,
  data: savedGateways,
  packaged: app.isPackaged,
});
if (gatewayTarget.dataDir !== null) {
  mkdirSync(gatewayTarget.dataDir, { recursive: true, mode: 0o700 });
  app.setPath("userData", gatewayTarget.dataDir);
  app.setPath("sessionData", gatewayTarget.dataDir);
}
/** Connected to a Gateway on another computer: nothing here may reach this Mac's helper or files. */
const remoteGateway = gatewayTarget.remote;
/** The Gateway is this Mac's own: the one this app supervises, launches a helper for and bootstraps. */
const thisMacGateway = !remoteGateway && isLocalGatewayOrigin(gatewayTarget.origin);
// A saved Gateway on the local network (`.local` or a private address): pinned self-signed TLS.
const lanGateway = remoteGateway && gatewayTarget.lan === true;
/** The mode the supervisor runs in: a saved remote Gateway starts nothing here. */
const supervisorMode = remoteGateway ? "remote" : chooseMode(process.env, app.isPackaged);
/**
 * Uninstall Psyche is for a packaged app that runs its own Gateway service: the LaunchAgent on a
 * Mac, the per-user scheduled task of a Squirrel install on Windows.
 */
const canUninstall =
  app.isPackaged &&
  ((supervisorMode === "launchd" && process.platform === "darwin") ||
    (supervisorMode === "systemd" && isLinux()) ||
    (supervisorMode === "taskscheduler" &&
      process.platform === "win32" &&
      squirrelLayout(process.execPath) !== undefined));

// A first-paint measurement run (main/perf-probe.ts) changes nothing outside its scratch dirs.
const perfProbe = perfProbeFile();
if (perfProbe !== undefined) startProbe(perfProbe);

/**
 * Arguments that start this copy of Psyche from outside (a protocol handler, the login item, the
 * jump list): an unpackaged run passes the app folder to Electron's binary.
 */
const leadingArgs = process.defaultApp ? [resolve(process.argv[1] ?? ".")] : [];
/**
 * Registers a URL scheme. Windows writes the handler into the registry: a Squirrel install names
 * its stable `Update.exe --processStart Psyche.exe`, as each `app-<version>` folder goes away
 * with the next update; the URL arrives as the second instance's last argument.
 */
function registerScheme(scheme: string): void {
  const squirrel = windows32 && app.isPackaged ? squirrelLayout(process.execPath) : undefined;
  if (squirrel) {
    app.setAsDefaultProtocolClient(scheme, squirrel.updateExe, [
      "--processStart",
      squirrel.exeName,
      "--process-start-args",
    ]);
  } else if (process.defaultApp) {
    // Dev: register the deep link with the Electron binary and the app path as arguments.
    app.setAsDefaultProtocolClient(scheme, process.execPath, leadingArgs);
  } else {
    app.setAsDefaultProtocolClient(scheme);
  }
}

if (perfProbe !== undefined) {
  // No psyche:// registration: it would point the owner's links at the measured copy.
} else {
  registerScheme("psyche");
  // psyche-pair: links (a pairing link opened from the OS) only in a packaged build: a dev copy
  // must not take the owner's links away from the installed app.
  if (app.isPackaged) registerScheme(PAIR_LINK_SCHEME);
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
let tray: PsycheTray | undefined;
let supervisor: Supervisor | undefined;
let quickEntryShortcut: QuickEntryShortcut | undefined;
/**
 * Whether the main window opens on the startup splash (#539: its first content, not a second
 * window). Decided once at launch: not in dev with PSYCHE_NO_SPLASH=1, under the perf probe, for
 * an external Gateway, or when the Gateway already answers (attach mode).
 */
let splashWanted = false;

async function decideSplash(): Promise<void> {
  const healthyAtLaunch = await fetch(new URL("/healthz", gatewayTarget.origin), {
    signal: AbortSignal.timeout(60),
  }).then(
    (r) => r.ok,
    () => false,
  );
  splashWanted = shouldShowSplash({
    packaged: app.isPackaged,
    env: process.env,
    mode: supervisorMode,
    healthyAtLaunch,
    probing: perfProbe !== undefined,
  });
}
let helper: HelperLauncher | undefined;

/**
 * The app's own signature no longer verifies (bundle-integrity.ts): the TCC-backed features
 * (microphone, screen, Apple Events, Contacts, Calendar) stay off until it is reinstalled.
 */
let integrityBlocked = false;
let integrityMessage =
  "Turned off: this copy of Psyche was modified. Reinstall it from the official download.";

async function startupIntegrity(): Promise<void> {
  if (!app.isPackaged || process.platform !== "darwin") return;
  const pinned = readBundledPinned(process.resourcesPath);
  const requirement = pinned === undefined ? undefined : parsePinnedRequirement(pinned);
  if (!requirement) return;
  const bundle = bundleOfExecutable(app.getPath("exe"));
  const verdict = await checkBundleIntegrity({
    bundle,
    requirement,
    cacheFile: join(app.getPath("userData"), "bundle-integrity.json"),
    appVersion: app.getVersion(),
    fingerprint: bundleFingerprint(bundle),
  });
  if (verdict.state !== "blocked") return;
  integrityBlocked = true;
  console.warn("[integrity] the app's signature no longer verifies; TCC-backed features are off");
  // Stop a helper that an earlier launch left running from this bundle (an exact path match, not a
  // regular expression). Only the helper: the Gateway keeps running and is not booted out from here.
  void (async () => {
    const exe = join(
      bundle,
      "Contents",
      "Resources",
      "PsycheHelper.app",
      "Contents",
      "MacOS",
      "psyche-helper",
    );
    const ps = await execRunner("/bin/ps", ["-axo", "pid=,comm="]);
    for (const pid of pidsOfExecutable(ps.stdout, exe)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  })();
  void integrityText(app.getSystemLocale())
    .then((text) => {
      integrityMessage = text.blocked;
      return dialog.showMessageBox({
        type: "warning",
        message: text.title,
        detail: text.detail,
        buttons: [text.ok],
      });
    })
    .catch(() => {});
}
let thisDeviceId: string | undefined;
let hud: HudWindow | undefined;
let screenAsk: ScreenAskWindow | undefined;
let screenAskShortcut: ScreenAskShortcut | undefined;
let dictation: DictationService | undefined;
const relay = new NotificationRelay();
const zoom = new ZoomController({
  targets: () => windows?.appContents() ?? [],
  call: (method, params) => requireGateway().call(method, params),
  warn: (message) => console.warn(`[zoom] ${message}`),
});
/** The macOS accessibility displays settings the renderer and the native layer follow. */
function systemAppearance(): { reduceTransparency: boolean; highContrast: boolean } {
  return {
    // Windows: Settings → Personalization → Colors → Transparency effects off.
    reduceTransparency: nativeTheme.prefersReducedTransparency || !windowsTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors,
  };
}

/** Psyche leaves the Dock and ⌘-Tab while no window is open. */
const dockPolicy = new DockPolicy({ app, warn: (m) => console.warn(`[dock] ${m}`) });
const loginItem = new LoginItem(app, {
  leadingArgs,
  // Linux has no Electron login item: an XDG autostart entry does the same job.
  ...(isLinux() && app.isPackaged
    ? {
        autostart: {
          file: autostartPath(process.env, homedir()),
          exec: linuxAutostartExec(process.env),
        },
      }
    : {}),
  warn: (m) => console.warn(`[login] ${m}`),
});
/** "Keep Psyche running after I log out" (Settings › General): systemd lingering, Linux only. */
const linger = new Linger(execRunner, { warn: (m) => console.warn(`[linger] ${m}`) });
/** False when no StatusNotifierWatcher is on the session bus (stock GNOME): no tray, quit on close. */
let trayAvailable = true;

const windowTheme = new WindowTheme({
  targets: () => windows?.chromeWindows() ?? [],
  call: (method, params) => requireGateway().call(method, params),
  setThemeSource: (source) => {
    nativeTheme.themeSource = source;
  },
  canvas: () => canvasColor(nativeTheme.shouldUseDarkColors),
  // Windows: the caption buttons' glyphs follow the theme with the canvas.
  ...(windows32
    ? {
        overlay: () =>
          titleBarOverlayColors(
            nativeTheme.shouldUseDarkColors,
            nativeTheme.shouldUseHighContrastColors,
          ),
        materialBackground: () =>
          chromeViewBackground(
            process.platform,
            nativeTheme.shouldUseDarkColors,
            nativeTheme.shouldUseHighContrastColors,
          ),
      }
    : {}),
  warn: (message) => console.warn(`[theme] ${message}`),
});
const pendingCommands: ShellCommand[] = [];
let quittingEntirely = false;

function isAppUrl(url: string | undefined): boolean {
  return isSameApp(url, rendererUrl);
}

function broadcast(channel: string, payload: unknown): void {
  for (const wc of windows?.appContents() ?? []) wc.send(channel, payload);
  // So does the ask panel: it streams the answer from Gateway events.
  screenAsk?.contents()?.send(channel, payload);
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

/**
 * A `psyche-pair:` link the OS handed to the app. It only opens Settings with the link in the Add a
 * Gateway field: no Gateway is added or connected to from here. The owner presses Add, and main
 * asks in a native dialog that names the normalized address (design §3.2, CVE-2026-25253).
 */
const pairLinks = createPairLinkInbox({
  show: () => windows?.showSettings("server"),
  notify: () => broadcast(IPC.gatewaysLinkOpened, null),
});

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
  return (
    (windows?.isAppContents(event.sender) === true || screenAsk?.owns(event.sender) === true) &&
    isAppUrl(event.senderFrame?.url)
  );
}

type Handler = (event: IpcMainInvokeEvent, arg: unknown) => unknown;

/** `invoke` handlers answer `{ok, value} | {ok: false, error}` so error codes survive IPC. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (event, arg: unknown) => {
    if (!trusted(event))
      return { ok: false, error: { code: "forbidden", message: "untrusted sender" } };
    if (remoteGateway && REMOTE_REFUSED_CHANNELS.has(channel)) {
      return {
        ok: false,
        error: { code: "forbidden", message: "That only works on the computer running Psyche" },
      };
    }
    if (!remoteGateway && REMOTE_ONLY_CHANNELS.has(channel)) {
      return {
        ok: false,
        error: { code: "forbidden", message: "That only works with a Gateway on another computer" },
      };
    }
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

/**
 * Host terminal sessions (`terminal.session.*`, remote-gateway design §4.2) belong to the window
 * that opened them. The Gateway connection lives here in main, so a renderer reload or a closed
 * window never disconnects it: close the sessions when the window goes (crash, reload, closed)
 * instead of leaving a shell on the Host until its idle timeout. Nothing is ever spawned here.
 */
const terminalOwners = new Map<string, WebContents>();
const watchedOwners = new WeakSet<WebContents>();

function closeHostTerminal(sessionId: string): void {
  terminalOwners.delete(sessionId);
  try {
    void requireGateway()
      .call("terminal.session.close", { sessionId })
      .catch(() => undefined);
  } catch {
    // no Gateway connection: its disconnect handling ends the session
  }
}

function ownTerminal(owner: WebContents, sessionId: string): void {
  terminalOwners.set(sessionId, owner);
  if (watchedOwners.has(owner)) return;
  watchedOwners.add(owner);
  const closeOwned = () => {
    for (const [id, wc] of [...terminalOwners]) {
      if (wc === owner) closeHostTerminal(id);
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

/** This computer's paired helper (Mac or Windows), when online (for its notify.* capabilities). */
async function onlineHelper(): Promise<string | null> {
  const res = (await requireGateway().call("nodes.list", {})) as {
    nodes?: { id: string; kind: string; status: string }[];
  };
  return res.nodes?.find((n) => isHostHelperKind(n.kind) && n.status === "online")?.id ?? null;
}

async function invokeHelper(capability: string, params: unknown): Promise<unknown> {
  const nodeId = await onlineHelper();
  if (nodeId === null) throw new Error("the Psyche helper is not running");
  const r = (await requireGateway().call("nodes.invoke", { nodeId, capability, params })) as {
    ok: boolean;
    result?: unknown;
  };
  if (!r.ok) throw new Error(`${capability} failed`);
  return r.result;
}

/** The sandbox PC's one-time setup on Windows (service install, guest image); idle elsewhere. */
const sandboxPc = createSandboxPc({
  platform: process.platform,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  psycheHome: home,
  localAppData: process.env.LOCALAPPDATA ?? join(app.getPath("appData"), "..", "Local"),
  run: execRunner,
  exists: existsSync,
  restartHelper: async () => {
    await helper?.restart();
  },
  onState: (s) => broadcast(IPC.sandboxPcState, s),
});

/** macOS privacy permissions for onboarding and Settings (issue #384). */
const permissions = createPermissions({
  platform: process.platform,
  systemPreferences,
  desktopCapturer,
  openExternal: (url) => shell.openExternal(url),
  helper: {
    notificationStatus: async () =>
      notificationStateOf(await invokeHelper("notify.authorization_status", {})),
    requestNotifications: async () =>
      notificationStateOf(
        await invokeHelper("notify.request_authorization", { provisional: false }),
      ),
  },
  showFirstNotification: () => {
    if (!Notification.isSupported()) return false;
    new Notification({ title: "Psyche", body: "Notifications are on." }).show();
    return true;
  },
});

/**
 * The bundled helper, only while this app is attached to the Gateway on this Mac. The helper dials
 * this Mac's own node socket, so it can only ever serve this Mac's Gateway: against a Gateway on
 * another machine it would be launched for nothing, and its device id and Touch ID key are not
 * ones that Gateway knows or may ask (remote-gateway design §5.2).
 */
function helperForThisGateway(): string | undefined {
  return perfProbe === undefined && thisMacGateway ? bundledHelperPath() : undefined;
}

/** Runs the bundled helper with flags that print one JSON line and exit. */
const runHelperOnce = (file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(file, args, { env, timeout: 15_000, windowsHide: true }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout) });
    });
  });

/** The bundled helper's own device id and Touch ID key id (`--print-identity`). */
function bundledHelperIdentity(): Promise<HelperIdentity | undefined> {
  return readHelperIdentity(helperForThisGateway(), home, runHelperOnce);
}

/**
 * The host helper: `<Resources>/PsycheHelper.app` in packaged macOS builds (dev macOS builds use
 * their own helper install); on Windows `<resources>\win-helper\psyche-helper.exe` packaged, and
 * the repo's `apps/win-helper/target/{release,debug}/psyche-helper.exe` unpackaged.
 */
function bundledHelperPath(): string | undefined {
  return helperPathFor({
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

/** Windows: a browser's `App Paths` registration (per user, then per machine), through reg.exe. */
async function readAppPath(exe: string): Promise<string | undefined> {
  const reg = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
  for (const key of appPathKeys(exe)) {
    const res = await execRunner(reg, ["query", key, "/ve"]);
    const value = res.code === 0 ? parseRegDefault(res.stdout) : undefined;
    if (value) return value;
  }
  return undefined;
}

/**
 * Windows' Personalize settings, re-read whenever `nativeTheme` says the appearance changed
 * (Chromium watches that registry key): whether the taskbar is dark (the tray glyph is white
 * then) and whether "Transparency effects" is on (off is the app's Reduce transparency).
 */
let taskbarDark = true;
let windowsTransparency = true;
async function readPersonalize(): Promise<void> {
  const reg = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`;
  const res = await execRunner(reg, ["query", PERSONALIZE_KEY]);
  const out = res.code === 0 ? res.stdout : undefined;
  const dark = taskbarIsDark(out);
  if (dark !== taskbarDark) {
    taskbarDark = dark;
    tray?.refreshIcon();
  }
  const transparency = transparencyEffects(out);
  if (transparency !== windowsTransparency) {
    windowsTransparency = transparency;
    broadcast(IPC.systemAppearance, systemAppearance());
  }
}

/**
 * `screen.capture` with the screenshot-only fallback (main/screen-ask/capture-fallback.ts): the
 * helper's capture when one offers `screen.context`; when the Gateway answers `unavailable`, a
 * `desktopCapturer` frame of this display handed over as `frame`. A Gateway that does not take
 * `frame` yet (invalid_params) gets the original answer back.
 */
async function captureScreen(params: unknown, forward: () => Promise<unknown>): Promise<unknown> {
  try {
    return await forward();
  } catch (err) {
    if (!wantsFallback(err)) throw err;
    const p = (params ?? {}) as Record<string, unknown>;
    const rect = p.rect as { x: number; y: number; width: number; height: number } | undefined;
    const frame = await captureScreenFrame(
      {
        mode: p.mode === "region" ? "region" : "window",
        ...(rect ? { rect } : {}),
        ...(typeof p.maxWidth === "number" ? { maxWidth: p.maxWidth } : {}),
        ...(typeof p.maxHeight === "number" ? { maxHeight: p.maxHeight } : {}),
      },
      {
        displays: () => screen.getAllDisplays(),
        pointer: () => screen.getCursorScreenPoint(),
        sources: (thumbnailSize) =>
          desktopCapturer.getSources({ types: ["screen"], thumbnailSize }),
        excludeOwnWindows: withoutOwnWindows,
      },
    ).catch(() => undefined);
    if (!frame?.image) throw err;
    try {
      return await requireGateway().call("screen.capture", { ...p, frame });
    } catch (second) {
      if ((second as { code?: unknown } | null)?.code === "invalid_params") throw err;
      throw second;
    }
  }
}

/**
 * Psyche's own windows are left out of a capture (content protection: WDA_EXCLUDEFROMCAPTURE on
 * Windows, NSWindowSharingNone on macOS) while it is taken, as the helpers leave them out.
 */
async function withoutOwnWindows<T>(run: () => Promise<T>): Promise<T> {
  const own = BaseWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
  for (const w of own) w.setContentProtection(true);
  try {
    // DWM applies the change on its next frame.
    await new Promise((r) => setTimeout(r, 60));
    return await run();
  } finally {
    for (const w of own) if (!w.isDestroyed()) w.setContentProtection(false);
  }
}

/** `/Applications/Psyche.app` for a packaged macOS build (three levels above the executable), else null. */
function installedBundlePath(): string | null {
  if (!app.isPackaged || process.platform !== "darwin") return null;
  return resolve(dirname(process.execPath), "..", "..");
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

/**
 * The native confirmation for a change to the saved Gateways. It names the address main
 * normalized, in a dialog the renderer can neither draw nor click, because the address decides
 * where this app sends its signed handshake (security §10: never an address a page chose).
 */
async function confirmGatewayChange(c: GatewayConfirm): Promise<boolean | "plain"> {
  const opts =
    c.kind === "addLan"
      ? {
          message: `Is ${c.origin} a Psyche on this network?`,
          detail: `Name: ${c.name}\n\nA Psyche on this network uses its own certificate, which Psyche pins instead of trusting the system's: it checks the certificate and the Gateway's key at the first connection and refuses any other later. Choose "Plain https" only for a server with an ordinary certificate (for example a reverse proxy with your own CA). Nothing is shared until its owner approves this computer there.`,
          buttons: ["Psyche on this network", "Plain https", "Cancel"],
        }
      : c.kind === "addLink"
        ? {
            message: c.lan
              ? `Connect Psyche to ${c.origin} on this network?`
              : `Connect Psyche to ${c.origin}?`,
            detail: `${
              c.external
                ? `This link was opened by another app or a website, not pasted by you. Only continue if you made it yourself on ${hostWords().theDevice} that runs Psyche.\n\n`
                : ""
            }Psyche will connect only if that Gateway proves this identity:\n${c.fingerprint}\n\n${
              c.lan
                ? `It uses its own certificate, not one the system trusts. Psyche holds it to the one this link names (${c.lan.certPin.slice(0, 12)}…) before sending anything, and refuses any other. Only continue if the link came from your own ${hostWords().device} on this network.\n\n`
                : ""
            }The link's one-time code then lets that Gateway approve this computer without asking again, with the access its owner chose when making it.`,
            buttons: ["Add Gateway", "Cancel"],
          }
        : c.kind === "add"
          ? {
              message: `Connect Psyche to ${c.origin}?`,
              detail: `Name: ${c.name}${c.fingerprint ? `\nKey it announced: ${c.fingerprint.slice(0, 31)}…` : ""}\n\nThis computer will ask that Gateway to pair. Nothing is shared until its owner approves this computer there, and Psyche pins the Gateway's identity at the first connection.`,
              buttons: ["Add Gateway", "Cancel"],
            }
          : c.kind === "forget"
            ? {
                message: `Forget ${c.name}?`,
                detail: `${c.origin}\n\nThis removes this computer's key for it and everything Psyche stored here for it. ${c.name} still lists this computer until someone removes it there.`,
                buttons: ["Forget", "Cancel"],
              }
            : c.kind === "repair"
              ? {
                  message: `Pair with ${c.name} again?`,
                  detail: `${c.origin}\n\nThis forgets the identity Psyche pinned for it and this computer's key, so the next connection pins whatever answers at that address and asks to pair as a new computer. Only do this if you know why its identity changed.`,
                  buttons: ["Pair again", "Cancel"],
                }
              : {
                  message: `Stop Psyche on ${hostWords().thisDevice}?`,
                  detail:
                    "Its automations and scheduled tasks stop until you switch back. Leave it running to keep them going.",
                  buttons: [`Stop Psyche on ${hostWords().thisDevice}`, "Keep it running"],
                };
  const win = windows?.main();
  const dialogOptions = {
    type: "question" as const,
    buttons: opts.buttons,
    defaultId: opts.buttons.length - 1,
    cancelId: opts.buttons.length - 1,
    message: opts.message,
    detail: opts.detail,
  };
  const res = win
    ? await dialog.showMessageBox(win, dialogOptions)
    : await dialog.showMessageBox(dialogOptions);
  if (c.kind === "addLan" && res.response === 1) return "plain";
  return res.response === 0;
}

/** The saved Gateways: the list, adding, forgetting, switching (a restart) and the active pin. */
const lanDiscovery = new LanDiscovery();
let discovering: ReturnType<LanDiscovery["discover"]> | null = null;
const gateways = new GatewayManager({
  userData: baseUserData,
  target: gatewayTarget,
  confirm: confirmGatewayChange,
  relaunch: () => {
    app.relaunch();
    app.quit();
  },
  ...(remoteGateway ? {} : { stopLocal: () => supervisor?.stopEverything() ?? Promise.resolve() }),
});

function registerIpc(): void {
  handle(IPC.getStatus, () => gateway?.getStatus());
  handle(IPC.getDeviceId, () => thisDeviceId);
  handle(IPC.gatewayGetRun, () => supervisor?.getState() ?? { kind: "unknown" });
  handle(IPC.gatewayShowLogs, () => {
    if (remoteGateway) throw new PsycheError("forbidden", "The logs are on the other computer");
    return shell.openPath(join(home, "logs"));
  });
  // The splash's Retry after a failed start: run the supervisor again, then connect.
  // "I put my data back myself" after a restore the Gateway could not finish: forget that
  // restore (and the note), then start again. Only the owner's click gets here.
  handle(IPC.gatewayRestoredByHand, async () => {
    // Nothing is cleared until the unfinished restore is really there, every file it was putting
    // back exists (else the Gateway would start on a new, empty database), and the owner has
    // confirmed in a dialog the page cannot click.
    const win = windows?.main();
    const show = (opts: Electron.MessageBoxOptions) =>
      win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    const go = await guardRestoredByHand(
      home,
      {
        refuse: async (title, body) => {
          await show({ type: "warning", message: title, detail: body, buttons: ["OK"] });
        },
        confirm: async (s) =>
          (
            await show({
              type: "question",
              message: s.confirmTitle,
              detail: s.confirmBody,
              buttons: [s.cancel, s.confirmButton],
              defaultId: 0,
              cancelId: 0,
            })
          ).response === 1,
      },
      app.getLocale(),
    );
    if (!go) return;
    supervisor?.retryAfterUpdateFailure({ restoredByHand: true });
    await supervisor?.ensureRunning();
    gateway?.start();
  });
  handle(IPC.gatewayRetry, async () => {
    // After a failed update was undone the Gateway refuses to try again until told to.
    supervisor?.retryAfterUpdateFailure();
    await supervisor?.ensureRunning();
    // A remote Gateway that failed a check has stopped its reconnect loop: start over.
    if (remoteGateway) gateway?.stop();
    gateway?.start();
  });
  handle(IPC.gatewaysList, () => gateways.list());
  handle(IPC.gatewaysAdd, (_e, arg) => {
    const r = rec(IPC.gatewaysAdd, arg);
    return gateways.add(
      str(IPC.gatewaysAdd, r.address, "address", 300),
      typeof r.name === "string" ? str(IPC.gatewaysAdd, r.name, "name", 64) : undefined,
    );
  });
  handle(IPC.gatewaysAddLink, (_e, arg) => {
    const link = str(IPC.gatewaysAddLink, rec(IPC.gatewaysAddLink, arg).link, "link", 2100);
    // Whether the OS handed this link to the app is main's own record, not the window's say.
    return gateways.addFromLink(link, { external: pairLinks.wasOffered(link) });
  });
  handle(IPC.gatewaysPendingLink, () => pairLinks.take());
  // "Look on this network": Bonjour `_psyche._tcp`, on the owner's click. The window can add
  // only a Gateway this process found (by id), never an address it supplies.
  handle(IPC.gatewaysDiscover, async () => {
    // One look at a time: a second click (or a script in the window) joins the one running.
    discovering ??= lanDiscovery.discover().finally(() => {
      discovering = null;
    });
    const found = await discovering;
    const saved = new Set(gateways.list().map((g) => g.origin));
    return found.map((d) => ({
      id: d.id,
      name: d.name,
      fingerprint: d.fingerprint,
      conflict: d.conflict,
      saved: saved.has(d.origin),
    }));
  });
  handle(IPC.gatewaysAddDiscovered, (_e, arg) => {
    const found = lanDiscovery.get(
      str(IPC.gatewaysAddDiscovered, rec(IPC.gatewaysAddDiscovered, arg).id, "id", 32),
    );
    if (found === undefined) throw new PsycheError("not_found", "Look on the network again");
    if (found.conflict) {
      // Two announcements for one name that disagree on the key: one of them is not the Host.
      throw new PsycheError("forbidden", "That name was announced with different keys");
    }
    return gateways.add(found.origin, found.name, {
      lan: true,
      ...(found.fingerprint === null ? {} : { advertisedFingerprint: found.fingerprint }),
    });
  });
  handle(IPC.gatewaysRename, (_e, arg) => {
    const r = rec(IPC.gatewaysRename, arg);
    gateways.rename(
      str(IPC.gatewaysRename, r.id, "id", 32),
      str(IPC.gatewaysRename, r.name, "name", 64),
    );
  });
  handle(IPC.gatewaysRemove, (_e, arg) =>
    gateways.remove(str(IPC.gatewaysRemove, rec(IPC.gatewaysRemove, arg).id, "id", 32)),
  );
  handle(IPC.gatewaysSwitch, (_e, arg) => {
    const r = rec(IPC.gatewaysSwitch, arg);
    return gateways.switchTo(str(IPC.gatewaysSwitch, r.id, "id", 32), {
      stopLocal: r.stopLocal === true,
    });
  });
  handle(IPC.gatewaysRepair, (_e, arg) =>
    gateways.repair(str(IPC.gatewaysRepair, rec(IPC.gatewaysRepair, arg).id, "id", 32)),
  );
  handle(IPC.call, async (e, arg) => {
    const r = rec(IPC.call, arg);
    const method = checkCallable(r.method, isMethodName);
    const idempotencyKey = checkIdempotencyKey(r.idempotencyKey);
    const forward = () =>
      requireGateway().call(
        method,
        r.params ?? {},
        idempotencyKey === undefined ? undefined : { idempotencyKey },
      );
    // Ask about my screen from the ask panel: without a helper here, the desktop takes the frame.
    const result =
      method === "screen.capture" && !remoteGateway && screenAsk?.owns(e.sender) === true
        ? await captureScreen(r.params, forward)
        : await forward();
    if (method === "terminal.session.open") {
      const id = (result as { sessionId?: unknown } | null)?.sessionId;
      if (typeof id === "string") ownTerminal(e.sender, id);
    } else if (method === "terminal.session.close") {
      const id = (r.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof id === "string") terminalOwners.delete(id);
    }
    return result;
  });

  // A passkey for the remote Gateway's site, made in a hidden window of its origin (R2).
  const passkeyHost = remoteGateway
    ? new PasskeyHost({
        origin: gatewayTarget.origin,
        createWindow: () => createPasskeyWindow(gatewayTarget.origin),
      })
    : undefined;
  const requirePasskeys = (): PasskeyHost => {
    if (passkeyHost === undefined) throw new PsycheError("forbidden", "No remote Gateway");
    return passkeyHost;
  };
  handle(IPC.passkeyCreate, (_e, arg) =>
    requirePasskeys().create(checkPasskeyOptions(IPC.passkeyCreate, arg)),
  );
  handle(IPC.passkeyGet, (_e, arg) =>
    requirePasskeys().get(checkPasskeyOptions(IPC.passkeyGet, arg)),
  );

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
  // Teach by showing. Only the owner's renderer reaches these (`trusted` in `handle`); there is
  // no Gateway method, tool or bridge command for them, so the agent cannot start or read one.
  handle(IPC.teachStart, (_e, arg) =>
    requireBrowser().teachStart(str(IPC.teachStart, rec(IPC.teachStart, arg).tabId, "tabId", 128)),
  );
  handle(IPC.teachStop, () => requireBrowser().teachStop());
  handle(IPC.teachCancel, () => requireBrowser().teachCancel());
  handle(IPC.teachKeep, (_e, arg) => {
    const k = checkTeachKeep(arg);
    return requireBrowser().teachKeep(k.id, k.title, k.steps);
  });
  handle(IPC.teachKept, () => requireBrowser().teachKept());
  handle(IPC.teachStorage, () => requireBrowser().teachStorage());
  handle(IPC.teachOpenKept, (_e, arg) =>
    requireBrowser().teachOpenKept(checkTeachId(IPC.teachOpenKept, rec(IPC.teachOpenKept, arg).id)),
  );
  handle(IPC.teachDeleteKept, (_e, arg) =>
    requireBrowser().teachDeleteKept(
      checkTeachId(IPC.teachDeleteKept, rec(IPC.teachDeleteKept, arg).id),
    ),
  );
  // Teach by showing in a desktop app. Main asks the Gateway (which asks the Host helper) only when the
  // owner's renderer sends one of these; `teach.app.*` is not callable through the generic call.
  handle(IPC.teachAppApps, () => requireGateway().call("teach.app.apps", {}));
  handle(IPC.teachAppStart, (_e, arg) =>
    requireGateway().call(
      "teach.app.start",
      { bundleId: checkTeachApp(arg) },
      { idempotencyKey: `teach-app-start:${Date.now()}` },
    ),
  );
  handle(IPC.teachAppStop, () => requireGateway().call("teach.app.stop", {}));
  handle(IPC.teachAppCancel, () =>
    requireGateway().call(
      "teach.app.cancel",
      {},
      { idempotencyKey: `teach-app-cancel:${Date.now()}` },
    ),
  );
  handle(IPC.teachAppStatus, () => requireGateway().call("teach.app.status", {}));
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
    const found = windows32 ? await findWindowsChromium({ appPath: readAppPath }) : undefined;
    const linuxFound = isLinux() ? await findLinuxChromium({ run: execRunner }) : undefined;
    const cmd =
      isLinux() && linuxFound === undefined
        ? null
        : realChromeOpenCommand(process.platform, dir, found?.path, linuxFound);
    if (cmd === null) {
      throw new PsycheError(
        "unavailable",
        windows32
          ? "Install Google Chrome (or Microsoft Edge) to open the Psyche Chrome profile"
          : isLinux()
            ? "Install Google Chrome, Chromium, Brave or Microsoft Edge to open the Psyche Chrome profile"
            : "Opening the Psyche Chrome profile needs macOS, Windows or Linux",
      );
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolveSpawn, reject) => {
      const child = spawn(cmd.command, cmd.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
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
  handle(IPC.browserPromptAnswer, (_e, arg) => {
    const r = rec(IPC.browserPromptAnswer, arg);
    const action = r.action === "accept" || r.action === "never" ? r.action : "dismiss";
    return requireBrowser().answerPrompt(
      str(IPC.browserPromptAnswer, r.promptId, "promptId", 64),
      action,
    );
  });
  handle(IPC.browserSignedInList, () => requireBrowser().signedInSites());
  handle(IPC.browserSignedInForget, (_e, arg) =>
    requireBrowser().forgetSignedInSite(checkHttpUrl(IPC.browserSignedInForget, arg)),
  );
  handle(IPC.browserClearData, (_e, arg) =>
    requireBrowser().clearBrowsingData(arg === "clean" ? "clean" : "logged-in"),
  );

  handle(IPC.windowPopOut, (_e, arg) => {
    const r = rec(IPC.windowPopOut, arg);
    windows?.popOut(
      checkRoute(IPC.windowPopOut, r.route),
      str(IPC.windowPopOut, r.title, "title", 120),
    );
  });
  handle(
    IPC.windowFocusPopOut,
    (_e, arg) =>
      windows?.focusPopOut(
        checkRoute(IPC.windowFocusPopOut, rec(IPC.windowFocusPopOut, arg).route),
      ) ?? false,
  );
  on(IPC.windowClose, (event) => windows?.closeFor(event.sender));
  // The section is checked against a slug pattern in settingsRoute().
  on(IPC.windowOpenSettings, (_e, arg) =>
    windows?.showSettings(typeof arg === "string" ? arg : undefined),
  );
  // Settings → Connectors "Try it" (#677): the main window comes forward with the text in its
  // composer, unsent.
  on(IPC.windowPrefillComposer, (_e, arg) =>
    command({ type: "prefillComposer", text: checkComposerText(arg) }),
  );
  // Settings window → "Run setup again" and its other links outside Settings: the main window
  // comes forward and navigates there (`command` shows it).
  on(IPC.windowOpenInMain, (_e, arg) => command({ type: "navigate", route: checkMainRoute(arg) }));
  handle(IPC.dictationGetStatus, () => dictation?.status);
  handle(IPC.dictationRecheck, async () => {
    await dictation?.recheck();
    return dictation?.status;
  });
  handle(IPC.permissionsStatus, () => permissions.statusAll());
  // Windows: Settings → Sandbox PC. State, and "Turn on" (the elevated service install, the helper
  // restart and the guest image download). Nothing in the arguments: main computes every path.
  handle(IPC.sandboxPcGetState, () => sandboxPc.getState());
  handle(IPC.sandboxPcRefresh, () => sandboxPc.refresh());
  handle(IPC.sandboxPcTurnOn, () => sandboxPc.turnOn());
  // Only on the owner's click; never from the startup check.
  handle(IPC.sandboxPcUpdateService, () => sandboxPc.updateService());
  handle(IPC.sandboxPcCancel, () => sandboxPc.cancel());
  handle(IPC.helperGetState, () => helper?.getState() ?? { kind: "unbundled" });
  // An approval card's "Start Psyche Helper": launch now (no relaunch throttle), wait to pair. On
  // Windows a running helper is always ended and started again (`restart`).
  handle(IPC.helperLaunch, async (_e, arg) => {
    if (arg === "restart" || windows32) await helper?.restart();
    else await helper?.launch();
    return helper?.getState() ?? { kind: "unbundled" };
  });
  // Touch ID from the window (security §3.7, §10): the main and Settings windows only, never a
  // pop-out or the screen-ask window. Main adds what the bundled helper says about itself, so the
  // Gateway registers and asks only that helper.
  const approvalWindow = (e: IpcMainInvokeEvent) => {
    if (windows?.isApprovalContents(e.sender) !== true) {
      throw new PsycheError(
        "forbidden",
        `${hostWords().presence} approvals come from the main window`,
      );
    }
  };
  handle(IPC.touchIdIdentity, async (e) => {
    approvalWindow(e);
    return (await bundledHelperIdentity()) ?? null;
  });
  handle(IPC.touchIdRegister, async (e, arg) => {
    approvalWindow(e);
    // The owner's confirmation that this replaces a named earlier key (see the Gateway method).
    const confirmReplacesKeyId =
      typeof arg === "string" && /^[0-9a-f]{64}$/.test(arg) ? arg : undefined;
    const id = await bundledHelperIdentity();
    if (id?.keyId === undefined) {
      throw new PsycheError(
        "unavailable",
        id === undefined
          ? `This app has no bundled Psyche Helper to read the ${hostWords().presence} key from`
          : id.error === undefined && process.platform === "darwin"
            ? `${hostWords().presence} on this Mac needs no key to register`
            : `The bundled Psyche Helper has no ${hostWords().presence} key (${id.error ?? "unknown"})`,
      );
    }
    // `confirmReplacesKeyId` is only an accident guard: any admin caller can send it. The owner's
    // real confirmation is this native box, which main shows itself (not the renderer), naming both
    // keys, before the parameter is forwarded.
    if (confirmReplacesKeyId !== undefined) {
      const ok = await confirmReplaceKey(
        (o) => dialog.showMessageBox(o),
        app.getLocale(),
        confirmReplacesKeyId,
        id.keyId,
      );
      if (!ok) throw new PsycheError("cancelled", "The Touch ID key was not replaced");
    }
    return requireGateway().call("devices.presenceKey.register", {
      deviceId: id.deviceId,
      expectKeyId: id.keyId,
      ...(confirmReplacesKeyId === undefined ? {} : { confirmReplacesKeyId }),
    });
  });
  handle(IPC.touchIdApprove, async (e, arg) => {
    approvalWindow(e);
    const r = rec(IPC.touchIdApprove, arg);
    const id = await bundledHelperIdentity();
    return requireGateway().call("approvals.approveWithTouchId", {
      approvalId: str(IPC.touchIdApprove, r.approvalId, "approvalId", 128),
      answerToken: str(IPC.touchIdApprove, r.answerToken, "answerToken", 512),
      ...(id === undefined ? {} : { helperDeviceId: id.deviceId }),
    });
  });
  // Linux: the window's Allow on a card that needs the owner's password (polkit, linux design §9).
  handle(
    IPC.passwordApprove,
    (e, arg) => (approvalWindow(e), passwordApprove(requireGateway(), arg)),
  );
  // The app session refuses navigator.clipboard (the permission check allows only audio), so
  // copy buttons (vault recovery key, credential ids) write through main (#507).
  handle(IPC.clipboardWrite, (_event, arg) => {
    const text = checkClipboardText(arg);
    clipboard.writeText(text);
    // A secret (a pairing link) asks to be cleared again, but only if it is still what is there.
    const clearAfterMs = checkClipboardClearAfter(arg);
    if (clearAfterMs !== undefined) {
      setTimeout(() => {
        void Promise.resolve(clipboard.readText()).then((now) => {
          if (now === text) void clipboard.clear();
        });
      }, clearAfterMs).unref();
    }
  });
  // A connector's consent page opens in the owner's browser (#505); https only.
  handle(IPC.openExternal, async (_event, arg) => {
    await shell.openExternal(checkExternalUrl(arg));
  });
  // A cited passage's original: the renderer sends a document id; main asks the Gateway what it
  // may open and checks the answer again (lib/source-open.ts). Nothing else reaches Mail or Finder.
  handle(IPC.sourceOpen, (_event, arg) =>
    openSource(checkSourceOpen(arg).docId, {
      call: (id) => requireGateway().call("search.openSource", { id }),
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    }),
  );
  handle(IPC.appInfo, () =>
    appInfo({
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osVersion: process.getSystemVersion(),
      versions: process.versions,
      psycheHome: home,
      gatewayOrigin: gatewayTarget.origin,
    }),
  );
  handle(IPC.appRevealHome, () => {
    // The data folder is on the Host, not here (design §4.2: "Show in Finder" is Host-only).
    if (remoteGateway) throw new PsycheError("forbidden", "That folder is on the other computer");
    shell.showItemInFolder(home);
  });
  // Uninstall Psyche (design updates-and-install §3.5). Only a packaged app that runs its own
  // LaunchAgent has it; remote windows, dev and external modes are refused, and "Delete my data"
  // asks the Gateway for fresh presence for exactly the folder it will move.
  const bundledProgram = join(process.resourcesPath, "psyched", "psyched");
  const readAgentPlist = (): string | undefined => {
    try {
      return existsSync(launchAgentPath()) ? readFileSync(launchAgentPath(), "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  const uninstallDeps = (): UninstallDeps => ({
    userHome: homedir(),
    psycheHome: process.env.PSYCHE_HOME,
    agentPsycheHome: (() => {
      const plist = readAgentPlist();
      return plist === undefined ? undefined : psycheHomeFromPlist(plist);
    })(),
    appBundlePath: installedBundlePath(),
    helperAppPath: bundledHelperPath() ?? null,
    uid: process.getuid?.() ?? 0,
    run: execRunner,
    trashItem: (p) => shell.trashItem(p),
    setOpenAtLogin: (v) => loginItem.set(v),
    agentOwner: () => {
      const plist = readAgentPlist();
      if (plist === undefined) return "none";
      return plistProgram(plist) === bundledProgram ? "ours" : "other";
    },
    agentLoaded: async () =>
      (await execRunner("/bin/launchctl", [...launchctl.print(process.getuid?.() ?? 0)])).code ===
      0,
    restartAgent: async () => {
      await supervisor?.ensureRunning();
    },
    clearStagedUpdate: async () => {
      stopUpdater();
      const staged = join(app.getPath("temp"), "psyche-update");
      return existsSync(staged) ? [staged] : [];
    },
    authorizeDelete: async (path, approvalId) => {
      await requireGateway().call("app.uninstall.authorize", {
        path,
        ...(approvalId === undefined ? {} : { approvalId }),
      });
    },
    confirm: async (plan) => {
      const box = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Cancel", plan.deleteData ? "Delete data and uninstall" : "Uninstall"],
        defaultId: 0,
        cancelId: 0,
        message: "Uninstall Psyche?",
        detail: [
          `${plan.trash.length} item(s) will be moved to the Trash, including Psyche.app.`,
          plan.deleteData && plan.dataFolder !== undefined
            ? `Your data folder ${plan.dataFolder} will be moved to the Trash too.`
            : "Your data folder is kept.",
          plan.keychain.length > 0
            ? "The Keychain items Psyche keeps will be removed."
            : "Keychain items stay; remove them in Keychain Access if you want.",
        ].join("\n"),
      });
      return box.response === 1;
    },
    closeWindows: () => {
      for (const w of BaseWindow.getAllWindows()) w.destroy();
    },
    quit: () => {
      quittingEntirely = true;
      app.quit();
    },
    log: (m) => console.warn(`[uninstall] ${m}`),
  });
  // Windows: the same sheet over uninstall-windows.ts (Recycle Bin, Windows Hello through the same
  // Gateway gate, the task, the sandbox PC service, then Squirrel's Update.exe --uninstall).
  const windowsDeps = () =>
    windowsUninstallDeps(
      {
        execPath: process.execPath,
        userDataDir: app.getPath("userData"),
        psycheHome: process.env.PSYCHE_HOME,
        updateExe: squirrelLayout(process.execPath)?.updateExe,
        appData: app.getPath("appData"),
      },
      {
        trashItem: (p) => shell.trashItem(p),
        setOpenAtLogin: (v) => loginItem.set(v),
        restartAgent: async () => {
          await supervisor?.ensureRunning();
        },
        clearStagedUpdate: async () => {
          stopUpdater();
          const staged = join(app.getPath("temp"), "psyche-update");
          return existsSync(staged) ? [staged] : [];
        },
        authorizeDelete: async (path, approvalId) => {
          await requireGateway().call("app.uninstall.authorize", {
            path,
            ...(approvalId === undefined ? {} : { approvalId }),
          });
        },
        confirm: async (plan) => {
          const box = await dialog.showMessageBox({
            type: "warning",
            buttons: ["Cancel", plan.deleteData ? "Delete data and uninstall" : "Uninstall"],
            defaultId: 0,
            cancelId: 0,
            message: "Uninstall Psyche?",
            detail: confirmDetailWindows(plan),
          });
          return box.response === 1;
        },
        showManualSteps: async (detail) => {
          await dialog.showMessageBox({
            type: "info",
            message: "One more step to finish removing Psyche",
            detail,
          });
        },
        closeWindows: () => {
          for (const w of BaseWindow.getAllWindows()) w.destroy();
        },
        quit: () => {
          quittingEntirely = true;
          app.quit();
        },
        log: (m) => console.warn(`[uninstall] ${m}`),
      },
    );
  // Linux: the same sheet over platform/uninstall-linux.ts (the Trash, the user unit, the package).
  const linuxDeps = async (): Promise<LinuxUninstallDeps> => {
    const install = linuxInstallKind(process.env);
    const launch = linuxGatewayLaunch(process.env);
    const unitFile = join(userUnitDir(process.env, homedir()), GATEWAY_UNIT);
    const readUnit = (): string | undefined => {
      try {
        return existsSync(unitFile) ? readFileSync(unitFile, "utf8") : undefined;
      } catch {
        return undefined;
      }
    };
    const locale = app.getLocale();
    return {
      userHome: homedir(),
      env: process.env,
      psycheHome: process.env.PSYCHE_HOME,
      unitPsycheHome: (() => {
        const text = readUnit();
        return text === undefined ? undefined : psycheHomeFromUnit(text);
      })(),
      install,
      appImagePath: install === "appimage" ? (process.env.APPIMAGE ?? null) : null,
      packageManager: install === "package" ? await linuxPackageManager(execRunner) : undefined,
      locale,
      run: execRunner,
      trashItem: (p) => shell.trashItem(p),
      removePath: (p) => rmSync(p, { recursive: true, force: true }),
      setOpenAtLogin: (v) => loginItem.set(v),
      unitOwner: () => linuxUnitOwner({ install, unitFile, program: launch.program }),
      unitActive: async () => (await execRunner("systemctl", systemctlUser.isActive())).code === 0,
      restartGateway: async () => {
        await supervisor?.ensureRunning();
      },
      clearStagedUpdate: async () => {
        stopUpdater();
        const staged = join(app.getPath("temp"), "psyche-update");
        return existsSync(staged) ? [staged] : [];
      },
      authorizeDelete: async (path, approvalId) => {
        await requireGateway().call("app.uninstall.authorize", {
          path,
          ...(approvalId === undefined ? {} : { approvalId }),
        });
      },
      confirm: async (plan) => {
        const text = confirmTextLinux(plan, locale);
        const box = await dialog.showMessageBox({
          type: "warning",
          buttons: [text.cancel, text.confirm],
          defaultId: 0,
          cancelId: 0,
          message: text.title,
          detail: text.detail,
        });
        return box.response === 1;
      },
      closeWindows: () => {
        for (const w of BaseWindow.getAllWindows()) w.destroy();
      },
      quit: () => {
        quittingEntirely = true;
        app.quit();
      },
      log: (m) => console.warn(`[uninstall] ${m}`),
    };
  };
  const asPsycheError = (err: unknown): unknown =>
    err instanceof UninstallError ? new PsycheError(err.code, err.message) : err;
  const uninstallAllowed = (): void => {
    if (!canUninstall) {
      throw new PsycheError("forbidden", "This copy of Psyche cannot uninstall itself from here");
    }
  };
  handle(IPC.appUninstallPlan, async (_event, arg) => {
    uninstallAllowed();
    const req = checkUninstall(IPC.appUninstallPlan, arg);
    try {
      const plan = windows32
        ? await planUninstallWindows(await windowsDeps(), req)
        : isLinux()
          ? planUninstallLinux(await linuxDeps(), req)
          : planUninstall(uninstallDeps(), req);
      return {
        stops: plan.stops.map(({ kind, label }) => ({ kind, label })),
        trash: plan.trash.map(({ kind, path, label }) => ({ kind, path, label })),
        confirmWord: DELETE_CONFIRM_WORD,
        agent: plan.agent,
        keychain: plan.keychain,
        warnings: plan.warnings,
        blockers: plan.blockers,
      };
    } catch (err) {
      throw asPsycheError(err);
    }
  });
  handle(IPC.appUninstall, async (_event, arg) => {
    uninstallAllowed();
    const req = checkUninstall(IPC.appUninstall, arg);
    try {
      const res = windows32
        ? await runUninstallWindows(await windowsDeps(), req)
        : isLinux()
          ? await runUninstallLinux(await linuxDeps(), req)
          : await runUninstall(uninstallDeps(), req);
      if (res.failed.length > 0) {
        throw new PsycheError(
          "internal",
          `Some items could not be moved to the ${windows32 ? "Recycle Bin" : "Trash"}, so Psyche stays open: ${res.failed
            .map((f) => f.path)
            .join(
              ", ",
            )}. ${res.restarted ? "The Gateway was started again. " : ""}${windows32 ? UNINSTALL_MANUAL_STEPS_WINDOWS : isLinux() ? UNINSTALL_MANUAL_STEPS_LINUX : UNINSTALL_MANUAL_STEPS}`,
        );
      }
    } catch (err) {
      throw asPsycheError(err);
    }
  });
  handle(IPC.systemAppearanceGet, () => systemAppearance());
  handle(IPC.localeGet, () => ({
    system: app.getSystemLocale(),
    preferred: app.getPreferredSystemLanguages(),
  }));
  handle(IPC.permissionsRequest, (_event, arg) => {
    if (integrityBlocked) throw new Error(integrityMessage);
    const kind = str(IPC.permissionsRequest, rec(IPC.permissionsRequest, arg).kind, "kind", 32);
    if (!(PERMISSION_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${IPC.permissionsRequest}: unknown permission ${kind}`);
    }
    return permissions.request(kind as PermissionKind);
  });
  handle(IPC.dictationCheckHotkey, (_event, arg) => {
    const r = rec(IPC.dictationCheckHotkey, arg);
    const accelerator = str(IPC.dictationCheckHotkey, r.accelerator, "accelerator", 64);
    // Settings checks each shortcut against the others': none may take one in use.
    if (r.purpose === "quickEntry") {
      if (accelerator !== "" && accelerator === dictation?.hotkey) return "taken";
      if (accelerator !== "" && accelerator === screenAskShortcut?.current) return "taken";
      return quickEntryShortcut?.check(accelerator) ?? "ok";
    }
    if (accelerator !== "" && accelerator === quickEntryShortcut?.current) return "taken";
    if (r.purpose === "screenAsk") {
      if (accelerator !== "" && accelerator === dictation?.hotkey) return "taken";
      return screenAskShortcut?.check(accelerator) ?? "ok";
    }
    if (accelerator !== "" && accelerator === screenAskShortcut?.current) return "taken";
    return dictation?.checkHotkey(accelerator) ?? "ok";
  });
  on(IPC.dictationOpenAccessibility, () => {
    void shell.openExternal(dictationSettingsUrl());
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
      typeof r.route === "string" ? checkNotifyRoute(IPC.notifyShow, r.route) : "/inbox",
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
  // Settings changes would register the Host's dictation and Ask-about-screen hotkeys here.
  if (!remoteGateway) {
    dictation?.onEvent(e.event, e.payload);
    screenAskShortcut?.onEvent(e.event, e.payload);
    quickEntryShortcut?.onEvent(e.event, e.payload);
  }
  const p = e.payload as Record<string, unknown>;
  if (e.event === "settings.changed") {
    const entries = (p.entries as { key: string; value: unknown }[] | undefined) ?? [];
    zoom.onSettingsChanged(entries);
    windowTheme.onSettingsChanged(entries);
    // The Host's Dock and open-at-login settings describe the Host, not this Mac (design §4.4).
    if (!remoteGateway) {
      dockPolicy.onSettingsChanged(entries);
      loginItem.onSettingsChanged(entries);
      linger.onSettingsChanged(entries);
    }
  }
  if (e.event === "notification.opened") {
    const route = p.route;
    if (typeof route === "string" && isAppRoute(route)) command({ type: "navigate", route });
  }
  // A client of another computer's Gateway shows what the Host routes to its own OS surface.
  if (e.event === "notification.device" && remoteGateway) {
    const d = relay.decideDevice(e.payload);
    if (d.show && d.title && d.body && d.route)
      showNotification(d.title, d.body, d.route, d.urgency);
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

type NodeRow = { kind?: string; status?: string; capabilities?: { name?: string }[] };

/** This computer's helpers online now (`mac-helper` or `win-helper`). */
async function onlineHostHelpers(): Promise<NodeRow[]> {
  const res = (await gateway?.call("nodes.list", {}).catch(() => undefined)) as
    | { nodes?: NodeRow[] }
    | undefined;
  return (res?.nodes ?? []).filter((n) => isHostHelperKind(n.kind) && n.status === "online");
}

/** Once per launch: the helper's notification permission, if it was never asked for. */
let helperNotificationsChecked = false;

async function refreshHelperPresence(): Promise<void> {
  const helpers = await onlineHostHelpers();
  relay.helperOnline = helpers.some((n) =>
    (n.capabilities ?? []).some((c) => c.name?.startsWith("notify.")),
  );
  if (relay.helperOnline && !helperNotificationsChecked) {
    helperNotificationsChecked = true;
    void askHelperNotificationsIfUndetermined(invokeHelper).catch(() => undefined);
  }
  // Launches the bundled helper the first time and when it went away (packaged macOS only).
  void helper?.onPresence(helpers.length > 0);
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
      (windows?.isAppContents(wc) === true ||
        hud?.owns(wc) === true ||
        screenAsk?.owns(wc) === true) &&
      isAppUrl(details.requestingUrl) &&
      (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === "audio") === true;
    callback(ok);
  });
  ses.setPermissionCheckHandler(
    (wc, permission, origin) =>
      permission === "media" &&
      wc !== null &&
      (windows?.isAppContents(wc) === true ||
        hud?.owns(wc) === true ||
        screenAsk?.owns(wc) === true) &&
      isAppUrl(origin),
  );
}

void app.whenReady().then(async () => {
  await startupIntegrity().catch((err) => console.warn(`[integrity] ${String(err)}`));
  if (gatewaysFileProblem !== undefined) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Psyche can't read its saved Gateways",
      detail: `${gatewaysFileProblem}. Psyche starts on This Mac and leaves the file as it is, so no pinned identity is lost. Fix or remove the file in Psyche's data folder to use another computer's Gateway.`,
    });
  }
  await decideSplash();
  nativeTheme.on("updated", () => {
    windowTheme.refresh();
    broadcast(IPC.systemAppearance, systemAppearance());
    // Windows' taskbar has its own light/dark setting; "updated" fires when either changes.
    if (windows32) void readPersonalize();
  });
  if (windows32) void readPersonalize();
  // 120 Hz check (docs/design/motion.md §5): compare with the renderer's rAF probe.
  if (!app.isPackaged) {
  }
  // Packaged builds get the icon from the bundle (forge.config.ts); dev runs set the Dock icon here.
  if (!app.isPackaged && process.platform === "darwin") {
    app.dock?.setIcon(join(app.getAppPath(), "assets", "icon.png"));
  }
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
      settings: () => windows?.showSettings(),
      zoomIn: () => void zoom.zoomIn(),
      zoomOut: () => void zoom.zoomOut(),
      zoomReset: () => void zoom.reset(),
    }),
  );

  // Liquid Glass spike: off unless PSYCHE_GLASS=native on an unpackaged macOS run.
  const glass = app.isPackaged ? "off" : glassMode(process.env, process.platform);
  windows = createAppWindows({
    rendererUrl,
    preloadPath: preloadPath(),
    settingsBoundsFile: join(app.getPath("userData"), "settings-window.json"),
    // The pane's window is gone: the main window docks it again instead of keeping it "popped".
    onPopOutClosed: (route) => command({ type: "popOutClosed", route }),
    // Windows: closing the window leaves Psyche in the notification area; say so the first time.
    ...(windows32 ? { onMainHidden: sayStillRunningOnce } : {}),
    splash: () => splashWanted,
    ...(remoteGateway ? { remote: { hostName: gatewayTarget.name } } : {}),
    ...(canUninstall ? { uninstall: true } : {}),
    anySize: wantsAnyWindowSize(app.isPackaged, process.env),
    mainOptions: glassWindowOptions(glass),
    dock: dockPolicy,
    // The stored zoom wins over Electron's own per-origin memory on every load.
    onViewCreated: (wc) => wc.on("did-finish-load", () => zoom.applyTo(wc)),
    // The native-glass spike keeps its window transparent; every other window paints the canvas.
    onChromeWindowCreated: (win, view) => {
      if (glass !== "native") windowTheme.applyTo({ win, view });
    },
    // Owner decision 2026-10-26 (docs/design/lightweight-2026.md item 2): after ten minutes in the
    // menu bar the main app renderer is freed (−90 MB or more); reopening rebuilds it.
    releaseHiddenAfterMs: releaseHiddenAfterMs(app.isPackaged, process.env),
    canRelease: async (wc) => !(await wc.executeJavaScript(HAS_UNSENT_TEXT).catch(() => true)),
    // Per page: the first main view and each one rebuilt after a release.
    onMainViewCreated: (win, view) => {
      view.webContents.once("did-finish-load", () => {
        for (const c of pendingCommands.splice(0)) view.webContents.send(IPC.shellCommand, c);
      });
      // Input in the app itself (chat, approvals) counts too; nothing synthesizes input there.
      view.webContents.on("before-input-event", (_e, input) => {
        if (input.type === "keyDown" || input.type === "rawKeyDown") attention.input();
      });
      view.webContents.on("input-event", (_e, ev) => {
        if (ev.type === "mouseDown") attention.input();
      });
      if (glass === "native") {
        void attachNativeGlass(win, view).then((id) => {
          if (id < 0) console.warn("[glass] no native glass here; the page stays opaque");
          const probe = process.env[GLASS_PROBE_ENV];
          if (id < 0 || !probe) return;
          const run = () =>
            void runGlassProbe(win, view, probe, {
              metrics: () => app.getAppMetrics(),
              setTheme: (t) => {
                nativeTheme.themeSource = t;
              },
            });
          // The addon loads asynchronously; the page may already have finished loading.
          if (view.webContents.isLoading()) view.webContents.once("did-finish-load", run);
          else run();
        });
      }
    },
    onMainCreated: (win, mainView) => {
      browser?.dispose();
      // The agent's browser stays on the Host (decision G4): no pane, no bridge to this Mac's
      // own Gateway, nothing for the Host to drive from here.
      if (remoteGateway) return;
      browser = new BrowserHost({
        window: win,
        rendererZoom: () =>
          mainView.webContents.isDestroyed() ? 1 : mainView.webContents.getZoomFactor(),
        psycheHome: home,
        userData: app.getPath("userData"),
        // Straight from this process to the Gateway's vault: the value never goes through the
        // renderer, a log or the model.
        vaultAdd: async (item) => void (await requireGateway().call("vault.add", item)),
        // Dev and test runs may shorten the idle time before a background tab is discarded.
        ...tabDiscardOverride(app.isPackaged, process.env),
      });
      browser.watchProfileCookies();
      browser.on("state", (s) => broadcast(IPC.browserState, s));
      // Pause-when-unwatched (#272): pane visibility and owner input go to the Gateway.
      browser.on("paneVisible", (v) => attention.visible(v));
      browser.on("ownerInput", () => attention.input());
      const host = browser;
      for (const ev of ["show", "hide", "minimize", "restore"] as const) {
        win.on(ev as "show", () => host.refreshVisibility());
      }
      host.refreshVisibility();
      browser.on("download", (d) => broadcast(IPC.browserDownload, d.notice));
      if (bridge) {
        void bridge.stop();
      }
      bridge = new BridgeClient({
        socketPath: process.env.PSYCHE_BROWSER_BRIDGE_SOCKET ?? bridgeSocketPath(home),
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

  // A Squirrel update ships a new sandbox PC service, but the installed one is replaced only by an
  // elevated install. Find out (no prompt, no network) and say so once; Settings has the update.
  if (windows32) {
    void sandboxPc
      .check()
      .then((s) => {
        const notice = serviceUpdateNotice(s);
        if (notice) showNotification(notice.title, notice.body, notice.route);
      })
      .catch(() => undefined);
  }

  // The bundled host helper (docs/archive/status/s14.md "Packaging"), started once this window
  // pairs, i.e. the Gateway answers: through LaunchServices on macOS (dev builds use their own
  // helper install), as a detached process on Windows (dev: the repo's Rust build, if any).
  helper = new HelperLauncher({
    appPath: helperForThisGateway(),
    psycheHome: home,
    run: execRunner,
    // A packaged Windows helper's Authenticode signature is checked once, in the background.
    verifySignature: windows32 && app.isPackaged,
    isPaired: async () => (await onlineHostHelpers()).length > 0,
    blocked: () => integrityBlocked,
    onState: (s) => {
      broadcast(IPC.helperState, s);
    },
  });

  const deviceKey = loadOrCreateDeviceKey(join(app.getPath("userData"), "device-key.json"));
  thisDeviceId = deviceKey.deviceId;
  const origin = gatewayTarget.origin;
  // Pairing work runs once per pairing, not on every 10 s health tick (which re-sent
  // dictation.watch and failed it as unavailable while the helper was offline).
  const onPairing = pairingEdge({
    onPaired: () => {
      attention.resend();
      void refreshHelperPresence();
      void refreshApprovals();
      void zoom.load();
      void windowTheme.load();
      if (!remoteGateway) {
        void dockPolicy.load((method, params) => requireGateway().call(method, params));
        void loginItem.load((method, params) => requireGateway().call(method, params));
        void linger.load((method, params) => requireGateway().call(method, params));
      }
      // System-wide dictation and Ask about my screen would listen to, and capture, the Host's
      // microphone and screen from here: off until they can run on this computer (design §4.2).
      if (!remoteGateway) {
        void dictation?.load();
        // The tray shows the shortcuts that ended up registered.
        void screenAskShortcut?.load().then(() => tray?.update({ shortcuts: shownShortcuts() }));
        void quickEntryShortcut?.load();
      }
      void bootstrapAdminIfNeeded({
        packaged: app.isPackaged,
        local: thisMacGateway,
        scopes: () => gateway?.getStatus().scopes,
        call: (m, p, o) => requireGateway().call(m, p, o),
        reconnect: () => {
          gateway?.stop();
          gateway?.start();
        },
        warn: (m) => console.warn(`[gateway] ${m}`),
      });
    },
    onUnpaired: () => dictation?.onDisconnected(),
  });
  // A Gateway on the local network has a self-signed certificate: it is reached only through a
  // channel that holds it to the pinned SPKI, and the verifier binds the identity proof to it.
  const lanChannel = lanGateway
    ? new PinnedChannel({
        host: new URL(origin).hostname.replace(/^\[|\]$/g, ""),
        port: Number(new URL(origin).port || 443),
        pinned: () => gateways.pinnedCert(),
      })
    : null;
  let serverSeen: { server: { version: string; build: string } | undefined } | undefined;
  const gatewayVerifier = createGatewayVerifier({
    dialedOrigin: origin,
    mode: remoteGateway ? "strict" : "local",
    pinnedKey: () => gateways.pinnedKey(),
    // A pairing link's fingerprint, until the key itself is pinned: the first connect is verified.
    pinnedFingerprint: () => gateways.pinnedFingerprint(),
    ...(remoteGateway ? { expectedFingerprint: () => gateways.advertisedFingerprint() } : {}),
    ...(lanChannel
      ? {
          lan: {
            observedSpki: () => lanChannel.observedSpki(),
            pinnedSpki: () => gateways.pinnedCert(),
          },
        }
      : {}),
    // This Mac's own Gateway must answer with the key in this Mac's own identity file.
    ...(thisMacGateway ? { localKey: () => readLocalGatewayKey(home) } : {}),
    // An update swaps the files under a Gateway that keeps running: restart it when its build is
    // not the one this app shipped (updates design §2.10, gap G1).
    // Called after the identity checks pass; acted on once the connection is paired.
    onServer: (server) => {
      serverSeen = { server };
    },
  });
  gateway = createDesktopGateway({
    deviceKey,
    httpOrigin: origin,
    psycheHome: home,
    ...(remoteGateway ? { remote: true } : {}),
    // The Gateway proves its identity key before this app signs anything (design §3.3). A saved
    // remote Gateway is pinned on first use and refused if the key ever differs; This Mac's own
    // is trusted by the per-launch secret, so it keeps no pin.
    verifyGateway: gatewayVerifier,
    // A pairing link's one-time token, presented only after the Gateway proved its identity.
    setupToken: () => gateways.setupToken(),
    ...(lanChannel
      ? {
          transport: {
            createWebSocket: (url: string) => createPinnedWebSocket(lanChannel, url),
            fetch: createPinnedFetch(lanChannel),
          },
        }
      : {}),
    onStatus: (s) => {
      broadcast(IPC.status, s);
      tray?.update({ status: s });
      // The Gateway proved it is this Mac's own and the connection is up: if it is not the
      // build this app shipped, restart it (after asking it to settle its work).
      if (s.phase === "paired" && !remoteGateway && serverSeen !== undefined) {
        const seen = serverSeen;
        serverSeen = undefined;
        void supervisor?.checkServerBuild(seen.server).catch(() => undefined);
      }
      // Trust on first use is held in memory and stored only once that connection is paired.
      if (s.phase === "paired" && remoteGateway) {
        const first = gatewayVerifier.candidateKey();
        if (first !== undefined) gateways.pin(first);
        const cert = gatewayVerifier.candidateCertSpki();
        if (cert !== undefined) gateways.pinCert(cert);
      }
      onPairing(s);
      if (s.phase === "paired") gateways.markConnected();
      // Once paired, the Host says what it is called; until then the entry is named by address.
      if (s.phase === "paired" && remoteGateway) {
        void gateway
          ?.call("gateway.info", {})
          .then((info) => {
            const name = (info as { hostName?: unknown } | undefined)?.hostName;
            if (typeof name === "string") gateways.adoptHostName(name);
          })
          .catch(() => undefined);
      }
      // The Host answered a connect that carried the token (paired, waiting, or refused): it is
      // spent or useless, so never offer it again.
      if (s.phase !== "paired" && setupTokenAnswered(s.phase)) gateways.clearSetupToken();
      // The Host sends this connection OS notifications only once it asks (R2); per connection.
      if (s.phase === "paired" && remoteGateway) {
        void gateway?.call("notifications.device.register", { enabled: true }).then(
          // Only now does the Host route toasts here, so only now does the fallback go quiet:
          // an older Host without the method keeps the in-app fallback.
          () => {
            relay.remote = true;
          },
          (err: unknown) => {
            relay.remote = false;
            console.warn(`[notify] could not register: ${String(err)}`);
          },
        );
      }
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
    warn: (m) => console.warn(`[dictation] ${m}`),
  });
  // Ask about my screen (docs/design/screen-ask-2026.md): the ask panel and its region overlay.
  screenAsk = new ScreenAskWindow({
    url: (route) => new URL(route, rendererUrl).toString(),
    preloadPath: preloadPath(),
    onOpenThread: (threadId) => command({ type: "navigate", route: threadRoute(threadId) }),
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
    ...((!app.isPackaged && process.env.PSYCHE_DISABLE_GLOBAL_SHORTCUTS === "1") || integrityBlocked
      ? {}
      : { shortcuts: globalShortcut }),
    warn: (m) => console.warn(`[dictation] ${m}`),
    onStatus: (s) => broadcast(IPC.dictationStatus, s),
    // Windows: Settings warns when Right Alt is AltGr on the layout in use.
    ...(process.platform === "win32"
      ? { altGrLayout: () => readAltGrLayout(helperForThisGateway(), runHelperOnce) }
      : {}),
    // Double-tapping the voice or dictation key opens "Ask about my screen", like the shortcut.
    onKeyDoubleTap: () => {
      if (!remoteGateway && !integrityBlocked) screenAsk?.trigger("window");
    },
    // The voice key (held from any app) opens the ask panel in voice mode: speak, and the answer
    // appears as text. The panel dictates through the renderer, which owns the microphone, and
    // Talk with Psyche keeps the panel window even with Ask about screen off.
    ...voicePopup(
      () => screenAsk,
      (down) => broadcast(IPC.voiceKey, { down }),
    ),
  });
  // A locked or sleeping Mac closes the panel and frees the microphone.
  powerMonitor.on("lock-screen", () => {
    broadcast(IPC.voiceSystem, { event: "lock" });
    screenAsk?.suspend();
  });
  powerMonitor.on("suspend", () => {
    broadcast(IPC.voiceSystem, { event: "suspend" });
    screenAsk?.suspend();
  });
  powerMonitor.on("unlock-screen", () => {
    screenAsk?.resume();
  });
  powerMonitor.on("resume", () => {
    screenAsk?.resume();
  });
  registerIpc();
  gateways.sweepForgottenData();

  // macOS: the LaunchAgent; Windows: the per-user scheduled task (main/supervisor-windows.ts).
  const bundledGateway = bundledGatewayPaths(process.resourcesPath);
  const expectedBuild = readBundledBuild(join(bundledGateway.dir, "build-info.json"));
  supervisor = createSupervisor({
    mode: supervisorMode,
    psycheHome: home,
    healthUrl: new URL("/healthz", origin).toString(),
    gatewayDir: resolve(app.getAppPath(), "..", "gateway"),
    bundledProgram: join(process.resourcesPath, "psyched", "psyched"),
    bundledPlist: join(process.resourcesPath, "launchd", "com.psyche.gateway.plist"),
    bundledPsyched: bundledGateway.dir,
    bundledNode: bundledGateway.node,
    bundledTemplate: bundledGateway.template,
    ...(isLinux()
      ? (() => {
          const launch = linuxGatewayLaunch(process.env);
          return {
            gatewayProgram: launch.program,
            gatewayArgs: launch.args,
            install: launch.install,
          };
        })()
      : {}),
    ...(expectedBuild === undefined ? {} : { expectedBuild }),
    prepareRestart: () =>
      requireGateway().call("gateway.prepareUpdate", { waitMs: 10_000, timeoutMs: 60_000 }),
    confirmTakeover: async (other) => {
      const opts = {
        type: "question" as const,
        buttons: ["Keep the other copy", "Use this copy"],
        defaultId: 0,
        cancelId: 0,
        message: "Another copy of Psyche is already running",
        detail: `It runs from ${other}. Using this copy switches Psyche to this app; the other copy then connects to this one.`,
      };
      const win = windows?.main();
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      return res.response === 1;
    },
    // Key-file slot unless the bundled helper can hold the Keychain (Touch ID) slot, which a
    // Windows helper never can. macOS passes it in the LaunchAgent's environment; Windows in
    // run\gateway-service.json, which the task's service host reads (supervisor-windows.ts).
    vaultKeyFile: async () =>
      !isLinux() && (await helperCanHoldKeychain(bundledHelperPath(), execRunner))
        ? undefined
        : desktopVaultKeyFile(home),
    onState: (run) => {
      tray?.update({ run });
      broadcast(IPC.gatewayRun, run);
    },
  });

  // Stock GNOME has no StatusNotifierWatcher: without a tray the app quits on the last window.
  if (isLinux()) {
    trayAvailable = await statusNotifierAvailable(execRunner);
    guardSafeStorage(safeStorage);
  }
  if (!isLinux() || trayAvailable)
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
        ...(remoteGateway ? {} : { askScreen: () => screenAsk?.trigger() }),
        openApprovals: () => command({ type: "navigate", route: "/agent/approvals" }),
        closeWindow: () => windows?.main()?.close(),
        quitApp: () => app.quit(),
        quitEntirely,
      },
      { taskbarDark: () => (isLinux() ? nativeTheme.shouldUseDarkColors : taskbarDark) },
    );

  // Quick entry: ⌥Space on macOS (⌃⌥Space when another utility owns it; docs/06 §3.21), on
  // Windows Ctrl+Alt+Space (Alt+Space is the system menu), until `quickEntry.shortcut` says
  // otherwise (main/shortcuts.ts).
  const skipShortcuts =
    perfProbe !== undefined ||
    (!app.isPackaged && process.env.PSYCHE_DISABLE_GLOBAL_SHORTCUTS === "1");
  quickEntryShortcut = new QuickEntryShortcut({
    call: (m, p) => requireGateway().call(m, p),
    ...(skipShortcuts ? {} : { shortcuts: globalShortcut }),
    toggle: () => windows?.toggleQuickEntry(),
    warn: (m) => console.warn(`[quick-entry] ${m}`),
    onChange: () => tray?.update({ shortcuts: shownShortcuts() }),
  });
  quickEntryShortcut.apply(undefined);
  // Ask about my screen: ⌥⇧Space (or ⌃⌥⇧Space) on macOS, Ctrl+Alt+Shift+Space on Windows,
  // until the settings say otherwise (spec §2, §6).
  screenAskShortcut = new ScreenAskShortcut({
    call: (m, p) => requireGateway().call(m, p),
    ...(skipShortcuts ? {} : { shortcuts: globalShortcut }),
    trigger: () => {
      if (!integrityBlocked) screenAsk?.trigger();
    },
    setEnabled: (on) => screenAsk?.setEnabled(on && !integrityBlocked, "screen"),
    warn: (m) => console.warn(`[screen-ask] ${m}`),
    disabled: remoteGateway,
  });
  screenAskShortcut.apply(screenAskShortcut.settings);
  tray?.update({ shortcuts: shownShortcuts() });
  if (!remoteGateway) {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        {
          label: "Ask about screen",
          click: () => {
            if (!integrityBlocked) screenAsk?.trigger();
          },
        },
      ]),
    );
  }
  // Windows: the taskbar's jump list stands in for the Dock menu.
  if (windows32 && perfProbe === undefined) {
    app.setUserTasks(jumpListTasks(process.execPath, { leadingArgs, askScreen: !remoteGateway }));
  }

  // The window shows first and comes forward; the Gateway starts behind it (issue #441).
  let shownAt: number | undefined;
  const appWindows = windows;
  const sup = supervisor;
  startShell({
    showMain: () => appWindows.showMain(),
    startHidden: () => appWindows.startHidden(),
    background: process.argv.includes("--background"),
    focusApp: () => app.focus({ steal: true }),
    startGateway: () => sup.ensureRunning().then(() => gateway?.start()),
    openedAtLogin: app.getLoginItemSettings().wasOpenedAtLogin === true,
    onShown: (at) => {
      shownAt = at;
    },
    warn: (m) => console.warn(`[startup] ${m}`),
  });
  const measured = windows.mainContents();
  if (perfProbe !== undefined && measured) {
    watchFirstPaint(measured, perfProbe, () => (perfHold() ? undefined : app.quit()), {
      ...(shownAt === undefined ? {} : { shownAt }),
    });
  }
  openDeepLink(deepLinkFromArgv(process.argv));
  runTaskbarTask(taskFromArgv(process.argv));
  pairLinks.offerArgv(process.argv);
  pairLinks.showPending();
  if (perfProbe === undefined) void startUpdater({ stateFile: join(home, "run", "updater.json") });

  app.on("activate", () => windows?.showMain());
});

/**
 * Windows: the first time the main window closes, one notification says Psyche keeps running in
 * the notification area (where macOS keeps it in the menu bar) and how to quit it.
 */
function sayStillRunningOnce(): void {
  if (quittingEntirely || !firstCloseToTray(join(baseUserData, "closed-to-tray"))) return;
  const title = "Psyche is still running";
  const body =
    "Tasks and automations keep going. Open Psyche from its icon in the notification area; right-click it to quit.";
  if (Notification.isSupported()) {
    const n = new Notification({ title, body, silent: true });
    n.on("click", () => windows?.showMain());
    n.show();
  } else {
    tray?.notify(title, body);
  }
}

/** The global shortcuts registered now, for the tray's menu. */
function shownShortcuts(): { quickEntry: string; askScreen: string } {
  return {
    quickEntry: quickEntryShortcut?.current ?? "",
    askScreen: screenAskShortcut?.current ?? "",
  };
}

/** A jump-list task, run in this copy (first launch or a second instance). */
function runTaskbarTask(task: TaskbarTask | undefined): void {
  if (task === "new-side-chat") command({ type: "newSideChat" });
  else if (task === "ask-screen" && !remoteGateway) screenAsk?.trigger();
}

async function quitEntirely(): Promise<void> {
  quittingEntirely = true;
  await supervisor?.stopEverything().catch(() => undefined);
  app.quit();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (isPairLinkUrl(url)) pairLinks.offer(url);
  else openDeepLink(parseDeepLink(url));
});

// Another launch (the Start menu, a psyche:// link, the jump list on Windows) comes here.
app.on("second-instance", (_e, argv) => {
  const task = taskFromArgv(argv);
  // Ask about my screen opens the panel over whatever is on screen, not the main window.
  if (task !== "ask-screen") windows?.showMain();
  runTaskbarTask(task);
  openDeepLink(deepLinkFromArgv(argv));
  pairLinks.offerArgv(argv);
});

// Closing the window keeps the app (the menu bar on macOS, the notification area on Windows) and
// the Gateway running (feature A7).
app.on("window-all-closed", () => {
  if (quitsOnLastWindowClosed(hostPlatform(), trayAvailable)) app.quit();
});

app.on("will-quit", () => {
  stopHelperForQuit();
  dictation?.dispose();
  screenAskShortcut?.dispose();
  quickEntryShortcut?.dispose();
  hud?.destroy();
  screenAsk?.destroy();
  globalShortcut.unregisterAll();
});

/**
 * Every real quit ends the bundled helper (⌘Q, the menu bar or Dock, "Quit Psyche entirely", an
 * update or restart relaunch, uninstall); closing the last window while the app stays in the menu
 * bar never gets here. The Gateway is not touched: "Quit Psyche" leaves it running, "Quit entirely"
 * boots it out (`quitEntirely`). Runs from both `before-quit` and `will-quit`; the second call finds
 * the launcher latched and the helper gone. A second copy that exits at once (single-instance lock)
 * has no launcher, so it never stops the first copy's helper.
 */
function stopHelperForQuit(): void {
  try {
    const res = helper?.stopForQuit();
    if (res === "killed" || res === "still-running") console.warn(`[helper] quit: ${res}`);
  } catch (err) {
    console.warn(`[helper] could not stop the helper on quit: ${String(err)}`);
  }
}

app.on("before-quit", () => {
  stopHelperForQuit();
  windows?.setQuitting();
  dockPolicy.dispose();
  for (const id of [...terminalOwners.keys()]) closeHostTerminal(id);
  void bridge?.stop();
  browser?.dispose();
  gateway?.stop();
  tray?.destroy();
  if (!quittingEntirely) void supervisor?.onAppQuit();
});

/** PSYCHE_TAB_DISCARD_MS (unpackaged runs only): idle time before a background tab is discarded. */
function tabDiscardOverride(
  packaged: boolean,
  env: NodeJS.ProcessEnv,
): { discardAfterMs?: number; discardCheckMs?: number } {
  const ms = packaged ? Number.NaN : Number(env.PSYCHE_TAB_DISCARD_MS ?? Number.NaN);
  if (!Number.isFinite(ms) || ms <= 0) return {};
  return { discardAfterMs: ms, discardCheckMs: Math.min(ms, 60_000) };
}
