/**
 * Where the Settings window opens (#596; redesign §4, §5.8): its remembered bounds while they're
 * still on a screen, otherwise centred on the main window the first time, as macOS settings
 * windows do. Pure, so unit tests run it without Electron.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How much of a remembered window must still be on a screen to reuse it (a grabbable strip). */
const MIN_VISIBLE = 48;

/** A stored value as bounds, or null when it isn't usable (missing, malformed, below the minimum). */
export function storedBounds(value: unknown, min: Size): Rect | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const n = (k: string) =>
    typeof v[k] === "number" && Number.isFinite(v[k]) ? Math.round(v[k] as number) : null;
  const x = n("x");
  const y = n("y");
  const width = n("width");
  const height = n("height");
  if (x === null || y === null || width === null || height === null) return null;
  if (width < min.width || height < min.height) return null;
  return { x, y, width, height };
}

function overlap(a: Rect, b: Rect): Size {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function onScreen(r: Rect, workAreas: readonly Rect[]): boolean {
  return workAreas.some((wa) => {
    const o = overlap(r, wa);
    return o.width >= MIN_VISIBLE && o.height >= MIN_VISIBLE;
  });
}

/** The work area holding a rect's centre (or the first one). */
function areaFor(r: Rect, workAreas: readonly Rect[]): Rect | undefined {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return (
    workAreas.find(
      (wa) => cx >= wa.x && cx < wa.x + wa.width && cy >= wa.y && cy < wa.y + wa.height,
    ) ?? workAreas[0]
  );
}

export function settingsWindowBounds(o: {
  saved: unknown;
  /** The main window's bounds, when it exists. */
  main?: Rect | undefined;
  /** Every display's work area; the first is the primary. */
  workAreas: readonly Rect[];
  size: Size;
  min: Size;
}): Rect {
  const saved = storedBounds(o.saved, o.min);
  if (saved && onScreen(saved, o.workAreas)) return saved;
  const anchor = o.main ?? o.workAreas[0];
  const area = anchor ? areaFor(anchor, o.workAreas) : undefined;
  const width = area ? Math.min(o.size.width, area.width) : o.size.width;
  const height = area ? Math.min(o.size.height, area.height) : o.size.height;
  if (!anchor) return { x: 0, y: 0, width, height };
  let x = Math.round(anchor.x + (anchor.width - width) / 2);
  let y = Math.round(anchor.y + (anchor.height - height) / 2);
  if (area) {
    x = Math.max(area.x, Math.min(x, area.x + area.width - width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  }
  return { x, y, width, height };
}
