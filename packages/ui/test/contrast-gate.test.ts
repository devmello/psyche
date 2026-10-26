import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCENT_SEED, generateTheme, wcagContrast } from "../src/theme/generate.ts";

/**
 * The colour pairs the UI uses for text, focus rings and icons (docs/a11y-audit.md), gated at
 * WCAG AA in light and dark: 4.5:1 for text, 3:1 for focus indicators and meaningful icons. The
 * generator's own gate covers only accent and gray; this adds the fixed semantic scales and the
 * pairs the audit found failing.
 */

const css = readFileSync(join(process.cwd(), "src/styles/semantic.css"), "utf8");

function scale(mode: "light" | "dark"): Record<string, string> {
  const [light = "", dark = ""] = css.split(':root[data-theme="dark"]');
  const block = mode === "light" ? light : dark;
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z]+-\d+):\s*(#[0-9a-f]{6})/gi))
    out[m[1] as string] = m[2] as string;
  return out;
}

const TEXT = 4.5;
const NON_TEXT = 3;

for (const mode of ["light", "dark"] as const) {
  describe(`contrast gate (${mode})`, () => {
    const s = scale(mode);
    const t = generateTheme({ accentSeed: DEFAULT_ACCENT_SEED })[mode];
    const gray = (n: number) => t.gray.solid[n - 1] as string;
    const accent = (n: number) => t.accent.solid[n - 1] as string;
    const sem = (name: string) => {
      const v = s[name];
      if (v === undefined) throw new Error(`${name} missing in semantic.css (${mode})`);
      return v;
    };
    // --approval-text: amber-12 in light, amber-11 in dark (styles/index.css).
    const approvalText = sem(mode === "light" ? "amber-12" : "amber-11");
    // Danger text on tinted surfaces: tomato-12 in light, tomato-11 in dark.
    const dangerOnTint = sem(mode === "light" ? "tomato-12" : "tomato-11");

    // --canvas = gray-1, --surface-sidebar = gray-2, --surface-raised = white (light) / gray-2 (dark).
    const surfaces: [string, string][] = [
      ["canvas", gray(1)],
      ["sidebar", gray(2)],
      ["raised", mode === "light" ? "#ffffff" : gray(2)],
    ];
    const pairs: [string, string, string, number][] = [
      ["approval text on gray-1", approvalText, gray(1), TEXT],
      ["approval text on gray-2 (approval card)", approvalText, gray(2), TEXT],
      ["approval text on gray-3", approvalText, gray(3), TEXT],
      ["approval text on amber-2", approvalText, sem("amber-2"), TEXT],
      ["approval text on amber-3 (Inbox chip)", approvalText, sem("amber-3"), TEXT],
      ["danger text on gray-1", sem("tomato-11"), gray(1), TEXT],
      ["danger text on tomato-3 (destructive button, chip)", dangerOnTint, sem("tomato-3"), TEXT],
      ["success text on grass-3", sem("grass-11"), sem("grass-3"), TEXT],
      ["info text on sky-3", sem("sky-11"), sem("sky-3"), TEXT],
      ["link accent-11 on gray-1", accent(11), gray(1), TEXT],
      ["Badge accent: accent-12 on accent-3", accent(12), accent(3), TEXT],
      ["muted gray-11 on gray-1", gray(11), gray(1), TEXT],
      ["muted gray-11 on gray-3", gray(11), gray(3), TEXT],
      ["focus ring accent-9 on gray-1", accent(9), gray(1), NON_TEXT],
      ["focus ring accent-9 on gray-2", accent(9), gray(2), NON_TEXT],
      ["incognito ring gray-9 on gray-1", gray(9), gray(1), NON_TEXT],
      ["pending icon gray-9 on gray-2", gray(9), gray(2), NON_TEXT],
      ["primary text on accent-9", t.accentContrast, accent(9), TEXT],
      // Redesign roles (styles/design.css): labels on canvas, sidebar and raised surfaces.
      ...surfaces.flatMap(([surface, bg]): [string, string, string, number][] => [
        [`label-primary on ${surface}`, gray(12), bg, TEXT],
        [`label-secondary on ${surface}`, gray(11), bg, TEXT],
        [`label-tertiary (metadata) on ${surface}`, gray(10), bg, NON_TEXT],
        [`accent-11 link on ${surface}`, accent(11), bg, TEXT],
        [`focus ring on ${surface}`, accent(9), bg, NON_TEXT],
        // Run-trace bars (styles/design.css --trace-*; run-trace-2026.md §3.3).
        [`trace thinking bar on ${surface}`, gray(9), bg, NON_TEXT],
        [`trace tool bar on ${surface}`, accent(9), bg, NON_TEXT],
        [
          `trace waiting bar on ${surface}`,
          sem(mode === "light" ? "amber-11" : "amber-9"),
          bg,
          NON_TEXT,
        ],
        [`trace failed bar on ${surface}`, sem("tomato-9"), bg, NON_TEXT],
      ]),
    ];
    for (const [name, fg, bg, min] of pairs) {
      it(`${name} ≥ ${min}:1`, () => {
        expect(wcagContrast(fg, bg)).toBeGreaterThanOrEqual(min);
      });
    }
  });
}
