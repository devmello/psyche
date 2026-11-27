import { describe, expect, it } from "vitest";
import { enableSearchSources, searchSourcesFor } from "../../src/compose/onboarding-search.ts";
import { completeOnboarding } from "../../src/compose/PsycheApp.tsx";
import type { ShellPlatform } from "../../src/shell/platform.ts";

/** "Make these searchable": the sources for what was connected, through search.sources.configure. */

describe("searchSourcesFor", () => {
  it.each([
    [["apple:mail"], ["mail"]],
    [
      ["apple:calendar", "apple:reminders", "apple:notes"],
      ["calendar", "reminders", "notes"],
    ],
    [["google"], ["mail", "calendar"]],
    [
      ["google", "apple:mail"],
      ["mail", "calendar"],
    ],
    [["imap"], ["mail"]],
    [["apple:messages"], ["messages"]],
    // Near misses: connecting Mail never turns on Messages, files or the browser.
    [["apple:mail"], ["mail"]],
    [["obsidian", "slack", "unknown"], []],
    [[], []],
  ])("%j makes %j searchable", (types, expected) => {
    expect(searchSourcesFor(types)).toEqual(expected);
  });
});

describe("enableSearchSources", () => {
  it("switches each matching source on, once, with the existing setting", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const enabled = await enableSearchSources(
      async (method, params) => {
        calls.push({ method, params });
        return {};
      },
      ["google", "apple:notes"],
    );
    expect(enabled).toEqual(["mail", "calendar", "notes"]);
    expect(calls).toEqual([
      { method: "search.sources.configure", params: { source: "mail", enabled: true } },
      { method: "search.sources.configure", params: { source: "calendar", enabled: true } },
      { method: "search.sources.configure", params: { source: "notes", enabled: true } },
    ]);
  });

  it("a source that cannot be switched on does not stop the rest", async () => {
    const enabled = await enableSearchSources(
      async (_m, params) => {
        if ((params as { source: string }).source === "mail") throw new Error("not now");
        return {};
      },
      ["google"],
    );
    expect(enabled).toEqual(["calendar"]);
  });

  it("switches nothing on when nothing was connected (positive control above)", async () => {
    let n = 0;
    await enableSearchSources(async () => {
      n += 1;
      return {};
    }, []);
    expect(n).toBe(0);
  });
});

describe("completeOnboarding turns on search for the connected accounts", () => {
  const base = {
    persona: { name: "Wren", creatureId: "moth", creatureDescription: null, tagline: "" },
    permissions: { accessibility: "skipped", screenRecording: "skipped", notifications: "skipped" },
    model: {
      kind: "cloud",
      provider: "anthropic",
      modelRef: "anthropic/claude-sonnet-5-5",
      keyRef: null,
      toolCheck: "untested",
    },
  };
  const google = { type: "google", label: "Google", mode: "read" };
  const platform = () => {
    const calls: { method: string; params: unknown }[] = [];
    const p = {
      gateway: {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "memory.read") return { content: "" };
          if (method === "threads.list") return { threads: [] };
          return {};
        },
      },
    } as unknown as ShellPlatform;
    return { p, calls };
  };
  const sourceCalls = (calls: { method: string; params: unknown }[]) =>
    calls.filter((c) => c.method === "search.sources.configure").map((c) => c.params);

  it("on by default: the sources for each connected account, before onboarding is marked done", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, { ...base, connectors: [google], searchable: true } as never);
    expect(sourceCalls(calls)).toEqual([
      { source: "mail", enabled: true },
      { source: "calendar", enabled: true },
    ]);
    const done = calls.findIndex(
      (c) => (c.params as { key?: string })?.key === "ui.onboarding.completedAt",
    );
    expect(calls.findIndex((c) => c.method === "search.sources.configure")).toBeLessThan(done);
  });

  it("an account that is not connected yet makes nothing searchable", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, {
      ...base,
      connectors: [{ ...google, status: "needs_auth" }],
      searchable: true,
    } as never);
    expect(sourceCalls(calls)).toEqual([]);
  });

  it("the owner's switch off writes nothing", async () => {
    const { p, calls } = platform();
    await completeOnboarding(p, { ...base, connectors: [google], searchable: false } as never);
    expect(sourceCalls(calls)).toEqual([]);
  });

  it("a re-run never switches a source back on", async () => {
    const { p, calls } = platform();
    await completeOnboarding(
      p,
      { ...base, connectors: [google], searchable: true } as never,
      undefined,
      { rerun: true },
    );
    expect(sourceCalls(calls)).toEqual([]);
  });
});
