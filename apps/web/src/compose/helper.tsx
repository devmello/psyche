import {
  DevicesSection,
  type MacHelperStatus,
  MacHelperStatusRow,
  t,
  type UiSlots,
} from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";

/**
 * The bundled Mac helper the desktop launches (apps/desktop/src/main/helper-launcher.ts). The web
 * host has no `helper` port, so this stays undefined there and nothing is shown.
 */
export function useMacHelper(platform: ShellPlatform): MacHelperStatus | undefined {
  const [state, setState] = useState<MacHelperStatus>();
  useEffect(() => {
    const port = platform.helper;
    if (!port) return;
    let live = true;
    void port.getState().then(
      (s) => live && setState(s),
      () => undefined,
    );
    const off = port.onState(setState);
    return () => {
      live = false;
      off();
    };
  }, [platform]);
  return state;
}

/** This window's device id, so Devices marks "this device" and offers no Revoke for it. */
export function useThisDeviceId(platform: ShellPlatform): string | undefined {
  const [deviceId, setDeviceId] = useState<string>();
  useEffect(() => {
    void platform.gateway.deviceId?.().then(
      (id) => setDeviceId(id),
      () => undefined,
    );
  }, [platform]);
  return deviceId;
}

/** Settings → Devices on the desktop: the helper's launch state above the Gateway's nodes. */
export function DesktopDevicesSettings({ platform }: { platform: ShellPlatform }): ReactElement {
  const helper = useMacHelper(platform);
  const deviceId = useThisDeviceId(platform);
  return (
    <div className="flex flex-col gap-4">
      {helper ? <MacHelperStatusRow state={helper} /> : null}
      <DevicesSection
        {...(deviceId === undefined ? {} : { thisDeviceId: deviceId })}
        {...(platform.helper?.touchId ? { touchId: platform.helper.touchId } : {})}
      />
    </div>
  );
}

type TouchIdFix = Parameters<NonNullable<UiSlots["touchIdFix"]>>[0];

/**
 * An approval card's fix when Touch ID cannot confirm it from the window: start the bundled
 * helper (main's launcher, waiting for it to pair), or open Settings → Devices, where the owner
 * checks the key id and registers the key. Neither approves anything.
 */
export async function fixTouchId(platform: ShellPlatform, fix: TouchIdFix): Promise<void> {
  if (fix === "start_helper" || fix === "restart_helper") {
    const state = await platform.helper?.launch?.(fix === "restart_helper");
    if (state?.kind !== "paired") throw new Error(t("web.touchId.helperDidNotStart"));
    return;
  }
  platform.windows?.openSettings?.("devices");
}
