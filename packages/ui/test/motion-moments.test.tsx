import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "../src/avatar/Avatar.tsx";
import { FadeIn, ListItem } from "../src/motion/primitives.tsx";
import { PanePresence, SidebarPresence } from "../src/shell/motion.tsx";
import { ThemeProvider } from "../src/theme/ThemeProvider.tsx";

/** This package's root: `vitest run` at the repository root does not change the cwd. */
const PKG = `${import.meta.dirname}/..`;
const REPO = join(PKG, "../..");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Every stylesheet that ships in a Psyche window, except the generated token file. */
const cssFiles = [
  ...walk(join(PKG, "src")),
  ...walk(join(REPO, "apps/web/src")),
  ...walk(join(REPO, "apps/desktop/src")),
].filter((f) => f.endsWith(".css") && !f.endsWith(`styles${sep}motion.css`));

const FORBIDDEN = /\b(width|height|top|left|box-shadow|backdrop-filter|border-radius)\b/;

describe("CSS holds to the tokens (docs/design/motion.md §1.7, §8)", () => {
  it("has stylesheets to check", () => {
    expect(cssFiles.length).toBeGreaterThan(3);
  });

  it("no transition or animation declaration carries a hand-typed time", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8");
      for (const m of css.matchAll(
        /(?:^|[\s;{])(transition|animation)(?:-duration)?\s*:([^;}]*)/g,
      )) {
        const value = m[2] ?? "";
        // `var(--duration-x)` and a literal 0 are fine; `1.2s`, `150ms` are not.
        const stripped = value.replace(/var\([^)]*\)/g, "").replace(/\b0m?s\b/g, "");
        if (/\d(?:\.\d+)?m?s\b/.test(stripped))
          offenders.push(`${relative(REPO, file)}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no transition list animates a layout or paint property", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8");
      for (const m of css.matchAll(/(?:^|[\s;{])transition(?:-property)?\s*:([^;}]*)/g)) {
        const value = (m[1] ?? "").replace(/var\([^)]*\)/g, "");
        if (FORBIDDEN.test(value)) offenders.push(`${relative(REPO, file)}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no keyframes animate a layout or paint property", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8");
      for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)) {
        const body = m[2] ?? "";
        if (FORBIDDEN.test(body.replace(/inset\([^)]*\)/g, "")))
          offenders.push(`${relative(REPO, file)}: @keyframes ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("components hold to the tokens", () => {
  const sources = [...walk(join(PKG, "src")), ...walk(join(REPO, "apps/web/src"))].filter(
    (f) => /\.tsx?$/.test(f) && !/\.stories\.tsx$/.test(f) && !/[\\/](motion|styles)[\\/]/.test(f),
  );

  it("no class or inline style animates box-shadow, width, height or runs a stock Tailwind loop", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(
        /transition-\[[^\]]*(?:box-shadow|width|height|left|top)[^\]]*\]|transition-shadow|animate-pulse|animate-\[|ease:\s*"(?:easeIn|easeOut|easeInOut)"/g,
      ))
        offenders.push(`${relative(REPO, file)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("reduced motion swaps movement for opacity (docs/design/motion.md §7)", () => {
  const reduced = (ui: React.ReactElement) =>
    render(<ThemeProvider settings={{ reduceMotion: true }}>{ui}</ThemeProvider>);

  it("the sidebar and pane columns fade in place instead of sliding", () => {
    const { container } = reduced(
      <>
        <SidebarPresence open testId="side">
          side
        </SidebarPresence>
        <PanePresence testId="pane">pane</PanePresence>
      </>,
    );
    const side = container.querySelector<HTMLElement>('[data-testid="side"]');
    expect(side).not.toBeNull();
    expect(side?.style.transform ?? "").not.toMatch(/translate/);
  });

  it("a list item and a card enter without a rise", () => {
    reduced(
      <>
        <ul>
          <ListItem data-testid="row">row</ListItem>
        </ul>
        <FadeIn data-testid="card">card</FadeIn>
      </>,
    );
    for (const id of ["row", "card"]) {
      const el = screen.getByTestId(id);
      expect(el.style.transform).not.toMatch(/translateY\((?!0)/);
    }
  });

  it("the needs-you halo loops with full motion and is absent when reduced", () => {
    const full = render(
      <ThemeProvider settings={{ reduceMotion: false }}>
        <Avatar name="Wren" state="needs-you" />
      </ThemeProvider>,
    );
    expect(full.queryByTestId("avatar-halo")).not.toBeNull();
    full.unmount();
    const still = reduced(<Avatar name="Wren" state="needs-you" />);
    expect(still.queryByTestId("avatar-halo")).toBeNull();
  });

  it("every enter/exit surface and the toasts have an opacity-only reduced form", () => {
    const css = readFileSync(join(PKG, "src/styles/design.css"), "utf8");
    // Popups, dialogs, sheets and backdrops: fade only at --duration-short, no scale or slide left.
    expect(css).toMatch(
      /data-reduce-motion="true"\] :is\(\.psy-popup, \.psy-dialog, \.psy-sheet, \.psy-backdrop\) \{\s*transition: opacity var\(--duration-short\)/,
    );
    expect(css).toMatch(
      /\.psy-sheet:is\(\[data-starting-style\], \[data-ending-style\]\) \{\s*translate: 0 0 !important/,
    );
    // Toasts: transition-property opacity, and a removed toast stays in place while it fades.
    const toast = css.slice(css.indexOf("Toasts (motion.md"));
    expect(toast).toMatch(
      /data-reduce-motion="true"\] \[data-sonner-toaster\][^{]*\{\s*transition-property: opacity/,
    );
    expect(toast).toMatch(/data-removed="true"\] \{\s*transform: var\(--y, none\) !important/);
  });
});
