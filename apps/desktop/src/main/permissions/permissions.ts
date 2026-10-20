/**
 * macOS privacy permissions for onboarding and Settings (issue #384; UI design §3.18, §3.19).
 * `request` shows the system prompt where macOS has one and opens the right System Settings
 * pane when the owner has to flip the switch there; `status` reads the current state without
 * prompting, so the renderer can re-read it when the owner comes back from System Settings.
 * Electron's APIs come in narrowed, so tests pass fakes.
 */

export type PermissionKind = "accessibility" | "screenRecording" | "notifications";
export type PermissionResult = "granted" | "denied" | "not_determined" | "unavailable";

export const PERMISSION_KINDS: readonly PermissionKind[] = [
  "accessibility",
  "screenRecording",
  "notifications",
];

export const PRIVACY_PANE: Record<"accessibility" | "screenRecording", string> = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

export interface PermissionDeps {
  platform: NodeJS.Platform;
  systemPreferences: {
    isTrustedAccessibilityClient(prompt: boolean): boolean;
    getMediaAccessStatus(mediaType: "screen"): string;
  };
  /** A one-off capture request is what makes macOS show the Screen Recording prompt. */
  desktopCapturer: {
    getSources(options: {
      types: ["screen"];
      thumbnailSize: { width: number; height: number };
    }): Promise<unknown>;
  };
  openExternal: (url: string) => Promise<void> | void;
  /** The paired Mac helper's notification capabilities, when it is online. */
  helper?: {
    notificationStatus(): Promise<PermissionResult>;
    requestNotifications(): Promise<PermissionResult>;
  };
  /** Shows a first notification (Electron), which prompts on macOS; false when unsupported. */
  showFirstNotification?: () => boolean;
}

function screenStatus(deps: PermissionDeps): PermissionResult {
  const s = deps.systemPreferences.getMediaAccessStatus("screen");
  if (s === "granted") return "granted";
  if (s === "not-determined") return "not_determined";
  return "denied";
}

export function createPermissions(deps: PermissionDeps) {
  const mac = deps.platform === "darwin";

  async function status(kind: PermissionKind): Promise<PermissionResult> {
    if (!mac) return "unavailable";
    switch (kind) {
      case "accessibility":
        return deps.systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied";
      case "screenRecording":
        return screenStatus(deps);
      case "notifications":
        if (deps.helper)
          return deps.helper.notificationStatus().catch(() => "unavailable" as const);
        return deps.showFirstNotification ? "not_determined" : "unavailable";
    }
  }

  async function request(kind: PermissionKind): Promise<PermissionResult> {
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
