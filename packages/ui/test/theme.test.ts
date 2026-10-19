import Color from "colorjs.io";
import { describe, expect, it } from "vitest";
import {
  appearanceFromSettings,
  DEFAULT_ACCENT_SEED,
  DEFAULT_APPEARANCE,
  GRAY_FAMILIES,
  generateTheme,
  isValidSeed,
  themeToCss,
  wcagContrast,
} from "../src/theme/index.ts";

/** Deterministic PRNG (mulberry32) so the 20 "random" seeds are the same on every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(20261019);
const SEEDS = Array.from({ length: 20 }, () => {
  const hex = Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `#${hex}`;
});

const lightness = (css: string) => new Color(css).to("oklch").coords[0] ?? 0;

describe("generateTheme contrast gate", () => {
  for (const seed of SEEDS) {
    for (const mode of ["light", "dark"] as const) {
      it(`${seed} passes the WCAG gate in ${mode}`, () => {
        const t = generateTheme({ accentSeed: seed })[mode];
        const s = t.accent.solid;
        expect(s).toHaveLength(12);
        expect(t.gray.solid).toHaveLength(12);
        expect(t.accent.alpha).toHaveLength(12);
        expect(wcagContrast(s[10] as string, s[1] as string)).toBeGreaterThanOrEqual(4.5);
        expect(wcagContrast(s[11] as string, s[1] as string)).toBeGreaterThanOrEqual(7);
        expect(wcagContrast(t.accentContrast, s[8] as string)).toBeGreaterThanOrEqual(4.5);
        expect(
          wcagContrast(t.gray.solid[10] as string, t.gray.solid[1] as string),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          wcagContrast(t.gray.solid[11] as string, t.gray.solid[1] as string),
        ).toBeGreaterThanOrEqual(7);
        expect(t.report.passes).toBe(true);
      });
    }
  }
});

describe("generateTheme scales", () => {
  it("places a passable seed on step 9 unchanged", () => {
    // #6e56cf with white text is 5.9:1, so it needs no nudge.
    const t = generateTheme({ accentSeed: DEFAULT_ACCENT_SEED });
    expect(t.light.accent.hex[8]).toBe("#6e56cf");
    expect(t.light.nudged).toEqual([]);
  });

  it("nudges a seed whose step-9 text would fail and says so", () => {
    // Radix blue 9 with white text is about 3.3:1.
    const t = generateTheme({ accentSeed: "#0090ff" });
    expect(t.light.nudged.some((n) => n.startsWith("Step 9"))).toBe(true);
    expect(t.light.report.contrastOn9).toBeGreaterThanOrEqual(4.5);
  });

  it("uses dark text on bright seeds (APCA choice)", () => {
    const t = generateTheme({ accentSeed: "#ffc53d" });
    expect(lightness(t.light.accentContrast)).toBeLessThan(0.5);
    expect(lightness(generateTheme({ accentSeed: "#6e56cf" }).light.accentContrast)).toBe(1);
  });

  it("orders background and border steps by lightness", () => {
    for (const seed of SEEDS.slice(0, 5)) {
      const t = generateTheme({ accentSeed: seed });
      const light = t.light.accent.solid.slice(0, 8).map(lightness);
      const dark = t.dark.accent.solid.slice(0, 8).map(lightness);
      for (let i = 1; i < 8; i++) {
        expect(light[i]).toBeLessThan(light[i - 1] as number);
        expect(dark[i]).toBeGreaterThan(dark[i - 1] as number);
      }
      expect(lightness(t.light.accent.solid[11] as string)).toBeLessThan(
        lightness(t.light.accent.solid[10] as string),
      );
      expect(lightness(t.dark.accent.solid[11] as string)).toBeGreaterThan(
        lightness(t.dark.accent.solid[10] as string),
      );
    }
  });

  it("supports every gray family, with neutral having no chroma", () => {
    for (const gray of GRAY_FAMILIES) {
      const t = generateTheme({ accentSeed: "#e54d2e", gray });
      expect(t.light.report.passes).toBe(true);
      expect(t.dark.report.passes).toBe(true);
    }
    const neutral = generateTheme({ accentSeed: "#e54d2e", gray: "neutral" });
    for (const c of neutral.light.gray.solid) expect(new Color(c).to("oklch").coords[1]).toBe(0);
  });

  it("emits alpha colors that composite back to the solid step", () => {
    const t = generateTheme({ accentSeed: "#46a758" });
    const white = new Color("white").to("srgb");
    for (let i = 0; i < 12; i++) {
      const a = new Color(t.light.accent.alpha[i] as string).to("srgb");
      const alpha = a.alpha as number;
      const composed = a.coords.map(
        (v, ch) => (v ?? 0) * alpha + (white.coords[ch] ?? 0) * (1 - alpha),
      );
      const solid = new Color(t.light.accent.solid[i] as string).to("srgb").coords;
      composed.forEach((v, ch) => {
        expect(Math.abs(v - (solid[ch] ?? 0))).toBeLessThan(0.01);
      });
    }
  });

  it("rejects invalid seeds", () => {
    expect(isValidSeed("not a color")).toBe(false);
    expect(isValidSeed("oklch(0.6 0.2 30)")).toBe(true);
    expect(() => generateTheme({ accentSeed: "nope" })).toThrow(/invalid accent seed/);
  });
});

describe("themeToCss", () => {
  it("writes light, dark and P3 blocks with every token", () => {
    const css = themeToCss(generateTheme({ accentSeed: "oklch(0.7 0.3 140)" }));
    expect(css).toContain(':root, :root[data-theme="light"] {');
    expect(css).toContain(':root[data-theme="dark"] {');
    expect(css).toContain("@media (color-gamut: p3)");
    for (let i = 1; i <= 12; i++) {
      expect(css).toContain(`--accent-${i}:`);
      expect(css).toContain(`--accent-a${i}:`);
      expect(css).toContain(`--gray-${i}:`);
    }
    expect(css).toContain("--accent-contrast:");
  });
});

describe("appearanceFromSettings", () => {
  it("reads appearance.* keys and ignores invalid values", () => {
    expect(appearanceFromSettings({})).toEqual(DEFAULT_APPEARANCE);
    expect(
      appearanceFromSettings({
        "appearance.theme": "dark",
        "appearance.accentSeed": "#e54d2e",
        "appearance.gray": "slate",
        "appearance.density": "compact",
        "appearance.reduceMotion": true,
        "appearance.contrast": "high",
      }),
    ).toEqual({
      theme: "dark",
      accentSeed: "#e54d2e",
      gray: "slate",
      density: "compact",
      reduceMotion: true,
      contrast: "high",
    });
    const bad = appearanceFromSettings({
      "appearance.theme": "sepia",
      "appearance.accentSeed": "x",
    });
    expect(bad.theme).toBe("auto");
    expect(bad.accentSeed).toBe(DEFAULT_ACCENT_SEED);
  });
});
