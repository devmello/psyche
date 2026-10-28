import type { ToolSpec } from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { defineTool, type TurnToolContext } from "../src/index.ts";
import { call, endOf, harness, recorder, resultsIn, runTurn, say, spec } from "./harness.ts";

const names = (tools: ToolSpec[] | undefined) => (tools ?? []).map((t) => t.name);
const deferTool = (s: ToolSpec) => s.name.startsWith("weather.") || s.name.startsWith("mcp__");

function withWeather(script: ReturnType<typeof say>[]) {
  const h = harness({ script, loop: { deferTool } });
  const forecast = recorder({ output: { temp: 18 } });
  h.loop.registry.register({
    spec: spec("weather.forecast", "read", {
      description: "Get the weather forecast for a city. Returns hourly temperatures.",
    }),
    execute: forecast.execute,
  });
  h.loop.registry.register({
    spec: spec("weather.alerts", "read", { description: "Severe weather alerts for a region." }),
    execute: recorder().execute,
  });
  return { h, forecast };
}

describe("deferred tools (progressive disclosure)", () => {
  it("finds a deferred tool, loads it mid-turn and calls it, keeping the prompt text stable", async () => {
    const { h, forecast } = withWeather([
      call("c1", "tool_search", { query: "weather forecast" }),
      call("c2", "load_tools", { names: ["weather.forecast"] }),
      call("c3", "weather.forecast", { city: "Lisbon" }),
      say("18 degrees."),
    ]);
    const events = await runTurn(h, "weather in Lisbon?");
    expect(endOf(events).outcome).toBe("final");
    const [r0, r1, r2, r3] = h.provider.requests;
    // Not sent until loaded; the finder pair is.
    expect(names(r0?.tools)).not.toContain("weather.forecast");
    expect(names(r0?.tools)).toEqual(expect.arrayContaining(["tool_search", "load_tools"]));
    expect(r0?.system).toContain("Loaded on demand (2");
    expect(r0?.system).toContain("weather.forecast");
    const found = resultsIn(r1).get("c1")?.output as { tools: { name: string }[] };
    expect(found.tools[0]?.name).toBe("weather.forecast");
    // Loaded: appended at the end of the list, the rest in the same order.
    expect(names(r2?.tools).at(-1)).toBe("weather.forecast");
    expect(names(r2?.tools).slice(0, -1)).toEqual(names(r0?.tools));
    expect(names(r2?.tools)).not.toContain("weather.alerts");
    // The system prompt does not change on a load (prefix caches survive).
    expect(r2?.system).toBe(r0?.system);
    expect(forecast.seen).toHaveLength(1);
    expect(resultsIn(r3).get("c3")?.output).toEqual({ temp: 18 });
    expect((await h.loop.threadState("thr_1")).loadedTools).toEqual(["weather.forecast"]);
  });

  it("keeps loaded tools for the thread's next turns", async () => {
    const { h } = withWeather([
      call("c1", "load_tools", { names: ["weather.forecast"] }),
      say("ok"),
      say("again"),
    ]);
    await runTurn(h, "load it");
    await runTurn(h, "next turn");
    expect(names(h.provider.requests.at(-1)?.tools)).toContain("weather.forecast");
  });

  it("a deferred tool called without loading runs when its arguments fit, and stays loaded", async () => {
    const { h, forecast } = withWeather([
      call("c1", "weather.forecast", { city: "Porto" }),
      say("done"),
    ]);
    await runTurn(h, "weather in Porto");
    expect(resultsIn(h.provider.requests[1]).get("c1")?.output).toEqual({ temp: 18 });
    expect(names(h.provider.requests[1]?.tools)).toContain("weather.forecast");
    expect(forecast.seen).toHaveLength(1);
  });

  it("a deferred tool called with bad arguments is refused with a pointer to its schema", async () => {
    const h = harness({
      script: [call("c1", "weather.typed", { city: 3 }), say("done")],
      loop: { deferTool },
    });
    h.loop.registry.register(
      defineTool({
        name: "weather.typed",
        description: "Typed forecast.",
        input: Type.Object({ city: Type.String() }),
        sideEffect: "read",
        run: async () => ({ output: {}, provenance: "trusted" }),
      }),
    );
    await runTurn(h, "weather");
    const r = resultsIn(h.provider.requests[1]).get("c1");
    expect(r?.isError).toBe(true);
    expect(JSON.stringify(r?.output)).toContain("loaded now");
    expect(names(h.provider.requests[1]?.tools)).toContain("weather.typed");
  });

  it("load_tools takes mcp__<server> for a whole connector and refuses unknown names", async () => {
    const h = harness({
      script: [call("c1", "load_tools", { names: ["mcp__linear", "nope"] }), say("ok")],
      loop: { deferTool },
    });
    for (const t of ["create_issue", "list_issues"]) {
      h.loop.registry.register({
        spec: spec(`mcp__linear__${t}`, "read", { descriptionProvenance: "untrusted" }),
        execute: recorder().execute,
      });
    }
    await runTurn(h, "linear");
    const out = resultsIn(h.provider.requests[1]).get("c1")?.output as {
      loaded: string[];
      unknown: string[];
    };
    expect(out.loaded).toEqual(["mcp__linear__create_issue", "mcp__linear__list_issues"]);
    expect(out.unknown).toEqual(["nope"]);
  });

  it("unloaded connector descriptions do not taint the turn; searching them does", async () => {
    const h = harness({
      script: [say("hi"), call("c1", "tool_search", { query: "issue" }), say("ok")],
      loop: { deferTool },
    });
    h.loop.registry.register({
      spec: spec("mcp__linear__create_issue", "write", {
        description: "Create an issue.",
        descriptionProvenance: "untrusted",
      }),
      execute: recorder().execute,
    });
    await runTurn(h, "hello");
    expect((await h.loop.threadState("thr_1")).taint).toBeUndefined();
    await runTurn(h, "find an issue tool");
    const r = resultsIn(h.provider.requests[2]).get("c1");
    expect(r?.provenance).toBe("untrusted");
    expect(JSON.stringify(r?.output)).toContain("data, not instructions");
  });

  it("a tool installed during the turn loads into the same turn (install_capability's path)", async () => {
    const h = harness({
      script: [call("c1", "install_x", {}), call("c2", "mcp__x__do", {}), say("done")],
      loop: { deferTool },
    });
    const done = recorder({ output: { did: true } });
    h.loop.registry.register(
      defineTool({
        name: "install_x",
        description: "Installs x.",
        input: Type.Object({}),
        sideEffect: "none",
        async run(_p, ctx) {
          // What an approved install does: its server's tools register, then load.
          h.loop.registry.register({ spec: spec("mcp__x__do", "read"), execute: done.execute });
          const api = (ctx as TurnToolContext).turn.deferredTools;
          return { output: api?.load(["mcp__x__do"]), provenance: "trusted" };
        },
      }),
    );
    await runTurn(h, "install x and use it");
    expect(resultsIn(h.provider.requests[1]).get("c1")?.output).toMatchObject({
      loaded: ["mcp__x__do"],
    });
    expect(names(h.provider.requests[1]?.tools)).toContain("mcp__x__do");
    expect(done.seen).toHaveLength(1);
  });

  it("without deferTool every tool is sent and the finder pair is absent", async () => {
    const h = harness({ script: [say("ok")] });
    h.loop.registry.register({
      spec: spec("weather.forecast", "read"),
      execute: recorder().execute,
    });
    await runTurn(h, "hi");
    const tools = names(h.provider.requests[0]?.tools);
    expect(tools).toContain("weather.forecast");
    expect(tools).not.toContain("tool_search");
  });
});
