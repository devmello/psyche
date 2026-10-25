import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Electron overrode the private `_cornerMask`, which drove WindowServer GPU load on macOS 26;
 * the fix shipped in 36.9.2 / 37.6.0 / 38.2.0 / 39 and later (electron/electron#48376;
 * docs/design/research/liquid-glass.md §6.3 item 2). Never ship below it.
 */
const FLOOR = [44, 9, 0] as const;

function version(): number[] {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const raw = pkg.devDependencies?.electron ?? pkg.dependencies?.electron ?? "";
  return raw
    .replace(/^[^\d]*/, "")
    .split(".")
    .map(Number);
}

describe("the Electron floor (Tahoe WindowServer fix)", () => {
  it(`pins Electron ≥ ${FLOOR.join(".")}`, () => {
    const v = version();
    expect(v.length).toBeGreaterThanOrEqual(3);
    const cmp =
      v[0] !== FLOOR[0]
        ? (v[0] as number) - FLOOR[0]
        : v[1] !== FLOOR[1]
          ? (v[1] as number) - FLOOR[1]
          : (v[2] as number) - FLOOR[2];
    expect(cmp, `electron ${v.join(".")}`).toBeGreaterThanOrEqual(0);
  });
});
