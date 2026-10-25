/**
 * Liquid Glass helpers (docs/design/research/liquid-glass.md): the fallback ladder that picks an
 * implementation for a glass surface, and the lens displacement map the CSS refraction path feeds
 * to an SVG `feDisplacementMap`. Pure functions: no DOM, so tests run them directly.
 */

/** How a glass surface is drawn, best first. */
export type GlassImpl = "native" | "refraction" | "css" | "opaque";

export interface GlassEnvironment {
  /** The desktop shell put an `NSGlassEffectView` under this window (`PSYCHE_GLASS=native`). */
  nativeGlass: boolean;
  /** Chromium renders `backdrop-filter: url(#svg)` (Safari and Firefox don't). */
  backdropUrl: boolean;
  /** `backdrop-filter` at all. */
  backdrop: boolean;
  /** macOS Reduce Transparency, or the in-app setting. */
  reduceTransparency: boolean;
  /** macOS Increase Contrast, or the in-app setting. */
  increaseContrast: boolean;
  /**
   * The window is not key: glass "recedes" to opaque, as Apple's does
   * (docs/design/research/liquid-glass.md §6.2, rung 4; `data-window-active="false"`).
   */
  inactive?: boolean;
}

/**
 * The fallback ladder: native → refraction → css → opaque. A surface asks for the best it wants
 * (`requested`); it gets that or the next rung the environment supports. Reduce Transparency,
 * Increase Contrast and an inactive window always land on opaque, as Apple's own materials do.
 */
export function resolveGlassImpl(requested: GlassImpl, env: GlassEnvironment): GlassImpl {
  if (env.reduceTransparency || env.increaseContrast || env.inactive) return "opaque";
  const ladder: GlassImpl[] = ["native", "refraction", "css", "opaque"];
  const supported: Record<GlassImpl, boolean> = {
    native: env.nativeGlass,
    refraction: env.backdropUrl,
    css: env.backdrop,
    opaque: true,
  };
  for (const impl of ladder.slice(ladder.indexOf(requested))) if (supported[impl]) return impl;
  return "opaque";
}

export interface LensMapOptions {
  width: number;
  height: number;
  /** Corner radius in px (capsules: height / 2). */
  radius: number;
  /** Width of the curved rim in px; the flat middle does not bend light. */
  bezel: number;
}

/**
 * The surface height of a convex squircle rim at `t` (0 at the outer edge, 1 where the flat top
 * starts): `(1 - (1 - t)^4)^(1/4)`. Its slope is what bends the light.
 */
export function rimHeight(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return (1 - (1 - c) ** 4) ** 0.25;
}

/** How far a sample is pulled at depth `t` into the rim, 0..1: steep at the edge, 0 on the flat. */
export function rimDisplacement(t: number): number {
  if (t >= 1) return 0;
  const e = 1e-3;
  const slope = (rimHeight(Math.min(1, t + e)) - rimHeight(Math.max(0, t - e))) / (2 * e);
  // The slope runs to infinity at the very edge; squash it into 0..1.
  return Math.min(1, slope / (slope + 1.5));
}

/**
 * Signed distance from (x, y) to a rounded rectangle's edge (negative inside) and the outward
 * normal there.
 */
export function roundedRectSdf(
  x: number,
  y: number,
  o: Pick<LensMapOptions, "width" | "height" | "radius">,
): { distance: number; nx: number; ny: number } {
  const r = Math.min(o.radius, o.width / 2, o.height / 2);
  const px = x - o.width / 2;
  const py = y - o.height / 2;
  const qx = Math.abs(px) - (o.width / 2 - r);
  const qy = Math.abs(py) - (o.height / 2 - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const outside = Math.hypot(ox, oy);
  const distance = outside + Math.min(Math.max(qx, qy), 0) - r;
  let nx: number;
  let ny: number;
  if (outside > 0) {
    nx = ox / outside;
    ny = oy / outside;
  } else if (qx > qy) {
    nx = 1;
    ny = 0;
  } else {
    nx = 0;
    ny = 1;
  }
  return { distance, nx: nx * Math.sign(px || 1), ny: ny * Math.sign(py || 1) };
}

/**
 * RGBA pixels for an `feDisplacementMap` (R = x, G = y, 128 = no shift). Samples in the rim are
 * pulled inward along the normal, so the edge shows magnified, compressed background like a lens;
 * the flat middle is untouched.
 */
export function lensDisplacementMap(o: LensMapOptions): Uint8ClampedArray {
  const w = Math.max(1, Math.round(o.width));
  const h = Math.max(1, Math.round(o.height));
  const out = new Uint8ClampedArray(w * h * 4);
  const bezel = Math.max(1, o.bezel);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const { distance, nx, ny } = roundedRectSdf(x + 0.5, y + 0.5, o);
      const depth = -distance;
      const m = depth < 0 ? 0 : rimDisplacement(depth / bezel);
      const i = (y * w + x) * 4;
      // Pull inward: sample at p - n·m (feDisplacementMap adds scale·(C/255 − 0.5)).
      out[i] = Math.round(255 * (0.5 - (nx * m) / 2));
      out[i + 1] = Math.round(255 * (0.5 - (ny * m) / 2));
      out[i + 2] = 128;
      out[i + 3] = 255;
    }
  }
  return out;
}
