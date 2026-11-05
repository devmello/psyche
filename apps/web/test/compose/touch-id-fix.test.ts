import { describe, expect, it, vi } from "vitest";
import { fixTouchId } from "../../src/compose/helper.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/**
 * An approval card's Touch ID fixes on the desktop: start the helper, or open Settings → Devices.
 * Neither registers a key or approves anything on its own (security review, finding 1).
 */

function platform(over: { launch?: () => Promise<unknown> } = {}) {
  const call = vi.fn(async () => ({}));
  const openSettings = vi.fn();
  const p = {
    gateway: { call },
    helper: { getState: vi.fn(), onState: vi.fn(), launch: over.launch },
    windows: { openSettings },
  } as unknown as ShellPlatform;
  return { p, call, openSettings };
}

describe("fixTouchId", () => {
  it("start_helper launches through main and fails when it did not pair", async () => {
    const launch = vi.fn(async () => ({ kind: "paired" }));
    await fixTouchId(platform({ launch }).p, "start_helper");
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(
      fixTouchId(platform({ launch: async () => ({ kind: "offline" }) }).p, "start_helper"),
    ).rejects.toThrow(/did not connect/);
  });

  it("restart_helper asks main to restart it and fails when it did not pair again", async () => {
    const launch = vi.fn(async () => ({ kind: "paired" }));
    await fixTouchId(platform({ launch }).p, "restart_helper");
    expect(launch).toHaveBeenCalledWith(true);
    await expect(
      fixTouchId(platform({ launch: async () => ({ kind: "offline" }) }).p, "restart_helper"),
    ).rejects.toThrow(/did not connect/);
  });

  it("open_devices only opens Settings → Devices: no registration, no Gateway call", async () => {
    const { p, call, openSettings } = platform();
    await fixTouchId(p, "open_devices");
    expect(openSettings).toHaveBeenCalledWith("devices");
    expect(call).not.toHaveBeenCalled();
  });
});
