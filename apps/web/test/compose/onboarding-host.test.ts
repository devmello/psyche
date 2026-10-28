import type { OnboardingResult } from "@psyche/ui";
import { describe, expect, it, vi } from "vitest";
import {
  commitImport,
  createStarterAutomation,
  detectCompleted,
  loadProgress,
  previewImport,
  runWin,
  saveHabits,
  saveProgress,
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

describe("starter tasks", () => {
  it("runs one in a side chat and returns the settled answer", async () => {
    let polls = 0;
    const g = gateway({
      "threads.newChat": () => ({ thread: { id: "t1" } }),
      "chat.send": () => ({ messageId: "m1", runId: "r1", queued: false }),
      "chat.history": () => {
        polls++;
        return {
          messages: [
            { role: "agent", blocks: [{ type: "text", md: polls < 2 ? "Par" : "Partly sunny." }] },
          ],
        };
      },
    });
    const text = await runWin(g.call, "brief", { pollMs: 1, timeoutMs: 2000 });
    expect(text).toBe("Partly sunny.");
    const send = g.calls.find((c) => c.method === "chat.send");
    expect(send?.params.threadId).toBe("t1");
    expect(String(send?.params.content)).toContain("Read only");
  });

  it("throws when no answer arrives", async () => {
    const g = gateway({
      "threads.newChat": () => ({ thread: { id: "t1" } }),
      "chat.send": () => ({}),
      "chat.history": () => ({ messages: [] }),
    });
    await expect(runWin(g.call, "inbox", { pollMs: 1, timeoutMs: 20 })).rejects.toThrow(
      "no answer",
    );
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
    await saveProgress(g.call, { step: "memory", done: ["agent", "about"] });
    expect(await loadProgress(g.call)).toEqual({ step: "memory", done: ["agent", "about"] });
  });

  it("detects what is already set up and leaves the rest", async () => {
    const g = gateway({
      "memory.read": () => ({ content: "- Name: Sam\n- Timezone: America/Los_Angeles\n" }),
      "connectors.list": () => ({ connectors: [{ status: "connected" }] }),
      "memory.claims.list": () => ({ claims: [] }),
      "settings.get": () => ({ settings: {} }),
    });
    expect(await detectCompleted(g.call)).toEqual(["about", "connectors"]);
  });

  it("treats a failing check as not done", async () => {
    const g = gateway({});
    expect(await detectCompleted(g.call)).toEqual([]);
  });
});

describe("habits and automations", () => {
  it("writes each habit key and keeps going when one is refused", async () => {
    const g = gateway({
      "settings.set": (p) => {
        if (p.key === "habits.wrapup.enabled") throw new Error("forbidden");
        return {};
      },
    });
    await saveHabits(g.call, { brief: true, wrapup: true, followups: false });
    expect(g.calls.map((c) => c.params.key)).toEqual([
      "mail.digest.enabled",
      "mail.digest.time",
      "habits.wrapup.enabled",
      "mail.followups.enabled",
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
    workspace: "local",
    owner: { name: "Sam", timeZone: "America/Los_Angeles", work: "Student", city: "Santa Cruz" },
    habits: { brief: true, wrapup: false, followups: true },
  } as unknown as OnboardingResult;

  function run(options?: { rerun?: boolean }) {
    const writes: { path: string; content: string }[] = [];
    const sets: string[] = [];
    const platform = {
      gateway: {
        call: async (method: string, params: Record<string, unknown>) => {
          if (method === "memory.read")
            return {
              content:
                "# About the owner\n\n- Name:\n- Timezone:\n- Work or study:\n- Home city:\n",
            };
          if (method === "memory.write") writes.push(params as { path: string; content: string });
          if (method === "settings.set") sets.push(String(params.key));
          if (method === "threads.list") return { threads: [] };
          return {};
        },
      },
    } as unknown as ShellPlatform;
    return completeOnboarding(platform, base, undefined, options).then(() => ({ writes, sets }));
  }

  it("fills USER.md's structured fields and writes the habit switches", async () => {
    const { writes, sets } = await run();
    const user = writes.find((w) => w.path === "USER.md")?.content;
    expect(user).toContain("- Name: Sam");
    expect(user).toContain("- Timezone: America/Los_Angeles");
    expect(user).toContain("- Work or study: Student");
    expect(user).toContain("- Home city: Santa Cruz");
    expect(sets).toContain("mail.digest.enabled");
    expect(sets).toContain("habits.wrapup.enabled");
  });

  it("a re-run leaves IDENTITY.md alone", async () => {
    const { writes } = await run({ rerun: true });
    expect(writes.map((w) => w.path)).toEqual(["USER.md"]);
  });
});
