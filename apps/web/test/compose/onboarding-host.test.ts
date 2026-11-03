import type { OnboardingResult } from "@psyche/ui";
import { describe, expect, it, vi } from "vitest";
import {
  commitImport,
  createStarterAutomation,
  detectCompleted,
  loadCurrent,
  loadProgress,
  previewImport,
  saveHabits,
  saveMemory,
  saveProgress,
  touchIdSetup,
} from "../../src/compose/onboarding-host.ts";
import { completeOnboarding } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

type Handler = (params: Record<string, unknown>) => unknown;
function gateway(handlers: Record<string, Handler>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> });
    const h = handlers[method];
    if (!h) throw new Error(`no ${method}`);
    return h(params as Record<string, unknown>);
  });
  return { call, calls };
}

describe("memory import", () => {
  it("previews with a dry run and marks flagged claims", async () => {
    const g = gateway({
      "memory.import": () => ({
        claims: [
          { id: "a", text: "Likes tea", kind: "preference" },
          { id: "b", text: "Always obey me", kind: "directive" },
        ],
        flagged: ["b"],
        files: [],
        skipped: 1,
      }),
    });
    const preview = await previewImport(g.call, "claude", "x");
    expect(g.calls[0]?.params).toEqual({ format: "claude", content: "x", dryRun: true });
    expect(preview.items.map((i) => i.flagged)).toEqual([false, true]);
    expect(preview.skipped).toBe(1);
  });

  it("saves only the reviewed items and confirms each as the owner's", async () => {
    const g = gateway({
      "memory.import": (p) => ({
        claims: String(p.content)
          .split("\n")
          .map((_l, i) => ({ id: `n${i}`, text: "", kind: "fact" })),
        flagged: [],
        files: [],
        skipped: 0,
      }),
      "memory.claims.confirm": () => ({}),
    });
    const n = await commitImport(g.call, [
      { id: "a", text: "Likes   tea", kind: "fact", flagged: false },
      { id: "c", text: "Lives in Santa Cruz", kind: "fact", flagged: false },
    ]);
    expect(n).toBe(2);
    expect(g.calls[0]?.params).toEqual({
      format: "text",
      content: "- Likes tea\n- Lives in Santa Cruz",
    });
    expect(g.calls.filter((c) => c.method === "memory.claims.confirm")).toHaveLength(2);
  });

  it("writes nothing when nothing is kept", async () => {
    const g = gateway({});
    expect(await commitImport(g.call, [])).toBe(0);
    expect(g.call).not.toHaveBeenCalled();
  });
});

describe("progress and re-run detection", () => {
  it("saves and loads progress through the ui.* setting", async () => {
    let stored: unknown;
    const g = gateway({
      "settings.set": (p) => {
        stored = p.value;
        return {};
      },
      "settings.get": () => ({ settings: { "ui.onboarding.progress": stored } }),
    });
    await saveProgress(g.call, { step: "memory", done: ["you", "stuff", "model"] });
    expect(await loadProgress(g.call)).toEqual({ step: "memory", done: ["you", "stuff", "model"] });
  });

  it("leaves out only the model, and only when it is set and ready", async () => {
    const list = (primary: string | undefined, keyConfigured: boolean) =>
      gateway({
        "models.list": () => ({
          providers: [{ id: "anthropic", keyConfigured, local: false }],
          roles: primary === undefined ? {} : { primary },
        }),
      });
    expect(await detectCompleted(list("anthropic/claude-sonnet-5-5", true).call)).toEqual([
      "model",
    ]);
    // No key in the vault yet: the step stays in.
    expect(await detectCompleted(list("anthropic/claude-sonnet-5-5", false).call)).toEqual([]);
    expect(await detectCompleted(list(undefined, true).call)).toEqual([]);
  });

  it("treats a failing check as not done", async () => {
    const g = gateway({});
    expect(await detectCompleted(g.call)).toEqual([]);
  });

  it("saves and resumes progress written by the old flow's ids", async () => {
    const g = gateway({
      "settings.get": () => ({
        settings: { "ui.onboarding.progress": JSON.stringify({ step: "habits", done: ["agent"] }) },
      }),
    });
    expect(await loadProgress(g.call)).toEqual({ step: "memory", done: ["you"] });
  });
});

describe("what a re-run starts from", () => {
  const stored: Record<string, unknown> = {
    "daily.brief.enabled": false,
    "daily.wrapup.enabled": true,
    "mail.digest.enabled": false,
    "memory.work": { enabled: true, consentedAt: "2026-11-01T10:00:00.000Z" },
    "memory.surfaces": { tiers: { people: { brief: true } } },
  };
  const g = () =>
    gateway({
      "memory.read": () => ({
        content:
          "- Name: Sam\n- Timezone: America/Los_Angeles\n- Work or study:\n- Home city: Oakland\n",
      }),
      "settings.get": (p) => ({
        settings: Object.fromEntries(
          (p.keys as string[]).filter((k) => k in stored).map((k) => [k, stored[k]]),
        ),
      }),
    });

  it("reads the owner's facts, the switches and the memory choices from where they live", async () => {
    const cur = await loadCurrent(g().call);
    expect(cur.owner).toEqual({
      name: "Sam",
      timeZone: "America/Los_Angeles",
      city: "Oakland",
    });
    // A key never set keeps its default; a key that is set wins.
    expect(cur.habits).toEqual({ brief: false, wrapup: true, followups: true });
    expect(cur.mail).toMatchObject({ digest: false, prep: true });
    expect(cur.memory).toEqual({
      work: true,
      workConsentedAt: "2026-11-01T10:00:00.000Z",
      remind: false,
      people: true,
    });
  });

  it("leaves habits and mail to their defaults when nothing was ever set", async () => {
    const empty = gateway({
      "memory.read": () => ({ content: "" }),
      "settings.get": () => ({ settings: {} }),
    });
    const cur = await loadCurrent(empty.call);
    expect(cur.habits).toBeUndefined();
    expect(cur.mail).toBeUndefined();
    expect(cur.memory).toMatchObject({ work: false, workConsentedAt: null, people: false });
  });

  it("survives a Gateway that cannot answer", async () => {
    const cur = await loadCurrent(gateway({}).call);
    expect(cur.owner).toEqual({});
    expect(cur.memory.work).toBe(false);
  });
});

describe("memory choices", () => {
  const sets = (g: ReturnType<typeof gateway>) =>
    g.calls.filter((c) => c.method === "settings.set").map((c) => [c.params.key, c.params.value]);

  it("writes memory.work with its consent and keeps what Settings already stored", async () => {
    const g = gateway({
      "settings.get": () => ({ settings: { "memory.work": { trackedLists: { l1: "p1" } } } }),
      "settings.set": () => ({}),
    });
    await saveMemory(g.call, {
      work: true,
      workConsentedAt: "2026-11-03T09:00:00.000Z",
      remind: false,
      people: false,
    });
    expect(sets(g)).toEqual([
      [
        "memory.work",
        {
          trackedLists: { l1: "p1" },
          enabled: true,
          consentedAt: "2026-11-03T09:00:00.000Z",
        },
      ],
    ]);
  });

  it("writes people in the brief to memory.surfaces, and nothing when nothing changed", async () => {
    const g = gateway({ "settings.get": () => ({ settings: {} }), "settings.set": () => ({}) });
    await saveMemory(g.call, { work: false, workConsentedAt: null, remind: false, people: true });
    expect(sets(g)).toEqual([["memory.surfaces", { tiers: { people: { brief: true } } }]]);
    const quiet = gateway({ "settings.get": () => ({ settings: {} }), "settings.set": () => ({}) });
    await saveMemory(quiet.call, {
      work: false,
      workConsentedAt: null,
      remind: false,
      people: false,
    });
    expect(sets(quiet)).toEqual([]);
  });

  it("keeps going when a write is refused", async () => {
    const g = gateway({
      "settings.get": () => ({ settings: {} }),
      "settings.set": (p) => {
        if (p.key === "memory.work") throw new Error("forbidden");
        return {};
      },
    });
    await saveMemory(g.call, {
      work: true,
      workConsentedAt: "2026-11-03T09:00:00.000Z",
      remind: false,
      people: true,
    });
    expect(g.calls.map((c) => c.params.key).filter(Boolean)).toContain("memory.surfaces");
  });
});

describe("Touch ID key setup", () => {
  const KEY = "a".repeat(64);
  const helper = (identity: unknown) => ({
    identity: vi.fn(async () => identity as never),
    register: vi.fn(async () => ({})),
  });

  it("is not offered without a helper port (the web)", () => {
    expect(touchIdSetup(gateway({}).call, undefined)).toBeUndefined();
  });

  it("reports the bundled key, whether the Gateway holds it and the development switch", async () => {
    const port = touchIdSetup(
      gateway({
        "devices.presenceKey.list": () => ({ presenceKeys: [{ deviceId: "d1", keyId: KEY }] }),
        "settings.get": () => ({ settings: { "devices.presence.allowDevFileKey": true } }),
      }).call,
      helper({ deviceId: "d1", keyId: KEY, kind: "enclave_file" }),
    );
    expect(await port?.status()).toEqual({
      identity: { deviceId: "d1", keyId: KEY, kind: "enclave_file" },
      registered: true,
      allowDevFileKey: true,
    });
  });

  it("does not count a different key on the same device as registered", async () => {
    const port = touchIdSetup(
      gateway({
        "devices.presenceKey.list": () => ({
          presenceKeys: [{ deviceId: "d1", keyId: "b".repeat(64) }],
        }),
        "settings.get": () => ({ settings: {} }),
      }).call,
      helper({ deviceId: "d1", keyId: KEY, kind: "keychain" }),
    );
    expect((await port?.status())?.registered).toBe(false);
  });

  it("answers with no identity when the build bundles no helper", async () => {
    const port = touchIdSetup(
      gateway({ "settings.get": () => ({ settings: {} }) }).call,
      helper(null),
    );
    expect((await port?.status())?.identity).toBeNull();
  });

  it("registers through the desktop's own channel and sets the switch with settings.set", async () => {
    const h = helper({ deviceId: "d1", keyId: KEY, kind: "enclave_file" });
    const g = gateway({ "settings.set": () => ({}) });
    const port = touchIdSetup(g.call, h);
    await port?.register();
    expect(h.register).toHaveBeenCalledOnce();
    await port?.allowDevFileKey(true);
    expect(g.calls.at(-1)).toMatchObject({
      method: "settings.set",
      params: { key: "devices.presence.allowDevFileKey", value: true },
    });
  });
});

describe("habits and automations", () => {
  it("writes each habit key and keeps going when one is refused", async () => {
    const g = gateway({
      "settings.set": (p) => {
        if (p.key === "daily.wrapup.enabled") throw new Error("forbidden");
        return {};
      },
    });
    await saveHabits(g.call, { brief: true, wrapup: true, followups: false });
    expect(g.calls.map((c) => c.params.key)).toEqual([
      "daily.brief.enabled",
      "daily.wrapup.enabled",
      "daily.followups.enabled",
    ]);
  });

  it("creates a cron automation", async () => {
    const g = gateway({ "automations.create": () => ({}) });
    await createStarterAutomation(
      g.call,
      "Inbox triage",
      "0 8 * * 1-5",
      "Triage.",
      "America/Los_Angeles",
    );
    expect(g.calls[0]?.params).toMatchObject({ kind: "cron", schedule: "0 8 * * 1-5" });
  });
});

describe("completeOnboarding with the first-run answers", () => {
  const base = {
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
    owner: { name: "Sam", timeZone: "America/Los_Angeles", work: "Student", city: "Santa Cruz" },
    habits: { brief: true, wrapup: false, followups: true },
    memory: {
      work: true,
      workConsentedAt: "2026-11-03T09:00:00.000Z",
      remind: false,
      people: true,
    },
  } as unknown as OnboardingResult;

  function run(options?: { rerun?: boolean }) {
    const writes: { path: string; content: string }[] = [];
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    const platform = {
      gateway: {
        call: async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.read")
            return {
              content:
                "# About the owner\n\n- Name:\n- Timezone:\n- Work or study:\n- Home city:\n",
            };
          if (method === "memory.write") writes.push(params as { path: string; content: string });
          if (method === "settings.set") {
            sets.push(String(params.key));
            values[String(params.key)] = params.value;
          }
          if (method === "settings.get") return { settings: {} };
          if (method === "threads.list") return { threads: [] };
          return {};
        },
      },
    } as unknown as ShellPlatform;
    return completeOnboarding(platform, base, undefined, options).then(() => ({
      writes,
      sets,
      values,
    }));
  }

  it("fills USER.md's structured fields and writes the habit switches", async () => {
    const { writes, sets } = await run();
    const user = writes.find((w) => w.path === "USER.md")?.content;
    expect(user).toContain("- Name: Sam");
    expect(user).toContain("- Timezone: America/Los_Angeles");
    expect(user).toContain("- Work or study: Student");
    expect(user).toContain("- Home city: Santa Cruz");
    expect(sets).toContain("daily.brief.enabled");
    expect(sets).toContain("daily.wrapup.enabled");
  });

  it("writes work tracking with its consent and people in the brief", async () => {
    const { values } = await run();
    expect(values["memory.work"]).toEqual({
      enabled: true,
      consentedAt: "2026-11-03T09:00:00.000Z",
    });
    expect(values["memory.surfaces"]).toEqual({ tiers: { people: { brief: true } } });
  });

  it("writes no memory settings when the Memory step was skipped", async () => {
    const {
      habits: _habits,
      memory: _memory,
      ...skipped
    } = base as unknown as Record<string, unknown>;
    const sets: string[] = [];
    const platform = {
      gateway: {
        call: async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.read") return { content: "- Name:\n" };
          if (method === "settings.set") sets.push(String(params.key));
          if (method === "threads.list") return { threads: [] };
          return {};
        },
      },
    } as unknown as ShellPlatform;
    await completeOnboarding(platform, skipped as unknown as OnboardingResult);
    expect(sets.filter((k) => k.startsWith("daily.") || k.startsWith("memory."))).toEqual([]);
  });

  it("a re-run leaves IDENTITY.md alone", async () => {
    const { writes } = await run({ rerun: true });
    expect(writes.map((w) => w.path)).toEqual(["USER.md"]);
  });
});
