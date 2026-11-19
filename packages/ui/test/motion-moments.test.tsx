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

  // Each moment is rendered twice: with motion it must carry the movement (the positive control),
  // and with reduced motion that same movement must be gone. A test that only checked the second
  // would also pass when nothing is set at all.
  const withMotion = (reduceMotion: boolean, ui: React.ReactElement) => (
    <ThemeProvider settings={{ reduceMotion }}>{ui}</ThemeProvider>
  );
  const MOVES = /translate/;

  it.each([
    [
      "the sidebar",
      (open: boolean) => (
        <SidebarPresence open={open} testId="moving">
          side
        </SidebarPresence>
      ),
    ],
    [
      "a pane",
      (open: boolean) => <PanePresence testId="moving">{open ? "pane" : null}</PanePresence>,
    ],
  ])("%s slides with motion and fades in place when reduced", (_name, make) => {
    const seen: Record<string, { transform: string; opacity: string }> = {};
    for (const reduceMotion of [false, true]) {
      const view = render(withMotion(reduceMotion, make(false)));
      view.rerender(withMotion(reduceMotion, make(true)));
      const el = screen.getByTestId("moving");
      seen[String(reduceMotion)] = { transform: el.style.transform, opacity: el.style.opacity };
      view.unmount();
    }
    expect(seen.false?.transform).toMatch(MOVES);
    expect(seen.true?.transform ?? "").not.toMatch(MOVES);
    expect(seen.true?.opacity).toBe("0");
  });

  it("a list item and a card rise with motion and enter without a rise when reduced", () => {
    const rises = /translateY\((?!0)/;
    for (const id of ["row", "card"]) {
      const ui = (
        <>
          <ul>
            <ListItem data-testid="row">row</ListItem>
          </ul>
          <FadeIn data-testid="card">card</FadeIn>
        </>
      );
      const full = render(withMotion(false, ui));
      expect(screen.getByTestId(id).style.transform).toMatch(rises);
      full.unmount();
      const still = render(withMotion(true, ui));
      expect(screen.getByTestId(id).style.transform).not.toMatch(rises);
      expect(screen.getByTestId(id).style.opacity).toBe("0");
      still.unmount();
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

  it("the toast stack offset still animates through transform and removal is on the tokens", () => {
    const css = readFileSync(join(PKG, "src/styles/design.css"), "utf8");
    const toast = css.slice(css.indexOf("Toasts (motion.md"));
    // Sonner positions every toast with `--y` through `transform`: it must stay in the list.
    expect(toast).toMatch(
      /\[data-styled="true"\] \{\s*transition-property: transform, opacity;[^}]*spring-smooth-duration/,
    );
    // A collapsed back toast has a more specific Sonner rule (transform .5s, opacity .2s): the
    // removal rule must also match it, or its exit would keep Sonner's hand-typed times.
    expect(toast).toMatch(
      /\[data-removed="true"\]\[data-front="false"\]\[data-swipe-out="false"\]\[data-expanded="false"\][^{]*\{[^}]*duration-medium-exit/,
    );
  });

  it("the working pulse follows the in-app reduce-motion setting, not only the OS one", () => {
    const hits = walk(join(PKG, "src"))
      .filter((f) => f.endsWith(".tsx"))
      .filter((f) => /motion-safe:animate-psy-working/.test(readFileSync(f, "utf8")))
      .map((f) => relative(PKG, f));
    expect(hits).toEqual([]);
    for (const f of ["src/blocks/ToolRun.tsx", "src/widgets/WidgetDraft.tsx"]) {
      expect(readFileSync(join(PKG, f), "utf8")).toMatch(
        /animate-psy-working reduced:animate-none/,
      );
    }
  });
});
