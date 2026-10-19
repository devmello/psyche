import type { AgentEvent, ModelEvent, ModelRequest } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import type { SubagentInfo } from "../src/index.ts";
import {
  call,
  calls,
  endOf,
  harness,
  recorder,
  resultsIn,
  runTurn,
  say,
  spec,
  start,
  until,
} from "./harness.ts";

const isChild = (r: ModelRequest) =>
  r.messages.some(
    (m) =>
      m.role === "user" &&
      m.parts.some((p) => p.type === "text" && p.text.startsWith("You are a subagent")),
  );
const childTitle = (r: ModelRequest) => {
  for (const m of r.messages) {
    for (const p of m.parts) {
      const t = p.type === "text" ? /Task: (.+)/.exec(p.text) : null;
      if (t?.[1] !== undefined) return t[1];
    }
  }
  return "";
};
const lastIsTool = (r: ModelRequest) => r.messages.at(-1)?.role === "tool";
const spawn = (id: string, title: string, context: "fork" | "fresh" = "fresh") => ({
  id,
  name: "subagent.spawn",
  input: { context, title, brief: `Research ${title}` },
});

describe("subagents (C6)", () => {
  it("a fresh subagent sees only its brief, has no questions/messaging/nesting, and reports back", async () => {
    const h = harness({
      script: [
        call("s1", "subagent.spawn", spawn("s1", "flights").input),
        say("Found 3 flights."),
        say("Here they are."),
      ],
    });
    h.loop.registry.register({
      spec: spec("email.send", "write", { targetKind: "recipient" }),
      execute: recorder().execute,
    });
    const events = await runTurn(h, "find flights to Lisbon");
    expect(endOf(events).outcome).toBe("final");
    const child = h.provider.requests[1];
    expect(child?.messages).toHaveLength(1);
    expect(child?.messages[0]?.role).toBe("user");
    const tools = child?.tools?.map((t) => t.name) ?? [];
    for (const name of [
      "ask_user",
      "subagent.spawn",
      "wrap_up",
      "task.start",
      "notify",
      "email.send",
    ]) {
      expect(tools).not.toContain(name);
    }
    expect(tools).toContain("memory");
    const result = resultsIn(h.provider.requests[2]).get("s1");
    expect(result).toMatchObject({
      provenance: "trusted",
      output: { outcome: "final", result: "Found 3 flights." },
    });
    const [info] = h.loop.subagents("thr_1");
    expect(info).toMatchObject({ title: "flights", context: "fresh", status: "final" });
    expect((await h.loop.threadState(info?.threadId as string)).messages.at(-1)?.role).toBe(
      "assistant",
    );
  });

  it("a forked subagent inherits the transcript without the step's unanswered calls", async () => {
    const h = harness({
      script: [
        say("noted"),
        call("s1", "subagent.spawn", spawn("s1", "hotels", "fork").input),
        say("Two hotels."),
        say("ok"),
      ],
    });
    await runTurn(h, "I like quiet places");
    await runTurn(h, "find a hotel");
    const child = h.provider.requests[2];
    const texts = child?.messages.flatMap((m) =>
      m.parts.map((p) => (p.type === "text" ? p.text : p.type)),
    );
    expect(texts?.slice(0, 4)).toEqual([
      "I like quiet places",
      "noted",
      "find a hotel",
      expect.stringContaining("You are a subagent"),
    ]);
    expect(child?.messages.some((m) => m.parts.some((p) => p.type === "tool_call"))).toBe(false);
  });

  it("runs parallel subagents concurrently and returns each result to its call", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness({
      script: Array.from({ length: 8 }, () => (r: ModelRequest): ModelEvent[] => {
        if (!isChild(r)) {
          return lastIsTool(r) ? say("compared") : calls(spawn("a", "Lisbon"), spawn("b", "Porto"));
        }
        return lastIsTool(r)
          ? say(`report on ${childTitle(r)}`)
          : call(`p-${childTitle(r)}`, "probe", {});
      }),
    });
    h.loop.registry.register({
      spec: spec("probe", "read"),
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { output: "data", provenance: "trusted" };
      },
    });
    const events = await runTurn(h, "compare two cities");
    expect(endOf(events).outcome).toBe("final");
    expect(maxInFlight).toBe(2);
    const results = resultsIn(h.provider.requests.at(-1));
    expect(results.get("a")?.output).toMatchObject({ result: "report on Lisbon" });
    expect(results.get("b")?.output).toMatchObject({ result: "report on Porto" });
    expect(h.loop.subagents()).toHaveLength(2);
  });

  it("has no approval authority: an action that would ask is blocked, nothing is issued", async () => {
    const exec = recorder();
    const h = harness({
      script: [
        call("s1", "subagent.spawn", spawn("s1", "cal").input),
        call("w1", "calendar.create", {}),
        say("Could not create it."),
        say("ok"),
      ],
    });
    h.loop.registry.register({ spec: spec("calendar.create", "write"), execute: exec.execute });
    await runTurn(h, "set it up");
    expect(exec.seen).toHaveLength(0);
    expect(h.broker.issued).toHaveLength(0);
    expect(JSON.stringify(resultsIn(h.provider.requests[2]).get("w1")?.output)).toContain(
      "subagents cannot ask",
    );
  });

  it("carries the subagent's taint into the parent", async () => {
    const h = harness({
      script: [
        call("s1", "subagent.spawn", spawn("s1", "web").input),
        call("f1", "web.fetch", {}),
        say("Page says X."),
        call("n1", "noop", {}),
        say("ok"),
      ],
    });
    h.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    h.loop.registry.register({ spec: spec("noop", "none"), execute: recorder().execute });
    await runTurn(h, "read the page");
    expect(resultsIn(h.provider.requests[3]).get("s1")?.provenance).toBe("untrusted");
    expect(h.broker.decisions.at(-1)?.call.tool).toBe("noop");
    expect(h.broker.decisions.at(-1)?.ctx.taint).toBe(true);
  });

  it("a parent tainted before spawning passes its taint to the subagent", async () => {
    const h = harness({
      script: [
        call("f1", "web.fetch", {}),
        call("s1", "subagent.spawn", spawn("s1", "x").input),
        call("n1", "noop", {}),
        say("done"),
        say("ok"),
      ],
    });
    h.loop.registry.register({
      spec: spec("web.fetch", "read", { provenanceOut: "untrusted" }),
      execute: recorder().execute,
    });
    h.loop.registry.register({ spec: spec("noop", "none"), execute: recorder().execute });
    await runTurn(h, "go");
    const childDecision = h.broker.decisions.find((d) => d.call.tool === "noop");
    expect(childDecision?.ctx.runId).toContain(":sub:");
    expect(childDecision?.ctx.taint).toBe(true);
  });

  it("cancelling the parent cancels its subagents", async () => {
    let release: () => void = () => {};
    const h = harness({
      script: [call("s1", "subagent.spawn", spawn("s1", "slow").input), call("w1", "wait", {})],
    });
    h.loop.registry.register({
      spec: spec("wait", "none"),
      execute: (_id, _p, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ output: "late", provenance: "trusted" });
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const turn = start(h, "go");
    await until(
      () => h.loop.subagents()[0]?.status === "running" && h.broker.decisions.length >= 2,
      "child waiting",
    );
    await h.loop.cancel(turn.runId);
    release();
    const events = await turn.done;
    expect(endOf(events).outcome).toBe("cancelled");
    expect(h.loop.subagents()[0]?.status).toBe("cancelled");
  });

  it("subagent tokens count toward the parent's budget", async () => {
    const h = harness({
      script: [
        call("s1", "subagent.spawn", spawn("s1", "big").input),
        say("report", { input: 900, output: 100 }),
        say("ok"),
      ],
      loop: { maxRunTokens: 1_000 },
    });
    const events = await runTurn(h, "go");
    expect(endOf(events)).toMatchObject({ outcome: "failed", error: "token_budget_exceeded" });
  });

  it("forwards every subagent event for the Subagents pane", async () => {
    const seen: { info: SubagentInfo; event: AgentEvent }[] = [];
    const h = harness({
      script: [call("s1", "subagent.spawn", spawn("s1", "pane").input), say("report"), say("ok")],
      loop: { onSubagentEvent: (info, event) => seen.push({ info, event }) },
    });
    await runTurn(h, "go");
    expect(seen[0]?.event).toMatchObject({ type: "run.status", status: "running" });
    expect(seen.at(-1)?.event).toMatchObject({ type: "end", outcome: "final" });
    expect(seen.at(-1)?.info).toMatchObject({ title: "pane", status: "final" });
    expect(seen.some((e) => e.event.type === "chat.delta")).toBe(true);
  });
});
