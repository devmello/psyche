import type { OnboardingResult } from "@psyche/ui";
import { describe, expect, it } from "vitest";
import { completeOnboarding } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

const result = (mail?: OnboardingResult["mail"]): OnboardingResult => ({
  persona: { name: "Wren", creatureId: "moth", creatureDescription: null, tagline: "" },
  permissions: { accessibility: "skipped", screenRecording: "skipped", notifications: "skipped" },
  connectors: [],
  model: {
    kind: "cloud",
    provider: "anthropic",
    modelRef: "anthropic/claude-sonnet-5-5",
    keyRef: null,
    toolCheck: "untested",
  },
  workspace: "local",
  ...(mail ? { mail } : {}),
});

function platform(fail: (method: string, params: unknown) => boolean = () => false) {
  const calls: { method: string; params: unknown }[] = [];
  const p = {
    gateway: {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (fail(method, params)) throw new Error("refused");
        if (method === "memory.read") return { content: "" };
        if (method === "threads.list") return { threads: [] };
        return {};
      },
    },
  } as unknown as ShellPlatform;
  return { p, calls };
}

const mail = { digest: true, prep: true, followups: false, voice: false, notes: true };
const settingWrites = (calls: { method: string; params: unknown }[]) =>
  calls
    .filter((c) => c.method === "settings.set")
    .map((c) => c.params as { key: string; value: unknown });

describe("completeOnboarding and the mail decision screen (§7.5)", () => {
  it("writes one setting per switch before it marks onboarding done", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, result(mail));
    const writes = settingWrites(calls);
    expect(writes.slice(0, -1).map((w) => [w.key, w.value])).toEqual([
      ["mail.digest.enabled", true],
      ["mail.digest.time", "07:30"],
      ["meetings.prep.enabled", true],
      ["mail.followups.enabled", false],
      ["mail.voice.enabled", false],
      ["meetings.notes.enabled", true],
    ]);
    expect(writes.at(-1)?.key).toBe("ui.onboarding.completedAt");
  });

  it("writes nothing for mail when the step was not offered", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, result());
    expect(settingWrites(calls).map((w) => w.key)).toEqual(["ui.onboarding.completedAt"]);
  });

  it("never blocks finishing when a mail setting is refused", async () => {
    const { p, calls } = platform(
      (m, params) =>
        m === "settings.set" && (params as { key: string }).key === "mail.digest.enabled",
    );
    await expect(completeOnboarding(p, result(mail))).resolves.toBeUndefined();
    expect(settingWrites(calls).at(-1)?.key).toBe("ui.onboarding.completedAt");
  });
});
