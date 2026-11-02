import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Bundle and RAM discipline for widgets (generative-ui-2026 §9): charts and images are their own
 * lazy chunks inside the lazy widget chunk, no chart library is imported, and the in-house chart
 * stays small. A real byte count of the built chunk is reported in the PR (storybook build).
 */
const dir = join(import.meta.dirname, "../src/widgets");
const read = (f: string) => readFileSync(join(dir, f), "utf8");

describe("widget bundle", () => {
  it("loads chart and image renderers lazily", () => {
    const nodes = read("nodes.tsx");
    expect(nodes).toMatch(/lazy\(\(\) => import\("\.\/WidgetChart\.tsx"\)\)/);
    expect(nodes).toMatch(/lazy\(\(\) => import\("\.\/WidgetImage\.tsx"\)\)/);
    expect(nodes).not.toMatch(/^import .*from "\.\/Widget(Chart|Image)\.tsx"/m);
  });

  it("imports no chart library and nothing heavy", () => {
    for (const f of ["WidgetChart.tsx", "WidgetImage.tsx", "nodes.tsx"]) {
      expect(read(f), f).not.toMatch(
        /from "(recharts|d3[^"]*|chart\.js|echarts|victory|visx[^"]*|maplibre-gl|@univerjs[^"]*)"/,
      );
    }
  });

  it("keeps the in-house chart under 14 KB of source", () => {
    expect(statSync(join(dir, "WidgetChart.tsx")).size).toBeLessThan(14 * 1024);
  });
});
