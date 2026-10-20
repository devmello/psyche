import { describe, expect, it } from "vitest";
import {
  type AgentEndContext,
  attachRoutineDetector,
  HookRegistry,
  type RoutineObservation,
} from "../src/index.ts";
import { calls, harness, recorder, runTurn, say, spec } from "./harness.ts";

/**
 * T3 routine detection: an in-process evaluator over `after_tool_call` / `agent_end`. A routine
 * is the same tool sequence ending an owner turn again in the same thread.
 */

const ROUTINE = () =>
  calls(
    { id: "a", name: "notes.list", input: { folder: "inbox" } },
    { id: "b", name: "notes.read", input: { id: "n1" } },
    { id: "c", name: "notes.save", input: { id: "n1", text: "filed" } },
  );

function setup(options: { incognito?: boolean } = {}) {
  const h = harness({ policy: { bySideEffect: { write: "allow", read: "allow" } } });
  for (const [name, effect] of [
    ["notes.list", "read"],
    ["notes.read", "read"],
    ["notes.save", "write"],
  ] as const) {
    h.loop.registry.register({ spec: spec(name, effect), execute: recorder().execute });
  }
  const seen: RoutineObservation[] = [];
  const off = attachRoutineDetector(h.loop.hooks, {
    onRoutine: (r) => {
      seen.push(r);
    },
    isIncognito: () => options.incognito === true,
  });
  return { h, seen, off };
}

const twice = (_h: ReturnType<typeof setup>["h"]) => [
  ROUTINE(),
  say("done"),
  ROUTINE(),
  say("done"),
];

describe("routine detection (T3)", () => {
  it("reports a tool sequence that ends two owner turns in one thread", async () => {
    const { h, seen } = setup();
    h.provider.script(twice(h));
    await runTurn(h, "File today's notes; mail dana@example.com");
    expect(seen).toEqual([]);
    await runTurn(h, "File today's notes again");
    expect(seen).toHaveLength(1);
    const r = seen[0] as RoutineObservation;
    expect(r.tools).toEqual(["notes.list", "notes.read", "notes.save"]);
    expect(r.runs.map((t) => t.ownerText)).toEqual([
      "File today's notes; mail dana@example.com",
      "File today's notes again",
    ]);
    expect(r.runs[0]?.steps[2]).toMatchObject({
      tool: "notes.save",
      sideEffect: "write",
      params: { id: "n1", text: "filed" },
    });
  });

  it("never counts another thread, someone else's turn, unattended runs or incognito", async () => {
    const { h, seen } = setup();
    h.provider.script([...twice(h)]);
    await runTurn(h, "file notes", { threadId: "thr_a" });
    await runTurn(h, "file notes", { threadId: "thr_b" });
    expect(seen).toEqual([]);

    // The gates on agent_end, driven directly (such turns park or run elsewhere in the loop).
    const hooks = new HookRegistry();
    const found: RoutineObservation[] = [];
    attachRoutineDetector(hooks, {
      onRoutine: (r) => {
        found.push(r);
      },
      isIncognito: (t) => t === "thr_inc",
    });
    const turn = async (runId: string, end: Partial<AgentEndContext>) => {
      for (const tool of ["notes.list", "notes.read", "notes.save"]) {
        for (const fn of hooks.handlers("after_tool_call"))
          await fn({
            threadId: "thr_x",
            runId,
            toolCallId: `${runId}_${tool}`,
            tool,
            params: {},
            spec: spec(tool, "read"),
            taint: false,
            permissionMode: "balanced",
            mode: "attended",
            result: { output: {}, provenance: "trusted" },
          });
      }
      for (const fn of hooks.handlers("agent_end"))
        await fn({
          threadId: "thr_x",
          runId,
          outcome: "final",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 },
          steps: 3,
          ownerText: "file notes",
          mode: "attended",
          ...end,
        });
    };
    await turn("u1", { mode: "unattended" });
    await turn("u2", { mode: "unattended" });
    await turn("d1", { ownerText: "" });
    await turn("d2", { ownerText: "" });
    await turn("s1", { subagent: true });
    await turn("s2", { subagent: true });
    await turn("i1", { threadId: "thr_inc" });
    await turn("i2", { threadId: "thr_inc" });
    await turn("f1", { outcome: "failed" });
    await turn("f2", { outcome: "failed" });
    expect(found).toEqual([]);
    await turn("ok1", {});
    await turn("ok2", {});
    expect(found).toHaveLength(1);
  });

  it("ignores short turns and failed calls, and detaches cleanly", async () => {
    const { h, seen, off } = setup();
    h.provider.script([
      calls({ id: "x", name: "notes.list", input: {} }),
      say("one step"),
      calls({ id: "y", name: "notes.list", input: {} }),
      say("one step"),
    ]);
    await runTurn(h, "list");
    await runTurn(h, "list");
    expect(seen).toEqual([]);
    off();
    h.provider.script(twice(h));
    await runTurn(h, "file");
    await runTurn(h, "file");
    expect(seen).toEqual([]);
  });
});
