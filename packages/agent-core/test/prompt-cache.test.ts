import type { ModelRequest, ToolSpec } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import {
  assembleContext,
  DEFAULT_CONTEXT_BUDGETS,
  renderSystemParts,
  renderSystemPrompt,
  type TurnContextProvider,
} from "../src/index.ts";
import { call, type Harness, harness, recorder, runTurn, say, spec } from "./harness.ts";

/**
 * Cache-stable prompt (research-harness-tokens PR 2), at the loop: what each request carries so
 * the provider can keep its prompt cache. model-router's prompt-cache.test.ts checks the bytes
 * the Anthropic request then has.
 */

const head = (r: ModelRequest | undefined) => r?.system?.slice(0, r.systemStableLength);
const tail = (r: ModelRequest | undefined) => r?.system?.slice(r.systemStableLength);
const names = (tools: ToolSpec[] | undefined) => (tools ?? []).map((t) => t.name);

/** Recall that depends on what the owner typed, as the Gateway's providers do. */
const recall: TurnContextProvider = {
  name: "memory",
  async provide(input) {
    return {
      sections: [{ title: "Recalled", text: `About "${input.text}": Ana prefers mornings.` }],
      source: { sourceKind: "memory", origin: "memory" },
    };
  },
};

/** A tool that appends to today's note mid-turn, as the memory tool does. */
function withNoteTool(h: Harness) {
  h.loop.registry.register({
    spec: spec("note.append", "none"),
    execute: async () => {
      await h.memory.appendDailyNote({ text: "standup moved to 10:00", provenance: "agent" });
      return { output: { appended: true }, provenance: "trusted" };
    },
  });
}

describe("cache-stable prompt: the loop's requests", () => {
  it("marks the stable head: base prompt to the tools section, nothing dated or per-turn", async () => {
    const h = harness({
      script: [say("ok")],
      files: { "memory/2026-01-01.md": "- 09:00 standup" },
      loop: { contextProviders: [recall] },
    });
    await runTurn(h, "plan my day");
    const r = h.provider.requests[0];
    expect(r?.systemStableLength).toBeGreaterThan(0);
    expect(head(r)).toMatch(/<section id="tools"[^>]*>[\s\S]*<\/section>$/);
    expect(head(r)).not.toContain("daily:");
    expect(head(r)).not.toContain("Ana prefers mornings");
    // The tail starts after the blank line that joined the sections: the text is unchanged.
    expect(tail(r)?.startsWith("\n\n")).toBe(true);
    expect(tail(r)).toContain("Ana prefers mornings");
  });

  it("keeps the stable head across owner turns with different recall", async () => {
    const h = harness({ script: [say("one"), say("two")], loop: { contextProviders: [recall] } });
    await runTurn(h, "plan my day");
    await runTurn(h, "draft a reply to Ana");
    const [r0, r1] = h.provider.requests;
    expect(head(r1)).toBe(head(r0));
    expect(tail(r1)).not.toBe(tail(r0));
  });

  it("does not re-render a daily-note append until the next run (steps keep the same system)", async () => {
    const h = harness({ script: [call("c1", "note.append", {}), say("noted"), say("next")] });
    withNoteTool(h);
    await runTurn(h, "move standup");
    await runTurn(h, "what's on today?");
    const [s1, s2, next] = h.provider.requests;
    expect(s1?.system).not.toContain("standup moved");
    // Same run: the system prompt is byte-identical although today's note changed.
    expect(s2?.system).toBe(s1?.system);
    // The next run reads the note again; only the volatile tail changes.
    expect(next?.system).toContain("standup moved to 10:00");
    expect(head(next)).toBe(head(s1));
  });

  it("sends every deferrable tool in deferredTools, unchanged by a load", async () => {
    const h = harness({
      script: [call("c1", "load_tools", { names: ["weather.forecast"] }), say("loaded")],
      loop: { deferTool: (s) => s.name.startsWith("weather.") },
    });
    h.loop.registry.register({
      spec: spec("weather.forecast", "read"),
      execute: recorder().execute,
    });
    h.loop.registry.register({ spec: spec("weather.alerts", "read"), execute: recorder().execute });
    await runTurn(h, "weather?");
    const [r0, r1] = h.provider.requests;
    expect(names(r0?.deferredTools)).toEqual(["weather.forecast", "weather.alerts"]);
    expect(r1?.deferredTools).toEqual(r0?.deferredTools);
    // Providers without deferred loading still get the loaded tool in `tools`, as before.
    expect(names(r0?.tools)).not.toContain("weather.forecast");
    expect(names(r1?.tools).at(-1)).toBe("weather.forecast");
    expect(r1?.system).toBe(r0?.system);
    expect(r1?.systemStableLength).toBe(r0?.systemStableLength);
  });

  it("sends no deferredTools when nothing is deferred", async () => {
    const h = harness({ script: [say("ok")] });
    await runTurn(h, "hi");
    expect(h.provider.requests[0]?.deferredTools).toBeUndefined();
  });

  it("gives two threads the same stable head", async () => {
    const h = harness({ script: [say("a"), say("b")], loop: { contextProviders: [recall] } });
    await runTurn(h, "plan my day", { threadId: "thr_a" });
    await runTurn(h, "book a table", { threadId: "thr_b" });
    const [a, b] = h.provider.requests;
    expect(head(b)).toBe(head(a));
  });
});

describe("renderSystemParts", () => {
  it("renders exactly renderSystemPrompt and splits after the leading stable sections", async () => {
    const { sections } = await assembleContext({
      basePrompt: "You are Psyche.",
      tools: [spec("notes.read", "read")],
      permissionMode: "balanced",
      runMode: "attended",
      now: Date.parse("2026-11-19T09:00:00Z"),
      timeZone: "UTC",
      summary: { text: "Earlier: the owner planned a trip.", untrusted: false },
      budgets: DEFAULT_CONTEXT_BUDGETS,
    });
    sections.push({ id: "context:memory:0", kind: "hook", title: "Recalled", text: "Ana." });
    const { system, stableLength } = renderSystemParts(sections);
    expect(system).toBe(renderSystemPrompt(sections));
    const stable = sections.filter((s) => ["base", "persona", "skills", "tools"].includes(s.kind));
    expect(system.slice(0, stableLength)).toBe(renderSystemPrompt(stable));
    expect(system.slice(stableLength)).toBe(
      `\n\n${renderSystemPrompt(sections.slice(stable.length))}`,
    );
  });

  it("puts nothing in the head when the first section is volatile, everything when none is", () => {
    const hook = { id: "h", kind: "hook" as const, title: "Hook", text: "x" };
    const base = { id: "base", kind: "base" as const, title: "Base", text: "You are Psyche." };
    expect(renderSystemParts([hook, base]).stableLength).toBe(0);
    const all = renderSystemParts([base]);
    expect(all.stableLength).toBe(all.system.length);
  });
});
