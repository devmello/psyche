import type { GeneratedTheme, ModeTheme } from "./generate.ts";

/**
 * Serializes a generated theme as the `<style id="psyche-theme">` block from UI design §4.10:
 * `:root` (light), `:root[data-theme="dark"]`, and P3 overrides under
 * `@supports (color: color(display-p3 1 1 1)) { @media (color-gamut: p3) { … } }`.
 * The shadcn names are mapped once in `styles/tokens.css` and never regenerated.
 */

export const THEME_STYLE_ID = "psyche-theme";

function vars(mode: ModeTheme): string[] {
  return [
    ...mode.accent.solid.map((c, i) => `--accent-${i + 1}: ${c};`),
    ...mode.accent.alpha.map((c, i) => `--accent-a${i + 1}: ${c};`),
    `--accent-contrast: ${mode.accentContrast};`,
    `--accent-surface: ${mode.accentSurface};`,
    ...mode.gray.solid.map((c, i) => `--gray-${i + 1}: ${c};`),
    ...mode.gray.alpha.map((c, i) => `--gray-a${i + 1}: ${c};`),
  ];
}

function p3Vars(mode: ModeTheme): string[] {
  return mode.accent.solidP3.flatMap((c, i) =>
    c === mode.accent.solid[i] ? [] : [`--accent-${i + 1}: ${c};`],
  );
}

function block(selector: string, lines: string[], indent = ""): string {
  if (lines.length === 0) return "";
  return `${indent}${selector} {\n${lines.map((l) => `${indent}  ${l}`).join("\n")}\n${indent}}\n`;
}

/** CSS text for both appearances. `scope` defaults to `:root`. */
export function themeToCss(theme: GeneratedTheme, scope = ":root"): string {
  const light = `${scope}, ${scope}[data-theme="light"]`;
  const dark = `${scope}[data-theme="dark"]`;
  let css = block(light, vars(theme.light));
  css += block(dark, vars(theme.dark));
  const p3Light = p3Vars(theme.light);
  const p3Dark = p3Vars(theme.dark);
  if (p3Light.length + p3Dark.length > 0) {
    css += "@supports (color: color(display-p3 1 1 1)) {\n  @media (color-gamut: p3) {\n";
    css += block(light, p3Light, "    ");
    css += block(dark, p3Dark, "    ");
    css += "  }\n}\n";
  }
  return css;
}
