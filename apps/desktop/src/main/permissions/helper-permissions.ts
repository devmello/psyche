/**
 * The Mac helper's own Accessibility and Screen Recording grants, for Settings → Computer use.
 *
 * macOS keeps these per app identity. Computer use runs in "Psyche Helper" (apps/mac-helper), so
 * the owner enabling "Psyche" in System Settings changes nothing for it: the row has to show what
 * the helper itself reports (`permissions.status`, preflight APIs only, never prompts) and ask
 * through the helper (`permissions.request`), then open the pane where "Psyche Helper" is listed.
 * Psyche.app's own grants (Ask about screen) stay with `createPermissions`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type HelperPermissionKind = "accessibility" | "screenRecording" | "notifications";
export type HelperPermissionState = "granted" | "denied" | "not_determined";

export interface HelperPermissionsStatus {
  /** `offline` when the helper is not connected: nothing below is known then. */
  helper: "online" | "offline";
  accessibility: HelperPermissionState;
  screenRecording: HelperPermissionState;
  /** Approval notifications through the helper (`notify.*`); not asked is the usual first state. */
  notifications: HelperPermissionState;
  /**
   * Granted to this helper before, not granted now, and not turned off on purpose (`denied`).
   * On the free signing path the usual cause is an update: macOS ties a grant to the helper's
   * code signature, keeps the switch on in System Settings, and still answers "not allowed".
   * Present only when non-empty.
   */
  lost?: HelperPermissionKind[];
  /**
   * Asked for in the running helper and still not granted: macOS applies a new Screen Recording
   * grant to a process only once it restarts, so the row offers "Restart Psyche Helper".
   * Present only when non-empty.
   */
  restartToApply?: HelperPermissionKind[];
}

export const HELPER_PERMISSION_KINDS: readonly HelperPermissionKind[] = [
  "accessibility",
  "screenRecording",
  "notifications",
];

/** The kinds seen granted, kept by the desktop (never under `~/.psyche`, never by the helper). */
export interface GrantMemory {
  load(): HelperPermissionKind[];
  save(kinds: HelperPermissionKind[]): void;
}

export interface HelperPermissionsDeps {
  /** Invokes a capability on this computer's helper; rejects when it is not online. */
  invoke(capability: string, params: unknown): Promise<unknown>;
  /** Which kinds this helper was ever seen granted (survives app restarts and updates). */
  memory?: GrantMemory;
}

const isKind = (k: unknown): k is HelperPermissionKind =>
  typeof k === "string" && (HELPER_PERMISSION_KINDS as readonly string[]).includes(k);

/** A JSON file in the app's user data; a missing or unreadable file remembers nothing. */
export function fileGrantMemory(path: () => string): GrantMemory {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(path(), "utf8")) as { granted?: unknown };
        return Array.isArray(raw.granted) ? raw.granted.filter(isKind) : [];
      } catch {
        return [];
      }
    },
    save(kinds) {
      try {
        const file = path();
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ granted: kinds })}\n`, { mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // Best effort: without it only the "lost after an update" hint is missing.
      }
    },
  };
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

type Snapshot = Omit<HelperPermissionsStatus, "lost" | "restartToApply">;

export function createHelperPermissions(deps: HelperPermissionsDeps) {
  /** Kinds asked for in the running helper process; cleared once granted or the helper restarts. */
  const askedThisRun = new Set<HelperPermissionKind>();

  /**
   * Remembers what is granted now and answers what was granted before but reads "not asked" now.
   * `denied` (the owner turned it off) is not a loss. A kind stays remembered until granted
   * again, so the hint shows on every read until the owner fixes it.
   */
  function lostSince(now: Snapshot): HelperPermissionKind[] {
    if (!deps.memory) return [];
    const before = deps.memory.load();
    const union = HELPER_PERMISSION_KINDS.filter((k) => before.includes(k) || now[k] === "granted");
    if (union.length !== before.length) deps.memory.save(union);
    return HELPER_PERMISSION_KINDS.filter((k) => before.includes(k) && now[k] === "not_determined");
  }

  async function status(): Promise<HelperPermissionsStatus> {
    let now: Snapshot;
    try {
      const result = await deps.invoke("permissions.status", {});
      const notifications = await deps
        .invoke("notify.authorization_status", {})
        .then(notificationState, () => "not_determined" as const);
      now = {
        helper: "online",
        accessibility: stateOf(result, "accessibility"),
        screenRecording: stateOf(result, "screenRecording"),
        notifications,
      };
    } catch {
      return { ...OFFLINE };
    }
    for (const k of [...askedThisRun]) if (now[k] === "granted") askedThisRun.delete(k);
    const lost = lostSince(now);
    const restartToApply = [...askedThisRun];
    return {
      ...now,
      ...(lost.length > 0 ? { lost } : {}),
      ...(restartToApply.length > 0 ? { restartToApply } : {}),
    };
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
    // Only Screen Recording waits for a restart: Accessibility is read live (`AXIsProcessTrusted`).
    if (kind === "screenRecording") askedThisRun.add(kind);
    const after = await status();
    if (after.helper === "online" && after[kind] !== "granted") {
      await deps.invoke("permissions.open_settings", { permission: kind }).catch(() => undefined);
    }
    return after;
  }

  /** The helper process was (re)started: a new process reads every grant afresh. */
  function helperRestarted(): void {
    askedThisRun.clear();
  }

  return { status, request, helperRestarted };
}
