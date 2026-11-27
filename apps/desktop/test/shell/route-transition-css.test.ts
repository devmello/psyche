import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The route swap must never show two pages at once: the incoming page waits for the outgoing one
 * to finish leaving. Read the shipped stylesheet and check the numbers.
 */
const css = readFileSync(
  new URL("../../src/shell/layout/shell-layout.css", import.meta.url),
  "utf8",
);

const motionCss = readFileSync(
  new URL("../../../../packages/ui/src/styles/motion.css", import.meta.url),
  "utf8",
);

const block = (selector: string) => {
  const i = css.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
};

describe("route transition stylesheet", () => {
  it("the new page starts only after the old page has left", () => {
    const out = Number(
      /--duration-route-out, (\d+)ms/.exec(block("::view-transition-old(.psy-route)"))?.[1],
    );
    const newBlock = block("::view-transition-new(.psy-route)");
    const delay = Number(/var\(--duration-route-out, (\d+)ms\)\s*both/.exec(newBlock)?.[1]);
    expect(out).toBeGreaterThan(0);
    expect(delay).toBeGreaterThanOrEqual(out);
  });

  it("does not blend the snapshots additively", () => {
    expect(block("::view-transition-old(.psy-route)")).toContain("mix-blend-mode: normal");
    expect(block("::view-transition-new(.psy-route)")).toContain("mix-blend-mode: normal");
  });

  it("reduced motion drops the rise and the old page's fade; normal motion keeps the rise", () => {
    expect(css).toContain("translateY(var(--route-rise, 4px))");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation-name: psy-route-fade");
    // The outgoing page's 1 ms comes from a motion token (41dce3a55); pin the token and its value.
    expect(reduced).toContain("animation-duration: var(--duration-route-old-reduced, 1ms)");
    expect(motionCss).toContain("--duration-route-old-reduced: 1ms;");
    expect(css).toContain(':root[data-reduce-motion="true"]::view-transition-new(.psy-route)');
  });
});
