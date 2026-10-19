import { composeStories, setProjectAnnotations } from "@storybook/react-vite";
import { act, render } from "@testing-library/react";
import axe from "axe-core";
import type { ComponentType } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import * as previewAnnotations from "../.storybook/preview.tsx";

/**
 * Renders every story in every `*.stories.tsx` file and runs axe-core on it, so accessibility is
 * checked in CI by `pnpm -r test`. jsdom cannot compute colors, so contrast is covered by the
 * theme generator's WCAG gate and the visual baseline instead.
 */

type StoryModule = Record<string, unknown> & { default: { title?: string } };
const modules = import.meta.glob<StoryModule>("../src/**/*.stories.tsx", { eager: true });

beforeAll(() => {
  setProjectAnnotations(previewAnnotations);
});

const AXE_OPTIONS: axe.RunOptions = {
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
    "landmark-one-main": { enabled: false },
    "page-has-heading-one": { enabled: false },
  },
};

describe.each(Object.entries(modules))("%s", (_path, mod) => {
  const stories = composeStories(mod as Parameters<typeof composeStories>[0]) as Record<
    string,
    ComponentType
  >;
  it.each(Object.entries(stories))("%s renders without axe violations", async (_name, Story) => {
    const { container } = render(<Story />);
    // Let loaders, effects and mock Gateway responses settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.innerHTML.length).toBeGreaterThan(0);
    const result = await axe.run(container, AXE_OPTIONS);
    const violations = result.violations.map(
      (v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    );
    expect(violations).toEqual([]);
  });
});
