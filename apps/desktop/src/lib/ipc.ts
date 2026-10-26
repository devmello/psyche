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
  browserOpenRealChromeProfile: "psyche:browser:open-real-chrome-profile",
  // Terminal.
  terminalOpen: "psyche:terminal:open",
  terminalWrite: "psyche:terminal:write",
  terminalResize: "psyche:terminal:resize",
  terminalClose: "psyche:terminal:close",
  terminalData: "psyche:terminal:data",
  terminalExit: "psyche:terminal:exit",
  // Windows, notifications, native commands.
  windowPopOut: "psyche:window:pop-out",
  windowClose: "psyche:window:close",
  windowOpenSettings: "psyche:window:open-settings",
  /** Settings → Connectors "Try it" (#677): fill the main window's composer, without sending. */
  windowPrefillComposer: "psyche:window:prefill-composer",
  shellCommand: "psyche:shell:command",
  notifyShow: "psyche:notify:show",
  // The bundled Mac helper's launch and pairing state (onboarding, Settings → Devices).
  helperGetState: "psyche:helper:get-state",
  helperState: "psyche:helper:state",
  // The owner's macOS region format (A12: numbers, dates and times; Settings can override it).
  localeGet: "psyche:locale:get",
  systemAppearanceGet: "psyche:system-appearance:get",
  systemAppearance: "psyche:system-appearance",
  // Open an https page in the default browser: a connector's sign-in (#505). Agent tabs stay
  // in the browser pane; app windows refuse window.open.
  openExternal: "psyche:shell:open-external",
  // Copy text to the system clipboard (the session refuses navigator.clipboard; #507).
  clipboardWrite: "psyche:clipboard:write",
  // Settings → About: versions, platform and the data folder (#610).
  appInfo: "psyche:app:info",
  appRevealHome: "psyche:app:reveal-home",
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
  // Whether a screen reader (VoiceOver) is running, so the reply ducks while it speaks (§4.10).
  voiceScreenReader: "psyche:voice:screen-reader",
  // Voice HUD only (HUD → main): the conversation ended, or open its thread in Psyche.
  voiceHudDone: "psyche:voice-hud:done",
  voiceHudOpenThread: "psyche:voice-hud:open-thread",
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

/** Text the renderer may put on the clipboard: a non-empty string up to 64 KiB. */
export function checkClipboardText(v: unknown): string {
  return str(IPC.clipboardWrite, rec(IPC.clipboardWrite, v).text, "text", 65_536);
}

/** Composer text from another window ("Try it", #677): a non-empty string up to 4,000 chars. */
export function checkComposerText(v: unknown): string {
  return str(IPC.windowPrefillComposer, rec(IPC.windowPrefillComposer, v).text, "text", 4_000);
}

/** Pages the renderer may open in the system browser: https only, no userinfo (#505). */
export function checkExternalUrl(v: unknown): string {
  const url = checkHttpUrl(
    IPC.openExternal,
    str(IPC.openExternal, rec(IPC.openExternal, v).url, "url"),
  );
  if (!url.startsWith("https://")) throw new IpcPayloadError(IPC.openExternal, "url must be https");
  return url;
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
    // The first-admin bootstrap runs from main only (approved design, condition 2).
    method === "devices.bootstrapAdmin"
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

/** Largest audio chunk the HUD may send: 100 ms of 16 kHz s16le is 4.3 kB as base64. */
export const DICTATION_AUDIO_MAX = 64_000;

/** A HUD audio chunk: base64 PCM, nothing else. */
export function checkAudioChunk(v: unknown): string {
  const s = str(IPC.dictationAudio, v, "chunk", DICTATION_AUDIO_MAX);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s))
    throw new IpcPayloadError(IPC.dictationAudio, "not base64");
  return s;
}
