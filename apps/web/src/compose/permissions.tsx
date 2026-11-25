import {
  ComputerUseSection,
  NotificationsSection,
  type PermissionResult,
  type TccPermission,
  type TccState,
} from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { HelperPermissionsState, ShellPlatform } from "../shell/platform.ts";

/**
 * macOS privacy permissions in the composed app (issue #384): onboarding's Allow buttons and
 * Settings → Computer use ask through the desktop's permissions port. The web build has none,
 * so a request answers `unavailable` and the row says so rather than "Skipped".
 */

export function requestPermission(
  platform: ShellPlatform,
  permission: TccPermission,
): Promise<PermissionResult> {
  return platform.permissions
    ? platform.permissions.request(permission)
    : Promise.resolve("unavailable");
}

export function readPermissions(
  platform: ShellPlatform,
): Promise<Partial<Record<TccPermission, PermissionResult>>> {
  return platform.permissions ? platform.permissions.status() : Promise.resolve({});
}

/** Unavailable reads as "not determined" where the kit only knows macOS states. */
const tccOf = (r: PermissionResult): TccState => (r === "unavailable" ? "not_determined" : r);

type HelperKind = "accessibility" | "screenRecording" | "notifications";

/**
 * Why a row may still read "not allowed" after the owner allowed it: macOS dropped the grant
 * (`lost`, usually an update that changed the helper's signature: turn it off and on, then
 * restart the helper) or the running helper has not picked it up yet (`restart`). Lost wins.
 */
export function helperNoticesOf(
  s: HelperPermissionsState,
): Partial<Record<TccPermission, "lost" | "restart">> {
  const out: Partial<Record<TccPermission, "lost" | "restart">> = {};
  for (const k of s.restartToApply ?? []) out[k] = "restart";
  for (const k of s.lost ?? []) out[k] = "lost";
  return out;
}

/**
 * The helper's own grants, when this window may ask for them: the desktop port has the helper
 * calls, and this is not a window onto another Mac's Gateway (the helper there is the Host's).
 */
function helperPortOf(platform: ShellPlatform) {
  const port = platform.permissions;
  if (platform.chrome?.remote !== undefined) return undefined;
  return port?.helperStatus && port.helperRequest ? port : undefined;
}

/** What Psyche Helper was granted, re-read on window focus (the owner returns from Settings). */
function useHelperPermissions(platform: ShellPlatform) {
  const [state, setState] = useState<HelperPermissionsState | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const helperPort = helperPortOf(platform);
  const apply = useCallback((s: HelperPermissionsState) => {
    setOffline(s.helper === "offline");
    setState(s);
  }, []);
  const read = useCallback(() => {
    void helperPort?.helperStatus?.().then(apply, () => setOffline(true));
  }, [helperPort, apply]);
  useEffect(() => {
    if (!helperPort) return;
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [helperPort, read]);
  const request = useCallback(
    (kind: HelperKind) => {
      void helperPort?.helperRequest?.(kind).then(apply, read);
    },
    [helperPort, apply, read],
  );
  return { helperPort, state, offline, read, request };
}

/**
 * Settings → Computer use shows what Psyche Helper itself was granted, not Psyche.app: computer
 * use runs in the helper and macOS keeps each app's grant apart. Re-read on window focus, since
 * the owner comes back from System Settings. A desktop without the helper port (an older shell)
 * falls back to the app's own states, as before.
 */
export function ComputerUseSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const [tcc, setTcc] = useState<Partial<Record<TccPermission, TccState>>>({});
  const helper = useHelperPermissions(platform);
  const { helperPort } = helper;
  const read = useCallback(() => {
    void readPermissions(platform).then(
      (states) =>
        setTcc(
          Object.fromEntries(
            Object.entries(states).map(([k, v]) => [k, tccOf(v as PermissionResult)]),
          ),
        ),
      () => undefined,
    );
  }, [platform]);
  useEffect(() => {
    if (helperPort) return;
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [helperPort, read]);
  const shown = helperPort
    ? helper.state
      ? { accessibility: helper.state.accessibility, screenRecording: helper.state.screenRecording }
      : {}
    : tcc;
  const launch = platform.helper?.launch?.bind(platform.helper);
  const { read: readHelper } = helper;
  const restartHelper = useCallback(() => {
    void launch?.(true).then(readHelper, readHelper);
  }, [launch, readHelper]);
  return (
    <ComputerUseSection
      tcc={shown}
      helperOffline={helperPort ? helper.offline : false}
      helperNotices={helperPort && helper.state ? helperNoticesOf(helper.state) : {}}
      {...(helperPort && launch ? { onRestartHelper: restartHelper } : {})}
      {...(platform.permissions?.openFullDiskAccess
        ? {
            onOpenFullDiskAccess: () => {
              void platform.permissions?.openFullDiskAccess?.().catch(() => undefined);
            },
          }
        : {})}
      {...(platform.permissions
        ? {
            onOpenSystemSettings: (p: TccPermission) => {
              if (helperPort && (p === "accessibility" || p === "screenRecording")) {
                helper.request(p);
                return;
              }
              void requestPermission(platform, p).then(read, () => undefined);
            },
          }
        : {})}
    />
  );
}

/**
 * Settings → Notifications: the quiet-hours section plus, on a desktop, whether Psyche Helper may
 * show notifications. Approval notifications go through the helper, so without its grant they
 * never arrive.
 */
export function NotificationsSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const { helperPort, state, offline, request } = useHelperPermissions(platform);
  return (
    <NotificationsSection
      {...(helperPort && (state || offline)
        ? {
            helperNotifications: {
              state: offline || !state ? ("offline" as const) : state.notifications,
              onAllow: () => request("notifications"),
            },
          }
        : {})}
    />
  );
}
