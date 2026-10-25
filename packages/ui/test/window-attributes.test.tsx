import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { medianFps } from "../src/motion/fps-probe.ts";
import {
  AppearanceProvider,
  REDUCE_TRANSPARENCY_SETTING,
  VIBRANCY_SETTING,
} from "../src/shell/AppearanceProvider.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const root = () => document.documentElement.dataset;

function mount(settings: Record<string, unknown>, supportsVibrancy: boolean) {
  return render(
    <StoryWorld edit={(w) => Object.assign(w.settings, settings)}>
      <AppearanceProvider supportsVibrancy={supportsVibrancy}>
        <p>content</p>
      </AppearanceProvider>
    </StoryWorld>,
  );
}

describe("window attributes (docs/design/redesign-2026.md §3.4, §4)", () => {
  it("marks vibrancy only where the host can draw the native material", async () => {
    mount({ [VIBRANCY_SETTING]: true }, true);
    await waitFor(() => expect(root().vibrancy).toBe("true"));
    cleanup();
    mount({ [VIBRANCY_SETTING]: true }, false);
    await waitFor(() => expect(root().vibrancy).toBe("false"));
  });

  it("follows the OS for transparency unless the owner chose", async () => {
    mount({}, false);
    await waitFor(() => expect(root().reduceTransparency).toBeUndefined());
    cleanup();
    mount({ [REDUCE_TRANSPARENCY_SETTING]: true }, false);
    await waitFor(() => expect(root().reduceTransparency).toBe("true"));
  });

  it("tracks whether the window is key", async () => {
    mount({}, false);
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(root().windowActive).toBe(String(document.hasFocus()));
  });
});

describe("the refresh-rate probe (docs/design/motion.md §5)", () => {
  it("reports the median frame interval as a rate", () => {
    expect(medianFps([8.33, 8.34, 8.3, 16.7])).toBe(120);
    expect(medianFps([16.6, 16.7, 16.8])).toBe(60);
    expect(medianFps([])).toBe(0);
  });
});
