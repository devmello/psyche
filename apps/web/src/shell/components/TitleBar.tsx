import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { WindowChrome } from "../platform.ts";

/**
 * Window chrome for frameless desktop windows (docs/06 §3.1, §4.1). Two kinds:
 * - macOS `hiddenInset` (`inset`): the bar is a drag region the height of the traffic-light row;
 *   its content starts after the traffic lights at the top left.
 * - Windows `titleBarStyle: "hidden"` + `titleBarOverlay` (`overlay`): Windows draws minimise,
 *   maximise and close at the top right; the bar and every toolbar keep clear of them through the
 *   Window Controls Overlay environment (`env(titlebar-area-x/width/height)`, shell-layout.css).
 * Interactive children opt out of dragging (`.titlebar` CSS). Hosts with a native title bar, and
 * the web client, render nothing.
 */

export const TITLEBAR_HEIGHT = 52;
/** Width of the three traffic-light buttons (12 px each, 8 px apart) plus a gutter. */
const TRAFFIC_LIGHTS_WIDTH = 52;
const GUTTER = 16;
/** Windows: nothing sits at the top left, so the bar's content starts at the window's padding. */
const OVERLAY_LEAD = 8;

export type FrameKind = "inset" | "overlay" | "native";

/**
 * The window's frame. `overlay` also when main left the chrome `native` but the page runs under
 * a title-bar overlay anyway (Electron's `navigator.windowControlsOverlay` says so), so a
 * mismatched build never puts controls under the caption buttons.
 */
export function frameKind(chrome: WindowChrome | undefined): FrameKind {
  if (chrome?.titleBar === "inset" || chrome?.titleBar === "overlay") return chrome.titleBar;
  if (chrome === undefined) return "native";
  const wco = (
    globalThis.navigator as { windowControlsOverlay?: { visible?: boolean } } | undefined
  )?.windowControlsOverlay;
  return wco?.visible === true ? "overlay" : "native";
}

/** The shell draws its own title bar: macOS's inset traffic lights or Windows' overlay. */
export function hasInsetTitleBar(chrome: WindowChrome | undefined): boolean {
  return frameKind(chrome) !== "native";
}

/**
 * Left padding that keeps bar content clear of the traffic lights (macOS). Windows' caption
 * buttons are on the right, so its bar starts at a small gutter and the right side is cleared in
 * CSS instead (`--caption-buttons-width`).
 */
export function titleBarInset(chrome: WindowChrome | undefined): number {
  if (frameKind(chrome) === "overlay") return OVERLAY_LEAD;
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
  const kind = frameKind(chrome);
  if (kind === "native") return null;
  const style: CSSProperties = {
    height: TITLEBAR_HEIGHT,
    // Physical on purpose: Electron places the traffic lights at a physical x, whatever the
    // reading direction (and Windows its caption buttons at the physical right).
    paddingLeft: titleBarInset(chrome),
  };
  return (
    <header className="titlebar" data-testid="titlebar" data-frame={kind} style={style}>
      {children}
    </header>
  );
}
