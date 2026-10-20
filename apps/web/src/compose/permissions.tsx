import {
  ComputerUseSection,
  type PermissionResult,
  type TccPermission,
  type TccState,
} from "@psyche/ui";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";

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

/** Settings → Computer use with the real permission states, re-read on window focus. */
export function ComputerUseSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const [tcc, setTcc] = useState<Partial<Record<TccPermission, TccState>>>({});
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
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  return (
    <ComputerUseSection
      tcc={tcc}
      {...(platform.permissions
        ? {
            onOpenSystemSettings: (p: TccPermission) => {
              void requestPermission(platform, p).then(read, () => undefined);
            },
          }
        : {})}
    />
  );
}
