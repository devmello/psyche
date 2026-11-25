import { type PointsPort, PointsProvider, usePoints } from "@psyche/ui";
import { type ReactElement, type ReactNode, useEffect } from "react";
import type { ShellPlatform } from "../shell/platform.ts";

/**
 * Psyche points in the composed app (docs/design/psyche-points-2026.md §6): the start sheet's
 * helper permission calls come from the same desktop port as Settings → Computer use, so a
 * window that may not ask for them (the web build, a window onto another Mac's Gateway) has no
 * port and shows none of Points. The Gateway refuses `points.*` to anything but the Host's own
 * desktop shell as well; this only keeps the entry points from being offered.
 */

/** The helper's Accessibility and Screen Recording calls, when this window may make them. */
export function pointsPortOf(platform: ShellPlatform): PointsPort | undefined {
  const port = platform.permissions;
  if (platform.chrome?.remote !== undefined) return undefined;
  const status = port?.helperStatus;
  const request = port?.helperRequest;
  if (!port || !status || !request) return undefined;
  return {
    helperStatus: () => status.call(port),
    helperRequest: (kind) => request.call(port, kind),
  };
}

/** The tray row's command: open the start sheet on the window main found behind Psyche. */
function PointsCommands({ platform }: { platform: ShellPlatform }): null {
  const points = usePoints();
  useEffect(
    () =>
      platform.windows?.onCommand((c) => {
        if (c.type === "points")
          points.open({ entry: "tray", ...(c.window === undefined ? {} : { window: c.window }) });
      }),
    [platform.windows, points],
  );
  return null;
}

/**
 * Owns the start sheet for the main window and listens for the tray's command. Must sit inside
 * the kit's slots and Gateway providers; the `points` slot comes from `pointsPortOf`.
 */
export function PointsHost({
  platform,
  children,
}: {
  platform: ShellPlatform;
  children?: ReactNode;
}): ReactElement {
  return (
    <PointsProvider>
      <PointsCommands platform={platform} />
      {children}
    </PointsProvider>
  );
}
