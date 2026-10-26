import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GLASS_PRESET_SETTING, GLASS_TINT_SETTING } from "../src/lib/glass-settings.ts";
import { medianFps } from "../src/motion/fps-probe.ts";
import {
  AppearanceProvider,
  REDUCE_TRANSPARENCY_SETTING,
} from "../src/shell/AppearanceProvider.tsx";
import { StoryWorld } from "../src/stories/harness.tsx";

afterEach(cleanup);

const root = () => document.documentElement.dataset;

function mount(
  settings: Record<string, unknown>,
  system: { reduceTransparency: boolean; highContrast: boolean } | null = null,
) {
  return render(
    <StoryWorld
      edit={(w) => {
        Object.assign(w.settings, settings);
        // `undefined` means "the owner never chose": drop the fixture's value.
        for (const [k, v] of Object.entries(settings)) if (v === undefined) delete w.settings[k];
      }}
    >
      <AppearanceProvider system={system}>
        <p>content</p>
      </AppearanceProvider>
    </StoryWorld>,
  );
}

describe("window attributes (docs/design/redesign-2026.md §3.4, §4)", () => {
  it("applies the Translucency preset and values to the root (#597)", async () => {
    mount({ [GLASS_PRESET_SETTING]: "clear", [GLASS_TINT_SETTING]: 50 });
    await waitFor(() => expect(root().glassPreset).toBe("clear"));
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--glass-tint")).toBe("50%");
    expect(style.getPropertyValue("--glass-blur")).toBe("10px");
    expect(style.getPropertyValue("--glass-refraction")).toBe("1.3");
    cleanup();
    expect(style.getPropertyValue("--glass-tint")).toBe("");
  });

  it("follows the OS for transparency unless the owner chose", async () => {
    mount({});
    await waitFor(() => expect(root().reduceTransparency).toBeUndefined());
    cleanup();
    mount({ [REDUCE_TRANSPARENCY_SETTING]: true });
    await waitFor(() => expect(root().reduceTransparency).toBe("true"));
  });

  it("applies macOS Reduce Transparency and Increase Contrast unless the owner chose", async () => {
    mount(
      { "appearance.contrast": undefined },
      {
        reduceTransparency: true,
        highContrast: true,
      },
    );
    await waitFor(() => expect(root().reduceTransparency).toBe("true"));
    await waitFor(() => expect(root().contrast).toBe("high"));
    cleanup();
    mount(
      { [REDUCE_TRANSPARENCY_SETTING]: false, "appearance.contrast": "standard" },
      {
        reduceTransparency: true,
        highContrast: true,
      },
    );
    await waitFor(() => expect(root().reduceTransparency).toBe("false"));
    await waitFor(() => expect(root().contrast).toBe("standard"));
  });

  it("tracks whether the window is key", async () => {
    mount({});
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
