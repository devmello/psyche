import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wcagContrast } from "../src/theme/generate.ts";

/**
 * Regression gate for the shipped tokens (apple-audit finding 1 and 13): the secondary labels the
 * UI sets at 11-12 px must reach WCAG AA 4.5:1 on every surface they sit on, in both themes. It
 * reads the generated theme-default.css and design.css as shipped, not the generator, so a hand
 * edit or a stale regeneration fails too.
 */

const PKG = `${import.meta.dirname}/..`;
const theme = readFileSync(join(PKG, "src/styles/theme-default.css"), "utf8");
const design = readFileSync(join(PKG, "src/styles/design.css"), "utf8");

const AA = 4.5;

/** The declarations of the first rule whose selector contains `selector` (e.g. `[data-theme="dark"]`). */
function block(css: string, selector: string | null): string {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find(([, sel]) =>
    selector === null ? !(sel as string).includes("dark") : (sel as string).includes(selector),
  );
  if (!hit) throw new Error(`no rule for ${selector}`);
  return hit[2] as string;
}

function grays(mode: "light" | "dark"): Record<number, string> {
  const decls = block(theme, mode === "light" ? null : '[data-theme="dark"]');
  const out: Record<number, string> = {};
  for (const m of decls.matchAll(/--gray-(\d+):\s*(oklch\([^)]+\))/g))
    out[Number(m[1])] = m[2] as string;
  return out;
}

for (const mode of ["light", "dark"] as const) {
  describe(`tertiary label contrast (${mode})`, () => {
    const g = grays(mode);
    // --label-tertiary is gray-10 (design.css); surfaces: canvas gray-1, sidebar and dark
    // raised/overlay gray-2, light raised/overlay white.
    const surfaces: [string, string][] = [
      ["canvas gray-1", g[1] as string],
      ["sidebar gray-2", g[2] as string],
      ["raised", mode === "light" ? "oklch(1 0 0)" : (g[2] as string)],
    ];
    for (const [name, bg] of surfaces) {
      it(`gray-10 on ${name} is at least 4.5:1`, () => {
        expect(wcagContrast(g[10] as string, bg)).toBeGreaterThanOrEqual(AA);
      });
      it(`gray-11 on ${name} is at least 4.5:1`, () => {
        expect(wcagContrast(g[11] as string, bg)).toBeGreaterThanOrEqual(AA);
      });
    }
    it("keeps tertiary quieter than secondary", () => {
      const bg = g[1] as string;
      expect(wcagContrast(g[10] as string, bg)).toBeLessThan(wcagContrast(g[11] as string, bg));
    });
  });
}

describe("contrast test positive control", () => {
  it("fails for the old values (3.5:1 light, 4.1:1 dark)", () => {
    const g = grays("dark");
    expect(wcagContrast("oklch(0.58 0.005 80)", g[2] as string)).toBeLessThan(AA);
    const l = grays("light");
    expect(wcagContrast("oklch(0.618 0.005 80)", l[2] as string)).toBeLessThan(AA);
  });
});

describe("menu material", () => {
  const root = block(design, null);
  it("--label-tertiary is gray-10", () => {
    expect(root).toMatch(/--label-tertiary:\s*var\(--gray-10\)/);
  });
  it("is at least 90% opaque by default", () => {
    const m = root.match(/--material-menu:\s*color-mix\(in oklch, var\(--surface-overlay\) (\d+)%/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(90);
  });
  it("is fully opaque under every reduced-transparency and high-contrast override", () => {
    const overrides = [...design.matchAll(/--material-menu:\s*var\(--surface-overlay\);/g)];
    // inactive window, increase contrast, prefers-contrast, reduce transparency / opaque preset,
    // prefers-reduced-transparency.
    expect(overrides.length).toBeGreaterThanOrEqual(5);
    expect(design).toMatch(/:root\[data-reduce-transparency="true"\][^{]*\{[^}]*--material-menu:/);
    expect(design).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)\s*\{\s*:root\s*\{[^}]*--material-menu:/,
    );
  });
});
