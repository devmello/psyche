import type { ModelMessage, ModelRequest, ToolSpec } from "@psyche/protocol";
import { collect } from "@psyche/testing";
import { describe, expect, it } from "vitest";
import { convertRequest } from "../src/convert-request.ts";
import { accumulate, type ProviderConfig } from "../src/index.ts";
import { fakeKey, makeAdapter, weatherTool } from "./helpers/adapters.ts";
import {
  type AnthropicBody,
  assertPrefixStable,
  breakpointProblems,
  breakpoints,
  positions,
  prefixDiff,
} from "./helpers/prefix-stability.ts";
import { loadFixture, replayFetch } from "./helpers/replay.ts";

/**
 * Cache-stable prompt (research-harness-tokens PR 2). The requests below have the shape the agent
 * loop sends (`system` = stable head + "\n\n" + volatile tail with `systemStableLength`, loaded
 * tools appended to `tools`, every deferrable tool in `deferredTools`). Each goes through the
 * real Anthropic provider package; the assertions read the captured HTTP body.
 */

const REF = "anthropic/claude-haiku-5-5";
const KEY = { secret: fakeKey("anthropic-cache"), origin: "https://api.anthropic.com" };
/** Deferred loading is off by default until a live smoke test; these tests turn it on. */
const CONFIG: ProviderConfig = { id: "anthropic", kind: "anthropic", deferLoading: true };
/** The shipped default: no `deferLoading`. */
const DEFAULT: ProviderConfig = { id: "anthropic", kind: "anthropic" };

const tool = (name: string, description = `The ${name} tool`): ToolSpec => ({
  ...weatherTool,
  name,
  description,
});
const CORE = [tool("ask_user"), tool("tool_search"), tool("load_tools"), tool("notes.read")];
const FORECAST = tool("weather.forecast", "Hourly forecast for a city");
const ALERTS = tool("weather.alerts", "Severe weather alerts");
const DEFERRED = [FORECAST, ALERTS];

const STABLE = [
  "You are Psyche, the owner's personal agent.",
  '<section id="persona:SOUL.md" source="SOUL.md" title="SOUL.md">\nBe brief.\n</section>',
  '<section id="tools" title="Tools">\n- ask_user (none)\nLoaded on demand (2; their schemas are not above): weather.forecast, weather.alerts.\n</section>',
].join("\n\n");
const note = (lines: string) =>
  `<section id="daily:2026-11-19" source="memory/2026-11-19.md" title="Today (2026-11-19)">\n${lines}\n</section>`;
const recall = (text: string) =>
  `<section id="context:memory:0" source="context:memory" title="Recalled">\n${text}\n</section>`;
const system = (volatile: string): Pick<ModelRequest, "system" | "systemStableLength"> => ({
  system: `${STABLE}\n\n${volatile}`,
  systemStableLength: STABLE.length,
});

const user = (text: string): ModelMessage => ({ role: "user", parts: [{ type: "text", text }] });
const callOf = (id: string, name: string, input: unknown): ModelMessage => ({
  role: "assistant",
  parts: [{ type: "tool_call", id, name, input }],
});
const resultOf = (id: string, name: string, output: unknown): ModelMessage => ({
  role: "tool",
  parts: [{ type: "tool_result", callId: id, name, output, provenance: "trusted" }],
});
const LOADED = { loaded: ["weather.forecast"], already: [], unknown: [] };

async function send(
  request: Omit<ModelRequest, "model">,
  config: ProviderConfig = CONFIG,
): Promise<AnthropicBody> {
  const replay = replayFetch(loadFixture("anthropic/text.json"));
  const { adapter } = makeAdapter(config, replay.fetch, KEY);
  await collect(adapter.stream({ model: REF, ...request }));
  return replay.requests[0]?.body as AnthropicBody;
}

/** One owner turn that loads a deferred tool mid-turn: the three requests the loop sends. */
function turnWithLoad(volatile = note("- 09:00 standup")) {
  const s1 = {
    ...system(volatile),
    messages: [user("Weather in Lisbon?")],
    tools: CORE,
    deferredTools: DEFERRED,
  };
  const s2 = {
    ...s1,
    messages: [
      ...s1.messages,
      callOf("c1", "load_tools", { names: ["weather.forecast"] }),
      resultOf("c1", "load_tools", LOADED),
    ],
    tools: [...CORE, FORECAST],
  };
  const s3 = {
    ...s2,
    messages: [
      ...s2.messages,
      callOf("c2", "weather.forecast", { city: "Lisbon" }),
      resultOf("c2", "weather.forecast", { temp: 18 }),
    ],
  };
  return [s1, s2, s3];
}

const toolNamed = (body: AnthropicBody, part: string) =>
  body.tools?.find((t) => String(t.name).includes(part));

describe("cache-stable prompt: request bodies", () => {
  it("keeps the prefix byte-identical across steps, through a deferred tool load", async () => {
    const [b1, b2, b3] = await Promise.all(turnWithLoad().map((r) => send(r)));
    if (b1 === undefined || b2 === undefined || b3 === undefined) throw new Error("no body");
    assertPrefixStable(b1, b2);
    assertPrefixStable(b2, b3);
    // A load does not touch the tools array at all.
    expect(JSON.stringify(b2.tools)).toBe(JSON.stringify(b1.tools));
    expect(JSON.stringify(b3.tools)).toBe(JSON.stringify(b1.tools));
  });

  it("sends every deferrable tool deferred and references the loaded one from load_tools", async () => {
    const [, s2] = turnWithLoad();
    const body = await send(s2 as Omit<ModelRequest, "model">);
    const forecast = toolNamed(body, "forecast");
    const alerts = toolNamed(body, "alerts");
    expect(forecast).toMatchObject({ defer_loading: true });
    expect(alerts).toMatchObject({ defer_loading: true });
    expect(forecast?.cache_control).toBeUndefined();
    // Deferred tools come after the ones sent up front; the last of those holds the breakpoint.
    const upFront = (body.tools ?? []).filter((t) => t.defer_loading !== true);
    expect(upFront.map((t) => t.name)).toEqual([
      "ask_user",
      "tool_search",
      "load_tools",
      expect.stringContaining("notes"),
    ]);
    expect(upFront.at(-1)?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // The model reads the same JSON as before, and the API expands the reference.
    const result = body.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .find((c) => c.type === "tool_result" && c.tool_use_id === "c1");
    expect(result?.content).toEqual([
      { type: "text", text: JSON.stringify(LOADED) },
      { type: "tool_reference", tool_name: forecast?.name },
    ]);
  });

  it("places three breakpoints, longer TTL first, never on a deferred tool", async () => {
    for (const request of turnWithLoad()) {
      const body = await send(request as Omit<ModelRequest, "model">);
      expect(breakpointProblems(body)).toEqual([]);
      expect(breakpoints(body).map((b) => [b.path.replace(/\[\d+\]/g, "[]"), b.ttl])).toEqual([
        ["tools[]", "1h"],
        ["system[]", "1h"],
        ["messages[][]", "5m"],
      ]);
    }
  });

  it("splits system into the stable head and the volatile tail without changing the text", async () => {
    const [s1] = turnWithLoad();
    const body = await send(s1 as Omit<ModelRequest, "model">);
    const blocks = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "text",
      text: STABLE,
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
    expect(blocks[1]).toEqual({ type: "text", text: note("- 09:00 standup") });
    // What the model is told is unchanged: the blocks join back into the system prompt.
    expect(blocks.map((b) => b.text).join("\n\n")).toBe(s1?.system);
  });

  it("keeps the tools and the stable head across owner turns and a daily-note append", async () => {
    const [, , s3] = turnWithLoad(
      `${note("- 09:00 standup")}\n\n${recall("Ana prefers mornings.")}`,
    );
    if (s3 === undefined) throw new Error("no step");
    const turn2 = {
      ...s3,
      // Another writer appended to today's note; the next turn recalled something else.
      ...system(
        `${note("- 09:00 standup\n- 11:30 feed: liked the article")}\n\n${recall("Lisbon is UTC+0.")}`,
      ),
      messages: [
        ...s3.messages,
        { role: "assistant" as const, parts: [{ type: "text" as const, text: "18 degrees." }] },
        user("And Porto?"),
      ],
    };
    const before = await send(s3 as Omit<ModelRequest, "model">);
    const after = await send(turn2 as Omit<ModelRequest, "model">);
    // Breakpoints #0 (tools) and #1 (stable system) are read on the next turn.
    assertPrefixStable(before, after, 0);
    assertPrefixStable(before, after, 1);
    // The volatile tail still differs, so the history is re-read from there (moving per-turn
    // context out of system is PR 3).
    expect(prefixDiff(before, after)?.next?.path).toBe("system[1]");
  });

  it("shares the tools and the stable head between two threads", async () => {
    const a = await send({
      ...system(note("(no notes)")),
      messages: [user("Plan my day")],
      tools: CORE,
      deferredTools: DEFERRED,
    });
    const b = await send({
      ...system(`${note("(no notes)")}\n\n${recall("Other chat: trip to Porto")}`),
      messages: [
        user("Draft a reply to Ana"),
        { role: "assistant", parts: [{ type: "text", text: "On it." }] },
        user("Shorter"),
      ],
      tools: CORE,
      deferredTools: DEFERRED,
    });
    assertPrefixStable(a, b, 1);
  });

  it("keeps the earlier turn's thinking across a load (the prefix it is bound to is unchanged)", async () => {
    const thinking = (body: AnthropicBody) =>
      body.messages.flatMap((m) =>
        typeof m.content === "string" ? [] : m.content.filter((c) => c.type === "thinking"),
      );
    const base = { ...system(note("(no notes)")), tools: CORE, deferredTools: DEFERRED };
    const firstTurn = async (config: ProviderConfig) => {
      const replay = replayFetch(loadFixture("anthropic/text.json"));
      const { adapter } = makeAdapter(config, replay.fetch, KEY);
      return (
        await accumulate(adapter.stream({ model: REF, ...base, messages: [user("Hi")] }))
      ).message();
    };
    const second = (turn1: ModelMessage) => ({
      ...base,
      messages: [
        user("Hi"),
        turn1,
        user("Weather in Lisbon?"),
        callOf("c1", "load_tools", { names: ["weather.forecast"] }),
        resultOf("c1", "load_tools", LOADED),
      ],
      tools: [...CORE, FORECAST],
    });
    const kept = await send(second(await firstTurn(CONFIG)));
    expect(thinking(kept)).toHaveLength(1);
    // Without deferred loading the load changes the tools, and the block is dropped as before.
    const off = { ...CONFIG, deferLoading: false };
    const dropped = await send(second(await firstTurn(off)), off);
    expect(thinking(dropped)).toEqual([]);
  });

  it("sends a tool loaded without a load_tools result up front, as before", async () => {
    // `#gate` loaded it when the model called it by name, or it was loaded before this change.
    const body = await send({
      ...system(note("(no notes)")),
      messages: [
        user("Weather?"),
        callOf("c1", "weather.forecast", { city: "Porto" }),
        resultOf("c1", "weather.forecast", { temp: 20 }),
      ],
      tools: [...CORE, FORECAST],
      deferredTools: DEFERRED,
    });
    expect(toolNamed(body, "forecast")?.defer_loading).toBeUndefined();
    expect(toolNamed(body, "forecast")?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(toolNamed(body, "alerts")?.defer_loading).toBe(true);
    expect(breakpointProblems(body)).toEqual([]);
  });

  it("never references a tool that is no longer sent (that would fail the request)", async () => {
    const body = await send({
      ...system(note("(no notes)")),
      messages: [
        user("Weather?"),
        callOf("c1", "load_tools", { names: ["weather.forecast"] }),
        resultOf("c1", "load_tools", LOADED),
      ],
      tools: CORE,
      deferredTools: [ALERTS],
    });
    expect(JSON.stringify(body)).not.toContain("tool_reference");
    expect(toolNamed(body, "forecast")).toBeUndefined();
  });

  it("caches an unsplit system prompt as before, with the tail TTL", async () => {
    const body = await send({ system: "You are terse.", messages: [user("Hi")], tools: CORE });
    expect(body.system).toEqual([
      { type: "text", text: "You are terse.", cache_control: { type: "ephemeral" } },
    ]);
    expect(breakpoints(body).map((b) => b.ttl)).toEqual(["5m", "5m", "5m"]);
  });

  it("follows cacheTtl and prefixCacheTtl, never a 1h entry after a 5m one", async () => {
    const [s1] = turnWithLoad();
    const req = s1 as Omit<ModelRequest, "model">;
    const allHour = await send(req, { ...CONFIG, cacheTtl: "1h", prefixCacheTtl: "5m" });
    expect(breakpoints(allHour).map((b) => b.ttl)).toEqual(["1h", "1h", "1h"]);
    const allFive = await send(req, { ...CONFIG, prefixCacheTtl: "5m" });
    expect(breakpoints(allFive).map((b) => b.ttl)).toEqual(["5m", "5m", "5m"]);
    const off = await send(req, { ...CONFIG, promptCaching: false });
    expect(breakpoints(off)).toEqual([]);
  });

  it("by default sends loaded tools as before, with the split system and the same breakpoints", async () => {
    const bodies = await Promise.all(turnWithLoad().map((r) => send(r, DEFAULT)));
    const [b1, b2, b3] = bodies;
    if (b1 === undefined || b2 === undefined || b3 === undefined) throw new Error("no body");
    expect(JSON.stringify(bodies)).not.toContain("defer_loading");
    expect(JSON.stringify(bodies)).not.toContain("tool_reference");
    // The loaded tool is appended up front (the old behaviour) and holds the tools breakpoint.
    expect(toolNamed(b2, "forecast")?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(toolNamed(b1, "forecast")).toBeUndefined();
    for (const body of bodies) {
      expect(breakpointProblems(body)).toEqual([]);
      expect(breakpoints(body).map((b) => b.ttl)).toEqual(["1h", "1h", "5m"]);
      expect(body.system).toHaveLength(2);
    }
    // Steps without a load keep the whole prefix. A load still rewrites from the appended tool
    // on, as before: the earlier tools breakpoint is read, everything after it is written.
    assertPrefixStable(b2, b3);
    assertPrefixStable(b1, b2, 0);
    expect(prefixDiff(b1, b2)?.next?.path).toBe(`tools[${CORE.length}]`);
  });

  it("positions skip deferred tools and strip cache_control", async () => {
    const [s1] = turnWithLoad();
    const body = await send(s1 as Omit<ModelRequest, "model">);
    const ps = positions(body);
    expect(ps.filter((p) => p.path.startsWith("tools["))).toHaveLength(CORE.length);
    expect(ps.every((p) => !p.bytes.includes("cache_control"))).toBe(true);
  });
});

describe("cache-stable prompt: other providers and models", () => {
  const convert = (config: ProviderConfig, modelId: string) => {
    const [, s2] = turnWithLoad();
    return convertRequest(
      { model: `${config.id}/${modelId}`, ...(s2 as Omit<ModelRequest, "model">) },
      { config, modelId },
    );
  };
  const names = (o: ReturnType<typeof convertRequest>) => (o.tools ?? []).map((t) => t.name);

  it("ignores deferredTools and sends one system message for another provider", () => {
    const o = convert({ id: "openai", kind: "openai" }, "gpt-5.5");
    expect(names(o)).not.toContain("weather_alerts");
    expect(JSON.stringify(o.tools)).not.toContain("deferLoading");
    expect(o.prompt.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("does not defer by default, on a Claude model older than 4.5, or with deferLoading off", () => {
    for (const [config, model] of [
      [DEFAULT, "claude-haiku-5-5"],
      [CONFIG, "claude-3-7-sonnet-latest"],
      [{ ...CONFIG, deferLoading: false }, "claude-haiku-5-5"],
      [
        { id: "proxy", kind: "anthropic-compatible", baseURL: "http://127.0.0.1:1" },
        "claude-haiku-5-5",
      ],
    ] as const) {
      const o = convert(config as ProviderConfig, model);
      expect(JSON.stringify(o.tools)).not.toContain("deferLoading");
      expect(names(o)).toHaveLength(CORE.length + 1);
    }
  });
});
