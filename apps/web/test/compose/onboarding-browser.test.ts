import { PsycheError } from "@psyche/protocol";
import type { OnboardingResult } from "@psyche/ui";
import { describe, expect, it } from "vitest";
import { completeOnboarding, ONBOARDED_KEY } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

const result = {
  persona: { name: "Wren", creatureId: "moth", creatureDescription: null, tagline: "" },
  permissions: { accessibility: "skipped", screenRecording: "skipped", notifications: "skipped" },
  connectors: [],
  model: {
    kind: "cloud",
    provider: "anthropic",
    modelRef: "m",
    keyRef: null,
    toolCheck: "untested",
  },
  owner: { name: "Sam", timeZone: "UTC", work: "", city: "" },
} as unknown as OnboardingResult;

/** A Gateway that refuses Memory files to this viewer, as it does for a browser. */
function gateway(kind: "web" | "desktop") {
  const calls: string[] = [];
  const settings: Record<string, unknown> = {};
  const platform = {
    kind,
    gateway: {
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        if (method.startsWith("memory."))
          throw new PsycheError(
            "forbidden",
            "Memory files open in the Psyche app on the Host only",
            {
              details: { reason: "not_desktop" },
            },
          );
        if (method === "settings.set") settings[String(params.key)] = params.value;
        if (method === "settings.get") {
          const keys = params.keys as string[];
          return { settings: Object.fromEntries(keys.map((k) => [k, settings[k]])) };
        }
        if (method === "threads.list") return { threads: [] };
        return {};
      },
    },
  } as unknown as ShellPlatform;
  return { platform, calls, settings };
}

describe("onboarding in a browser", () => {
  it("finishes without a Memory call, and a reload finds onboarding done", async () => {
    const g = gateway("web");
    await completeOnboarding(g.platform, result);
    expect(g.calls.filter((m) => m.startsWith("memory."))).toEqual([]);
    // The gate on the next load reads this key: set means chat, not step 7.
    const reload = (await g.platform.gateway.call("settings.get", { keys: [ONBOARDED_KEY] })) as {
      settings: Record<string, unknown>;
    };
    expect(Boolean(reload.settings[ONBOARDED_KEY])).toBe(true);
  });

  it("a viewer the Gateway refuses (a remote Mac) also finishes, after one refused read", async () => {
    const g = gateway("desktop");
    await completeOnboarding(g.platform, result);
    expect(g.calls.filter((m) => m.startsWith("memory."))).toEqual(["memory.read"]);
    expect(g.settings[ONBOARDED_KEY]).toBeTruthy();
  });

  it("another Memory failure still fails onboarding (positive control)", async () => {
    const g = gateway("desktop");
    const call = g.platform.gateway.call;
    g.platform.gateway.call = (async (m: string, p: never, o: never) => {
      if (m === "memory.read") throw new PsycheError("internal", "disk full");
      return call(m, p, o);
    }) as never;
    await expect(completeOnboarding(g.platform, result)).rejects.toThrow("disk full");
  });
});
