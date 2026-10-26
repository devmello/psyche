/**
 * The Timeline's keyboard map (docs/design/run-trace-2026.md §3.3). Pure: the view maps a key
 * event to an action and decides what it means for the focused row.
 */

export type TimelineAction =
  | "prev"
  | "next"
  | "fold"
  | "unfold"
  | "inspect"
  | "back"
  | "playPause"
  | "eventBack"
  | "eventForward"
  | "prevIssue"
  | "nextIssue"
  | "copy"
  | "zoomIn"
  | "zoomOut"
  | "zoomFit"
  | "first"
  | "last";

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/** ⌘ on macOS, Ctrl elsewhere: either counts as the command modifier. */
function command(e: KeyLike): boolean {
  return Boolean(e.metaKey || e.ctrlKey);
}

export function timelineAction(e: KeyLike, rtl = false): TimelineAction | null {
  if (e.altKey) return null;
  if (command(e)) {
    switch (e.key) {
      case "c":
      case "C":
        return "copy";
      case "=":
      case "+":
        return "zoomIn";
      case "-":
      case "_":
        return "zoomOut";
      case "0":
        return "zoomFit";
      default:
        return null;
    }
  }
  if (e.shiftKey && e.key !== "?") return null;
  switch (e.key) {
    case "ArrowUp":
      return "prev";
    case "ArrowDown":
      return "next";
    case "ArrowLeft":
      return rtl ? "unfold" : "fold";
    case "ArrowRight":
      return rtl ? "fold" : "unfold";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
      return "inspect";
    case "Escape":
      return "back";
    case " ":
      return "playPause";
    case ",":
      return "eventBack";
    case ".":
      return "eventForward";
    case "[":
      return "prevIssue";
    case "]":
      return "nextIssue";
    default:
      return null;
  }
}

/** Waterfall zoom steps (⌘+ / ⌘− / ⌘0 and pinch): track width multipliers. */
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8] as const;

export function zoomStep(zoom: number, dir: 1 | -1): number {
  const i = ZOOM_LEVELS.findIndex((z) => z >= zoom);
  const at = i === -1 ? ZOOM_LEVELS.length - 1 : i;
  const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, at + dir));
  return ZOOM_LEVELS[next] ?? 1;
}
