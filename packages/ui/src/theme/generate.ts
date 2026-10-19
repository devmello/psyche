import BezierEasing from "bezier-easing";
import Color from "colorjs.io";

/**
 * Theme generator (UI design §4.8, §4.10). A user-picked seed becomes a 12-step accent scale and a
 * 12-step gray scale per appearance, in OKLCH, following the Radix custom-palette approach: the
 * seed lands on step 9, steps 1–8 ease from a near-background tint to a border tone, 10 is the
 * hover of 9, and 11–12 are text steps. Text on step 9 is chosen with APCA (advisory) and then
 * gated with WCAG 2, which is binding:
 *
 * - step 11 ≥ 4.5:1 and step 12 ≥ 7:1 on step 2,
 * - `--accent-contrast` ≥ 4.5:1 on step 9.
 *
 * A seed that cannot meet the gate is nudged in lightness and the result says so (`nudged`).
 */

export type Appearance = "light" | "dark";
export type GrayFamily = "auto" | "neutral" | "slate" | "mauve" | "sage" | "olive" | "sand";

export const GRAY_FAMILIES: readonly GrayFamily[] = [
  "auto",
  "neutral",
  "slate",
  "mauve",
  "sage",
  "olive",
  "sand",
];

/** Default seed: a lantern violet for the moth's wing spots. */
export const DEFAULT_ACCENT_SEED = "#6e56cf";

export interface GeneratedScale {
  /** 12 OKLCH colors mapped into sRGB. Index 0 is step 1. */
  solid: string[];
  /** The same steps mapped into Display P3 (used under `@media (color-gamut: p3)`). */
  solidP3: string[];
  /** 12 translucent colors that composite to `solid` over white (light) or black (dark), as Radix alpha scales do. */
  alpha: string[];
  /** sRGB hex, for previews and tests. */
  hex: string[];
}

export interface ContrastReport {
  /** WCAG 2 ratios. */
  accent11On2: number;
  accent12On2: number;
  contrastOn9: number;
  gray11On2: number;
  gray12On2: number;
  /** APCA Lc of the step-9 text color (advisory only). */
  apcaOn9: number;
  passes: boolean;
}

export interface ModeTheme {
  appearance: Appearance;
  accent: GeneratedScale;
  gray: GeneratedScale;
  /** Text color on accent step 9. */
  accentContrast: string;
  /** Translucent accent surface for tinted cards. */
  accentSurface: string;
  report: ContrastReport;
  /** Human-readable notes when the generator had to move a step to pass the gate. */
  nudged: string[];
}

export interface ThemeInput {
  accentSeed: string;
  gray?: GrayFamily;
}

export interface GeneratedTheme {
  input: Required<ThemeInput>;
  light: ModeTheme;
  dark: ModeTheme;
}

// --- Targets ------------------------------------------------------------------------------------

/** Lightness of steps 1 and 8 per appearance; steps 2–7 ease between them. */
const ENDS: Record<Appearance, { l1: number; l8: number }> = {
  light: { l1: 0.993, l8: 0.74 },
  dark: { l1: 0.18, l8: 0.5 },
};

/** Lightness across steps 1–8: a slow start keeps the background steps close together. */
const lightEase = BezierEasing(0.45, 0.05, 0.75, 0.55);
/** Chroma across steps 1–8. */
const chromaEase = BezierEasing(0.3, 0.1, 0.6, 1);

/** Chroma of steps 1, 8, 11 and 12 as a share of the seed's chroma. */
const CHROMA: Record<Appearance, { c1: number; c8: number; c11: number; c12: number }> = {
  light: { c1: 0.03, c8: 0.62, c11: 0.8, c12: 0.42 },
  dark: { c1: 0.1, c8: 0.66, c11: 0.62, c12: 0.26 },
};

/** Starting lightness for the text steps; the gate moves them further when needed. */
const TEXT_START: Record<Appearance, { l11: number; l12: number }> = {
  light: { l11: 0.56, l12: 0.33 },
  dark: { l11: 0.78, l12: 0.92 },
};

/** Gray lightness per step (Radix gray, measured in OKLCH). */
const GRAY_L: Record<Appearance, number[]> = {
  light: [0.991, 0.982, 0.956, 0.931, 0.906, 0.884, 0.85, 0.795, 0.649, 0.618, 0.521, 0.244],
  dark: [0.178, 0.213, 0.252, 0.285, 0.313, 0.348, 0.401, 0.488, 0.537, 0.58, 0.771, 0.949],
};

/** Hue and peak chroma per gray family; `auto` tints toward the seed hue. */
const GRAY_TINT: Record<Exclude<GrayFamily, "auto">, { h: number; c: number }> = {
  neutral: { h: 0, c: 0 },
  slate: { h: 260, c: 0.012 },
  mauve: { h: 305, c: 0.012 },
  sage: { h: 165, c: 0.01 },
  olive: { h: 125, c: 0.01 },
  sand: { h: 75, c: 0.01 },
};

/** Gray chroma per step as a share of the family's peak chroma. */
const GRAY_CHROMA_PROFILE = [0.25, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1, 1, 0.9, 0.6];

// --- Helpers ------------------------------------------------------------------------------------

type Oklch = [number, number, number];

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Parses any CSS color into OKLCH coordinates. Throws on an invalid seed. */
export function parseSeed(seed: string): Oklch {
  let color: Color;
  try {
    color = new Color(seed).to("oklch");
  } catch {
    throw new Error(`invalid accent seed ${JSON.stringify(seed)}`);
  }
  const [l, c, h] = color.coords;
  const hue = typeof h === "number" && Number.isFinite(h) ? h : 0;
  return [l ?? 0, c ?? 0, hue];
}

function mapped(lch: Oklch, space: "srgb" | "p3"): Color {
  return new Color("oklch", [...lch]).toGamut({ space, method: "css" }).to("oklch");
}

function oklchString(color: Color, alpha?: number): string {
  const [l, c, h] = color.coords;
  const hue = typeof h === "number" && Number.isFinite(h) ? round(h, 2) : 0;
  const base = `${round(l ?? 0, 4)} ${round(c ?? 0, 4)} ${hue}`;
  return alpha === undefined || alpha >= 1
    ? `oklch(${base})`
    : `oklch(${base} / ${round(alpha, 3)})`;
}

function hexOf(color: Color): string {
  return color.to("srgb").toString({ format: "hex", collapse: false });
}

/** WCAG 2.1 contrast ratio between two CSS colors. */
export function wcagContrast(a: string, b: string): number {
  return round(Color.contrast(new Color(a), new Color(b), "WCAG21"), 3);
}

/** APCA Lc of `text` on `background` (advisory; WCAG 3 is undecided). */
export function apcaContrast(background: string, text: string): number {
  return round(Color.contrast(new Color(background), new Color(text), "APCA"), 2);
}

/**
 * The translucent color that composites to `target` over `background` with the smallest alpha
 * (as Radix alpha scales do), computed per channel in sRGB.
 */
function alphaOver(target: Color, background: Color): string {
  const t = target.to("srgb").coords.map((v) => clamp(v ?? 0, 0, 1));
  const b = background.to("srgb").coords.map((v) => clamp(v ?? 0, 0, 1));
  let alpha = 0;
  for (let i = 0; i < 3; i++) {
    const tv = t[i] ?? 0;
    const bv = b[i] ?? 0;
    let needed = 0;
    if (tv > bv) needed = (tv - bv) / (1 - bv || 1);
    else if (bv > tv) needed = (bv - tv) / (bv || 1);
    alpha = Math.max(alpha, needed);
  }
  alpha = clamp(Math.ceil(alpha * 1000) / 1000, 0.001, 1);
  const rgb = t.map((tv, i) => clamp((tv - (b[i] ?? 0) * (1 - alpha)) / alpha, 0, 1));
  return oklchString(new Color("srgb", [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0]).to("oklch"), alpha);
}

function buildScale(raw: Oklch[], page: Color): GeneratedScale {
  const srgb = raw.map((lch) => mapped(lch, "srgb"));
  const p3 = raw.map((lch) => mapped(lch, "p3"));
  return {
    solid: srgb.map((c) => oklchString(c)),
    solidP3: p3.map((c) => oklchString(c)),
    alpha: srgb.map((c) => alphaOver(c, page)),
    hex: srgb.map(hexOf),
  };
}

function css(lch: Oklch): string {
  return oklchString(mapped(lch, "srgb"));
}

/** Moves a text step's lightness until it reaches `ratio` on `bg` (darker in light mode). */
function gateText(lch: Oklch, bg: string, ratio: number, appearance: Appearance) {
  const out: Oklch = [...lch];
  let moved = false;
  for (let i = 0; i < 100 && wcagContrast(css(out), bg) < ratio; i++) {
    out[0] = clamp(out[0] + (appearance === "light" ? -0.01 : 0.01), 0, 1);
    moved = true;
  }
  return { lch: out, moved };
}

/** Picks the step-9 text color by APCA, then nudges step 9 until WCAG ≥ 4.5:1 holds. */
function contrastFor(step9: Oklch, hue: number) {
  const white = "oklch(1 0 0)";
  const dark = css([0.22, 0.02, hue]);
  let s9: Oklch = [...step9];
  const pick =
    Math.abs(apcaContrast(css(s9), white)) >= Math.abs(apcaContrast(css(s9), dark)) ? white : dark;
  let moved = false;
  for (let i = 0; i < 100 && wcagContrast(css(s9), pick) < 4.5; i++) {
    s9 = [clamp(s9[0] + (pick === white ? -0.01 : 0.01), 0, 1), s9[1], s9[2]];
    moved = true;
  }
  return { step9: s9, text: pick, apca: apcaContrast(css(s9), pick), moved };
}

/** Step 10 is the hover of 9: darker in light mode, lighter in dark mode (or lighter for near-black seeds). */
function hoverLightness(l9: number, appearance: Appearance): number {
  if (appearance === "light" && l9 > 0.12) return clamp(l9 - 0.035, 0, 1);
  return clamp(l9 + 0.045, 0, 1);
}

// --- Generation ---------------------------------------------------------------------------------

function grayRaw(appearance: Appearance, family: GrayFamily, seed: Oklch): Oklch[] {
  const tint =
    family === "auto"
      ? { h: seed[2], c: seed[1] < 0.02 ? 0 : Math.min(0.014, seed[1] * 0.06) }
      : GRAY_TINT[family];
  return GRAY_L[appearance].map(
    (l, i): Oklch => [l, tint.c * (GRAY_CHROMA_PROFILE[i] ?? 1), tint.h],
  );
}

function accentRaw(appearance: Appearance, seed: Oklch): Oklch[] {
  const [sl, sc, sh] = seed;
  const ends = ENDS[appearance];
  const chroma = CHROMA[appearance];
  const steps: Oklch[] = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const l = ends.l1 + (ends.l8 - ends.l1) * lightEase(t);
    const c = sc * (chroma.c1 + (chroma.c8 - chroma.c1) * chromaEase(t));
    steps.push([l, c, sh]);
  }
  steps.push([sl, sc, sh]);
  steps.push([hoverLightness(sl, appearance), sc * 0.98, sh]);
  const start = TEXT_START[appearance];
  steps.push([start.l11, sc * chroma.c11, sh]);
  steps.push([start.l12, sc * chroma.c12, sh]);
  return steps;
}

/** Generates the scales for one appearance. */
export function generateMode(input: ThemeInput, appearance: Appearance): ModeTheme {
  const seed = parseSeed(input.accentSeed);
  const family = input.gray ?? "auto";
  const nudged: string[] = [];

  const grays = grayRaw(appearance, family, seed);
  const page = new Color(appearance === "light" ? "white" : "black");

  const raw = accentRaw(appearance, seed);
  const c9 = contrastFor(raw[8] as Oklch, seed[2]);
  if (c9.moved) {
    raw[8] = c9.step9;
    raw[9] = [hoverLightness(c9.step9[0], appearance), (raw[9] as Oklch)[1], seed[2]];
    nudged.push(
      `Step 9 moved from lightness ${round(seed[0], 3)} to ${round(c9.step9[0], 3)} so its text reaches 4.5:1.`,
    );
  }

  const step2 = css(raw[1] as Oklch);
  const g11 = gateText(raw[10] as Oklch, step2, 4.5, appearance);
  raw[10] = g11.lch;
  if (g11.moved) nudged.push("Step 11 adjusted to reach 4.5:1 on step 2.");
  const g12 = gateText(raw[11] as Oklch, step2, 7, appearance);
  raw[11] = g12.lch;
  if (g12.moved) nudged.push("Step 12 adjusted to reach 7:1 on step 2.");

  const grayStep2 = css(grays[1] as Oklch);
  grays[10] = gateText(grays[10] as Oklch, grayStep2, 4.5, appearance).lch;
  grays[11] = gateText(grays[11] as Oklch, grayStep2, 7, appearance).lch;

  const accent = buildScale(raw, page);
  const gray = buildScale(grays, page);
  const at = (s: GeneratedScale, step: number) => s.solid[step - 1] as string;

  const report: ContrastReport = {
    accent11On2: wcagContrast(at(accent, 11), at(accent, 2)),
    accent12On2: wcagContrast(at(accent, 12), at(accent, 2)),
    contrastOn9: wcagContrast(c9.text, at(accent, 9)),
    gray11On2: wcagContrast(at(gray, 11), at(gray, 2)),
    gray12On2: wcagContrast(at(gray, 12), at(gray, 2)),
    apcaOn9: c9.apca,
    passes: false,
  };
  report.passes =
    report.accent11On2 >= 4.5 &&
    report.accent12On2 >= 7 &&
    report.contrastOn9 >= 4.5 &&
    report.gray11On2 >= 4.5 &&
    report.gray12On2 >= 7;

  const accentSurface = oklchString(
    mapped(raw[1] as Oklch, "srgb"),
    appearance === "light" ? 0.6 : 0.5,
  );

  return { appearance, accent, gray, accentContrast: c9.text, accentSurface, report, nudged };
}

/** Generates both appearances from one seed. */
export function generateTheme(input: ThemeInput): GeneratedTheme {
  const full: Required<ThemeInput> = { accentSeed: input.accentSeed, gray: input.gray ?? "auto" };
  return { input: full, light: generateMode(full, "light"), dark: generateMode(full, "dark") };
}

/** `true` when the string parses as a CSS color. */
export function isValidSeed(seed: string): boolean {
  try {
    parseSeed(seed);
    return true;
  } catch {
    return false;
  }
}
