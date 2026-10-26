/**
 * Translucency settings (Settings → Appearance → Translucency; issue #597): a preset named after
 * the HIG's glass variants, and Advanced values the owner can tune. AppearanceProvider turns them
 * into root CSS variables (`--glass-tint`, `--glass-blur`, `--glass-refraction` …) that the
 * material tokens in styles/design.css read, so the accessibility and inactive-window fallbacks
 * still override the result. Pure functions: tests run them directly.
 */

export const GLASS_PRESET_SETTING = "appearance.glass";
export const GLASS_TINT_SETTING = "appearance.glassTint";
export const GLASS_BLUR_SETTING = "appearance.glassBlur";
export const GLASS_REFRACTION_SETTING = "appearance.glassRefraction";

export type GlassPreset = "clear" | "regular" | "opaque";

export interface GlassValues {
  /** Tint opacity of the CSS rung, percent (the refraction and clear rungs scale from it). */
  tint: number;
  /** Blur radius of the CSS rung, px (the refraction and clear rungs scale from it). */
  blur: number;
  /** Lens strength, percent of the default (0–200). */
  refraction: number;
}

export const GLASS_LIMITS = {
  tint: { min: 10, max: 95, step: 1 },
  blur: { min: 0, max: 40, step: 1 },
  refraction: { min: 0, max: 200, step: 5 },
} as const;

/** The presets, mapped to the HIG variants (research/liquid-glass.md §1.2). */
export const GLASS_PRESETS: Record<Exclude<GlassPreset, "opaque">, GlassValues> = {
  clear: { tint: 38, blur: 10, refraction: 130 },
  regular: { tint: 72, blur: 20, refraction: 100 },
};

const clamp = (n: number, { min, max }: { min: number; max: number }) =>
  Math.min(max, Math.max(min, n));

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

export function glassPreset(settings: Record<string, unknown>): GlassPreset {
  const v = settings[GLASS_PRESET_SETTING];
  return v === "clear" || v === "opaque" ? v : "regular";
}

/** The effective values: the preset's, overridden by any Advanced value the owner set. */
export function glassValues(settings: Record<string, unknown>): GlassValues {
  const preset = glassPreset(settings);
  const base = GLASS_PRESETS[preset === "opaque" ? "regular" : preset];
  return {
    tint: clamp(num(settings[GLASS_TINT_SETTING]) ?? base.tint, GLASS_LIMITS.tint),
    blur: clamp(num(settings[GLASS_BLUR_SETTING]) ?? base.blur, GLASS_LIMITS.blur),
    refraction: clamp(
      num(settings[GLASS_REFRACTION_SETTING]) ?? base.refraction,
      GLASS_LIMITS.refraction,
    ),
  };
}

/** Root CSS variables for the values; the defaults reproduce styles/design.css exactly. */
export function glassCssVariables(v: GlassValues): Record<string, string> {
  const r = (n: number) => `${Math.round(n * 10) / 10}`;
  return {
    "--glass-tint": `${r(v.tint)}%`,
    // The refraction rung shows more of the backdrop (its lens is the point); clear more still.
    "--glass-tint-refraction": `${r(Math.max(5, v.tint - 22))}%`,
    "--glass-tint-clear": `${r(Math.max(4, v.tint * 0.2))}%`,
    "--glass-blur": `${r(v.blur)}px`,
    "--glass-blur-refraction": `${r(v.blur / 2)}px`,
    "--glass-blur-clear": `${r(v.blur / 5)}px`,
    "--glass-refraction": r(v.refraction / 100),
  };
}

/** True when the owner changed nothing from the preset (the Advanced reset is disabled). */
export function glassIsPreset(settings: Record<string, unknown>): boolean {
  return [GLASS_TINT_SETTING, GLASS_BLUR_SETTING, GLASS_REFRACTION_SETTING].every(
    (k) => num(settings[k]) === undefined,
  );
}
