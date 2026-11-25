/**
 * The Mac helper's own Accessibility and Screen Recording grants, for Settings → Computer use.
 *
 * macOS keeps these per app identity. Computer use runs in "Psyche Helper" (apps/mac-helper), so
 * the owner enabling "Psyche" in System Settings changes nothing for it: the row has to show what
 * the helper itself reports (`permissions.status`, preflight APIs only, never prompts) and ask
 * through the helper (`permissions.request`), then open the pane where "Psyche Helper" is listed.
 * Psyche.app's own grants (Ask about screen) stay with `createPermissions`.
 */

export type HelperPermissionKind = "accessibility" | "screenRecording" | "notifications";
export type HelperPermissionState = "granted" | "denied" | "not_determined";

export interface HelperPermissionsStatus {
  /** `offline` when the helper is not connected: nothing below is known then. */
  helper: "online" | "offline";
  accessibility: HelperPermissionState;
  screenRecording: HelperPermissionState;
  /** Approval notifications through the helper (`notify.*`); not asked is the usual first state. */
  notifications: HelperPermissionState;
}

export const HELPER_PERMISSION_KINDS: readonly HelperPermissionKind[] = [
  "accessibility",
  "screenRecording",
  "notifications",
];

export interface HelperPermissionsDeps {
  /** Invokes a capability on this computer's helper; rejects when it is not online. */
  invoke(capability: string, params: unknown): Promise<unknown>;
}

const OFFLINE: HelperPermissionsStatus = {
  helper: "offline",
  accessibility: "not_determined",
  screenRecording: "not_determined",
  notifications: "not_determined",
};

/** `notify.authorization_status`: authorized and provisional both deliver. */
function notificationState(result: unknown): HelperPermissionState {
  const r = (result ?? {}) as Record<string, unknown>;
  const s = String(r.authorization ?? r.status ?? r.authorizationStatus ?? "");
  if (s === "authorized" || s === "provisional" || s === "ephemeral") return "granted";
  return s === "denied" ? "denied" : "not_determined";
}

/** Reads one permission's row out of `permissions.status`; anything but `granted` is not granted. */
function stateOf(result: unknown, kind: HelperPermissionKind): HelperPermissionState {
  const rows = (result as { permissions?: unknown } | null)?.permissions;
  if (!Array.isArray(rows)) return "not_determined";
  const row = rows.find((r) => (r as { permission?: unknown } | null)?.permission === kind) as
    | { status?: unknown }
    | undefined;
  if (row?.status === "granted") return "granted";
  return row?.status === "denied" ? "denied" : "not_determined";
}

export function createHelperPermissions(deps: HelperPermissionsDeps) {
  async function status(): Promise<HelperPermissionsStatus> {
    try {
      const result = await deps.invoke("permissions.status", {});
      const notifications = await deps
        .invoke("notify.authorization_status", {})
        .then(notificationState, () => "not_determined" as const);
      return {
        helper: "online",
        accessibility: stateOf(result, "accessibility"),
        screenRecording: stateOf(result, "screenRecording"),
        notifications,
      };
    } catch {
      return { ...OFFLINE };
    }
  }

  /**
   * The helper's own request (the system prompt naming "Psyche Helper"), then its pane in System
   * Settings when it is still not granted, because a prompt that was dismissed once does not come
   * back. Answers the state read afterwards; an offline helper answers `offline` and prompts
   * nothing.
   */
  async function request(kind: HelperPermissionKind): Promise<HelperPermissionsStatus> {
    if ((await status()).helper === "offline") return { ...OFFLINE };
    // Notifications ask through `notify.*` (the explicit prompt, not the provisional one that
    // delivers quietly); the other two through `permissions.request`.
    await (kind === "notifications"
      ? deps.invoke("notify.request_authorization", { provisional: false })
      : deps.invoke("permissions.request", {
          permission: kind,
          // The owner's click on Allow is the request the helper wants for Screen Recording.
          ...(kind === "screenRecording" ? { purpose: "vision_fallback" } : {}),
        })
    ).catch(() => undefined);
    const after = await status();
    if (after.helper === "online" && after[kind] !== "granted") {
      await deps.invoke("permissions.open_settings", { permission: kind }).catch(() => undefined);
    }
    return after;
  }

  return { status, request };
}
