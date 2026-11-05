/**
 * Privacy permissions for onboarding and Settings (issue #384; UI design §3.18, §3.19).
 * `request` shows the system prompt where the OS has one and opens the right settings page
 * when the owner has to flip the switch there; `status` reads the current state without
 * prompting, so the renderer can re-read it when the owner comes back from the settings.
 * Electron's APIs come in narrowed, so tests pass fakes.
 */

export type PermissionKind = "accessibility" | "screenRecording" | "notifications" | "microphone";
export type PermissionResult = "granted" | "denied" | "not_determined" | "unavailable";

export const PERMISSION_KINDS: readonly PermissionKind[] = [
  "accessibility",
  "screenRecording",
  "notifications",
  "microphone",
];

export const PRIVACY_PANE: Record<"accessibility" | "screenRecording" | "microphone", string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
};

/** Settings → Privacy & security → Microphone ("Let desktop apps access your microphone"). */
export const WINDOWS_MICROPHONE_SETTINGS = "ms-settings:privacy-microphone";

export interface PermissionDeps {
  platform: NodeJS.Platform;
  systemPreferences: {
    isTrustedAccessibilityClient(prompt: boolean): boolean;
    getMediaAccessStatus(mediaType: "screen" | "microphone"): string;
    /** macOS: the microphone prompt (resolves true when allowed). */
    askForMediaAccess?(mediaType: "microphone"): Promise<boolean>;
  };
  /** A one-off capture request is what makes macOS show the Screen Recording prompt. */
  desktopCapturer: {
    getSources(options: {
      types: ["screen"];
      thumbnailSize: { width: number; height: number };
    }): Promise<unknown>;
  };
  openExternal: (url: string) => Promise<void> | void;
  /** This computer's helper's notification capabilities, when it is online. */
  helper?: {
    notificationStatus(): Promise<PermissionResult>;
    requestNotifications(): Promise<PermissionResult>;
  };
  /** Shows a first notification (Electron), which prompts on macOS; false when unsupported. */
  showFirstNotification?: () => boolean;
}

function mediaStatus(deps: PermissionDeps, kind: "screen" | "microphone"): PermissionResult {
  const s = deps.systemPreferences.getMediaAccessStatus(kind);
  if (s === "granted") return "granted";
  if (s === "not-determined") return "not_determined";
  return "denied";
}

const screenStatus = (deps: PermissionDeps) => mediaStatus(deps, "screen");

/**
 * Windows asks no grant for UI Automation, input or screen capture by a desktop app (the helper
 * still cannot reach elevated windows, UIPI), so those answer granted; Electron reads the screen
 * state from Windows' privacy settings. The microphone is Windows' privacy toggle, which only the
 * owner flips, in Settings. Notifications are the helper's toasts when it is online, else
 * Electron's (Windows asks nothing first; the owner turns them off in Settings → System →
 * Notifications).
 */
function windowsPermissions(deps: PermissionDeps) {
  async function status(kind: PermissionKind): Promise<PermissionResult> {
    switch (kind) {
      case "accessibility":
        return "granted";
      case "screenRecording": {
        const s = screenStatus(deps);
        return s === "not_determined" ? "granted" : s;
      }
      case "microphone": {
        // Windows has no "not asked yet": the toggle is on (the default) or off.
        const s = mediaStatus(deps, "microphone");
        return s === "not_determined" ? "granted" : s;
      }
      case "notifications":
        if (deps.helper)
          return deps.helper.notificationStatus().catch(() => "unavailable" as const);
        return deps.showFirstNotification ? "granted" : "unavailable";
    }
  }
  async function request(kind: PermissionKind): Promise<PermissionResult> {
    if (kind === "microphone") {
      const now = await status(kind);
      if (now !== "granted") await deps.openExternal(WINDOWS_MICROPHONE_SETTINGS);
      return now;
    }
    if (kind !== "notifications") return status(kind);
    if (deps.helper) {
      const r = await deps.helper.requestNotifications().catch(() => null);
      if (r !== null) return r;
    }
    return deps.showFirstNotification?.() ? "granted" : "unavailable";
  }
  return { status, request };
}

export function createPermissions(deps: PermissionDeps) {
  const mac = deps.platform === "darwin";
  const windows = deps.platform === "win32" ? windowsPermissions(deps) : undefined;

  async function status(kind: PermissionKind): Promise<PermissionResult> {
    if (windows) return windows.status(kind);
    if (!mac) return "unavailable";
    switch (kind) {
      case "accessibility":
        return deps.systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
      case "screenRecording":
        return screenStatus(deps);
      case "microphone":
        return mediaStatus(deps, "microphone");
      case "notifications":
        if (deps.helper)
          return deps.helper.notificationStatus().catch(() => "unavailable" as const);
        return deps.showFirstNotification ? "not_determined" : "unavailable";
    }
  }

  async function request(kind: PermissionKind): Promise<PermissionResult> {
    if (windows) return windows.request(kind);
    if (!mac) return "unavailable";
    switch (kind) {
      case "accessibility": {
        // `true` shows the "would like to control this computer" prompt the first time.
        if (deps.systemPreferences.isTrustedAccessibilityClient(true)) return "granted";
        await deps.openExternal(PRIVACY_PANE.accessibility);
        return "denied";
      }
      case "screenRecording": {
        if (screenStatus(deps) === "granted") return "granted";
        await deps.desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => undefined);
        const after = screenStatus(deps);
        if (after !== "granted") await deps.openExternal(PRIVACY_PANE.screenRecording);
        return after === "granted" ? "granted" : "denied";
      }
      case "microphone": {
        const now = mediaStatus(deps, "microphone");
        if (now === "granted") return "granted";
        // The prompt shows only the first time; after a "no" the switch is in System Settings.
        if (now === "not_determined" && deps.systemPreferences.askForMediaAccess) {
          return (await deps.systemPreferences.askForMediaAccess("microphone").catch(() => false))
            ? "granted"
            : "denied";
        }
        await deps.openExternal(PRIVACY_PANE.microphone);
        return "denied";
      }
      case "notifications": {
        if (deps.helper) {
          const r = await deps.helper.requestNotifications().catch(() => null);
          if (r !== null) return r;
        }
        if (deps.showFirstNotification?.()) return "granted";
        return "unavailable";
      }
    }
  }

  async function statusAll(): Promise<Record<PermissionKind, PermissionResult>> {
    const out = {} as Record<PermissionKind, PermissionResult>;
    for (const k of PERMISSION_KINDS) out[k] = await status(k);
    return out;
  }

  return { status, request, statusAll };
}

export type Permissions = ReturnType<typeof createPermissions>;

/** Reads `nodes.invoke` results from the helper's `notify.*` capabilities. */
export function notificationStateOf(result: unknown): PermissionResult {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r.granted === true) return "granted";
  if (r.granted === false) return "denied";
  const s = String(r.status ?? r.authorization ?? r.authorizationStatus ?? "");
  if (s === "authorized" || s === "provisional" || s === "ephemeral") return "granted";
  if (s === "denied") return "denied";
  if (s === "notDetermined") return "not_determined";
  return "unavailable";
}
