import type { SpecialistSpec } from "@psyche/protocol";
import { describe, expect, it } from "vitest";
import { FakeAgentLoop, FakeTaskEngine } from "../src/index.ts";

const spec: SpecialistSpec = {
  role: "researcher",
  parentRunId: "run_parent",
  parentThreadId: "thr_1",
  rootRunId: "run_parent",
  model: "fake/primary",
  tools: ["web_search", "web_fetch"],
  permissionMode: "balanced",
  budget: {
    limit: { tokens: 400_000, wallMs: 1_800_000, costUsd: 2 },
    used: { steps: 0, tokens: 0, wallMs: 0, costUsd: 0 },
  },
  deadline: null,
  inputs: { libraryItemIds: [], folders: [], urls: [] },
  deliver: "inbox",
  planFirst: false,
  queuePosition: 1,
  result: null,
};

describe("specialist fakes (docs/agent/specialists-2026.md §7)", () => {
  it("FakeTaskEngine stores a task's specialist block", async () => {
    const tasks = new FakeTaskEngine();
    const task = await tasks.create({
      threadId: "thr_sub",
      title: "Apartments near the office",
      goal: "Find three under $2,500",
      createdFrom: "subagent",
      specialist: spec,
    });
    expect((await tasks.get(task.id))?.specialist).toEqual(spec);
  });

  it("FakeAgentLoop scripts the subagent step event", async () => {
    const loop = FakeAgentLoop.script([
      [
        {
          type: "subagent",
          messageId: "m1",
          toolCallId: "call_1",
          taskId: "tsk_1",
          childRunId: null,
          status: "queued",
          label: "Researcher · Apartments",
        },
        { type: "end", outcome: "final" },
      ],
    ]);
    const events = [];
    for await (const e of loop.startTurn({
      threadId: "thr_1",
      runId: "run_parent",
      input: { text: "find apartments" },
      mode: "attended",
      permissionMode: "balanced",
    }))
      events.push(e);
    expect(events[0]).toMatchObject({ type: "subagent", runId: "run_parent", status: "queued" });
  });
});
