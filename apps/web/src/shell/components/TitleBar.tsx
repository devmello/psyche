import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { WindowChrome } from "../platform.ts";

/**
 * Window chrome for frameless desktop windows (macOS `hiddenInset`; docs/06 §3.1, §4.1). The
 * bar is a drag region the height of the traffic-light row; its content starts after the
 * traffic lights, and interactive children opt out of dragging (`.titlebar` CSS). Hosts with a
 * native title bar, and the web client, render nothing.
 */

export const TITLEBAR_HEIGHT = 52;
/** Width of the three traffic-light buttons (12 px each, 8 px apart) plus a gutter. */
const TRAFFIC_LIGHTS_WIDTH = 52;
const GUTTER = 16;

export function hasInsetTitleBar(chrome: WindowChrome | undefined): boolean {
  return chrome?.titleBar === "inset";
}

/** Left padding that keeps bar content clear of the traffic lights. */
export function titleBarInset(chrome: WindowChrome | undefined): number {
  const x = chrome?.trafficLights?.x ?? 18;
  return x + TRAFFIC_LIGHTS_WIDTH + GUTTER;
}

export function TitleBar({
  chrome,
  children,
}: {
  chrome: WindowChrome | undefined;
  children?: ReactNode;
}): ReactElement | null {
  if (!hasInsetTitleBar(chrome)) return null;
  const style: CSSProperties = {
    height: TITLEBAR_HEIGHT,
    // Physical on purpose: Electron places the traffic lights at a physical x, whatever the
    // reading direction.
    paddingLeft: titleBarInset(chrome),
  };
  return (
    <header className="titlebar" data-testid="titlebar" style={style}>
      {children}
    </header>
  );
}
