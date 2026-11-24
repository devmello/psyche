import {
  ComputerUseSection,
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

type HelperKind = "accessibility" | "screenRecording";

/**
 * Settings → Computer use shows what Psyche Helper itself was granted, not Psyche.app: computer
 * use runs in the helper and macOS keeps each app's grant apart. Re-read on window focus, since
 * the owner comes back from System Settings. A desktop without the helper port (an older shell)
 * falls back to the app's own states, as before.
 */
export function ComputerUseSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const [tcc, setTcc] = useState<Partial<Record<TccPermission, TccState>>>({});
  const [helperOffline, setHelperOffline] = useState(false);
  const port = platform.permissions;
  const helperPort = port?.helperStatus && port.helperRequest ? port : undefined;
  const apply = useCallback((s: HelperPermissionsState) => {
    setHelperOffline(s.helper === "offline");
    setTcc({ accessibility: s.accessibility, screenRecording: s.screenRecording });
  }, []);
  const read = useCallback(() => {
    if (helperPort?.helperStatus) {
      void helperPort.helperStatus().then(apply, () => setHelperOffline(true));
      return;
    }
    void readPermissions(platform).then(
      (states) =>
        setTcc(
          Object.fromEntries(
            Object.entries(states).map(([k, v]) => [k, tccOf(v as PermissionResult)]),
          ),
        ),
      () => undefined,
    );
  }, [platform, helperPort, apply]);
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  return (
    <ComputerUseSection
      tcc={tcc}
      helperOffline={helperOffline}
      {...(platform.permissions
        ? {
            onOpenSystemSettings: (p: TccPermission) => {
              if (helperPort?.helperRequest && (p === "accessibility" || p === "screenRecording")) {
                void helperPort.helperRequest(p as HelperKind).then(apply, read);
                return;
              }
              void requestPermission(platform, p).then(read, () => undefined);
            },
          }
        : {})}
    />
  );
}
