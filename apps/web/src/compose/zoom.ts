/**
 * Renderer zoom as an explicit appearance setting (desktop; docs/06 §3.18 Appearance). View →
 * Zoom In / Out / Actual Size and Settings → Appearance write `appearance.zoom` (a percentage,
 * default 100, clamped to 67–200); the desktop applies it to every app renderer on launch, so a
 * stray per-session zoom never survives a restart silently. The key is cosmetic (`appearance.*`
 * needs no admin), so any device of the user can change it.
 */

export const ZOOM_KEY = "appearance.zoom";
export const ZOOM_DEFAULT = 100;
export const ZOOM_MIN = 67;
export const ZOOM_MAX = 200;
/** Chrome's zoom presets inside the allowed range. */
export const ZOOM_LADDER: readonly number[] = [67, 75, 80, 90, 100, 110, 125, 150, 175, 200];

/** A stored value as a percentage in range; anything else is the default. */
export function clampZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value)));
}

/** The next ladder step up or down from `current` (which need not be on the ladder). */
export function zoomStep(current: number, direction: 1 | -1): number {
  const from = clampZoom(current);
  if (direction === 1) return ZOOM_LADDER.find((v) => v > from) ?? ZOOM_MAX;
  return [...ZOOM_LADDER].reverse().find((v) => v < from) ?? ZOOM_MIN;
}

export function zoomFactor(percent: number): number {
  return clampZoom(percent) / 100;
}
