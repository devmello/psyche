import { describe, expect, it, vi } from "vitest";
import { fixTouchId } from "../../src/compose/helper.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/** An approval card's Touch ID fixes on the desktop: start the helper, register its key. */

function platform(over: { launch?: () => Promise<unknown>; nodes?: unknown[] } = {}) {
  const call = vi.fn(async (method: string) =>
    method === "nodes.list" ? { nodes: over.nodes ?? [] } : { presenceKey: { keyId: "k" } },
  );
  const p = {
    gateway: { call },
    helper: { getState: vi.fn(), onState: vi.fn(), launch: over.launch },
  } as unknown as ShellPlatform;
  return { p, call };
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

  it("register_key registers the online helper's key", async () => {
    const { p, call } = platform({
      nodes: [
        { kind: "mac-helper", status: "offline", deviceId: "old" },
        { kind: "mac-helper", status: "online", deviceId: "dev_helper" },
      ],
    });
    await fixTouchId(p, "register_key");
    expect(call).toHaveBeenLastCalledWith("devices.presenceKey.register", {
      deviceId: "dev_helper",
    });
    await expect(fixTouchId(platform().p, "register_key")).rejects.toThrow(/did not connect/);
  });
});
