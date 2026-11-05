import type { BrowserTeachStep } from "@psyche/protocol";

/**
 * IPC channel names shared by main and preload (`psyche:<area>:<verb>`) and the validators main
 * runs on every renderer payload. The renderer is treated as untrusted input: main checks the
 * sender frame, then the payload shape, before acting.
 */
export const IPC = {
  // Gateway connection (main holds the socket and keys).
  getStatus: "psyche:gateway:get-status",
  /** This window's device id (Settings → Devices marks it; onboarding's admin check). */
  getDeviceId: "psyche:gateway:get-device-id",
  status: "psyche:gateway:status",
  call: "psyche:gateway:call",
  event: "psyche:gateway:event",
  resync: "psyche:gateway:resync",
  // The Gateway process the app supervises (LaunchAgent / dev child), for the connection banner.
  gatewayGetRun: "psyche:gateway:get-run",
  gatewayRun: "psyche:gateway:run",
  gatewayShowLogs: "psyche:gateway:show-logs",
  gatewayRetry: "psyche:gateway:retry",
  gatewayRestoredByHand: "psyche:gateway:restored-by-hand",
  // Saved Gateways (remote-gateway design §1.3): the list, add, forget, switch, pair again.
  gatewaysList: "psyche:gateways:list",
  gatewaysAdd: "psyche:gateways:add",
  /** A pasted `psyche-pair:v1` link; main parses it and asks the owner in a native dialog. */
  gatewaysAddLink: "psyche:gateways:add-link",
  /** The link the OS opened, once (main keeps it; the Settings window asks for it). */
  gatewaysPendingLink: "psyche:gateways:pending-link",
  /** A pairing link is waiting: ask `gatewaysPendingLink`. Carries nothing. */
  gatewaysLinkOpened: "psyche:gateways:link-opened",
  gatewaysDiscover: "psyche:gateways:discover",
  gatewaysAddDiscovered: "psyche:gateways:add-discovered",
  gatewaysRename: "psyche:gateways:rename",
  gatewaysRemove: "psyche:gateways:remove",
  gatewaysSwitch: "psyche:gateways:switch",
  gatewaysRepair: "psyche:gateways:repair",
  // Embedded agent browser.
  browserGetState: "psyche:browser:get-state",
  browserState: "psyche:browser:state",
  browserDownload: "psyche:browser:download",
  browserViewport: "psyche:browser:set-viewport",
  browserOpen: "psyche:browser:open",
  browserClose: "psyche:browser:close",
  browserActivate: "psyche:browser:activate",
  browserNavigate: "psyche:browser:navigate",
  browserFind: "psyche:browser:find",
  browserStopFind: "psyche:browser:stop-find",
  browserSetControl: "psyche:browser:set-control",
  browserPopOut: "psyche:browser:pop-out",
  browserClearData: "psyche:browser:clear-data",
  browserPromptAnswer: "psyche:browser:prompt-answer",
  browserSignedInList: "psyche:browser:signed-in-list",
  browserSignedInForget: "psyche:browser:signed-in-forget",
  browserOpenRealChromeProfile: "psyche:browser:open-real-chrome-profile",
  // Teach by showing (owner only): Record, Stop, Cancel and the kept recordings.
  teachStart: "psyche:teach:start",
  teachStop: "psyche:teach:stop",
  teachCancel: "psyche:teach:cancel",
  teachKeep: "psyche:teach:keep",
  teachKept: "psyche:teach:kept",
  teachStorage: "psyche:teach:storage",
  teachOpenKept: "psyche:teach:open-kept",
  teachDeleteKept: "psyche:teach:delete-kept",
  // Teach by showing in a Mac app (phase 2): pick a granted app, Record, Stop, Cancel, status.
  teachAppApps: "psyche:teach:app-apps",
  teachAppStart: "psyche:teach:app-start",
  teachAppStop: "psyche:teach:app-stop",
  teachAppCancel: "psyche:teach:app-cancel",
  teachAppStatus: "psyche:teach:app-status",
  // Windows, notifications, native commands.
  windowPopOut: "psyche:window:pop-out",
  /** Raises a pane's pop-out window; resolves false when it is gone. */
  windowFocusPopOut: "psyche:window:focus-pop-out",
  windowClose: "psyche:window:close",
  windowOpenSettings: "psyche:window:open-settings",
  /** Settings → Connectors "Try it" (#677): fill the main window's composer, without sending. */
  windowPrefillComposer: "psyche:window:prefill-composer",
  /** The Settings window's links to anywhere else (Run setup again): the main window navigates. */
  windowOpenInMain: "psyche:window:open-in-main",
  shellCommand: "psyche:shell:command",
  notifyShow: "psyche:notify:show",
  // A passkey for the remote Gateway, made in a window of its origin (remote windows only).
  passkeyCreate: "psyche:passkey:create",
  passkeyGet: "psyche:passkey:get",
  // The bundled Mac helper's launch and pairing state (onboarding, Settings → Devices).
  helperGetState: "psyche:helper:get-state",
  helperState: "psyche:helper:state",
  helperLaunch: "psyche:helper:launch",
  // "Turn on the sandbox PC" (Windows, Settings → Sandbox PC): state, and the elevated install +
  // guest image download.
  sandboxPcGetState: "psyche:sandbox-pc:get-state",
  sandboxPcRefresh: "psyche:sandbox-pc:refresh",
  sandboxPcTurnOn: "psyche:sandbox-pc:turn-on",
  sandboxPcUpdateService: "psyche:sandbox-pc:update-service",
  sandboxPcCancel: "psyche:sandbox-pc:cancel",
  sandboxPcState: "psyche:sandbox-pc:state",
  // Touch ID from the window (security §3.7, §10): main and Settings windows only.
  touchIdIdentity: "psyche:touchid:identity",
  touchIdRegister: "psyche:touchid:register",
  touchIdApprove: "psyche:touchid:approve",
  // The owner's macOS region format (A12: numbers, dates and times; Settings can override it).
  localeGet: "psyche:locale:get",
  systemAppearanceGet: "psyche:system-appearance:get",
  systemAppearance: "psyche:system-appearance",
  // Open an https page in the default browser: a connector's sign-in (#505). Agent tabs stay
  // in the browser pane; app windows refuse window.open.
  openExternal: "psyche:shell:open-external",
  // Open the original of a cited passage (a mail message in Mail, a granted file in Finder) from
  // a search document id; main asks the Gateway what that may open (lib/source-open.ts).
  sourceOpen: "psyche:source:open",
  // Copy text to the system clipboard (the session refuses navigator.clipboard; #507).
  clipboardWrite: "psyche:clipboard:write",
  // Settings → About: versions, platform and the data folder (#610).
  appInfo: "psyche:app:info",
  appRevealHome: "psyche:app:reveal-home",
  // Settings → About → Uninstall Psyche: what would go, then do it. Main only; never a remote window.
  appUninstallPlan: "psyche:app:uninstall-plan",
  appUninstall: "psyche:app:uninstall",
  // Native dialogs.
  dialogPickFolder: "psyche:dialog:pick-folder",
  // Dictation HUD only (main → HUD state and capture commands, HUD → main audio).
  dictationHudState: "psyche:dictation:hud-state",
  dictationCapture: "psyche:dictation:capture",
  dictationAudio: "psyche:dictation:audio",
  dictationCaptured: "psyche:dictation:captured",
  // Settings → Voice & dictation (any app renderer).
  dictationGetStatus: "psyche:dictation:get-status",
  dictationStatus: "psyche:dictation:status",
  dictationRecheck: "psyche:dictation:recheck",
  dictationCheckHotkey: "psyche:dictation:check-hotkey",
  permissionsStatus: "psyche:permissions:status",
  permissionsRequest: "psyche:permissions:request",
  dictationOpenAccessibility: "psyche:dictation:open-accessibility",
  // Voice conversation (docs/voice/voice-mode-2026.md §4.1, §4.7): main → app renderers. The
  // voice key from the helper's watch, and screen lock / sleep, which end a conversation.
  voiceKey: "psyche:voice:key",
  voiceSystem: "psyche:voice:system",
  // Ask about my screen (docs/design/screen-ask-2026.md): main → panel what to capture; panel →
  // main hide, open the thread, resize, select an area; region overlay → main the dragged box.
  screenAskOpen: "psyche:screen-ask:open",
  screenAskDone: "psyche:screen-ask:done",
  screenAskOpenThread: "psyche:screen-ask:open-thread",
  screenAskResize: "psyche:screen-ask:resize",
  screenAskSelectArea: "psyche:screen-ask:select-area",
  screenAskRegion: "psyche:screen-ask:region",
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export class IpcPayloadError extends Error {
  constructor(channel: string, what: string) {
    super(`invalid ${channel} payload: ${what}`);
    this.name = "IpcPayloadError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(channel: string, v: unknown, name: string, max = 8192): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max)
    throw new IpcPayloadError(channel, `${name} must be a non-empty string ≤ ${max}`);
  return v;
}

export function num(channel: string, v: unknown, name: string, min = 0, max = 100_000): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new IpcPayloadError(channel, `${name} must be a number in [${min}, ${max}]`);
  return v;
}

export function rec(channel: string, v: unknown): Record<string, unknown> {
  if (!isRecord(v)) throw new IpcPayloadError(channel, "expected an object");
  return v;
}

const KEPT_ID = /^teach_[a-z0-9]{8,32}$/;

/** A kept recording's id: the shape the store writes, so a path can never come through. */
export function checkTeachId(channel: string, v: unknown): string {
  const id = str(channel, v, "id", 64);
  if (!KEPT_ID.test(id)) throw new IpcPayloadError(channel, "id is not a recording id");
  return id;
}

/**
 * Keep this recording: an id, a title and the reviewed steps. The store cleans the steps again
 * (`sanitizeTeachSteps`); here only the shape and size are bounded.
 */
export function checkTeachKeep(v: unknown): {
  id: string;
  title: string;
  steps: BrowserTeachStep[];
} {
  const r = rec(IPC.teachKeep, v);
  const steps = r.steps;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 200)
    throw new IpcPayloadError(IPC.teachKeep, "steps must be 1 to 200 steps");
  const kinds = [
    "navigate",
    "click",
    "type",
    "select",
    "press",
    "app_click",
    "app_type",
    "app_menu",
  ];
  for (const x of steps) {
    if (!isRecord(x) || typeof x.id !== "string" || !kinds.includes(String(x.kind)))
      throw new IpcPayloadError(IPC.teachKeep, "not a list of recorded steps");
  }
  return {
    id: checkTeachId(IPC.teachKeep, r.id),
    title: str(IPC.teachKeep, r.title, "title", 120),
    steps: steps as BrowserTeachStep[],
  };
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;

/** The app to record in: a bundle id, nothing else (the Gateway checks the grant list). */
export function checkTeachApp(v: unknown): string {
  const r = rec(IPC.teachAppStart, v);
  const id = str(IPC.teachAppStart, r.bundleId, "bundleId", 200);
  if (!BUNDLE_ID.test(id)) throw new IpcPayloadError(IPC.teachAppStart, "not an app bundle id");
  return id;
}

/** Text the renderer may put on the clipboard: a non-empty string up to 64 KiB. */
export function checkClipboardText(v: unknown): string {
  return str(IPC.clipboardWrite, rec(IPC.clipboardWrite, v).text, "text", 65_536);
}

/**
 * How long after a clipboard write main clears it again if it still holds that text: for secrets
 * (a pairing link). Optional; between one second and five minutes.
 */
export function checkClipboardClearAfter(v: unknown): number | undefined {
  const ms = rec(IPC.clipboardWrite, v).clearAfterMs;
  if (ms === undefined) return undefined;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 1_000 || ms > 300_000) {
    throw new Error("clearAfterMs must be 1000 to 300000");
  }
  return ms;
}

/** Composer text from another window ("Try it", #677): a non-empty string up to 4,000 chars. */
export function checkComposerText(v: unknown): string {
  return str(IPC.windowPrefillComposer, rec(IPC.windowPrefillComposer, v).text, "text", 4_000);
}

/**
 * Pages the renderer may open in the system browser: http, https and mailto only, no userinfo
 * (#505). `file:`, `javascript:` and custom schemes never reach `shell.openExternal`.
 */
export function checkExternalUrl(v: unknown): string {
  const raw = str(IPC.openExternal, rec(IPC.openExternal, v).url, "url");
  if (/^mailto:/i.test(raw.trim())) {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new IpcPayloadError(IPC.openExternal, "url is not valid");
    }
    return u.href;
  }
  return checkHttpUrl(IPC.openExternal, raw);
}

/**
 * What only a client of another computer's Gateway does (remote-gateway design §6.2): a passkey
 * for that Gateway's site. Main refuses these in a window of This Mac's own Gateway.
 */
export const REMOTE_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  IPC.passkeyCreate,
  IPC.passkeyGet,
]);

/** WebAuthn options from the renderer: a JSON object, small, never more. */
export function checkPasskeyOptions(channel: string, v: unknown): Record<string, unknown> {
  const o = rec(channel, v);
  let size: number;
  try {
    size = JSON.stringify(o).length;
  } catch {
    throw new IpcPayloadError(channel, "options are not plain JSON");
  }
  if (size > 16_384) throw new IpcPayloadError(channel, "options are too large");
  return o;
}

/** The key a call retries under (the chat outbox): short, plain characters. */
export function checkIdempotencyKey(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const s = str(IPC.call, v, "idempotencyKey", 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(s))
    throw new IpcPayloadError(IPC.call, "idempotencyKey has odd characters");
  return s;
}

/** Methods the renderer may call through main: any protocol method except the handshake. */
export function checkCallable(method: unknown, isMethodName: (m: unknown) => boolean): string {
  if (typeof method !== "string" || !isMethodName(method))
    throw new IpcPayloadError(IPC.call, "unknown method");
  // dictation.* types into other apps as the owner: only main calls it, after a key it watched.
  if (
    method === "connect" ||
    method === "connect.verify" ||
    method.startsWith("node.") ||
    method.startsWith("dictation.") ||
    // Recording in a Mac app starts from main's own channels (`teachApp*`), on the owner's click.
    method.startsWith("teach.app.") ||
    // Where a source opens (a Message-ID, a host path) is resolved for main only (`sourceOpen`).
    method === "search.openSource" ||
    // The first-admin bootstrap runs from main only (approved design, condition 2).
    method === "devices.bootstrapAdmin" ||
    // Touch ID from the window and its key go through their own channels, which only the main
    // and Settings windows reach and which add the bundled helper's identity (security §10).
    method === "approvals.approveWithTouchId" ||
    method === "devices.presenceKey.register"
  )
    throw new IpcPayloadError(IPC.call, `${method} is not callable from the renderer`);
  return method;
}

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function checkViewport(v: unknown): ViewportRect | null {
  if (v === null) return null;
  const r = rec(IPC.browserViewport, v);
  return {
    x: Math.round(num(IPC.browserViewport, r.x, "x")),
    y: Math.round(num(IPC.browserViewport, r.y, "y")),
    width: Math.round(num(IPC.browserViewport, r.width, "width")),
    height: Math.round(num(IPC.browserViewport, r.height, "height")),
  };
}

/** Only http(s) URLs may be opened in agent tabs (architecture §8). */
export function checkHttpUrl(channel: string, v: unknown): string {
  const s = str(channel, v, "url");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new IpcPayloadError(channel, "url must be absolute");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new IpcPayloadError(channel, "only http and https URLs");
  if (url.username || url.password) throw new IpcPayloadError(channel, "no userinfo in URLs");
  return url.toString();
}

/** Routes the shell may open in a pop-out window (docs/06 §2.7); never a URL. */
export function checkRoute(channel: string, v: unknown): string {
  const s = str(channel, v, "route", 512);
  // One leading slash only: "//host/x" would resolve to another origin in new URL(route, base).
  if (!/^\/[A-Za-z0-9_\-.:][A-Za-z0-9/_\-.:]*$/.test(s) && s !== "/")
    throw new IpcPayloadError(channel, "route must be an app path");
  if (s.includes("..") || s.includes("//"))
    throw new IpcPayloadError(channel, "route must be an app path");
  return s;
}

/** A notification's route: an app path with the plain `?message=` / `?approval=` / `?tab=` query. */
export function checkNotifyRoute(channel: string, v: unknown): string {
  const s = str(channel, v, "route", 512);
  const at = s.indexOf("?");
  checkRoute(channel, at === -1 ? s : s.slice(0, at));
  if (at !== -1 && !/^\?[A-Za-z0-9_\-.:=&%]*$/.test(s.slice(at)))
    throw new IpcPayloadError(channel, "route must be an app path");
  return s;
}

/**
 * A route the Settings window asks the main window to open: an app path (as `checkRoute`), with
 * an optional `?query` or `#hash` of plain characters. Never a URL.
 */
export function checkMainRoute(v: unknown): string {
  const s = str(IPC.windowOpenInMain, rec(IPC.windowOpenInMain, v).route, "route", 512);
  const at = s.search(/[?#]/);
  const path = at === -1 ? s : s.slice(0, at);
  const rest = at === -1 ? "" : s.slice(at);
  checkRoute(IPC.windowOpenInMain, path);
  if (!/^(?:[?#][A-Za-z0-9_\-.:=&%,/]*)*$/.test(rest))
    throw new IpcPayloadError(IPC.windowOpenInMain, "route must be an app path");
  return s;
}

/** Largest audio chunk the HUD may send: 100 ms of 16 kHz s16le is 4.3 kB as base64. */
export const DICTATION_AUDIO_MAX = 64_000;

/** A HUD audio chunk: base64 PCM, nothing else. */
export function checkAudioChunk(v: unknown): string {
  const s = str(IPC.dictationAudio, v, "chunk", DICTATION_AUDIO_MAX);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    throw new IpcPayloadError(IPC.dictationAudio, "not base64");
  return s;
}

/**
 * What a client of another computer's Gateway never does here (remote-gateway design §4.2): each
 * one reaches this Mac's own shell, folders, helper, screen, microphone or apps on a Gateway's
 * say-so, or for a Host's data. The remote window leaves the controls out; main refuses the
 * calls as well, whatever the window sends. (There is no local terminal channel at all: the
 * terminal pane is a session on the Host over the Gateway connection, so main never starts a
 * process from what a Gateway answers.)
 */
export const REMOTE_REFUSED_CHANNELS: ReadonlySet<string> = new Set([
  IPC.browserOpenRealChromeProfile,
  IPC.teachStart,
  IPC.teachStop,
  IPC.teachCancel,
  IPC.teachKeep,
  IPC.teachKept,
  IPC.teachStorage,
  IPC.teachOpenKept,
  IPC.teachDeleteKept,
  IPC.teachAppApps,
  IPC.teachAppStart,
  IPC.teachAppStop,
  IPC.teachAppCancel,
  IPC.teachAppStatus,
  IPC.dialogPickFolder,
  IPC.permissionsRequest,
  IPC.helperLaunch,
  // The sandbox PC is this computer's: a client of another Gateway never turns it on.
  IPC.sandboxPcGetState,
  IPC.sandboxPcRefresh,
  IPC.sandboxPcTurnOn,
  IPC.sandboxPcUpdateService,
  IPC.sandboxPcCancel,
  IPC.touchIdIdentity,
  IPC.touchIdRegister,
  IPC.touchIdApprove,
  IPC.dictationRecheck,
  IPC.dictationCheckHotkey,
  IPC.sourceOpen,
  IPC.appUninstallPlan,
  IPC.appUninstall,
]);

/** The uninstall sheet's request: whether to delete the data, the typed word, a presence card. */
export function checkUninstall(
  channel: string,
  v: unknown,
): { deleteData: boolean; removeKeychain?: boolean; confirm?: string; approvalId?: string } {
  const r = rec(channel, v);
  if (typeof r.deleteData !== "boolean")
    throw new IpcPayloadError(channel, "deleteData must be a boolean");
  const out: {
    deleteData: boolean;
    removeKeychain?: boolean;
    confirm?: string;
    approvalId?: string;
  } = { deleteData: r.deleteData };
  if (r.removeKeychain !== undefined) {
    if (typeof r.removeKeychain !== "boolean")
      throw new IpcPayloadError(channel, "removeKeychain must be a boolean");
    out.removeKeychain = r.removeKeychain;
  }
  if (r.confirm !== undefined) out.confirm = str(channel, r.confirm, "confirm", 32);
  if (r.approvalId !== undefined) out.approvalId = str(channel, r.approvalId, "approvalId", 128);
  return out;
}
