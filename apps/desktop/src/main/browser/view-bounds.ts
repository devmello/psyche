import type { Rect } from "@psyche/web/platform";

/**
 * Where the native tab view goes for the pane placeholder the renderer reported.
 * `rect` is in the renderer's CSS pixels; `scale` is that renderer's zoom factor (CSS px → window
 * DIPs). The result is clamped to the window's content area, and null when nothing of the
 * placeholder is inside it, so the native view never draws outside the pane.
 */
export function computeViewBounds(
  rect: Rect,
  content: { width: number; height: number },
  scale = 1,
): Rect | null {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const left = Math.max(0, Math.round(rect.x * s));
  const top = Math.max(0, Math.round(rect.y * s));
  const right = Math.min(content.width, Math.round((rect.x + rect.width) * s));
  const bottom = Math.min(content.height, Math.round((rect.y + rect.height) * s));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
